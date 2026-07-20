/**
 * Background translate orchestration + message handler: the fetch → cache → prep
 * → provider → merge path. Wires the `translatePage` message to a real
 * translation of one on-page image, now cache-first and concurrency-limited
 * (Phase 4).
 *
 * Split like `imagePrep.ts`:
 *  - {@link mergeTilePages} is PURE (concat + dedupe overlapping tiles, §7.4) and
 *    unit-tested.
 *  - {@link translateImage} is the thin, browser-only driver (calls
 *    `prepareImage`, which needs OffscreenCanvas, and the IndexedDB cache) — kept
 *    minimal, untested for the same env reason `prepareImage` is; every
 *    non-obvious decision it makes is delegated to a tested pure helper
 *    (`buildCacheKey`, `classifyCacheLookup`, `shouldNegativeCache`, the queue).
 *
 * Phase 4 wiring (was deferred out of Phases 2/3):
 *  - Cache-first: hash the fetched bytes, look up the composite key; a hit skips
 *    the provider entirely (§7.5 "cache hits render in <50 ms"). A live negative
 *    entry re-surfaces the cached failure instead of re-hitting the provider.
 *  - A single module-level {@link PriorityQueue} enforces the global concurrency
 *    cap (`settings.concurrency`) with viewport-priority ordering; only cache
 *    MISSES enter it, so cache hits never wait behind a full queue.
 *  - Successful pages are cached and their token usage recorded (F17); a
 *    deterministic failure (`malformed`/`refusal`) is negatively cached.
 */
import { PROMPT_VERSION } from "../shared/constants";
import { createLogger } from "../shared/log";
import type { MessageHandlers, TranslatePageResult } from "../shared/messages";
import {
  deriveProviderSettings,
  loadSettings,
  type Settings,
} from "../shared/settings";
import type {
  PageTranslation,
  ProviderSettings,
  TranslateJob,
} from "../shared/types";
import type browser from "webextension-polyfill";
import {
  buildCacheKey,
  cacheLookup,
  cacheStoreNegative,
  cacheStorePage,
  classifyResnap,
  countCacheForOrigin,
  shouldNegativeCache,
} from "./cache";
import { snapPageRegions, SNAP_VERSION } from "./bubbleSnap";
import { coalesce } from "./coalesce";
import { createSharedAbort, type SharedAbort } from "./sharedAbort";
import { isAbortError } from "../shared/guards";
import { recordUsage, usageFromPage } from "./costTracker";
import { ImageFetchError, fetchImageBytes } from "./imageFetcher";
import { sha256Hex } from "./hash";
import { dedupeRegions, prepareImage, type PreparedImage } from "./imagePrep";
import { PriorityQueue } from "./queue";
import { ProviderError } from "./providers/ProviderBase";
import { createProvider, resolveEffectiveModel } from "./providers/factory";
import { createRateGate, type RateGate } from "./rateGate";
import {
  BATCH_LINGER_MS,
  BATCH_MIN_PRIORITY,
  batchEligible,
  batchSignature,
  classifyBatchFailure,
  clampBatchSize,
  createBatchCollector,
  type BatchCollector,
  type BatchJob,
} from "./batch";

const log = createLogger("translate");

/**
 * Sentinel thrown by {@link translateImage} when a `cacheOnly` probe (Phase 7.6
 * hydrate) finds no live cache entry. Module-local: {@link errorToTranslateResult}
 * maps it to the `not-cached` {@link TranslatePageResult} arm — it is NOT a
 * {@link ProviderError} and never reaches negative-cache policy or an error badge.
 * Unreachable for a non-`cacheOnly` request.
 */
class NotCachedError extends Error {
  constructor() {
    super("not cached");
    this.name = "NotCachedError";
  }
}

/**
 * The one process-wide translation queue. Lazily created (an event page may be
 * torn down and re-created; gap #8 — in-flight jobs are re-requested, not
 * persisted) and re-tuned to the current concurrency on every request.
 */
let translationQueue: PriorityQueue | undefined;

/**
 * Get/create the shared queue, syncing its concurrency to current settings.
 * Exported so region translation (regionHandlers.ts) shares the SAME global
 * concurrency cap as page translation — a burst of drag-selects can't blow past
 * the in-flight limit that page requests respect.
 */
export function getTranslationQueue(concurrency: number): PriorityQueue {
  if (!translationQueue) {
    // maxRetries: 0 — the provider layer owns rate-limit backoff; retrying here
    // would double it. The queue's job is concurrency + priority, not backoff.
    translationQueue = new PriorityQueue({ concurrency });
  } else {
    translationQueue.setConcurrency(concurrency);
  }
  return translationQueue;
}

/** Reset the shared queue — test seam only; no production caller. */
export function resetTranslationQueueForTest(): void {
  translationQueue = undefined;
}

/**
 * The one process-wide rate-limit cooldown gate (Phase 7.2 item 3). Shared by
 * page AND region translation so an exhausted key brakes the whole pipeline, not
 * per-job. Lazily created (event-page lifetime; a cooldown is transient state we
 * don't persist).
 */
let rateGate: RateGate | undefined;

/** Get/create the shared rate gate. */
export function getRateGate(): RateGate {
  if (!rateGate) rateGate = createRateGate();
  return rateGate;
}

/** Reset the shared rate gate — test seam only; no production caller. */
export function resetRateGateForTest(): void {
  rateGate = undefined;
}

/**
 * One batch member's payload (translateHandlers-local; {@link BatchCollector} is
 * generic over it). Carries everything the group task needs to prep + translate +
 * settle this member.
 */
interface BatchMemberPayload {
  /** The member's composite cache key (§2 re-prioritization lookup + cache anchor). */
  cacheKey: string;
  pageHash: string;
  blob: Blob;
  settings: Settings;
  providerSettings: ProviderSettings;
  signal: AbortSignal;
  onStarted?: () => void;
}

/**
 * Phase 9.1 §3: a completed translation carries BOTH the snapped `page` (served +
 * cached as `CacheRecord.page`) and the pre-snap merged provider regions
 * (`rawPage`, cached as `CacheRecord.rawPage`), so a later snap-logic change
 * replays LOCALLY at hit time for zero provider spend (see {@link classifyResnap}).
 */
interface SnapPair {
  page: PageTranslation;
  rawPage: PageTranslation;
}

