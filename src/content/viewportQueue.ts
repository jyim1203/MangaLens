/**
 * Visibility → priority → translate requests (Architecture §7.5).
 *
 * This wires the priority plumbing that has existed end-to-end since Phase 1
 * (`TranslatePageRequest.priority` → background `PriorityQueue`) but never had a
 * real sender. Split per the pure-core / thin-shell rule:
 *  - PURE, unit-tested: {@link planEnqueues} — given the candidate count, the
 *    index whose visibility tier just changed, the already-requested set, and
 *    `prefetchAhead`, it returns the exact `{ index, priority }` list to send.
 *  - THIN shell: {@link createViewportQueue} — two IntersectionObservers, the
 *    requested/outstanding bookkeeping, the fire-and-forget send with a timeout,
 *    and the per-request cancellation on teardown (item 4).
 *
 * Priorities (§7.5): 0 = visible now, 1 = near viewport, 2 = prefetch ahead.
 */
import { createLogger } from "../shared/log";
import { sendToBackground } from "../shared/messages";
import type { PageTranslation, ProviderErrorKind } from "../shared/types";
import { classifyImageUrl, type Candidate } from "./scanner";
import { acquireBlobBytes, type AcquiredBytes } from "./imageSource";
import { withTimeout } from "./withTimeout";

const log = createLogger("viewport-queue");

/** rootMargin for the "near viewport" observer — one viewport in every direction. */
const NEAR_ROOT_MARGIN = "100%";

/**
 * Generous timeout around the `translatePage` await (§7.5, gap #8). WHY: the
 * background event page is NOT persistent — if it dies mid-request the promise
 * may never settle, which would wedge this image's requested-set entry forever.
 * On timeout we return the entry to "unrequested" so a later visibility event
 * retries.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** The visibility tier a candidate just entered. 0 = visible, 1 = near. */
export type Tier = 0 | 1;

/** One enqueue instruction: translate candidate `index` at `priority`. */
export interface Enqueue {
  index: number;
  priority: number;
}

/** Inputs to {@link planEnqueues}. All indices are into the doc-ordered list. */
export interface PlanInput {
  /** Total number of registered candidates. */
  count: number;
  /** The candidate index whose tier just changed. */
  changedIndex: number;
  /** Which tier it entered (0 visible / 1 near). */
  changedTier: Tier;
  /** Candidate indices already requested (never re-sent — no priority upgrade). */
  requested: ReadonlySet<number>;
  /** How many following pages to prefetch when a page becomes visible (§7.5). */
  prefetchAhead: number;
}

/**
 * Decide what to enqueue when one candidate's visibility tier changes (§7.5).
 *
 * The candidate itself is enqueued at its tier priority. Additionally, when a
 * candidate becomes *visible* (tier 0), the next `prefetchAhead` candidates in
 * document order are enqueued at priority 2 ("when page N becomes visible,
 * enqueue N+1..N+3"). Already-requested indices are skipped (no re-send / no
 * priority upgrade — the background queue has no re-prioritize API and a
 * duplicate send would coalesce anyway), and prefetch never runs past the end of
 * the list.
 *
 * @returns the enqueues to send, the changed candidate first. Pure.
 */
export function planEnqueues(input: PlanInput): Enqueue[] {
  const { count, changedIndex, changedTier, requested, prefetchAhead } = input;
  const plan: Enqueue[] = [];

  const push = (index: number, priority: number): void => {
    if (index < 0 || index >= count) return;
    if (requested.has(index)) return;
    if (plan.some((e) => e.index === index)) return;
    plan.push({ index, priority });
  };

  push(changedIndex, changedTier);
  if (changedTier === 0) {
    for (let k = 1; k <= prefetchAhead; k++) push(changedIndex + k, 2);
  }
  return plan;
}

/** What the queue needs from the overlay layer — kept minimal to avoid coupling. */
export interface OverlaySink {
  /** Show the pending (skeleton/spinner) state for a candidate (§7.5). */
  setPending(candidate: Candidate): void;
  /** Render a finished translation. */
  render(candidate: Candidate, page: PageTranslation): void;
  /** Show the error badge for a candidate. */
  setError(candidate: Candidate, errorKind: ProviderErrorKind): void;
  /** Remove any overlay/pending state for a candidate. */
  clear(candidate: Candidate): void;
}

