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
  shouldNegativeCache,
} from "./cache";
import { snapPageRegions } from "./bubbleSnap";
import { coalesce } from "./coalesce";
import { createSharedAbort, type SharedAbort } from "./sharedAbort";
import { isAbortError } from "../shared/guards";
import { recordUsage, usageFromPage } from "./costTracker";
import { ImageFetchError, fetchImageBytes } from "./imageFetcher";
import { sha256Hex } from "./hash";
import { dedupeRegions, prepareImage } from "./imagePrep";
import { PriorityQueue } from "./queue";
import { ProviderError } from "./providers/ProviderBase";
import { createProvider, resolveEffectiveModel } from "./providers/factory";
import { createRateGate, type RateGate } from "./rateGate";

const log = createLogger("translate");

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
): Promise<{ page: PageTranslation; providerCalls: number }> {
  const prepared = await prepareImage(blob, {
    maxEdgePx: settings.maxImageEdgePx,
    jpegQuality: settings.jpegQuality,
  });

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
  return { page: snapped, providerCalls: prepared.tiles.length };
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
    log.debug(`cache hit for ${imageUrl}`);
    return lookup.page;
  }
  if (lookup.status === "negative") {
    // A recent deterministic failure is cached (PROMPTS §6.5); don't re-hit the
    // provider. Throw the same typed error so it maps to the UI ⚠ the same way.
    throw new ProviderError(lookup.errorKind, lookup.message);
  }

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
  const queue = getTranslationQueue(settings.concurrency);
  let result: { page: PageTranslation; providerCalls: number };
  try {
    result = await queue.add(
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
  void cacheStorePage(cacheKey, result.page, cacheCapBytes(settings), origin);
  // providerCalls (tile count) → accurate `images` accounting for strips (item 2).
  void recordUsage(usageFromPage(result.page, result.providerCalls));
  return result.page;
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
          req.requestId ? () => startedRequests.add(req.requestId!) : undefined,
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
        if (!result.ok && result.errorKind === "aborted") {
          log.debug(`translatePage aborted for ${req.imageUrl}`, err);
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