/** A {@link SnapPair} plus the solo path's tile count (usage `images`, F17). */
interface TranslateOutcome extends SnapPair {
  providerCalls: number;
}

/**
 * The one process-wide batch collector (F12). Lazily created (event-page
 * lifetime; a partial group is dropped on unload — gap #8, content re-requests).
 * Groups eligible priority-2 cache-miss jobs by signature and flushes each to
 * {@link executeBatchGroup}.
 */
let batchCollector: BatchCollector<BatchMemberPayload, SnapPair> | undefined;

/** Get/create the shared batch collector. */
function getBatchCollector(): BatchCollector<BatchMemberPayload, SnapPair> {
  if (!batchCollector) {
    batchCollector = createBatchCollector<BatchMemberPayload, SnapPair>({
      lingerMs: BATCH_LINGER_MS,
      runGroup: (jobs) => executeBatchGroup(jobs),
    });
  }
  return batchCollector;
}

/** Reset the shared batch collector — test seam only; no production caller. */
export function resetBatchCollectorForTest(): void {
  batchCollector = undefined;
}

/**
 * requestId → cacheKey for in-flight MISS jobs (Phase 8 §2 re-prioritization).
 * Registered when a miss enters {@link translateImage} with a requestId, cleaned
 * in its `finally`. Bridges a content `reprioritizeTranslation(requestId, …)` to
 * the queued job / batch member for that image (many requestIds can share one
 * cacheKey when coalesced — they upgrade the same job). Not persisted (gap #8).
 */
const requestIdToCacheKey = new Map<string, string>();

/**
 * cacheKey → the queue handle of its in-flight job, so `reprioritizeTranslation`
 * can lift a still-queued job (Phase 8 §2). For a solo miss it is the page's own
 * job; for a flushed batch it is the group's ONE handle, registered under EVERY
 * member's cacheKey (lifting the whole batch when one member becomes visible is
 * accepted). Deleted on settle.
 */
const queuedHandles = new Map<string, { setPriority(priority: number): boolean }>();

/**
 * requestId → the priority of a `reprioritizeTranslation` that arrived BEFORE its
 * {@link translateImage} registered a `requestId → cacheKey` mapping (Phase 8.1
 * §5). A prefetched page's background fetch + hash can take seconds; an upgrade
 * landing in that window used to be a silent no-op — and because the content side
 * already stamped the better `sentPriority` and IntersectionObserver fires only on
 * transitions, it was never re-sent, so the page stayed at priority 2 behind the
 * whole backlog: the exact symptom §2 exists to fix, recurring in a timing window.
 * The miss path drains this the moment it registers its mapping. Bounded (oldest
 * evicted, {@link MAX_PENDING_REPRIORITIZE}) because a requestId that cache-hits or
 * is cancelled before the miss never drains; drained/settled entries are deleted.
 */
const pendingReprioritize = new Map<string, number>();

/** Cap on buffered pre-registration upgrades (§5); the oldest is evicted past it. */
export const MAX_PENDING_REPRIORITIZE = 500;

/** Reset the §2/§5 re-prioritization registries — test seam only; no production caller. */
export function resetReprioritizeForTest(): void {
  requestIdToCacheKey.clear();
  queuedHandles.clear();
  pendingReprioritize.clear();
}

/** Buffered pre-registration upgrade count — test seam only (asserts the cap holds). */
export function pendingReprioritizeSizeForTest(): number {
  return pendingReprioritize.size;
}

/**
 * Buffer an upgrade that arrived before its miss registered (§5). Keeps the more
 * urgent priority (min — never worsen) and re-inserts so the entry counts as
 * freshly used, then evicts the oldest while over {@link MAX_PENDING_REPRIORITIZE}
 * (a `Map` preserves insertion order, so the first key is the oldest).
 */
function bufferPendingReprioritize(requestId: string, priority: number): void {
  const existing = pendingReprioritize.get(requestId);
  pendingReprioritize.delete(requestId);
  pendingReprioritize.set(
    requestId,
    existing === undefined ? priority : Math.min(existing, priority),
  );
  while (pendingReprioritize.size > MAX_PENDING_REPRIORITIZE) {
    const oldest = pendingReprioritize.keys().next().value;
    if (oldest === undefined) break;
    pendingReprioritize.delete(oldest);
  }
}

/**
 * Apply an upgrade to the in-flight job for `cacheKey` (§2/§5). A member still
 * buffered in the batch collector is pulled out and run SOLO at `priority` (don't
 * drag its batch-mates up); a queued solo job / flushed batch is lifted via
 * `setPriority` (min() never worsens). A running/settled job has no handle → no-op.
 */
function applyReprioritize(cacheKey: string, priority: number): void {
  const pulled = batchCollector?.remove((p) => p.cacheKey === cacheKey);
  if (pulled) {
    runPulledMemberSolo(pulled, priority);
    return;
  }
  queuedHandles.get(cacheKey)?.setPriority(priority);
}

/**
 * Run one provider call gated by the global cooldown (Phase 7.2 item 3): wait out
 * any active cooldown, make the call, then feed the outcome back to the gate — a
 * `rate-limit` {@link ProviderError} reports (starting/extending the cooldown),
 * any success clears it. The wait lives INSIDE the concurrency slot on purpose:
 * sleeping occupies a lane, so during a cooldown at most `concurrency` jobs idle
 * and ZERO new HTTP fires — the queue self-paces to the provider's rate.
 *
 * Extracted (rather than inlined at each call site) so the gate wiring is
 * unit-testable without OffscreenCanvas (the tile fan-out that calls it needs
 * `prepareImage`). Pure w.r.t. its injected `gate`/`call`.
 *
 * @param gate the shared rate gate.
 * @param signal abort signal (rejects the wait promptly if it fires).
 * @param call the actual provider request.
 */
export async function callWithRateGate<T>(
  gate: RateGate,
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  await gate.waitUntilClear(signal);
  try {
    const result = await call();
    gate.clear();
    return result;
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "rate-limit") {
      gate.report(err.retryAfterMs);
    }
    throw err;
  }
}

/**
 * In-flight translations keyed by cache key, so concurrent requests for the same
 * image (scanner + prefetch overlap, duplicate scroll events, two tabs on one
 * chapter) share ONE provider run instead of each paying it (F13 "never
 * translate the same image twice"). See {@link coalesce}.
 */
