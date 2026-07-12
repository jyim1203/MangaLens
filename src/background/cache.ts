/**
 * IndexedDB translation cache (F13, Architecture §5/§7.3) — "never translate the
 * same image twice". Keyed by a composite of the SHA-256 image digest + target
 * language + model + {@link PROMPT_VERSION}, so a cache hit guarantees the same
 * bytes, language, model, and prompt would have produced the stored result.
 *
 * Split like the rest of the background layer (imagePrep / translateHandlers):
 *  - a PURE, exhaustively-tested core — key composition, size estimation, LRU
 *    eviction planning, negative-entry expiry, and the lookup classifier — none
 *    of which touch a browser API;
 *  - a THIN, untested `idb`-backed shell (`cacheLookup`/`cacheStorePage`/…). It
 *    is untested for the same reason `prepareImage` is: IndexedDB does not exist
 *    in the Node/jsdom test runtime, and every shell call is wrapped so a cache
 *    fault degrades to "no caching", never a failed translation (handoff rule 6).
 *
 * Negative caching (PROMPTS.md §6.5): a translation that fails as `malformed` or
 * `refusal` is remembered for {@link NEGATIVE_TTL_MS} so a stuck page does not
 * loop the provider; transient faults (auth/rate-limit/network/aborted) are
 * never cached — they succeed once the underlying condition clears.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { CACHE_VERSION } from "../shared/constants";
import { createLogger } from "../shared/log";
import type {
  PageTranslation,
  ProviderErrorKind,
  ProviderId,
} from "../shared/types";

const log = createLogger("cache");

/** How long a negative (failed) entry is honoured before we retry (PROMPTS §6.5). */
export const NEGATIVE_TTL_MS = 10 * 60 * 1000;

/**
 * Per-record fixed overhead (bytes) added to the estimated JSON size: the key
 * string, timestamps, and IndexedDB's own per-entry bookkeeping. A rough
 * constant is enough — the size cap is a soft budget, not an exact accountant.
 */
const RECORD_OVERHEAD_BYTES = 256;

/** IndexedDB database name; versioned so a value-shape change retires it wholesale. */
export const CACHE_DB_NAME = `mangalens-cache-v${CACHE_VERSION}`;
/** Matches any versioned cache DB name, for sweeping stale versions (item 8). */
const CACHE_DB_NAME_RE = /^mangalens-cache-v\d+$/;
/** The object store holding every cached page/tile translation. */
export const CACHE_STORE = "translations";
/** Tiny singleton store holding running aggregates (the byte total, item 6). */
export const META_STORE = "meta";
/** Key in {@link META_STORE} for the running sum of every record's `bytes`. */
export const TOTAL_BYTES_KEY = "totalBytes";

/**
 * One row in the cache. `page` is the translation for a positive entry, or
 * `null` for a negative one (in which case `errorKind`/`message` carry the
 * cached failure and `expiresAt` bounds it). Positive entries never expire; they
 * are only removed by LRU eviction once the store exceeds its cap.
 */
export interface CacheRecord {
  /** Composite cache key (see {@link buildCacheKey}); the store's primary key. */
  key: string;
  /** SHA-256 of the original image bytes (the page identity), for reference/debug. */
  imageHash: string;
  /** The translation, or `null` for a negative (cached-failure) entry. */
  page: PageTranslation | null;
  /** Negative entries only: the failure kind to re-surface. */
  errorKind?: ProviderErrorKind;
  /** Negative entries only: the human-readable failure message. */
  message?: string;
  /** Estimated serialized size in bytes, summed for the LRU size cap. */
  bytes: number;
  /** Hostname the image was translated for (F15 per-site clear); may be absent. */
  origin?: string;
  /** Epoch ms the entry was written. */
  createdAt: number;
  /** Epoch ms of the most recent read/write — the LRU recency key. */
  lastAccess: number;
  /** Negative entries only: epoch ms after which the entry is stale. */
  expiresAt?: number;
}

