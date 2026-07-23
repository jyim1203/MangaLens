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
 *
 * Cost contract (Phase 9 §1/§2 + Phase 9.1 §8/§9): auto-translate spends only
 * within `prefetchAhead` of a page the user has confirmably looked at. The
 * reading window is the UNION of each CONFIRMED anchor's forward range
 * `[j, j + prefetchAhead]` ({@link anchoredWindowAllows}), NOT a single cursor's
 * `[0, cursor + prefetchAhead]` — so contiguous forward reading is byte-identical
 * to Phase 9, but a backward/jumped-to page only buys near a page the user
 * actually confirmed (a fast reverse skim buys nothing). A tier-0 event becomes an
 * anchor only after a re-read layout after {@link CONFIRM_DELAY_MS} shows a
 * meaningful, LOADED (§9) overlap ({@link classifyConfirm} + `checkVisibility`),
 * killing the lazy-load/stacked-page/placeholder false "visible" events that made
 * a whole chapter burst out on open (2026-07-17 HAR). Explicit intent —
 * translate-all, drag-select, upgrades of already-sent jobs, hydrate probes —
 * bypasses the window entirely.
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

/**
 * Hard ceiling on the translate-all timeout budget (§3, the Phase 5.1 "120 s vs
 * translate-all" revisit). A 200-page `requestAll` at concurrency 6 on a slow
 * provider blows the flat 120 s `withTimeout`, churning resets; the budget scales
 * with the backlog but never past 15 minutes.
 */
export const TRANSLATE_ALL_MAX_TIMEOUT_MS = 15 * 60_000;

/** Default concurrency assumed for the translate-all timeout estimate (§11). */
const DEFAULT_CONCURRENCY = 6;

/**
 * The per-send timeout a `requestAll` (translate-all) should use for a backlog of
 * `count` pages at `concurrency` in flight (§3). ~30 s of budget per wave of
 * `concurrency` requests on top of the flat `baseMs`, capped at
 * {@link TRANSLATE_ALL_MAX_TIMEOUT_MS}. Monotonic in `count`, floor = `baseMs`.
 * Pure — unit-tested. Visibility-driven sends keep the flat `baseMs`; only the
 * translate-all burst (which legitimately sits behind a long queue) gets the
 * bigger budget so the background finishes + caches instead of timing out.
 */
export function requestAllTimeoutMs(
  count: number,
  concurrency: number,
  baseMs: number,
): number {
  const lanes = Math.max(1, Math.floor(concurrency));
  const waves = Math.ceil(Math.max(0, count) / lanes);
  return Math.min(baseMs + waves * 30_000, TRANSLATE_ALL_MAX_TIMEOUT_MS);
}

/**
 * Phase 9.6 §2 persistent translate-all intent. Armed by a real `requestAll`,
 * scoped to the page URL it was clicked on (`href`) and carrying the same
 * backlog-scaled per-send `budgetMs` the burst used. While armed, a candidate
 * registered LATER auto-sends at {@link TRANSLATE_ALL_PRIORITY} so it isn't left
 * blank.
 */
export interface TranslateAllIntent {
  /** The page URL the intent was armed on — the scope of "this chapter". */
  href: string;
  /** The per-send timeout budget to reuse for auto-sends ({@link requestAllTimeoutMs}). */
  budgetMs: number;
}

/** What {@link classifyRegisterIntent} says to do with a fresh registration. */
export type RegisterIntentAction = "send" | "disarm" | "ignore";

/**
 * Phase 9.6 §2 — decide what a freshly-registered candidate should do against the
 * armed translate-all intent. Pure so the persistence policy is unit-tested apart
 * from the DOM shell:
 *  - `"ignore"` — no intent armed (nothing to persist).
 *  - `"disarm"` — the page URL no longer matches the intent's: MangaDex is an SPA,
 *    so a chapter change re-registers a whole new chapter's images; auto-sending
 *    THOSE would be spend the user never clicked for. The href is the cheapest
 *    precise scope for "this chapter", and a mismatch lapses the intent.
 *  - `"send"` — armed, same page, not paused → auto-send this candidate (a recycled
 *    element's fresh candidate re-sends → the background coalesces onto the
 *    §1-spared in-flight run or cache-hits the finished one; a late lazy-loaded
 *    page finally sends). NOT gated on the anchored reading window: translate-all
 *    is explicit intent and bypasses the window by existing doctrine.
 *
 * @param intent the armed intent, or `undefined` when none.
 * @param currentHref the page URL at registration time.
 * @param paused whether the queue is paused (a paused queue never auto-sends;
 *   `setPaused(true)` also disarms, so this is belt-and-braces).
 */
export function classifyRegisterIntent(
  intent: TranslateAllIntent | undefined,
  currentHref: string,
  paused: boolean,
): RegisterIntentAction {
  if (!intent) return "ignore";
  if (intent.href !== currentHref) return "disarm";
  if (paused) return "ignore";
  return "send";
}

/** The visibility tier a candidate just entered. 0 = visible, 1 = near. */
export type Tier = 0 | 1;

/**
 * One instruction from {@link planEnqueues}: a fresh translate send, a priority
 * UPGRADE of an already-requested, still-unsettled candidate (Phase 8 §2), or a
 * Phase 9 §1 window SUPPRESSION. `upgrade: true` → the shell fires
 * `reprioritizeTranslation` (lift the existing job); `suppressed: true` → the
 * shell marks the record suppressed and sends NOTHING (the candidate re-plans
 * when the reading window slides over it); neither → a fresh `translatePage`
 * send at `priority`.
 */