const inflightTranslations = new Map<string, Promise<PageTranslation>>();

/** Reset the in-flight coalescing map — test seam only; no production caller. */
export function resetInflightForTest(): void {
  inflightTranslations.clear();
}

/**
 * Shared abort contexts keyed by cache key, parallel to
 * {@link inflightTranslations}. Each coalesced run has ONE {@link SharedAbort}
 * so per-request cancellation is refcounted: the underlying provider call is
 * aborted only when every coalesced waiter has aborted (Phase 5 item 4).
 */
const sharedAborts = new Map<string, SharedAbort>();

/** Reset the shared-abort map — test seam only; no production caller. */
export function resetSharedAbortsForTest(): void {
  sharedAborts.clear();
}

/** Current shared-abort map size — test seam only (asserts cleanup ran, item 3). */
export function sharedAbortsSizeForTest(): number {
  return sharedAborts.size;
}

/**
 * In-flight `translatePage` requests keyed by their content-generated
 * `requestId`, so a later `cancelTranslation` can abort the exact request the
 * content side gave up on (teardown, element removal, `src` swap). Module-level
 * because the event page has no other place to hold it (gap #8: not persisted —
 * an event-page death drops these, which is fine, the request died with it).
 */
const requestControllers = new Map<string, AbortController>();

/**
 * requestIds whose provider call has actually STARTED (left the priority queue's
 * wait list), parallel to {@link requestControllers} (Phase 7.4 pause). The pause
 * feature only cancels queued-but-not-started jobs; an id in here is past the
 * "started" boundary and {@link MessageHandlers.cancelQueuedTranslations} skips
 * it. Cleared in the same `finally` that clears its controller.
 */
const startedRequests = new Set<string>();

/** Reset the request-controller registry — test seam only; no production caller. */
export function resetRequestControllersForTest(): void {
  requestControllers.clear();
  startedRequests.clear();
}

/** Whether a requestId has reached the "started" boundary — test seam only. */
export function startedRequestsHasForTest(requestId: string): boolean {
  return startedRequests.has(requestId);
}

/**
 * Register an {@link AbortController} under a `requestId` so a later
 * {@link MessageHandlers.cancelTranslation} aborts it. Exported so region
 * requests (regionHandlers.ts) share the SAME registry — the existing
 * `cancelTranslation` message then covers drag-select regions too (Phase 7
 * item 3), with no second cancellation path.
 */
export function registerRequestController(
  requestId: string,
  controller: AbortController,
): void {
  requestControllers.set(requestId, controller);
}

/** Remove a request's controller from the shared registry (in the handler's finally). */
export function unregisterRequestController(requestId: string): void {
  requestControllers.delete(requestId);
}

/**
 * Merge the per-tile {@link PageTranslation}s of one image into a single page
 * (§7.4). Regions arrive already remapped to full-image space by the provider,
 * so this concatenates them and dedupes the duplicates that appear in adjacent
 * tiles' overlap zones (IoU-based, keep higher confidence).
 *
 * @param pages tile results in top-to-bottom order (never empty).
 * @param imageHash the page-level cache key to stamp on the merged result.
 * @returns one PageTranslation for the whole image.
 */
export function mergeTilePages(
  pages: readonly PageTranslation[],
  imageHash: string,
): PageTranslation {
  const first = pages[0];
  if (!first) {
    throw new Error("mergeTilePages requires at least one page");
  }
  if (pages.length === 1) {
    return { ...first, imageHash };
  }

  const regions = dedupeRegions(pages.flatMap((p) => p.regions));
  // First tile that actually detected a language wins; "und" means "no text".
  const sourceLang =
    pages.find((p) => p.sourceLang && p.sourceLang !== "und")?.sourceLang ??
    first.sourceLang;
  const tokensIn = sumDefined(pages.map((p) => p.tokensIn));
  const tokensOut = sumDefined(pages.map((p) => p.tokensOut));

  return {
    imageHash,
    sourceLang,
    targetLang: first.targetLang,
    regions,
    model: first.model,
    provider: first.provider,
    tokensIn,
    tokensOut,
    createdAt: Date.now(),
  };
}

/** Sum an array of maybe-undefined counts; undefined when none were reported. */
function sumDefined(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
}

/** Floor for the cache byte cap: a corrupt/zero `cacheCapMb` must not make every
 *  store evict the whole cache. WHY 1 MB: small enough to never surprise a user
 *  who really wants a tiny cache, large enough to keep caching useful. */
const MIN_CACHE_CAP_BYTES = 1024 * 1024;

/** MB → bytes for the cache size cap, clamped to a sane floor (item 11). */
function cacheCapBytes(settings: Settings): number {
  return Math.max(MIN_CACHE_CAP_BYTES, settings.cacheCapMb * 1024 * 1024);
}

/**
 * Prep + translate + merge one already-fetched image (the cache-MISS body of
 * {@link translateImage}). Kept separate so the whole of it — not the fetch or
 * cache lookup — is what runs *inside* the concurrency queue.
 *
 * @param blob the original downloaded image bytes.
 * @param pageHash SHA-256 of `blob` (the page identity / cache anchor).
 * @param settings full settings (prep dimensions).
 * @param providerSettings the provider slice.
 * @param signal merged abort signal from the queue.
 * @returns the merged page plus `providerCalls`, the number of tiles = provider
 *   image requests made (1 for a normal page, N for a tiled webtoon strip), so
 *   the cost tracker's `images` count is accurate (F17, item 2).
 */