/** Injectable seams for {@link createViewportQueue} (defaults use real APIs). */
export interface ViewportQueueOptions {
  overlay: OverlaySink;
  /** How many pages ahead to prefetch (from settings). */
  prefetchAhead: number;
  /**
   * Whether visibility auto-enqueues candidates (Phase 7.2 item 3). When false,
   * candidates are still registered, doc-ordered, and overlay-managed (so
   * {@link ViewportQueue.requestAll} still works), but the IntersectionObservers
   * never observe them — no tier events, no auto sends. The content composition
   * root sets this from {@link import("../shared/settings").getAutoTranslate}: the
   * global toggle activates the content script everywhere, but page images only
   * leave the browser on a per-site opt-in.
   */
  autoEnqueue: boolean;
  /** Optional per-request target-language override (drag-select etc.). */
  targetLang?: string;
  /** Generate a request id; defaulted to `crypto.randomUUID()`. */
  makeRequestId?: () => string;
  /**
   * Read a blob-sourced candidate's bytes content-side (Phase 7.2 item 1); seam
   * for tests. Defaulted to {@link import("./imageSource").acquireBlobBytes}. Only
   * invoked for `accept-bytes` (blob) candidates.
   */
  acquireBytes?: (url: string) => Promise<AcquiredBytes>;
  /** IntersectionObserver factory seam (tests inject a fake). */
  createObserver?: (
    cb: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
  /** Per-request timeout (ms); defaulted to {@link REQUEST_TIMEOUT_MS}. Injectable
   *  so the retry path (item 6) is testable without a 2-minute fake-timer wait. */
  requestTimeoutMs?: number;
  /**
   * Called with the error kind when a translation fails with a rendered badge
   * (Phase 7 item 6) — drives the actionable-error toast policy. NOT called for
   * `aborted` (silent) or on timeout (a transient wedge, not a provider verdict).
   */
  onProviderError?: (kind: ProviderErrorKind) => void;
}

/** Priority for "translate all" enqueues — the prefetch/all tier (§7.5). */
export const TRANSLATE_ALL_PRIORITY = 2;

/** A live viewport queue. */
export interface ViewportQueue {
  /** Register a candidate for visibility tracking (from the scanner). */
  register(candidate: Candidate): void;
  /** Unregister a candidate: unobserve, cancel any in-flight request, clear overlay. */
  unregister(candidate: Candidate): void;
  /**
   * Request translation of every registered, not-yet-requested candidate at
   * {@link TRANSLATE_ALL_PRIORITY} (F8 "translate all" from the popup).
   * Visible pages that were already requested keep their better priority —
   * this only fills in the rest.
   *
   * @param dryRun count what would be sent without sending (the popup's
   *   confirm-first flow for large chapters).
   * @returns how many candidates were (or would be) requested.
   */
  requestAll(dryRun?: boolean): number;
  /**
   * Pause or resume this tab's translate queue (Phase 7.4). Pausing lets every
   * already-STARTED provider call finish and render, aborts every
   * queued-but-not-started page job (one batched `cancelQueuedTranslations`), and
   * blocks new sends (visibility, prefetch, translate-all) until resumed.
   * Resuming re-observes still-visible unrequested candidates so auto sites
   * re-plan; on a non-auto site the user re-clicks Translate all.
   *
   * @param paused the desired state.
   * @returns how many queued jobs the background reported cancelling (0 on
   *   resume, or when nothing was queued / the message failed — fail soft).
   */
  setPaused(paused: boolean): Promise<number>;
  /** Whether the queue is currently paused (Phase 7.4). */
  isPaused(): boolean;
  /** Tear everything down: cancel all in-flight requests and disconnect observers. */
  stop(): void;
}

/** Per-candidate bookkeeping. */
interface Tracked {
  candidate: Candidate;
  requested: boolean;
  /** requestId of the in-flight translate, if any (for cancellation, item 4). */
  requestId?: string;
}

/**
 * Build the viewport queue (§7.5). Observes registered candidates with two
 * IntersectionObservers (exact viewport → priority 0; one-viewport margin →
 * priority 1), plans enqueues with {@link planEnqueues}, and sends
 * `translatePage` for each, wiring the result into the overlay sink. In-flight
 * requests are cancellable by id so teardown/removal stops paying the provider
 * (item 4).
 *
 * @param opts overlay sink, prefetch depth, and optional test seams.
 */
export function createViewportQueue(opts: ViewportQueueOptions): ViewportQueue {
  const overlay = opts.overlay;
  const autoEnqueue = opts.autoEnqueue;
  const makeRequestId = opts.makeRequestId ?? (() => crypto.randomUUID());
  const acquireBytes = opts.acquireBytes ?? acquireBlobBytes;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const makeObserver =
    opts.createObserver ??
    ((cb, options) => new IntersectionObserver(cb, options));

  /** Candidates in document order (as registered by the scanner). */
  const order: Candidate[] = [];
  /** element → tracking record, so an IntersectionObserver entry maps back. */
  const tracked = new Map<Element, Tracked>();
  /** Pause state (Phase 7.4): while true, no new sends leave this queue. Per-tab
   *  RUNTIME state — it dies with the content script on navigation. */
  let paused = false;

  const indexOf = (candidate: Candidate): number =>
    order.findIndex((c) => c.id === candidate.id);

  /** Build the requested-index set the pure planner needs. */
  const requestedIndices = (): Set<number> => {
    const set = new Set<number>();
    order.forEach((c, i) => {
      if (tracked.get(c.el)?.requested) set.add(i);
    });
    return set;
  };

  const onTierChange = (candidate: Candidate, tier: Tier): void => {
    const changedIndex = indexOf(candidate);
    if (changedIndex < 0) return;
    const plan = planEnqueues({
      count: order.length,
      changedIndex,
      changedTier: tier,
      requested: requestedIndices(),
      prefetchAhead: opts.prefetchAhead,
    });
    for (const { index, priority } of plan) {
      const c = order[index];
      if (c) void sendTranslate(c, priority);
    }
  };

  const visibleObserver = makeObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const rec = tracked.get(entry.target);
        if (rec) safe(() => onTierChange(rec.candidate, 0));
      }
    },
    { rootMargin: "0px" },
  );

  const nearObserver = makeObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const rec = tracked.get(entry.target);
        if (rec) safe(() => onTierChange(rec.candidate, 1));
      }
    },
    { rootMargin: NEAR_ROOT_MARGIN },
  );

  /**
   * Force a fresh intersection callback for `el` by unobserving then re-observing
   * both observers (item 6). WHY: IntersectionObserver fires only on *transitions*,
   * so an image sitting still in the viewport when its request times out (or aborts
   * while still registered) produces no new event and would be wedged — no overlay,
   * no retry — until the user scrolls it out and back. `observe()` always delivers
   * an initial entry with the current intersection state, which re-plans and
   * re-sends when the image is (near-)visible. Only meaningful after `requested`
   * has been reset to false, or the re-fired callback is a no-op.
   */
  const reobserve = (el: Element): void => {
    // WHY no-op when auto-enqueue is off: there are no observers watching this
    // element to re-fire (a non-auto site never observes), so a timed-out
    // translate-all page won't visibility-retry there — the user re-clicks
    // Translate all (Phase 7.2 item 3, accepted).
    if (!autoEnqueue) return;
    safe(() => visibleObserver.unobserve(el));
    safe(() => nearObserver.unobserve(el));
    safe(() => visibleObserver.observe(el));
    safe(() => nearObserver.observe(el));
  };

  async function sendTranslate(
    candidate: Candidate,
    priority: number,
  ): Promise<void> {
    const rec = tracked.get(candidate.el);
    // WHY re-check identity: a rescan may have unregistered/replaced this element
    // between the plan and this async send.
    if (!rec || rec.candidate.id !== candidate.id || rec.requested) return;
    // Pause gate (item 4): stop BEFORE flipping `requested`/showing a skeleton so
    // a paused queue leaves no trace to unwind. Resume reobserves this candidate.
    if (paused) return;

    rec.requested = true;
    const requestId = makeRequestId();
    safe(() => overlay.setPending(candidate));

    // Blob-sourced pages (MangaDex etc.): the background can't fetch a
    // document-scoped blob URL (§7.3), so read the bytes content-side and ship
    // them — exactly as drag-select does. // WHY lazy at dispatch, never at
    // registration: a chapter can register 200 candidates, and holding
    // 200 × ~1–3 MB ArrayBuffers would be a content-side memory bomb; only jobs
    // actually SENT pay for their bytes.
    let acquired: AcquiredBytes | undefined;
    if (classifyImageUrl(candidate.url) === "accept-bytes") {
      try {
        acquired = await acquireBytes(candidate.url);
      } catch (err) {
        // Revoked object URL / fetch throw. // WHY do NOT reset `requested`: a
        // revoked blob never heals by retry — the reader swapping the <img> src
        // produces a FRESH candidate via the scanner reconcile, and that new
        // registration IS the retry path. Re-acquiring the same dead URL on the
        // next visibility event would just fail again. `requestId` was never
        // stamped on the record (no request was sent), so teardown fires no
        // phantom cancel.
        log.warn(`byte acquisition failed for ${candidate.url}`, err);
        safe(() => overlay.setError(candidate, "network"));
        return;
      }
      // Torn down while acquiring? Don't send for a candidate that's gone.
      const still = tracked.get(candidate.el);
      if (!still || still.candidate.id !== candidate.id) return;
      // Paused during the acquireBytes gap (item 4): abandon the send and reset to
      // unrequested + clear the skeleton so resume can re-plan it (same pattern as
      // the teardown re-check above).
      if (paused) {
        still.requested = false;
        safe(() => overlay.clear(candidate));
        return;
      }
    }

    // Stamp the id only now that we're actually about to send, so a teardown
    // during byte acquisition has no requestId to (needlessly) cancel.
    rec.requestId = requestId;
    try {
      const result = await withTimeout(
        sendToBackground("translatePage", {
          imageUrl: candidate.url,
          priority,
          requestId,
          targetLang: opts.targetLang,
          ...acquired,
        }),
        requestTimeoutMs,
      );
      // The candidate may have been torn down while we awaited.
      const live = tracked.get(candidate.el);
      if (!live || live.candidate.id !== candidate.id) return;
      live.requestId = undefined;

      if (result.ok) {
        safe(() => overlay.render(candidate, result.page));
      } else if (result.errorKind === "aborted") {
        // Silent: the user scrolled away or toggled off — nothing is wrong. But a
        // terminal-without-render result must stay retryable on next visibility
        // (item 6): reset + re-observe so a still-visible image isn't wedged. Today
        // aborts arrive from unregister/teardown (already removed from `tracked`,
        // so this is near-unreachable), but it's one line to keep the invariant.
        live.requested = false;
        safe(() => overlay.clear(candidate));
        reobserve(live.candidate.el);
      } else {
        safe(() => overlay.setError(candidate, result.errorKind));
        // Actionable failures (auth/rate-limit) also raise a once-per-activation
        // toast; the policy in the toast manager decides (Phase 7 item 6).
        if (opts.onProviderError) safe(() => opts.onProviderError!(result.errorKind));
      }
    } catch (err) {
      // Timeout or channel close (event page died mid-request, gap #8): return
      // the entry to "unrequested" so a later visibility event retries.
      log.warn(`translate request failed for ${candidate.url}`, err);
      const live = tracked.get(candidate.el);
      if (live && live.candidate.id === candidate.id) {
        live.requested = false;
        live.requestId = undefined;
        safe(() => overlay.clear(candidate));
        // WHY re-observe: an image still in the viewport at timeout emits no new
        // intersection event (IO fires on transitions only), so without this it
        // would never retry until scrolled away and back (item 6).
        reobserve(live.candidate.el);
      }
    }
  }

  /** Cancel a candidate's in-flight request, if any (item 4). Fire-and-forget. */
  const cancel = (rec: Tracked): void => {
    if (!rec.requestId) return;
    const requestId = rec.requestId;
    rec.requestId = undefined;
    void sendToBackground("cancelTranslation", { requestId }).catch((err) =>
      log.warn("cancelTranslation failed", err),
    );
  };

  return {
    register(candidate: Candidate): void {
      if (tracked.has(candidate.el)) return; // de-duped by the scanner already
      tracked.set(candidate.el, { candidate, requested: false });
      // Keep `order` in document order so prefetch (N+1..N+3) and translate-all
      // fill in document order (both read `order`), independent of auto-enqueue.
      insertInDocOrder(order, candidate);
      // WHY only observe when auto-enqueue is on (Phase 7.2 item 3): on a non-auto
      // site the registry still drives Translate all / drag-select, but nothing is
      // sent to the provider without a user action — so the visibility observers
      // that would auto-send must not watch these elements.
      if (autoEnqueue) {
        safe(() => visibleObserver.observe(candidate.el));
        safe(() => nearObserver.observe(candidate.el));
      }
    },

    unregister(candidate: Candidate): void {
      const rec = tracked.get(candidate.el);
      if (!rec || rec.candidate.id !== candidate.id) return;
      tracked.delete(candidate.el);
      const i = order.findIndex((c) => c.id === candidate.id);
      if (i >= 0) order.splice(i, 1);
      safe(() => visibleObserver.unobserve(candidate.el));
      safe(() => nearObserver.unobserve(candidate.el));
      cancel(rec); // stop paying the provider for work nobody will see (item 4)
      safe(() => overlay.clear(candidate));
    },

    requestAll(dryRun = false): number {
      // Paused (item 4): translate-all is a no-op both ways — the popup disables
      // the button anyway, and a dry-run count of 0 keeps the confirm flow honest.
      if (paused) return 0;
      // WHY filter on `requested` and not in-flight state: sendTranslate flips
      // `requested` synchronously before its first await, so double-clicking
      // "translate all" (or clicking during a visibility burst) can't double-send.
      const pending = order.filter((c) => !tracked.get(c.el)?.requested);
      if (!dryRun) {
        for (const c of pending) void sendTranslate(c, TRANSLATE_ALL_PRIORITY);
      }
      return pending.length;
    },

    isPaused(): boolean {
      return paused;
    },

    async setPaused(next: boolean): Promise<number> {
      if (next === paused) return 0;
      paused = next;
      if (next) {
        // Collect every tracked job's live requestId and cancel the queued ones in
        // ONE message; already-STARTED calls finish + render (background skips
        // them). An id present here but not yet started is aborted; its
        // translatePage resolves { errorKind: "aborted" }, which sendTranslate's
        // existing aborted branch turns into reset + clear + reobserve.
        const requestIds: string[] = [];
        for (const rec of tracked.values()) {
          if (rec.requestId) requestIds.push(rec.requestId);
        }
        if (requestIds.length === 0) return 0;
        try {
          const { cancelled } = await sendToBackground("cancelQueuedTranslations", {
            requestIds,
          });
          return cancelled;
        } catch (err) {
          log.warn("cancelQueuedTranslations failed", err);
          return 0; // fail soft — "nothing paused"
        }
      }
      // Resume: reobserve still-visible unrequested candidates so auto sites
      // re-plan (IntersectionObserver fires on transitions only — same reasoning
      // as the timeout retry path). On a non-auto site reobserve is a no-op and
      // the user re-clicks Translate all.
      for (const rec of tracked.values()) {
        if (!rec.requested) reobserve(rec.candidate.el);
      }
      return 0;
    },

    stop(): void {
      for (const rec of tracked.values()) cancel(rec);
      tracked.clear();
      order.length = 0;
      safe(() => visibleObserver.disconnect());
      safe(() => nearObserver.disconnect());
    },
  };
}

/**
 * Insert `candidate` into `order` keeping document order via
 * `compareDocumentPosition`. WHY: a lazily-loaded image can appear before
 * already-registered ones; prefetch reads this order, so append-only would
 * prefetch the wrong neighbours.
 */
function insertInDocOrder(order: Candidate[], candidate: Candidate): void {
  for (let i = 0; i < order.length; i++) {
    const rel = candidate.el.compareDocumentPosition(order[i]!.el);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
      order.splice(i, 0, candidate);
      return;
    }
  }
  order.push(candidate);
}

/** Swallow + log any throw so an observer callback can never break the page (rule 6). */
function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn("viewport-queue step failed", err);
  }
}