export interface Enqueue {
  index: number;
  priority: number;
  upgrade?: boolean;
  /** Phase 9 §1: a fresh send the reading-window budget rejected. */
  suppressed?: boolean;
}

/** Inputs to {@link planEnqueues}. All indices are into the doc-ordered list. */
export interface PlanInput {
  /** Total number of registered candidates. */
  count: number;
  /** The candidate index whose tier just changed. */
  changedIndex: number;
  /** Which tier it entered (0 visible / 1 near). */
  changedTier: Tier;
  /**
   * For each already-requested, still-unsettled candidate: the priority it was
   * last sent at. Presence ⇒ requested. A tier change to a STRICTLY better
   * (lower-number) priority yields an `upgrade` instruction; an equal/worse tier
   * is skipped (never worsen). Absence ⇒ unrequested ⇒ a fresh send.
   */
  sentPriority: ReadonlyMap<number, number>;
  /** How many following pages to prefetch when a page becomes visible (§7.5). */
  prefetchAhead: number;
  /**
   * Phase 9.1 §8 anchored reading window: one flag per candidate in doc order,
   * true where the user has CONFIRMED the page visible (a reading anchor). A fresh
   * send at index `i` is allowed IFF some confirmed index `j` satisfies
   * `i − prefetchAhead ≤ j ≤ i` — i.e. `i` sits in the forward window
   * `[j, j + prefetchAhead]` of SOME anchor (see {@link anchoredWindowAllows}).
   * WHY the union-of-forward-windows (not the Phase 9 single `cursor +
   * prefetchAhead`): every page BEHIND the furthest anchor used to be inside the
   * window, so a fast reverse skim bought every page instantly; anchoring spend to
   * each confirmed page's FORWARD range keeps contiguous forward reading
   * byte-identical while a backward/jumped page only buys near a page the user
   * actually confirmed. All-false ⇒ nothing allowed (nothing confirmed yet).
   */
  confirmed: readonly boolean[];
}

/**
 * Phase 9.1 §8: is a fresh send at `index` inside the anchored reading window?
 * True IFF some CONFIRMED index `j` lies in `[index − prefetchAhead, index]` — the
 * union of every anchor's forward `[j, j + prefetchAhead]` range. Bounded backward
 * scan (≤ prefetchAhead steps). WHY err toward FALSE on a non-finite/negative
 * prefetchAhead (rule 6): a NaN window must never widen into a burst. Pure.
 *
 * @param confirmed one flag per candidate in doc order (true = a reading anchor).
 * @param index the doc-order index of the candidate a fresh send would target.
 * @param prefetchAhead how far forward each anchor's window reaches.
 */
export function anchoredWindowAllows(
  confirmed: readonly boolean[],
  index: number,
  prefetchAhead: number,
): boolean {
  const pa = Math.max(0, prefetchAhead);
  if (!Number.isFinite(pa)) return false; // NaN/∞ prefetch → suppress (rule 6)
  const lo = Math.max(0, index - pa);
  for (let j = index; j >= lo; j--) {
    if (confirmed[j]) return true;
  }
  return false;
}

/**
 * Decide what to enqueue when one candidate's visibility tier changes (§7.5, §2).
 *
 * The candidate itself is enqueued at its tier priority. Additionally, when a
 * candidate becomes *visible* (tier 0), the next `prefetchAhead` candidates in
 * document order are enqueued at priority 2 ("when page N becomes visible,
 * enqueue N+1..N+3").
 *
 * Phase 8 §2 re-prioritization (closes the Phase 5 "no priority upgrade"
 * deferral): an already-requested candidate is no longer simply skipped — if its
 * new tier is a STRICTLY better priority than what it was sent at (e.g. a
 * prefetched page at 2 scrolls into view at 0), it yields an `upgrade`
 * instruction so the shell lifts the in-flight job. Equal/worse tiers are skipped
 * (never worsen). Prefetch never runs past the end of the list.
 *
 * Phase 9.1 §8 anchored reading-window budget: a FRESH send at an index outside
 * every confirmed anchor's forward window ({@link anchoredWindowAllows}) is
 * emitted as a `suppressed` instruction instead — no spend leaves the planner
 * beyond a page the user has confirmably looked at. UPGRADE instructions are never
 * suppressed: their job is already paid for, the upgrade only lifts its queue
 * priority. WHY the gate lives here and not in `sendTranslate`: `requestAll`
 * (translate-all) calls `sendTranslate` directly and must stay ungated — explicit
 * intent bypasses the window.
 *
 * @returns the instructions to apply, the changed candidate first. Pure.
 */
export function planEnqueues(input: PlanInput): Enqueue[] {
  const { count, changedIndex, changedTier, sentPriority, prefetchAhead, confirmed } =
    input;
  const plan: Enqueue[] = [];

  const push = (index: number, priority: number): void => {
    if (index < 0 || index >= count) return;
    if (plan.some((e) => e.index === index)) return;
    const sent = sentPriority.get(index);
    if (sent === undefined) {
      // Unrequested → fresh send, gated by the §8 anchored reading window.
      if (anchoredWindowAllows(confirmed, index, prefetchAhead)) {
        plan.push({ index, priority });
      } else {
        plan.push({ index, priority, suppressed: true });
      }
    } else if (priority < sent) {
      plan.push({ index, priority, upgrade: true }); // better tier → upgrade (never gated)
    }
    // else already requested at an equal/better priority → skip (never worsen)
  };

  push(changedIndex, changedTier);
  if (changedTier === 0) {
    for (let k = 1; k <= prefetchAhead; k++) push(changedIndex + k, 2);
  }
  return plan;
}