async function translatePrepared(
  blob: Blob,
  pageHash: string,
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<TranslateOutcome> {
  const prepared = await prepareImage(blob, {
    maxEdgePx: settings.maxImageEdgePx,
    jpegQuality: settings.jpegQuality,
  });
  return translateTiles(prepared, blob, pageHash, providerSettings, signal);
}

/**
 * Translate an ALREADY-prepped image's tiles (the provider + merge + snap portion
 * of {@link translatePrepared}). Split out so the batch collector can reuse it for
 * a member it has already prepped — a multi-tile page diverted out of a batch, or
 * a single-tile member on a split-retry — without re-prepping.
 *
 * @param prepared the {@link prepareImage} output (1 tile for a normal page, N for
 *   a webtoon strip).
 * @param blob the ORIGINAL full-image bytes (for the snap pass + hash anchor).
 * @param pageHash SHA-256 of `blob` (stamped as the merged page's `imageHash`).
 */
async function translateTiles(
  prepared: PreparedImage,
  blob: Blob,
  pageHash: string,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<TranslateOutcome> {
  const provider = createProvider(providerSettings);
  const gate = getRateGate();
  // WHY parallel: tiles of one strip are independent requests, and §7.5's
  // latency target dies on a 10-tile strip translated serially. The global
  // concurrency cap (settings.concurrency) is enforced by the queue one level up;
  // the rate gate (callWithRateGate) is the single choke point per HTTP request —
  // during a cooldown these awaits idle inside their queue slot and fire nothing.
  const tilePages: PageTranslation[] = await Promise.all(
    prepared.tiles.map(async (tile): Promise<PageTranslation> => {
      const imageHash = await sha256Hex(tile.blob);
      const job: TranslateJob = {
        imageHash,
        imageBlob: tile.blob,
        tileOffset: prepared.tiled ? tile.offset : undefined,
        targetLang: providerSettings.targetLang,
        sourceLangHint: providerSettings.sourceLangHint,
        priority: 0,
      };
      return callWithRateGate(gate, signal, () =>
        provider.translatePage(job, providerSettings, signal),
      );
    }),
  );

  const merged = mergeTilePages(tilePages, pageHash);
  // Bubble snap (Phase 7.5): refine bubble/thought boxes against the ORIGINAL
  // full-image bytes BEFORE caching, so hits replay the tight geometry for free.
  // Fail-soft (never throws): a decode fault returns `merged` unchanged. Runs
  // inside the queue slot — decode + fill at ≤512px is ms-scale next to a provider
  // round trip. WHY cache the snapped boxes (unlike the render-time trimOverlaps):
  // snap is a deterministic function of (bytes, provider box), so caching it is
  // memoization, not a lie about what the provider said.
  const snapped = await snapPageRegions(blob, merged);
  log.debug(
    `translated: ${snapped.regions.length} regions from ${prepared.tiles.length} tile(s)`,
  );
  // §3: keep `merged` (the pre-snap provider regions) as `rawPage` so a future
  // SNAP_VERSION bump replays the snap locally with no re-fetch/re-translate.
  return { page: snapped, rawPage: merged, providerCalls: prepared.tiles.length };
}

// --- Multi-page batch execution (F12, PROMPTS §4.2) -------------------------

/** A single-tile batch member paired with its already-prepped image. */
interface PreppedSingle {
  job: BatchJob<BatchMemberPayload, SnapPair>;
  prepared: PreparedImage;
}

/**
 * Execute one flushed batch group (the collector's injected `runGroup`). Enqueues
 * ONE priority-2 queue task carrying all members — so a batch = one queue slot =
 * one provider request (§4.2). The task preps each member, diverts any that prep
 * multi-tile to the per-tile path, and runs one `translateBatch` on the rest.
 * Never throws: it settles every member's promise itself. The `.catch` handles
 * only a queue-level PRE-RUN abort (the task never ran → members unsettled).
 */
function executeBatchGroup(jobs: BatchJob<BatchMemberPayload, SnapPair>[]): void {
  if (jobs.length === 0) return;
  // Members share settings by signature construction — use the first for the
  // group's concurrency, prep dims, and provider.
  const settings = jobs[0]!.payload.settings;
  const providerSettings = jobs[0]!.payload.providerSettings;

  // Combined abort: the batch aborts only when EVERY member has aborted. A single
  // member aborting stays in the batch — its result is nearly free and still
  // cached (same semantics as a coalesce follower). SharedAbort refcounts this.
  const shared = createSharedAbort();
  const stops = jobs.map((j) => shared.addWaiter(j.payload.signal));

  const queue = getTranslationQueue(settings.concurrency);
  const handle = queue.addJob(
    (qSignal) => runBatchGroupTask(jobs, settings, providerSettings, qSignal),
    BATCH_MIN_PRIORITY,
    shared.signal,
  );
  // Register the ONE batch handle under every member's cacheKey so a
  // reprioritizeTranslation for any member lifts the whole batch (§2, accepted).
  for (const j of jobs) queuedHandles.set(j.payload.cacheKey, handle);
  handle.promise
    .catch((err: unknown) => {
      // Queue-level pre-run abort: the task never ran, so no member was settled —
      // reject them all. (A member the task already settled is a fixed promise;
      // this reject is then a no-op.)
      for (const j of jobs) j.reject(err);
    })
    .finally(() => {
      shared.settle();
      for (const stop of stops) stop();
      for (const j of jobs) {
        if (queuedHandles.get(j.payload.cacheKey) === handle) {
          queuedHandles.delete(j.payload.cacheKey);
        }
      }
    });
}

/**
 * Run a member PULLED out of the batch collector (§2 re-prioritization) SOLO at
 * the new priority — don't drag its batch-mates up. Records its own usage (the
 * batch task won't) and settles the member's original promise, so its
 * {@link runTranslateMiss} caller caches it exactly as if it had never batched.
 */
function runPulledMemberSolo(
  job: BatchJob<BatchMemberPayload, SnapPair>,
  priority: number,
): void {
  const { blob, pageHash, settings, providerSettings, signal, onStarted, cacheKey } = job.payload;
  const queue = getTranslationQueue(settings.concurrency);
  const handle = queue.addJob(
    (qSignal) => {
      onStarted?.();
      return translatePrepared(blob, pageHash, settings, providerSettings, qSignal);
    },
    priority,
    signal,
  );
  queuedHandles.set(cacheKey, handle); // a further reprioritize can still upgrade it
  void handle.promise
    .then(
      (result) => {
        void recordUsage(usageFromPage(result.page, result.providerCalls));
        job.resolve({ page: result.page, rawPage: result.rawPage }); // §3
      },
      (err: unknown) => job.reject(err),
    )
    .finally(() => {
      if (queuedHandles.get(cacheKey) === handle) queuedHandles.delete(cacheKey);
    });
}

/**
 * The batch queue task body: mark every member started, prep each, partition into
 * single-tile (one batch call) vs multi-tile (per-tile divert), and run both to
 * completion INSIDE this one queue slot. Never throws (each member settles itself).
 */
async function runBatchGroupTask(
  jobs: BatchJob<BatchMemberPayload, SnapPair>[],
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<void> {
  // The task just left the queue's wait list — mark every member "started" (the
  // pause boundary; a whole group crosses it together).
  for (const j of jobs) j.payload.onStarted?.();

  const prepared = await Promise.all(
    jobs.map((j) =>
      prepareImage(j.payload.blob, {
        maxEdgePx: settings.maxImageEdgePx,
        jpegQuality: settings.jpegQuality,
      }).then(
        (p) => ({ ok: true as const, p }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
    ),
  );

  const singles: PreppedSingle[] = [];
  const work: Promise<void>[] = [];
  jobs.forEach((job, i) => {
    const pr = prepared[i]!;
    if (!pr.ok) {
      job.reject(pr.e); // a prep failure fails just this member (same as solo)
      return;
    }
    if (pr.p.tiled && pr.p.tiles.length > 1) {
      // A webtoon strip snuck into a batch — divert to the per-tile path (its own
      // usage; not part of the one batch HTTP call). Awaited so it stays in-slot.
      work.push(translateSoloAndSettle(job, pr.p, providerSettings, signal));
    } else {
      singles.push({ job, prepared: pr.p });
    }
  });

  // WHY a lone single-tile member goes SOLO, never through translateBatch (§4): a
  // batch of one amortizes nothing — it swaps the proven single-page prompt for the
  // batch envelope for zero benefit, and against a provider that returns a
  // single-page body for one image it needlessly trips the malformed → one-repair →
  // split ladder (two wasted extra round trips). This is the 10-page @ batch-3
  // linger-flush of the 10th member. translateBatch itself stays able to take 1 job
  // (unit-tested, harmless); the collector just never sends it one.
  if (singles.length === 1) {
    work.push(
      translateSoloAndSettle(singles[0]!.job, singles[0]!.prepared, providerSettings, signal),
    );
  } else if (singles.length > 1) {
    work.push(runBatchSingles(singles, providerSettings, signal));
  }
  await Promise.all(work);
}

/** Translate ONE already-prepped member solo and settle it (multi-tile divert + split-retry). */
async function translateSoloAndSettle(
  job: BatchJob<BatchMemberPayload, SnapPair>,
  prepared: PreparedImage,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<void> {
  try {
    const { page, rawPage, providerCalls } = await translateTiles(
      prepared,
      job.payload.blob,
      job.payload.pageHash,
      providerSettings,
      signal,
    );
    void recordUsage(usageFromPage(page, providerCalls));
    job.resolve({ page, rawPage }); // §3
  } catch (err) {
    job.reject(err);
  }
}

/**
 * Run ONE `translateBatch` over the single-tile members, then snap + settle each,
 * and record ONE usage event for the whole call (F17). On a failure the pure
 * {@link classifyBatchFailure} decides: `split` → retry each member solo (never
 * re-batch); `fail-all` → reject every member with the error.
 */
async function runBatchSingles(
  singles: PreppedSingle[],
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<void> {
  const provider = createProvider(providerSettings);
  const gate = getRateGate();
  const jobs: TranslateJob[] = singles.map((s) => ({
    // Stamp the ORIGINAL bytes' hash directly (single-tile → no merge/remap).
    imageHash: s.job.payload.pageHash,
    imageBlob: s.prepared.tiles[0]!.blob,
    targetLang: providerSettings.targetLang,
    sourceLangHint: providerSettings.sourceLangHint,
    priority: BATCH_MIN_PRIORITY,
  }));

  let pages: PageTranslation[];
  try {
    pages = await callWithRateGate(gate, signal, () =>
      provider.translateBatch(jobs, providerSettings, signal),
    );
  } catch (err) {
    if (classifyBatchFailure(err) === "split") {
      // Split-retry: translate each member SOLO (never re-batch). Each records its
      // own usage; a member failing solo negative-caches via its runTranslateMiss.
      await Promise.all(
        singles.map((s) => translateSoloAndSettle(s.job, s.prepared, providerSettings, signal)),
      );
    } else {
      // fail-all: a split would just repeat the same error N times.
      for (const s of singles) s.job.reject(err);
    }
    return;
  }

  // Success. Snap each page against its ORIGINAL bytes (single-tile → full-image
  // space already), then settle. finishBatch stamped each page's imageHash with
  // the member's pageHash, so cache anchoring is correct.
  await Promise.all(
    pages.map(async (page, i) => {
      const s = singles[i]!;
      try {
        // §3: `page` is the pre-snap provider result → snap for the served page,
        // keep `page` as rawPage for local re-snap.
        const snapped = await snapPageRegions(s.job.payload.blob, page);
        s.job.resolve({ page: snapped, rawPage: page });
      } catch (err) {
        s.job.reject(err);
      }
    }),
  );
  // ONE usage event for the batch call: exact aggregate (the per-page split sums
  // to the provider total — no double count, no loss), images = member count.
  void recordUsage({
    provider: providerSettings.provider,
    model: resolveEffectiveModel(providerSettings),
    tokensIn: sumTokens(pages, "tokensIn"),
    tokensOut: sumTokens(pages, "tokensOut"),
    images: pages.length,
  });
}

/** Sum a token field across batch pages (undefined → 0) for the one batch usage event. */
function sumTokens(
  pages: readonly PageTranslation[],
  field: "tokensIn" | "tokensOut",
): number {
  return pages.reduce((sum, p) => sum + (p[field] ?? 0), 0);
}

/**
 * Translate one on-page image end to end, cache-first (§7.3/§7.5): fetch its
 * bytes, hash them, and consult the IndexedDB cache. On a hit, return instantly;
 * on a live negative entry, re-surface the cached failure; otherwise run the
 * (prep → provider → merge) work through the shared concurrency queue, then
 * cache the result and record its token usage (F17).
 *
 * Browser-only (via `prepareImage` + IndexedDB). Errors propagate as typed
 * {@link import("./providers/ProviderBase").ProviderError} /
 * {@link import("./imageFetcher").ImageFetchError} for the caller to fail soft.
 *
 * @param imageUrl absolute URL of the on-page image.
 * @param settings full settings (prep dimensions, concurrency, cache cap).
 * @param providerSettings the provider slice (already target-lang-overridden if needed).
 * @param signal abort signal from the caller.
 * @param priority scheduling priority from the request (§7.5); orders the queue.
 * @param origin hostname the image belongs to (F15 per-site cache clear), if known.
 * @param providedBlob content-acquired bytes for a blob-sourced page (Phase 7.2
 *   item 1). When present the fetch is skipped and `imageUrl` is identity/
 *   diagnostics only.
 * @param onStarted invoked (Phase 7.4 pause) the moment this job's provider call
 *   leaves the queue's wait list — the precise "started" boundary. Only the
 *   coalesce LEADER reaches it; a follower never runs the miss body, so it stays
 *   "not started" and is abortable by pause (accepted caveat).
 * @param cacheOnly Phase 7.6 hydrate probe: on a cache MISS/EXPIRED, throw
 *   {@link NotCachedError} WITHOUT touching the coalesce map, SharedAbort
 *   registry, or queue — never enqueue or call the provider. A hit still returns
 *   the page and a live negative still throws its cached error (both are genuine
 *   cached results). `onStarted` is never reached for a probe (it never queues).
 */
export async function translateImage(
  imageUrl: string,
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
  priority = 0,
  origin?: string,
  providedBlob?: Blob,
  onStarted?: () => void,
  cacheOnly = false,
  requestId?: string,
): Promise<PageTranslation> {
  // A blob-sourced page (MangaDex etc.) ships its bytes content-side because the
  // background can't fetch a document-scoped blob URL (§7.3); otherwise fetch
  // reuses the browser's HTTP cache (imageFetcher: force-cache), so a repeat
  // visit is cheap. The page identity is the hash of the ORIGINAL bytes — stable
  // regardless of how many tiles it is later split into.
  //
  // WHY the bytes path needs zero cache/coalesce changes: page identity is the
  // CONTENT HASH, not the URL. `sha256Hex(blob)` → the composite cache key →
  // coalesce/SharedAbort all key on that hash, so two tabs showing the same page
  // under different ephemeral blob URLs coalesce onto one provider run, and a
  // revisit next session cache-hits even though every blob URL is new.
  const blob = providedBlob ?? (await fetchImageBytes(imageUrl, signal)).blob;
  const pageHash = await sha256Hex(blob);
  const cacheKey = buildCacheKey({
    provider: providerSettings.provider,
    imageHash: pageHash,
    targetLang: providerSettings.targetLang,
    // WHY resolveEffectiveModel, not providerSettings.model: the provider runs
    // `settings.model || defaultModel`, so keying on the raw (often empty)
    // string would key under "" while the request used e.g. gemini-2.0-flash —
    // stale entries and needless re-translation (item 3).
    model: resolveEffectiveModel(providerSettings),
    preserveHonorifics: providerSettings.preserveHonorifics,
    readingDirection: providerSettings.readingDirection,
    sourceLangHint: providerSettings.sourceLangHint,
    promptVersion: PROMPT_VERSION,
  });

  const lookup = await cacheLookup(cacheKey);
  if (lookup.status === "hit") {
    // §3: re-snap a stale entry LOCALLY (zero provider spend) when a SNAP_VERSION
    // bump has landed and the entry retained its raw provider regions. Serve +
    // write back the re-snapped page ONCE per page per version (the write-back
    // stamps SNAP_VERSION, so the next hit classifies as up-to-date); any failure
    // serves the stored page as-is (rule 6). Runs on the normal translate path AND
    // the hydrate probe — both fetch/carry the bytes needed for the fill.
    if (classifyResnap(lookup.record, SNAP_VERSION, blob.size > 0) && lookup.record.rawPage) {
      try {
        const resnapped = await snapPageRegions(blob, lookup.record.rawPage);
        void cacheStorePage(
          cacheKey,
          resnapped,
          cacheCapBytes(settings),
          origin ?? lookup.record.origin,
          lookup.record.rawPage,
          SNAP_VERSION,
        );
        log.debug(`re-snapped cache hit for ${imageUrl} (snapVersion → ${SNAP_VERSION})`);
        return resnapped;
      } catch (err) {
        log.debug("re-snap failed; serving cached page as-is", err);
        return lookup.page;
      }
    }
    log.debug(`cache hit for ${imageUrl}`);
    return lookup.page;
  }
  if (lookup.status === "negative") {
    // A recent deterministic failure is cached (PROMPTS §6.5); don't re-hit the
    // provider. Throw the same typed error so it maps to the UI ⚠ the same way.
    // WHY this is right even for a cacheOnly probe: a live negative IS a cached
    // result — within its 10-min TTL the honest answer is the same error badge a
    // real request would show.
    throw new ProviderError(lookup.errorKind, lookup.message);
  }

  // miss / expired. A cacheOnly probe (Phase 7.6 hydrate) stops HERE — it must
  // never enqueue, coalesce, or call the provider. Signalled with a sentinel that
  // maps to the `not-cached` result arm; the coalesce map, SharedAbort registry,
  // and queue below are left completely untouched.
  if (cacheOnly) {
    throw new NotCachedError();
  }

  // §2 re-prioritization: map this request's id → its cacheKey so a later
  // `reprioritizeTranslation` can find the queued job / batch member. Cleaned in
  // the finally. (Coalesced callers all register their own id → the same key.)
  if (requestId) requestIdToCacheKey.set(requestId, cacheKey);

  // Coalesce concurrent misses for the same key onto one provider run (item 7)
  // and refcount the callers' abort signals (Phase 5 item 4): the run owns one
  // SharedAbort; each caller registers its own `signal`; the underlying provider
  // call is aborted only when EVERY caller has aborted, so a follower tab is
  // never cancelled by a leader that scrolled away or toggled off.
  //
  // Leadership is decided synchronously (no await between here and `coalesce`):
  // the first caller for a key creates the SharedAbort and owns its teardown;
  // followers reuse it (it is set before the inflight entry that gates them).
  const leader = !inflightTranslations.has(cacheKey);
  const shared = leader
    ? createSharedAbort()
    : (sharedAborts.get(cacheKey) ?? createSharedAbort());
  if (leader) sharedAborts.set(cacheKey, shared);
  const stopWaiting = shared.addWaiter(signal);

  const run = coalesce(inflightTranslations, cacheKey, () =>
    runTranslateMiss(
      cacheKey,
      pageHash,
      blob,
      settings,
      providerSettings,
      shared.signal,
      priority,
      origin,
      onStarted,
    ),
  );

  // §5: apply any upgrade that raced ahead of this miss's registration. The job is
  // now enqueued — a solo handle is registered under `cacheKey`, or the batch
  // member is buffered/flushed — so the buffered priority can finally land. This
  // runs in the SAME synchronous turn as the `requestIdToCacheKey.set` above (no
  // await between), so a reprioritize arriving LATER instead finds the mapping and
  // applies directly; neither path drops the upgrade. Drain once, then delete.
  if (requestId) {
    const pending = pendingReprioritize.get(requestId);
    if (pending !== undefined) {
      pendingReprioritize.delete(requestId);
      applyReprioritize(cacheKey, pending);
    }
  }

  if (leader) {
    // The leader owns the SharedAbort lifecycle. `coalesce` clears the inflight
    // entry in its own `.finally` first (it is upstream in the chain), so by the
    // time this runs the entry is gone; only delete our own instance in case a
    // fresh run for the same key already replaced it.
    //
    // WHY `.catch(() => {})` after `.finally`: `.finally()` returns a NEW promise
    // that RE-REJECTS whenever `run` rejects. Left un-caught (the old `void`),
    // every failed coalesced run (auth/refusal/network) would surface an
    // `unhandledrejection` in the event page — console noise on every failure
    // path, and an AMO-review flag — even though the real rejection is handled by
    // the `await run` below. Swallow only this derived promise; cleanup still runs
    // on both resolve and reject (item 3).
    run
      .finally(() => {
        shared.settle();
        if (sharedAborts.get(cacheKey) === shared) sharedAborts.delete(cacheKey);
      })
      .catch(() => {});
  }

  try {
    return await run;
  } finally {
    // Detach this caller's abort listener (does not count as leaving — a settled
    // run must not trip the refcount).
    stopWaiting();
    if (requestId) {
      requestIdToCacheKey.delete(requestId);
      // Drop any still-buffered upgrade for this settled id (§5) so it can't leak.
      pendingReprioritize.delete(requestId);
    }
  }
}

/**
 * The cache-MISS body of {@link translateImage}: run the (prep → provider →
 * merge) work through the shared concurrency queue, then cache the result and
 * record its usage — or negatively cache a deterministic failure. Extracted so
 * {@link translateImage} can wrap it in {@link coalesce}.
 */
async function runTranslateMiss(
  cacheKey: string,
  pageHash: string,
  blob: Blob,
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
  priority: number,
  origin?: string,
  onStarted?: () => void,
): Promise<PageTranslation> {
  let page: PageTranslation;
  let rawPage: PageTranslation; // §3: pre-snap regions cached alongside the page
  try {
    if (batchEligible(priority, settings.pagesPerRequest)) {
      // Batch path (F12): group with other eligible priority-2 misses. The group
      // task (executeBatchGroup) fires onStarted, makes ONE provider request via
      // translateBatch, records ONE usage event for the whole call, snaps, and
      // settles each member. We only CACHE the member's own page here (per its own
      // cacheKey) — a batch result caches under the SAME key as the single result.
      const out = await getBatchCollector().submit(
        batchSignature(providerSettings, {
          maxEdgePx: settings.maxImageEdgePx,
          jpegQuality: settings.jpegQuality,
        }),
        clampBatchSize(settings.pagesPerRequest),
        { cacheKey, pageHash, blob, settings, providerSettings, signal, onStarted },
      );
      page = out.page;
      rawPage = out.rawPage;
    } else {
      const queue = getTranslationQueue(settings.concurrency);
      const handle = queue.addJob(
        (qSignal) => {
          // First statement in the task closure: the PriorityQueue invokes this
          // exactly when the job leaves the wait list — the precise "started"
          // boundary the pause feature keys on (Phase 7.4).
          onStarted?.();
          return translatePrepared(blob, pageHash, settings, providerSettings, qSignal);
        },
        priority,
        signal,
      );
      // Register the handle so reprioritizeTranslation can lift this queued job (§2).
      queuedHandles.set(cacheKey, handle);
      let result: TranslateOutcome;
      try {
        result = await handle.promise;
      } finally {
        if (queuedHandles.get(cacheKey) === handle) queuedHandles.delete(cacheKey);
      }
      page = result.page;
      rawPage = result.rawPage;
      // Solo path records its own usage (the batch path records once per batch
      // call). providerCalls (tile count) → accurate `images` for strips (item 2).
      void recordUsage(usageFromPage(result.page, result.providerCalls));
    }
  } catch (err) {
    // Only cache failures that will recur on immediate retry (malformed/refusal);
    // transient faults stay retryable. Fire-and-forget — never block the caller.
    if (err instanceof ProviderError && shouldNegativeCache(err.kind)) {
      void cacheStoreNegative(cacheKey, pageHash, err.kind, err.message, origin);
    }
    throw err;
  }

  // NOTE (accepted, Phase 5.1 item 9): fire-and-forget, and the coalesce entry
  // clears on settle, so a request arriving in the ms-wide window between this
  // run settling and the IndexedDB commit landing re-pays one provider call.
  // Acceptable — the window is tiny and the worst case is a single duplicate.
  // §3: store `rawPage` + SNAP_VERSION so a later snap change re-snaps locally.
  void cacheStorePage(cacheKey, page, cacheCapBytes(settings), origin, rawPage, SNAP_VERSION);
  return page;
}

/** Best-effort hostname of the tab that sent a translate request (per-site cache). */
function originFromSender(
  sender: browser.Runtime.MessageSender | undefined,
): string | undefined {
  const url = sender?.url ?? sender?.tab?.url;
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map any translate-path failure to the wire-safe failure arm of
 * {@link TranslatePageResult}. WHY: typed errors don't survive
 * `runtime.sendMessage` serialization (only the message string does), so the
 * §6 error-kind taxonomy must cross the boundary as data. Pure — unit-tested
 * directly.
 */
export function errorToTranslateResult(err: unknown): TranslatePageResult {
  if (err instanceof NotCachedError) {
    // Phase 7.6 hydrate: a cacheOnly probe missed. NOT a provider error — its own
    // result arm, so `errorKind` never enters ProviderErrorKind (no badge/toast).
    return { ok: false, errorKind: "not-cached" };
  }
  if (err instanceof ProviderError) {
    return { ok: false, errorKind: err.kind, message: err.message };
  }
  if (err instanceof ImageFetchError) {
    // The fetch taxonomy is finer-grained than the provider one; aborted maps
    // 1:1 and everything else is a fetch-stage failure the UI treats alike.
    return {
      ok: false,
      errorKind: err.reason === "aborted" ? "aborted" : "network",
      message: `Image fetch failed (${err.reason}): ${err.message}`,
    };
  }
  // A raw abort (queue-level pre-run cancel, or a DOMException an inner await
  // rethrew) must map to `aborted`, not `unknown`, so the overlay stays silent
  // (handoff item 5: aborted → render nothing). ProviderError('aborted') and
  // ImageFetchError('aborted') are already handled above; this catches the rest.
  if (isAbortError(err)) {
    return { ok: false, errorKind: "aborted", message: "Translation aborted" };
  }
  return {
    ok: false,
    errorKind: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** The translate slice of the background message router. */
export function createTranslateHandlers(): MessageHandlers {
  return {
    translatePage: async (req, sender) => {
      // A fresh controller gives the provider an AbortSignal; the queue merges
      // it with its own so a queue-wide abort still cancels this job. Registered
      // under the request's id so `cancelTranslation` can abort it (item 4).
      const controller = new AbortController();
      if (req.requestId) requestControllers.set(req.requestId, controller);
      try {
        const settings = await loadSettings();
        const providerSettings = deriveProviderSettings(settings);
        // A request-level target language (e.g. drag-select) overrides settings.
        if (req.targetLang) providerSettings.targetLang = req.targetLang;

        // Blob-sourced pages ship bytes content-side; build the Blob (mime
        // defaults like regionHandlers does) and pass it in so `imageUrl` is
        // never fetched (§7.3). Item 1.
        const providedBlob =
          req.imageBytes instanceof ArrayBuffer && req.imageBytes.byteLength > 0
            ? new Blob([req.imageBytes], { type: req.imageMime || "image/jpeg" })
            : undefined;

        const page = await translateImage(
          req.imageUrl,
          settings,
          providerSettings,
          controller.signal,
          req.priority,
          originFromSender(sender),
          providedBlob,
          // Mark this id "started" the moment its provider call leaves the queue
          // wait list, so pause can tell running jobs from queued ones (item 4).
          // A cacheOnly probe never reaches the queue, so this is never invoked
          // for it — pause correctly treats a probe as not-started.
          req.requestId ? () => startedRequests.add(req.requestId!) : undefined,
          req.cacheOnly ?? false,
          // §2: register requestId → cacheKey so reprioritizeTranslation can lift it.
          req.requestId,
        );
        return { ok: true, page };
      } catch (err) {
        // Aborts (pause, teardown, src-swap) are normal control flow, not
        // failures — a 15-page pause aborts every queued job, and each would
        // otherwise log a warn-level "translatePage failed …" (e.g. "All waiters
        // aborted") that reads as an error (Phase 7.5 item 2). Gate on the MAPPED
        // kind, not bare isAbortError: an abort surfaces variously as a raw
        // AbortError (queue/SharedAbort), an ImageFetchError('aborted') (mid-fetch,
        // whose .name is NOT "AbortError"), or a ProviderError('aborted'), and
        // errorToTranslateResult already collapses all three to `aborted`.
        const result = errorToTranslateResult(err);
        // Aborts (control flow) and not-cached (a hydrate probe's normal negative
        // answer) are non-events — debug, not warn, so a probed chapter doesn't
        // spam one warn per uncached page.
        if (
          !result.ok &&
          (result.errorKind === "aborted" || result.errorKind === "not-cached")
        ) {
          log.debug(`translatePage ${result.errorKind} for ${req.imageUrl}`, err);
        } else {
          log.warn(`translatePage failed for ${req.imageUrl}`, err);
        }
        return result;
      } finally {
        if (req.requestId) {
          requestControllers.delete(req.requestId);
          startedRequests.delete(req.requestId);
        }
      }
    },

    cancelTranslation: (req) => {
      // Abort the registered controller; unknown/already-settled ids are a silent
      // no-op (the normal race — the request may have finished before the cancel
      // arrived, or the event page was torn down and lost the registry).
      const controller = requestControllers.get(req.requestId);
      if (controller) {
        controller.abort(new DOMException("Translation cancelled", "AbortError"));
        requestControllers.delete(req.requestId);
      }
    },

    reprioritizeTranslation: (req) => {
      // §2: a prefetched/translate-all page (priority 2) scrolled into view — lift
      // it so it renders before the sequential backlog reaches it. Fire-and-forget.
      const cacheKey = requestIdToCacheKey.get(req.requestId);
      if (cacheKey) {
        // Mapping registered → apply now: (a) pull a still-buffered batch member out
        // and run it SOLO at the new priority, or (b) setPriority a queued job /
        // flushed batch. Running/settled → no handle → no-op.
        applyReprioritize(cacheKey, req.priority);
        return;
      }
      // §5: the mapping isn't registered yet (the miss is still fetching/hashing a
      // prefetched page). Buffer the upgrade so the miss applies it the instant it
      // registers — otherwise it is silently lost and the page stalls at priority 2
      // (the §2 symptom in a timing window). Bounded; an id that never registers
      // ages out. An unknown/settled id likewise just buffers harmlessly and ages.
      bufferPendingReprioritize(req.requestId, req.priority);
    },

    countCachedForSite: async (_req, sender) => {
      // Phase 7.6 hydrate gate: how many cache entries this tab's origin has, so
      // the content side skips probing entirely on sites the user never
      // translated. Fail-soft to 0 (no origin → nothing to hydrate).
      const origin = originFromSender(sender);
      if (!origin) return { count: 0 };
      return { count: await countCacheForOrigin(origin) };
    },

    cancelQueuedTranslations: (req) => {
      // Pause (item 4): abort each id that is registered AND not yet started —
      // let started provider calls finish, stop the rest. Unknown/started ids are
      // silently skipped; that IS the feature. Counts what was actually aborted.
      let cancelled = 0;
      for (const requestId of req.requestIds) {
        if (startedRequests.has(requestId)) continue;
        const controller = requestControllers.get(requestId);
        if (!controller) continue;
        controller.abort(new DOMException("Translation paused", "AbortError"));
        requestControllers.delete(requestId);
        cancelled++;
      }
      return { cancelled };
    },
  };
}