/** The typed result of a cache read, produced by {@link classifyCacheLookup}. */
export type CacheLookup =
  | { status: "miss" }
  | { status: "hit"; page: PageTranslation }
  | { status: "negative"; errorKind: ProviderErrorKind; message: string }
  | { status: "expired" };

// --- Pure core (unit-tested, browser-free) ---------------------------------

/** Everything that shapes a translation's output, folded into its cache key. */
export interface CacheKeyParts {
  provider: ProviderId;
  imageHash: string;
  targetLang: string;
  /** The RESOLVED model actually sent (see `resolveEffectiveModel`), not raw settings. */
  model: string;
  /** Honorifics rule slot (PROMPTS §3) — flips the prompt, so it keys. */
  preserveHonorifics: boolean;
  /** Reading-order slot (PROMPTS §3/§7). */
  readingDirection: "rtl" | "ltr" | "auto";
  /** Pinned source-language hint (PROMPTS §4/§7); absent encodes as `-`. */
  sourceLangHint?: string;
  promptVersion: number;
}

/**
 * Compose the composite cache key from everything that changes a translation's
 * output. WHY each part: the same image bytes produce genuinely different
 * results — and must not collide — under a different provider, language, model,
 * prompt version, or any prompt-shaping slot (honorifics / reading direction /
 * source-lang hint, PROMPTS §3/§4/§7). {@link PROMPT_VERSION} only covers prompt
 * *text* changes; the slot *values* are folded in here (Phase 4.1 item 4).
 *
 * Every field is always encoded (no omit-when-default, or an old key would
 * silently match a new setting), and the free-text segments are
 * `encodeURIComponent`-ed so a model id that legally contains `|` can't be
 * mistaken for a delimiter and collide with a crafted neighbor.
 *
 * `temperature` is deliberately EXCLUDED: it's a continuous knob with a minor
 * output effect, and folding it in would fragment the cache for no real gain.
 *
 * @param parts image digest + the provider/settings that shape the output.
 * @returns a stable, collision-free key string.
 */
export function buildCacheKey(parts: CacheKeyParts): string {
  const enc = encodeURIComponent;
  const honorifics = parts.preserveHonorifics ? "1" : "0";
  const hint = parts.sourceLangHint ? enc(parts.sourceLangHint) : "-";
  // Format: {provider}|{imageHash}|{targetLang}|{model}|h{0|1}|d{dir}|s{hint|-}|p{ver}
  return [
    parts.provider,
    parts.imageHash,
    enc(parts.targetLang),
    enc(parts.model),
    `h${honorifics}`,
    `d${parts.readingDirection}`,
    `s${hint}`,
    `p${parts.promptVersion}`,
  ].join("|");
}

/**
 * Estimate the stored size of a page translation in bytes, used to keep the
 * store under {@link import("../shared/settings").Settings.cacheCapMb}. This is
 * an approximation (serialized JSON UTF-8 length + fixed record overhead), which
 * is all the soft size cap needs. A `null` page (negative entry) is tiny.
 *
 * @param page the translation to size, or `null` for a negative entry.
 * @returns approximate bytes the record occupies.
 */
export function estimatePageBytes(page: PageTranslation | null): number {
  const body = page ? new TextEncoder().encode(JSON.stringify(page)).length : 0;
  return body + RECORD_OVERHEAD_BYTES;
}

/**
 * Classify a raw record read from the store. Positive entries are `hit` (unless
 * they somehow carry an elapsed `expiresAt`); negative entries are `negative`
 * while live and `expired` once past their TTL; a missing record is `miss`.
 *
 * @param record the stored record, or `undefined` when the key was absent.
 * @param now epoch ms (injectable for tests).
 */
export function classifyCacheLookup(
  record: CacheRecord | undefined,
  now: number = Date.now(),
): CacheLookup {
  if (!record) return { status: "miss" };
  if (typeof record.expiresAt === "number" && record.expiresAt <= now) {
    return { status: "expired" };
  }
  if (record.page) return { status: "hit", page: record.page };
  return {
    status: "negative",
    errorKind: record.errorKind ?? "unknown",
    message: record.message ?? "cached failure",
  };
}