/**
 * Delay before a tier-0 intersection event is CONFIRMED against a re-read
 * layout (Phase 9 §2). Long enough that a lazy-load accordion's transient
 * "page N at the fold" state has re-flowed away; short enough that a reader
 * jumping mid-chapter waits imperceptibly before the window recenters.
 */
export const CONFIRM_DELAY_MS = 300;

/**
 * Minimum viewport overlap HEIGHT (px) for {@link confirmVisibility} — or 50%
 * of the candidate's own height, whichever is smaller (so a short strip tile
 * can still confirm).
 */
export const CONFIRM_MIN_OVERLAP_PX = 48;

/**
 * Cap on the §2 rejected-confirm retry backoff, as a multiple of the confirm
 * delay (300 ms base → retries at 600, 1200, 2400, then every 2400 ms).
 */
export const CONFIRM_RETRY_MAX_FACTOR = 8;

/** The minimal client-rect slice {@link classifyConfirm} reads (test-friendly). */
export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

/** What a due confirmation should do (see {@link classifyConfirm}). */
export type ConfirmVerdict = "confirm" | "retry" | "drop";

/**
 * Classify a re-read bounding rect against the viewport (Phase 9 §2):
 *  - `"confirm"` — a MEANINGFUL overlap: horizontal overlap plus a vertical
 *    overlap of at least `min(`{@link CONFIRM_MIN_OVERLAP_PX}`, height / 2)`, AND
 *    (Phase 9.1 §9) the candidate is `loaded`. WHY a real threshold instead of
 *    "intersects at all": the false tier events this kills (lazy-load accordion,
 *    a page grazing the fold during layout shift) typically overlap by a few px;
 *    a page being read overlaps by hundreds.
 *  - `"retry"` — SOME overlap, but below the floor, OR (§9) an overlapping-but-
 *    NOT-yet-loaded candidate. WHY not drop: a sequential reader's page enters the
 *    viewport at ~0 px overlap (its ONE transition) and then only gains overlap —
 *    IntersectionObserver never fires again, so dropping would wedge the cursor at
 *    the fold (caught by e2e Scenario D); likewise a lazy-load placeholder finishes
 *    loading with NO IO event, so it must re-check on the backoff. The shell
 *    re-checks on a capped backoff instead.
 *  - `"drop"` — no overlap at all (the streaker left) or degenerate input; the
 *    next real transition covers any return.
 * Pure.
 *
 * @param rect the candidate's current bounding client rect.
 * @param viewportW viewport width (px).
 * @param viewportH viewport height (px).
 * @param loaded Phase 9.1 §9: whether the candidate's image has finished loading.
 *   Defaults to `true` so every pre-§9 call site is unchanged. When `false`, any
 *   overlap → `"retry"` (never `"confirm"`) — an unloaded MangaDex placeholder
 *   still overlaps but must not confirm as "being read"; the no-overlap `"drop"`
 *   case is unchanged.
 */
export function classifyConfirm(
  rect: RectLike,
  viewportW: number,
  viewportH: number,
  loaded = true,
): ConfirmVerdict {
  if (!(rect.height > 0) || !(viewportW > 0) || !(viewportH > 0)) return "drop";
  const overlapX = Math.min(rect.right, viewportW) - Math.max(rect.left, 0);
  const overlapY = Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0);
  if (overlapX <= 0 || overlapY <= 0) return "drop";
  if (!loaded) return "retry"; // §9: overlapping placeholder — wait for the image
  const needed = Math.min(CONFIRM_MIN_OVERLAP_PX, rect.height / 2);
  return overlapY >= needed ? "confirm" : "retry";
}

/** Boolean view of {@link classifyConfirm} — true only for a meaningful overlap. */
export function confirmVisibility(
  rect: RectLike,
  viewportW: number,
  viewportH: number,
): boolean {
  return classifyConfirm(rect, viewportW, viewportH) === "confirm";
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
  /** How many pages ahead to prefetch (from settings). Live-updatable via
   *  {@link ViewportQueue.setPrefetchAhead} (§3 mid-session change). */
  prefetchAhead: number;
  /** Provider concurrency cap (from settings), for the translate-all timeout
   *  budget estimate only (§3). Defaults to 6. */
  concurrency?: number;
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
  /**
   * Whether to run the Phase 7.6 cache-only hydrate pass: on register, probe each
   * candidate for an existing cached translation and render it with ZERO provider
   * spend, so a previously-translated page reappears on reload with no click. The
   * composition root passes `!getAutoTranslate(...)` — // WHY only non-auto sites:
   * an auto site already self-hydrates (visibility fires real requests whose cache
   * hits render in <50 ms), so doubling sends there buys nothing. Gated by a cheap
   * one-time origin cache count so sites the user never translated stay inert.
   */
  hydrate: boolean;
  /** Optional per-request target-language override (drag-select etc.). */
  targetLang?: string;
  /** Generate a request id; defaulted to `crypto.randomUUID()`. */
  makeRequestId?: () => string;
  /**
   * Read a blob-sourced candidate's bytes content-side (Phase 7.2 item 1); seam
   * for tests. Defaulted to {@link import("./imageSource").acquireBlobBytes}. Only
   * invoked for `accept-bytes` (blob) candidates.
   */
  acquireBytes?: (url: string, el?: Element) => Promise<AcquiredBytes>;
  /** IntersectionObserver factory seam (tests inject a fake). */
  createObserver?: (
    cb: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
  /** Per-request timeout (ms); defaulted to {@link REQUEST_TIMEOUT_MS}. Injectable
   *  so the retry path (item 6) is testable without a 2-minute fake-timer wait. */
  requestTimeoutMs?: number;
  /** Tier-0 confirmation delay (ms); defaulted to {@link CONFIRM_DELAY_MS}.
   *  Injectable for tests, exactly like `requestTimeoutMs` (Phase 9 §2). */
  confirmDelayMs?: number;
  /** Viewport-size reader for the §2 confirmation pass; defaulted to
   *  `window.innerWidth/innerHeight`. Injectable so the confirmation shell is
   *  testable in a windowless runtime. */
  getViewport?: () => { w: number; h: number };
  /** Current page URL reader for the Phase 9.6 §2 translate-all intent scope;
   *  defaulted to `location.href` (empty string in a location-less test runtime).
   *  Injectable so the persistence shell is testable without a real `location`. */
  getHref?: () => string;
  /**
   * Called with the error kind when a translation fails with a rendered badge
   * (Phase 7 item 6) — drives the actionable-error toast policy. NOT called for
   * `aborted` (silent) or on timeout (a transient wedge, not a provider verdict).
   */
  onProviderError?: (kind: ProviderErrorKind) => void;
}

/** Priority for "translate all" enqueues — the prefetch/all tier (§7.5). */
export const TRANSLATE_ALL_PRIORITY = 2;

/**
 * Max concurrent hydrate probes in flight (Phase 7.6). WHY bounded: blob-sourced
 * candidates (MangaDex) ship their bytes with the probe via `acquireBytes`, and a
 * 200-page chapter acquiring 200 buffers at once is the exact memory bomb the 7.2
 * lazy-acquisition note forbids. Three keeps hydration brisk without the spike.
 */
export const HYDRATE_CONCURRENCY = 3;

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
   * Update how many pages ahead to prefetch, live (§3 — closes the Phase 5
   * "mid-session prefetchAhead is a no-op" deferral). The pure planner reads the
   * new value on the next tier change; no gate reclassification needed.
   */
  setPrefetchAhead(n: number): void;
  /**
   * On-demand cache-only hydrate of EVERY registered, not-yet-requested candidate
   * (Phase 8 §0 "Show cached translations" popup button). Schedules a probe per
   * eligible candidate through the SAME bounded {@link HYDRATE_CONCURRENCY} gate
   * the Phase 7.6 auto-hydrate uses, but **bypassing the per-lifetime origin gate**
   * — the user's explicit click is the intent signal, so it must not silently
   * no-op on a count-0 read (which can race a freshly-populated cache). Works
   * whether or not `hydrate` was true at construction (auto sites included): it
   * does not read that flag. Each probe renders a hit with zero provider spend and
   * is invisible on miss/error (see {@link probe}).
   *
   * @returns how many candidates a probe was scheduled for (0 while nothing is
   *   registered / everything is already requested).
   */
  hydrateAll(): number;
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
  /** Priority this candidate was last sent at (Phase 8 §2 upgrade planning). */
  sentPriority?: number;
  /**
   * Phase 9 §2: set ONLY by the confirmation pass — this candidate held a real,
   * layout-stable, loaded (§9) viewport overlap. The §8 anchored window is the
   * union of these flags' forward ranges.
   */
  confirmedVisible?: boolean;
  /** Phase 9 §1 / 9.1 §8: the window gate rejected this candidate's last fresh
   *  send; a new anchor whose forward range covers it re-observes it so it
   *  re-plans. */
  suppressed?: boolean;
  /** Phase 9 §2: the one pending confirmation timer for this element, if any. */
  confirmTimer?: ReturnType<typeof setTimeout>;
  /** Phase 9 §2: current retry delay (ms) while a partially-overlapping
   *  candidate re-checks; reset by each fresh tier-0 transition. */
  confirmRetryMs?: number;
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
  const hydrate = opts.hydrate;
  /** Live-updatable prefetch depth (§3); the planner reads it per tier change. */
  let prefetchAhead = opts.prefetchAhead;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const makeRequestId = opts.makeRequestId ?? (() => crypto.randomUUID());
  const acquireBytes = opts.acquireBytes ?? acquireBlobBytes;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const confirmDelayMs = opts.confirmDelayMs ?? CONFIRM_DELAY_MS;
  const getViewport =
    opts.getViewport ?? (() => ({ w: window.innerWidth, h: window.innerHeight }));
  // §2: read the current page URL for the translate-all intent scope. Fails soft to
  // "" in a location-less runtime (the Node test env) — mirrors `isImageLoaded`'s
  // feature-detect — so the shell never throws where `location` is absent.
  const getHref =
    opts.getHref ?? (() => (typeof location !== "undefined" ? location.href : ""));
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
  /**
   * Phase 9.6 §2: the armed translate-all intent, or `undefined` when disarmed.
   * Queue-lifetime state (a fresh queue per activation starts disarmed). Set by a
   * real `requestAll`; disarmed by `setPaused(true)`, `stop()`, and lazily on an
   * href mismatch at register time — so persistence only ever spends under the
   * exact intent the user bought (translate-all on this page URL) and stops the
   * moment that intent lapses.
   */
  let translateAllIntent: TranslateAllIntent | undefined;

  const indexOf = (candidate: Candidate): number =>
    order.findIndex((c) => c.id === candidate.id);

  /** Build the index → sent-priority map the pure planner needs (present ⇒ requested). */
  const sentPriorities = (): Map<number, number> => {
    const map = new Map<number, number>();
    order.forEach((c, i) => {
      const rec = tracked.get(c.el);
      if (rec?.requested && rec.sentPriority !== undefined) map.set(i, rec.sentPriority);
    });
    return map;
  };

  /** §8: the per-candidate confirmed-anchor flags in doc order, fresh per plan. */
  const confirmedFlags = (): boolean[] =>
    order.map((c) => tracked.get(c.el)?.confirmedVisible === true);

  const onTierChange = (candidate: Candidate, tier: Tier): void => {
    const changedIndex = indexOf(candidate);
    if (changedIndex < 0) return;
    const plan = planEnqueues({
      count: order.length,
      changedIndex,
      changedTier: tier,
      sentPriority: sentPriorities(),
      prefetchAhead,
      confirmed: confirmedFlags(),
    });
    for (const { index, priority, upgrade, suppressed } of plan) {
      const c = order[index];
      if (!c) continue;
      if (suppressed) {
        // §1: beyond the reading window — remember it so a later cursor advance
        // re-observes it (otherwise a page whose tier never changes again would
        // wedge exactly like the Phase 5.1 item-6 bug).
        const rec = tracked.get(c.el);
        if (rec && rec.candidate.id === c.id) rec.suppressed = true;
      } else if (upgrade) {
        sendUpgrade(c, priority);
      } else {
        void sendTranslate(c, priority);
      }
    }
  };

  // --- Phase 9 §2 / 9.1 §8: tier-0 confirmation (kills false "visible" events) -
  // A tier-0 IO event does not create a reading ANCHOR directly: manga readers
  // fire false intersections during load (a lazy-load accordion parking image N
  // at the fold while pages above are collapsed; stacked pages hidden via
  // opacity/visibility, which still "intersect"). Confirmation re-reads layout
  // after CONFIRM_DELAY_MS and only then sets `confirmedVisible` (§9: and only
  // once the image has actually loaded).
  //
  // WHY confirm EVERY unconfirmed tier-0 (Phase 9.1 §8, was: only cursor-advancing
  // ones): the window is now the UNION of each confirmed anchor's forward range,
  // so a BACKWARD page must be able to become its own anchor. An unconfirmed
  // tier-0 already INSIDE the window still plans (and may send) immediately — it is
  // inside the budget the user accepted, so normal reading pays zero added latency
  // — and it also schedules a confirm so it anchors the window forward from itself.
  // A page outside the window waits the ~300 ms confirm before it can anchor; a
  // fast reverse skim (the element leaves before the confirm) anchors nothing and
  // buys nothing. Tier-1 (near) events are NOT confirmed — they cannot anchor and
  // the window already bounds them.

  /** `checkVisibility` gate, feature-detected. Absent → fail-open (treat as
   *  visible — the anchored window still bounds the damage). */
  const passesCheckVisibility = (el: Element): boolean => {
    const check = (
      el as Element & {
        checkVisibility?: (opts?: {
          opacityProperty?: boolean;
          visibilityProperty?: boolean;
        }) => boolean;
      }
    ).checkVisibility;
    if (typeof check !== "function") return true;
    try {
      return check.call(el, { opacityProperty: true, visibilityProperty: true });
    } catch {
      return true; // fail-open, same as feature-absent
    }
  };

  /**
   * §9: has the candidate's image finished loading? A non-image candidate fails
   * OPEN (true) — the scanner only registers images today, but the guard must not
   * brick a future candidate kind — and so does a runtime without
   * `HTMLImageElement` (the Node test env). A MangaDex lazy-load placeholder
   * (`complete === false` / `naturalWidth === 0`) fails closed so it can't confirm
   * as "being read" while still loading.
   */
  const isImageLoaded = (el: Element): boolean => {
    if (typeof HTMLImageElement === "undefined" || !(el instanceof HTMLImageElement)) {
      return true;
    }
    return el.complete && el.naturalWidth > 0;
  };

  /** Run one due confirmation: re-read layout, maybe anchor the window, re-plan. */
  const runConfirm = (el: Element, candidateId: string): void => {
    const rec = tracked.get(el);
    if (!rec || rec.candidate.id !== candidateId) return; // unregistered meanwhile
    let rect: RectLike;
    try {
      rect = rec.candidate.el.getBoundingClientRect();
    } catch {
      return; // detached/broken element — the observers cover any real return
    }
    const viewport = getViewport();
    // §9: an unloaded placeholder overlaps but must not confirm — classifyConfirm
    // returns "retry" for it, so it re-checks on the backoff and confirms shortly
    // after the image arrives (an image load fires no IntersectionObserver event).
    const verdict = classifyConfirm(
      rect,
      viewport.w,
      viewport.h,
      isImageLoaded(rec.candidate.el),
    );
    if (verdict === "drop") return; // fully outside — the next transition covers it
    if (verdict === "retry" || !passesCheckVisibility(rec.candidate.el)) {
      // Still overlapping but not confirmable (sliver at the fold, an unloaded
      // placeholder, or an opacity/visibility-hidden stack member occupying the
      // viewport). WHY retry rather than wait for a transition: none of gaining
      // overlap while scrolling deeper, an image finishing load, or an opacity flip
      // fires IntersectionObserver, so a one-shot rejection would wedge the anchor
      // (e2e Scenario D caught the sliver case). Capped exponential backoff bounds
      // the polling on pathological pages.
      scheduleRetryConfirm(rec);
      return;
    }

    rec.confirmRetryMs = undefined; // §2 backoff resets on success
    const idx = indexOf(rec.candidate);
    if (idx < 0) return;
    rec.confirmedVisible = true; // §8: this page is now a reading anchor
    // Re-plan at tier 0 with the new anchor: sends the candidate itself if the
    // immediate within-window pass didn't, upgrades it if it did, and prefetches
    // into this anchor's forward range. Then slide: re-observe suppressed
    // candidates now inside [idx, idx + prefetchAhead].
    onTierChange(rec.candidate, 0);
    slideWindow(idx);
  };

  /** Schedule (at most one) pending confirmation for a tracked element. */
  const scheduleConfirmAt = (rec: Tracked, delayMs: number): void => {
    if (rec.confirmTimer !== undefined) return; // one pending confirm per element
    const el = rec.candidate.el;
    const id = rec.candidate.id;
    rec.confirmTimer = setTimeout(() => {
      const live = tracked.get(el);
      if (live && live.candidate.id === id) live.confirmTimer = undefined;
      safe(() => runConfirm(el, id));
    }, delayMs);
  };

  /** Re-arm a rejected-but-overlapping confirmation with capped backoff (§2). */
  const scheduleRetryConfirm = (rec: Tracked): void => {
    const next = Math.min(
      (rec.confirmRetryMs ?? confirmDelayMs) * 2,
      confirmDelayMs * CONFIRM_RETRY_MAX_FACTOR,
    );
    rec.confirmRetryMs = next;
    scheduleConfirmAt(rec, next);
  };

  /** Cancel a record's pending confirmation, if any (unregister/stop). */
  const cancelConfirm = (rec: Tracked): void => {
    if (rec.confirmTimer !== undefined) {
      clearTimeout(rec.confirmTimer);
      rec.confirmTimer = undefined;
    }
  };

  /**
   * §8: a new anchor at `anchor` opened its forward window
   * `[anchor, anchor + prefetchAhead]` — re-observe every SUPPRESSED candidate now
   * inside it so it re-plans (the existing transition-only-IO workaround:
   * `observe()` redelivers current intersection state). WHY only the anchor's
   * FORWARD range (not [0, edge]): a page BEHIND this anchor is not newly allowed
   * by it — it needs its own anchor — so re-observing backward would resurrect the
   * reverse-skim burst §8 exists to kill. Candidates still outside stay suppressed.
   */
  const slideWindow = (anchor: number): void => {
    const lo = anchor;
    const hi = anchor + Math.max(0, prefetchAhead);
    order.forEach((c, i) => {
      if (i < lo || i > hi) return;
      const rec = tracked.get(c.el);
      if (!rec || rec.candidate.id !== c.id || !rec.suppressed) return;
      rec.suppressed = false; // the re-plan re-sets it if the gate still rejects
      reobserve(c.el);
    });
  };

  /** A tier-0 intersection event (Phase 9 §2 / 9.1 §8 split of the direct plan). */
  const onTier0Event = (rec: Tracked): void => {
    const idx = indexOf(rec.candidate);
    if (idx < 0) return;
    // Already inside the anchored window → plan (and possibly send) immediately;
    // the budget already covers it, so no confirmation latency (§8 WHY above).
    if (anchoredWindowAllows(confirmedFlags(), idx, prefetchAhead)) {
      onTierChange(rec.candidate, 0);
    }
    // §8: EVERY unconfirmed tier-0 can become an anchor (forward OR backward), so
    // schedule its confirmation. A fresh transition resets the retry backoff (real
    // movement deserves a prompt re-check).
    if (!rec.confirmedVisible) {
      rec.confirmRetryMs = undefined;
      scheduleConfirmAt(rec, confirmDelayMs);
    }
  };

  /**
   * Fire `reprioritizeTranslation` for an already-requested candidate whose tier
   * improved (§2). Fire-and-forget — an unknown/settled id is a background no-op.
   * Updates the tracked sent-priority so a later plan sees the new tier.
   */
  const sendUpgrade = (candidate: Candidate, priority: number): void => {
    const rec = tracked.get(candidate.el);
    if (!rec || rec.candidate.id !== candidate.id || !rec.requested || !rec.requestId) return;
    if (paused) return; // a paused job is being cancelled; don't bother upgrading it
    rec.sentPriority = priority;
    const requestId = rec.requestId;
    void sendToBackground("reprioritizeTranslation", { requestId, priority }).catch((err) =>
      log.warn("reprioritizeTranslation failed", err),
    );
  };

  const visibleObserver = makeObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const rec = tracked.get(entry.target);
        // Phase 9 §2: tier-0 events route through the confirmation split —
        // within-window plans immediately, cursor advancement confirms first.
        if (rec) safe(() => onTier0Event(rec));
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
    timeoutMs: number = requestTimeoutMs,
  ): Promise<void> {
    const rec = tracked.get(candidate.el);
    // WHY re-check identity: a rescan may have unregistered/replaced this element
    // between the plan and this async send.
    if (!rec || rec.candidate.id !== candidate.id || rec.requested) return;
    // Pause gate (item 4): stop BEFORE flipping `requested`/showing a skeleton so
    // a paused queue leaves no trace to unwind. Resume reobserves this candidate.
    if (paused) return;

    rec.requested = true;
    rec.sentPriority = priority; // §2: what the background queued this job at
    rec.suppressed = false; // §1: a real send supersedes any stale suppression mark
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
        acquired = await acquireBytes(candidate.url, candidate.el);
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
        timeoutMs,
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
      } else if (result.errorKind === "not-cached") {
        // Unreachable here: a real (non-cacheOnly) request never gets not-cached
        // (only the hydrate probe sets cacheOnly). Guard it so `errorKind` narrows
        // to ProviderErrorKind for setError; treat like aborted — silent, retryable.
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

  /**
   * Cancel a candidate's in-flight request, if any (item 4). Fire-and-forget.
   *
   * `mode` (Phase 9.6 §1) picks the background cancel semantics:
   *  - `"queued-only"` (the DOM-reconcile `unregister` path) spares a started
   *    provider call — MangaDex recycles `<img>` elements mid-scroll, and killing
   *    the in-flight tail-page jobs those unregisters trigger refunds nothing while
   *    destroying the cache value the recycled element's §2 re-send would hit.
   *  - `"hard"` (teardown `stop()`) aborts unconditionally — the user is switching
   *    off / leaving, so respect it.
   */
  const cancel = (rec: Tracked, mode: "hard" | "queued-only"): void => {
    if (!rec.requestId) return;
    const requestId = rec.requestId;
    rec.requestId = undefined;
    void sendToBackground("cancelTranslation", { requestId, mode }).catch((err) =>
      log.warn("cancelTranslation failed", err),
    );
  };

  /**
   * Phase 9.6 §2: if the translate-all intent is armed for the CURRENT page,
   * auto-send this freshly-registered candidate at {@link TRANSLATE_ALL_PRIORITY}
   * (a recycled `<img>`'s new candidate re-sends → coalesces/cache-hits; a late
   * lazy-loaded page finally sends). Lazily disarms the intent on an href mismatch
   * (an SPA chapter change). Returns whether a send was fired.
   *
   * The `!translateAllIntent` fast-path means the common (unarmed) case never even
   * reads `getHref()`, so a location-less runtime is untouched unless intent is armed.
   * `sendTranslate`'s own `requested` re-check dedupes against anything already in
   * flight, so a double registration can't double-send.
   */
  const maybeAutoSendForIntent = (candidate: Candidate): boolean => {
    if (!translateAllIntent) return false;
    const action = classifyRegisterIntent(translateAllIntent, getHref(), paused);
    if (action === "disarm") {
      translateAllIntent = undefined; // SPA navigated off the clicked chapter
      return false;
    }
    if (action !== "send") return false;
    void sendTranslate(candidate, TRANSLATE_ALL_PRIORITY, translateAllIntent.budgetMs);
    return true;
  };

  // --- Phase 7.6 cache-only hydrate -----------------------------------------
  // On a non-auto site, probe each registered candidate for an existing cached
  // translation and render it with ZERO provider spend, so a reload re-shows a
  // chapter the user already translated without a click. A probe is INVISIBLE
  // when it fails: no skeleton, no badge, no toast — it only ever renders a hit.

  /**
   * Origin gate, memoized for the queue's lifetime: how many cache entries this
   * origin has. `0` (or a failed message) makes every probe a no-op, so a site
   * the user never translated on pays one indexed count and nothing more.
   */
  let originCacheCount: Promise<number> | undefined;
  const originHasCache = (): Promise<boolean> => {
    if (!originCacheCount) {
      originCacheCount = sendToBackground("countCachedForSite")
        .then((r) => r.count)
        .catch((err) => {
          log.warn("countCachedForSite failed", err);
          return 0; // fail soft → not hydrated
        });
    }
    return originCacheCount.then((count) => count > 0);
  };

  /** Bounded-concurrency probe scheduler (blob candidates ship bytes — item forbids a burst). */
  const probeQueue: Candidate[] = [];
  let activeProbes = 0;
  const pumpProbes = (): void => {
    while (activeProbes < HYDRATE_CONCURRENCY && probeQueue.length > 0) {
      const candidate = probeQueue.shift()!;
      activeProbes++;
      void probe(candidate).finally(() => {
        activeProbes--;
        pumpProbes();
      });
    }
  };

  /**
   * Gate a candidate through the origin check, then schedule one bounded probe.
   * Fire-and-forget from `register`; on a zero-count / failed gate nothing is
   * scheduled.
   */
  const maybeProbe = async (candidate: Candidate): Promise<void> => {
    if (!(await originHasCache())) return;
    probeQueue.push(candidate);
    pumpProbes();
  };

  /**
   * One cache-only probe. Never `setPending` (no skeleton flash on every page);
   * stamps `requestId` so unregister/stop cancel it, but leaves `requested` false
   * while in flight. On a hit → render + `requested = true` (a later Translate all
   * skips it). On not-cached / abort / error / timeout → leave the record
   * untouched and render NOTHING. Ignores `paused` (a probe spends no provider
   * budget) and skips candidates already `requested`.
   */
  async function probe(candidate: Candidate): Promise<void> {
    const rec = tracked.get(candidate.el);
    if (!rec || rec.candidate.id !== candidate.id || rec.requested) return;

    // Blob-sourced candidates must ship their bytes (the background can't fetch a
    // document-scoped blob URL); the concurrency gate bounds simultaneous reads.
    let acquired: AcquiredBytes | undefined;
    if (classifyImageUrl(candidate.url) === "accept-bytes") {
      try {
        acquired = await acquireBytes(candidate.url, candidate.el);
      } catch (err) {
        log.debug("hydrate byte acquisition failed", err); // silent
        return;
      }
      const still = tracked.get(candidate.el);
      if (!still || still.candidate.id !== candidate.id || still.requested) return;
    }

    const requestId = makeRequestId();
    rec.requestId = requestId; // cancellable on teardown; `requested` stays false
    try {
      const result = await withTimeout(
        sendToBackground("translatePage", {
          imageUrl: candidate.url,
          // priority is irrelevant — a cacheOnly probe never enters the queue.
          priority: TRANSLATE_ALL_PRIORITY,
          requestId,
          cacheOnly: true,
          targetLang: opts.targetLang,
          ...acquired,
        }),
        requestTimeoutMs,
      );
      const live = tracked.get(candidate.el);
      if (!live || live.candidate.id !== candidate.id) return;
      // Only clear our own id — a concurrent real send may have re-stamped it
      // (accepted race: Translate all vs an in-flight probe).
      if (live.requestId === requestId) live.requestId = undefined;
      if (result.ok) {
        live.requested = true; // done — a later Translate all won't re-send it
        safe(() => overlay.render(candidate, result.page));
      }
      // not-cached / any error arm → leave the record untouched, render nothing.
    } catch (err) {
      // Timeout / channel close: silent, leave the record retryable by a real send.
      log.debug("hydrate probe failed", err);
      const live = tracked.get(candidate.el);
      if (live && live.candidate.id === candidate.id && live.requestId === requestId) {
        live.requestId = undefined;
      }
    }
  }

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
      // §2: translate-all persistence. A recycled `<img>` (or a late lazy-loaded
      // page) registers as a fresh candidate after the burst already ran and would
      // otherwise stay blank; while the intent is armed for THIS page, auto-send it.
      const autoSent = safeBool(() => maybeAutoSendForIntent(candidate));
      // Hydrate probe (Phase 7.6): non-auto sites only (autoEnqueue and hydrate are
      // complementary). Probing on register — not one batch at activation — covers
      // lazily-added images for free. Fire-and-forget; the origin gate + concurrency
      // gate inside keep it cheap and bounded. Skip it when §2 just fired a real send
      // for this candidate — the invisible probe would only lose the race (§2
      // micro-cleanup, flagged in PROGRESS).
      if (hydrate && !autoSent) void maybeProbe(candidate);
    },

    unregister(candidate: Candidate): void {
      const rec = tracked.get(candidate.el);
      if (!rec || rec.candidate.id !== candidate.id) return;
      tracked.delete(candidate.el);
      const i = order.findIndex((c) => c.id === candidate.id);
      if (i >= 0) order.splice(i, 1);
      cancelConfirm(rec); // §2: no dangling confirm → no post-removal send
      safe(() => visibleObserver.unobserve(candidate.el));
      safe(() => nearObserver.unobserve(candidate.el));
      // §1: soft-cancel — a started run finishes + caches (the recycled element's
      // §2 re-send hits it); only a still-queued job is aborted (it cost nothing).
      cancel(rec, "queued-only");
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
        // §3: a large translate-all legitimately sits behind a long queue, so give
        // each send a backlog-scaled timeout instead of the flat 120 s (which a
        // 200-page chapter blows, churning resets). Visibility sends keep 120 s.
        const budget = requestAllTimeoutMs(pending.length, concurrency, requestTimeoutMs);
        // Phase 9.6 §2: arm the persistent intent for THIS page so a candidate
        // REGISTERED LATER — a recycled element's fresh candidate (the MangaDex
        // element-churn hole) or a late lazy-loaded page — auto-sends at the same
        // priority + budget instead of staying blank. A dry-run never arms it.
        translateAllIntent = { href: getHref(), budgetMs: budget };
        for (const c of pending) void sendTranslate(c, TRANSLATE_ALL_PRIORITY, budget);
      }
      return pending.length;
    },

    setPrefetchAhead(n: number): void {
      // §3: live-update the prefetch depth. The pure planner reads `prefetchAhead`
      // on the next tier change, so no re-scan / gate reclassification is needed.
      const previous = prefetchAhead;
      prefetchAhead = Math.max(0, Math.floor(n));
      // Phase 9 §1 / 9.1 §8 (implementer's call, flagged in PROGRESS): raising the
      // depth WIDENS every anchor's forward window, so suppressed candidates newly
      // inside the (larger) anchored window must re-plan — otherwise a suppressed
      // page whose tier never changes again would ignore the new setting until the
      // user scrolls. Re-observe every suppressed candidate the new depth allows.
      if (prefetchAhead > previous) {
        const confirmed = confirmedFlags();
        order.forEach((c, i) => {
          const rec = tracked.get(c.el);
          if (!rec || rec.candidate.id !== c.id || !rec.suppressed) return;
          if (anchoredWindowAllows(confirmed, i, prefetchAhead)) {
            rec.suppressed = false;
            reobserve(c.el);
          }
        });
      }
    },

    hydrateAll(): number {
      // WHY bypass the origin gate (unlike maybeProbe): the user's explicit click
      // IS the intent signal, so we don't want a stale count-0 read (which can race
      // a cache the user just populated) to silently no-op the button. We schedule
      // every unrequested candidate directly onto the bounded probe queue — the
      // probe itself is invisible on a miss, so probing all of them is cheap and
      // safe. Reuses the SAME concurrency gate as auto-hydrate.
      let scheduled = 0;
      for (const c of order) {
        if (tracked.get(c.el)?.requested) continue;
        // De-dupe against an already-queued (auto-hydrate) probe for the same el.
        if (probeQueue.some((q) => q.el === c.el)) continue;
        probeQueue.push(c);
        scheduled++;
      }
      pumpProbes();
      return scheduled;
    },

    isPaused(): boolean {
      return paused;
    },

    async setPaused(next: boolean): Promise<number> {
      if (next === paused) return 0;
      paused = next;
      if (next) {
        // §2: pausing revokes the translate-all intent — the user chose to stop
        // spending, so a later-registered candidate must NOT auto-send. Resume does
        // not re-arm it; the user re-clicks Translate all to buy the rest.
        translateAllIntent = undefined;
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
      probeQueue.length = 0; // drop not-yet-started hydrate probes (item: teardown)
      translateAllIntent = undefined; // §2: teardown revokes translate-all persistence
      for (const rec of tracked.values()) {
        cancelConfirm(rec); // §2: no confirm may fire after teardown
        cancel(rec, "hard"); // teardown: the user is leaving — abort unconditionally
      }
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

/** {@link safe} for a boolean-returning step: any throw degrades to `false` (rule 6). */
function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch (err) {
    log.warn("viewport-queue step failed", err);
    return false;
  }
}