/**
 * Decide whether a failed translation should be negatively cached. Only
 * *deterministic* failures qualify: a `malformed` response or a provider
 * `refusal` will recur on immediate retry, so we suppress re-hammering for
 * {@link NEGATIVE_TTL_MS}. Transient kinds (`auth`, `rate-limit`, `network`,
 * `aborted`) clear on their own and must stay retryable (PROMPTS §6.5).
 *
 * @param kind the failure kind from a {@link import("./providers/ProviderBase").ProviderError}.
 */
export function shouldNegativeCache(kind: ProviderErrorKind): boolean {
  return kind === "malformed" || kind === "refusal";
}

/**
 * The running byte total after storing a record that replaces one occupying
 * `existingBytes` (0 when the key is new). Never negative. This is the exact
 * update the {@link META_STORE} `totalBytes` gets on every put, extracted pure
 * so the accounting is unit-tested without IndexedDB (Phase 4.1 item 6).
 *
 * @param prevTotal the current running total.
 * @param existingBytes bytes of the record being overwritten (0 if none).
 * @param newBytes bytes of the record now being written.
 */
export function totalAfterPut(
  prevTotal: number,
  existingBytes: number,
  newBytes: number,
): number {
  return Math.max(0, prevTotal - existingBytes + newBytes);
}

/** The minimal record shape {@link planLruEviction} needs — decoupled for testing. */
export interface EvictionCandidate {
  key: string;
  bytes: number;
}

/**
 * Given the entries ordered OLDEST-first (by `lastAccess`) and the running byte
 * `total`, decide which keys to evict so the store drops to `capBytes` — pure
 * LRU: walk oldest→newest, dropping until the total fits. This is the exact
 * decision {@link evictToCap}'s cursor implements; extracted pure so the rule is
 * unit-tested without IndexedDB (Phase 4.1 item 6).
 *
 * WHY no separate "expired first" pass (unlike the retired planEviction):
 * expired negatives are tiny and are swept two other ways — the fire-and-forget
 * delete on an `expired` {@link cacheLookup} (item 9) and this LRU walk when the
 * store is over cap. {@link classifyCacheLookup}'s TTL check remains the
 * correctness guard, so a lingering expired record is never *served*.
 *
 * @param orderedOldestFirst candidates sorted ascending by `lastAccess`.
 * @param total current running byte total.
 * @param capBytes the byte budget (values ≤ 0 evict everything).
 * @returns the keys to delete (a prefix of the input) and the remaining total.
 */
export function planLruEviction(
  orderedOldestFirst: readonly EvictionCandidate[],
  total: number,
  capBytes: number,
): { keys: string[]; remaining: number } {
  if (total <= capBytes) return { keys: [], remaining: total };
  const keys: string[] = [];
  let remaining = total;
  for (const e of orderedOldestFirst) {
    if (remaining <= capBytes) break;
    keys.push(e.key);
    remaining -= e.bytes;
  }
  return { keys, remaining: Math.max(0, remaining) };
}

// --- IndexedDB shell (thin, fail-soft, untested) ---------------------------

interface CacheDb extends DBSchema {
  [CACHE_STORE]: {
    key: string;
    value: CacheRecord;
    indexes: { origin: string; lastAccess: number };
  };
  [META_STORE]: {
    key: string;
    value: number;
  };
}

let dbPromise: Promise<IDBPDatabase<CacheDb>> | undefined;

/**
 * Fire-and-forget: delete every stale `mangalens-cache-v*` database except the
 * current one, so a {@link CACHE_VERSION} bump doesn't strand the previous
 * (up-to-cap-sized) database on disk forever (Phase 4.1 item 8). Fail-soft and
 * never blocks the open — `indexedDB.databases()` needs Firefox 126+, below our
 * `strict_min_version` of 128, so the guard is just defensive.
 */
async function sweepOldCacheDatabases(): Promise<void> {
  try {
    if (typeof indexedDB.databases !== "function") return;
    const infos = await indexedDB.databases();
    for (const { name } of infos) {
      if (name && CACHE_DB_NAME_RE.test(name) && name !== CACHE_DB_NAME) {
        indexedDB.deleteDatabase(name);
        log.debug(`swept stale cache DB ${name}`);
      }
    }
  } catch (err) {
    log.debug("cache DB sweep skipped", err);
  }
}

/**
 * Open (once) the versioned cache database, creating the stores + indexes. On a
 * FAILED open the memo is cleared so the next call retries (Phase 4.1 item 5 — a
 * memoized rejection would otherwise disable caching for the whole event-page
 * lifetime after one transient fault). On a successful open, stale-version DBs
 * are swept in the background (item 8).
 */
function getDb(): Promise<IDBPDatabase<CacheDb>> {
  if (!dbPromise) {
    const opening = openDB<CacheDb>(CACHE_DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore(CACHE_STORE, { keyPath: "key" });
        // Index origin for O(site) per-site clear; lastAccess for eviction scans.
        store.createIndex("origin", "origin");
        store.createIndex("lastAccess", "lastAccess");
        // Out-of-line keyed meta store (the byte total lives under TOTAL_BYTES_KEY).
        db.createObjectStore(META_STORE);
      },
    });
    dbPromise = opening;
    opening.then(
      () => void sweepOldCacheDatabases(),
      // Guard the reset so a newer attempt isn't clobbered. Callers already
      // catch, so attaching this handler also avoids an unhandled rejection.
      () => {
        if (dbPromise === opening) dbPromise = undefined;
      },
    );
  }
  return dbPromise;
}

/** Read the running byte total (0 when unset). */
async function readTotalBytes(db: IDBPDatabase<CacheDb>): Promise<number> {
  return (await db.get(META_STORE, TOTAL_BYTES_KEY)) ?? 0;
}

/**
 * Look up a cache key, returning a classified {@link CacheLookup}. A hit bumps
 * the record's `lastAccess` (fire-and-forget, for LRU recency). Any IndexedDB
 * fault degrades to a `miss` so translation proceeds uncached (rule 6).
 *
 * @param key composite key from {@link buildCacheKey}.
 * @param now epoch ms (injectable for tests).
 */
export async function cacheLookup(
  key: string,
  now: number = Date.now(),
): Promise<CacheLookup> {
  try {
    const db = await getDb();
    const record = await db.get(CACHE_STORE, key);
    const result = classifyCacheLookup(record, now);
    if (result.status === "hit" && record) {
      // Touch recency without blocking the read path (bytes unchanged → total
      // is unaffected, so no meta update is needed here).
      void db
        .put(CACHE_STORE, { ...record, lastAccess: now })
        .catch((err) => log.debug("lastAccess bump failed", err));
    } else if (result.status === "expired" && record) {
      // WHY delete now: the dead negative entry would otherwise linger until an
      // eviction pass. Fire-and-forget so the read path isn't blocked (item 9).
      void deleteEntry(db, record).catch((err) =>
        log.debug("expired cleanup failed", err),
      );
    }
    return result;
  } catch (err) {
    log.warn("cacheLookup failed, treating as miss", err);
    return { status: "miss" };
  }
}

/**
 * Delete one record and decrement the running byte total in a single
 * transaction, so the {@link META_STORE} total never drifts from the store.
 */
async function deleteEntry(
  db: IDBPDatabase<CacheDb>,
  record: CacheRecord,
): Promise<void> {
  const tx = db.transaction([CACHE_STORE, META_STORE], "readwrite");
  await tx.objectStore(CACHE_STORE).delete(record.key);
  const meta = tx.objectStore(META_STORE);
  const prev = (await meta.get(TOTAL_BYTES_KEY)) ?? 0;
  await meta.put(Math.max(0, prev - record.bytes), TOTAL_BYTES_KEY);
  await tx.done;
}

/**
 * Store a successful translation and then evict down to the size cap. Fail-soft:
 * a write error is logged and swallowed (the translation is already in hand).
 *
 * @param key composite key from {@link buildCacheKey}.
 * @param page the translation to cache.
 * @param capBytes the store byte budget (`Settings.cacheCapMb` × 2²⁰).
 * @param origin hostname the image was translated for (per-site clear), if known.
 */
export async function cacheStorePage(
  key: string,
  page: PageTranslation,
  capBytes: number,
  origin?: string,
): Promise<void> {
  try {
    const now = Date.now();
    const record: CacheRecord = {
      key,
      imageHash: page.imageHash,
      page,
      bytes: estimatePageBytes(page),
      origin,
      createdAt: now,
      lastAccess: now,
    };
    const db = await getDb();
    await putRecordTrackingTotal(db, record);
    await evictToCap(capBytes);
  } catch (err) {
    log.warn("cacheStorePage failed", err);
  }
}

/**
 * Put a record and update the running byte total in one transaction, accounting
 * for the bytes of any record it overwrites so the total stays exact (item 6).
 */
async function putRecordTrackingTotal(
  db: IDBPDatabase<CacheDb>,
  record: CacheRecord,
): Promise<void> {
  const tx = db.transaction([CACHE_STORE, META_STORE], "readwrite");
  const store = tx.objectStore(CACHE_STORE);
  const existing = await store.get(record.key);
  await store.put(record);
  const meta = tx.objectStore(META_STORE);
  const prev = (await meta.get(TOTAL_BYTES_KEY)) ?? 0;
  await meta.put(totalAfterPut(prev, existing?.bytes ?? 0, record.bytes), TOTAL_BYTES_KEY);
  await tx.done;
}

/**
 * Store a negative (failed-translation) entry with a {@link NEGATIVE_TTL_MS}
 * expiry, so an immediate re-request short-circuits instead of re-hitting a
 * provider that will fail again. Only call for kinds where
 * {@link shouldNegativeCache} is true.
 *
 * @param key composite key from {@link buildCacheKey}.
 * @param imageHash the page digest (for reference).
 * @param errorKind the deterministic failure kind.
 * @param message the failure message to re-surface.
 * @param origin hostname the image was translated for, if known.
 */
export async function cacheStoreNegative(
  key: string,
  imageHash: string,
  errorKind: ProviderErrorKind,
  message: string,
  origin?: string,
): Promise<void> {
  try {
    const now = Date.now();
    const record: CacheRecord = {
      key,
      imageHash,
      page: null,
      errorKind,
      message,
      bytes: estimatePageBytes(null),
      origin,
      createdAt: now,
      lastAccess: now,
      expiresAt: now + NEGATIVE_TTL_MS,
    };
    const db = await getDb();
    await putRecordTrackingTotal(db, record);
  } catch (err) {
    log.warn("cacheStoreNegative failed", err);
  }
}

/**
 * Bring the store under `capBytes` (LRU). Reads the running byte total first, so
 * the common "still under cap" case is O(1) — no store scan (Phase 4.1 item 6,
 * the fix for deserializing the whole store on every write). Only when over cap
 * does it walk the `lastAccess` index oldest-first with a cursor, deleting until
 * it fits and decrementing the total as it goes. Mirrors {@link planLruEviction}.
 * Fail-soft.
 *
 * @param capBytes the store byte budget.
 */
export async function evictToCap(capBytes: number): Promise<void> {
  try {
    const db = await getDb();
    // O(1) common case — no scan, and no readwrite lock taken while under cap.
    if ((await readTotalBytes(db)) <= capBytes) return;

    const tx = db.transaction([CACHE_STORE, META_STORE], "readwrite");
    // WHY re-read inside the tx: the pre-check above ran in its own transaction,
    // so a concurrent put/delete (stores are fire-and-forget at concurrency 6)
    // could land between it and this one; the absolute total written back below
    // would clobber that update. Reading as part of this readwrite tx makes the
    // read + cursor walk + write-back atomic against the other total-tracking txs.
    let total: number =
      (await tx.objectStore(META_STORE).get(TOTAL_BYTES_KEY)) ?? 0;
    // Ascending lastAccess = least-recently-accessed first.
    let cursor = await tx.objectStore(CACHE_STORE).index("lastAccess").openCursor();
    let evicted = 0;
    while (cursor && total > capBytes) {
      total -= cursor.value.bytes;
      await cursor.delete();
      evicted++;
      cursor = await cursor.continue();
    }
    await tx.objectStore(META_STORE).put(Math.max(0, total), TOTAL_BYTES_KEY);
    await tx.done;
    if (evicted) {
      log.debug(`evicted ${evicted} cache entr${evicted === 1 ? "y" : "ies"}`);
    }
  } catch (err) {
    log.warn("evictToCap failed", err);
  }
}

/**
 * Delete every cache entry recorded against a hostname (F15 "clear cache for
 * this site" / per-site rules). Fail-soft.
 *
 * @param hostname bare hostname to purge.
 * @returns the number of entries deleted (0 on error).
 */
export async function clearCacheForSite(hostname: string): Promise<number> {
  try {
    const db = await getDb();
    const records = await db.getAllFromIndex(CACHE_STORE, "origin", hostname);
    if (!records.length) return 0;
    const tx = db.transaction([CACHE_STORE, META_STORE], "readwrite");
    const store = tx.objectStore(CACHE_STORE);
    let removed = 0;
    for (const record of records) {
      await store.delete(record.key);
      removed += record.bytes;
    }
    const meta = tx.objectStore(META_STORE);
    const prev = (await meta.get(TOTAL_BYTES_KEY)) ?? 0;
    await meta.put(Math.max(0, prev - removed), TOTAL_BYTES_KEY);
    await tx.done;
    return records.length;
  } catch (err) {
    log.warn("clearCacheForSite failed", err);
    return 0;
  }
}

/** Totals for the options page cache panel (Phase 6). */
export interface CacheStats {
  /** Number of cached entries (positive + negative). */
  entries: number;
  /** Estimated bytes used (the running {@link TOTAL_BYTES_KEY} total). */
  bytes: number;
}

/**
 * Read the cache totals for display (options page). Fail-soft to zeros — a
 * cache fault must never break the settings page. Safe to call from the
 * options context directly: extension pages share the background's origin, so
 * it's the same IndexedDB, and reads don't contend with the write paths.
 */
export async function getCacheStats(): Promise<CacheStats> {
  try {
    const db = await getDb();
    const tx = db.transaction([CACHE_STORE, META_STORE], "readonly");
    const entries = await tx.objectStore(CACHE_STORE).count();
    const bytes =
      (await tx.objectStore(META_STORE).get(TOTAL_BYTES_KEY)) ?? 0;
    await tx.done;
    return { entries, bytes };
  } catch (err) {
    log.warn("getCacheStats failed", err);
    return { entries: 0, bytes: 0 };
  }
}

/**
 * Count how many cache entries are recorded against a hostname, via the `origin`
 * index (Phase 7.6 hydrate gate). O(log n) — `IDBIndex.count`, no `getAll`, no
 * deserialization. Fail-soft to 0 (a cache fault must degrade to "not hydrated",
 * never break the page). Counts positive + negative entries alike; a non-zero
 * count is only a "worth probing" signal, not an exact translated-page tally.
 *
 * @param hostname bare hostname to count.
 * @returns the number of entries (0 on error / no entries).
 */
export async function countCacheForOrigin(hostname: string): Promise<number> {
  try {
    const db = await getDb();
    return await db.countFromIndex(CACHE_STORE, "origin", hostname);
  } catch (err) {
    log.warn("countCacheForOrigin failed", err);
    return 0;
  }
}

/** Wipe the entire translation cache (options page "clear cache"). Fail-soft. */
export async function clearAllCache(): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([CACHE_STORE, META_STORE], "readwrite");
    await tx.objectStore(CACHE_STORE).clear();
    await tx.objectStore(META_STORE).put(0, TOTAL_BYTES_KEY);
    await tx.done;
  } catch (err) {
    log.warn("clearAllCache failed", err);
  }
}

/** Reset the memoized DB handle — test seam only; no production caller. */
export function resetCacheDbForTest(): void {
  dbPromise = undefined;
}
