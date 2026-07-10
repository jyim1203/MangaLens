/**
 * Candidate manga-image discovery (Architecture §7.1).
 *
 * Split per the repo's pure-core / thin-shell rule:
 *  - PURE, unit-tested: the candidate predicate + scorer ({@link isCandidate},
 *    {@link scoreCandidate}) operating on plain metrics, the image-URL policy
 *    ({@link classifyImageUrl}), and CSS `url(...)` extraction
 *    ({@link parseCssUrl}). None of these touch the DOM.
 *  - THIN, untested shell: {@link createScanner} — the DOM walk, the debounced
 *    MutationObserver, the `popstate` listener, and the registry that de-dupes
 *    and reconciles added / changed / removed images. Metrics are read through an
 *    injectable seam ({@link ScannerOptions.readMetrics}) so the walk is testable
 *    in jsdom (which does no layout — see the handoff) with synthetic metrics.
 *
 * Lazy is load-bearing (§7.1): scanning only *registers* candidates. Nothing is
 * fetched, hashed, or translated here — that is the viewport queue's job once an
 * image nears the viewport.
 */
import { createLogger } from "../shared/log";
import { OVERLAY_HOST_ATTR } from "../shared/constants";

const log = createLogger("scanner");

/** Minimum rendered size (px, both sides) for an image to be a candidate. */
export const MIN_RENDERED_PX = 180;
/** Minimum natural size (px) on at least ONE side. */
export const MIN_NATURAL_PX = 400;

/** Trailing-edge debounce for MutationObserver-triggered re-scans (ms). */
const RESCAN_DEBOUNCE_MS = 250;
/**
 * Max wait before a re-scan is forced even under continuous mutations (ms). WHY:
 * a page with a perpetually-animating inline `style` (sliders, progress bars)
 * mutates faster than the debounce forever, so a pure trailing-edge debounce
 * would never fire and late-added images would never be found (item 4). This caps
 * the starvation: a scan runs at most ~1 s into a continuous mutation burst.
 */
const RESCAN_MAX_WAIT_MS = 1000;

/**
 * DOM-free metrics describing one image element, everything the pure predicate
 * and scorer need. Read from the DOM by the shell (or injected in tests).
 */
export interface CandidateMetrics {
  /** Rendered (on-screen) width/height in CSS px. */
  renderedW: number;
  renderedH: number;
  /** Intrinsic image width/height in px (for `<img>`, `naturalWidth/Height`). */
  naturalW: number;
  naturalH: number;
  /** Viewport width in px (for the centered-vs-sidebar position score). */
  viewportW: number;
  /** Horizontal center of the element in viewport px. */
  centerX: number;
}

/**
 * Is this image a plausible manga/comic page (§7.1)? Rendered area must be at
 * least {@link MIN_RENDERED_PX} on both sides (skips icons/thumbnails) and the
 * intrinsic image at least {@link MIN_NATURAL_PX} on one side (skips avatars and
 * upscaled sprites). The aspect ratio is deliberately NOT constrained — webtoon
 * strips are extremely tall and must pass.
 *
 * @param m metrics for the element (no DOM access).
 * @returns true if the element should be registered as a candidate.
 */
export function isCandidate(m: CandidateMetrics): boolean {
  if (m.renderedW < MIN_RENDERED_PX || m.renderedH < MIN_RENDERED_PX) {
    return false;
  }
  // WHY max, not min: a tall webtoon strip may be narrow; one large side is
  // enough to distinguish real artwork from a 200-px avatar.
  if (Math.max(m.naturalW, m.naturalH) < MIN_NATURAL_PX) {
    return false;
  }
  return true;
}

/**
 * Rank a candidate so the most likely main-content page sorts first (§7.1).
 * Larger rendered area and closer-to-horizontally-centered both raise the score,
 * so a big centered page beats a small sidebar/footer thumbnail. Pure.
 *
 * RESERVED / not yet consumed: the scanner no longer sorts by score (the viewport
 * queue re-orders everything into document order, so it had no effect — item 7).
 * This stays exported + tested for the §7.1 main-image ranking a later consumer
 * will use (drag-select default target / main-image heuristics, Phase 7).
 *
 * @param m metrics for the element.
 * @returns a non-negative score; higher is more manga-page-like.
 */
export function scoreCandidate(m: CandidateMetrics): number {
  const area = m.renderedW * m.renderedH;
  // Centeredness in [0,1]: 1 when the element's center is at the viewport center,
  // 0 at either edge. A zero/unknown viewport degrades to "no position bonus".
  const centeredness =
    m.viewportW > 0
      ? 1 - Math.min(1, Math.abs(m.centerX / m.viewportW - 0.5) * 2)
      : 0;
  return area * (1 + centeredness);
}

/** Whether an image URL can be sent to the background for translation (§7.1/§7.3). */
export type UrlPolicy = "accept" | "skip";

/**
 * Decide whether a resolved image URL is translatable (§7.1). `http(s):` and
 * `data:` are accepted (the background can fetch/decode both). `blob:` is
 * skipped — a blob URL is scoped to the document that created it, so the
 * background context cannot fetch it (§7.3); the Phase 7 drag-select/screenshot
 * path covers those. Anything else (`about:`, `chrome:`, empty) is skipped.
 *
 * @param url the (already absolute) URL, or a nullish value.
 */
export function classifyImageUrl(url: string | null | undefined): UrlPolicy {
  if (!url) return "skip";
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:")
  ) {
    return "accept";
  }
  // WHY skip blob: — cross-context fetch fails; not our problem until Phase 7.
  return "skip";
}

/**
 * Extract the first `url(...)` target from a CSS `background-image` value.
 * Returns the raw (possibly relative) URL, or null when there is none (e.g. a
 * pure gradient, or `none`). Pure — the shell resolves it against the document
 * base and classifies it.
 *
 * @param backgroundImage a computed `background-image` string.
 */
export function parseCssUrl(backgroundImage: string): string | null {
  const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(backgroundImage);
  return m && m[2] ? m[2] : null;
}

/**
 * Is `node` one of our own overlay HOST elements (marked with
 * {@link OVERLAY_HOST_ATTR})? Used to drop MutationObserver records that the
 * OverlayManager itself produces when it rewrites host `style` on every
 * scroll/resize sync — without this, scrolling would schedule an endless
 * self-triggered re-scan (item 4). Host *children* live in a shadow root and
 * never reach the page-level observer, so testing the record target suffices.
 * Pure.
 *
 * @param node a MutationRecord target (or any node), possibly null.
 */
export function isOwnOverlayHost(node: Node | null | undefined): boolean {
  return node instanceof Element && node.hasAttribute(OVERLAY_HOST_ATTR);
}

/**
 * Trailing-edge debounce with a max-wait ceiling (item 4). Given the current
 * time, when the *first* mutation of the current burst was seen, and the two
 * bounds, return how many ms from now the re-scan should run: normally
 * `debounceMs` after the latest mutation (quiet-settles), but never later than
 * `maxWaitMs` after the burst began, so a continuously-mutating page still gets
 * scanned. Clamped to ≥ 0. Pure.
 *
 * @param now current timestamp (ms).
 * @param firstScheduledAt timestamp of the first mutation since the last run.
 * @param debounceMs trailing-edge quiet window.
 * @param maxWaitMs hard ceiling from `firstScheduledAt`.
 * @returns delay in ms from `now` until the scan should run.
 */
export function computeRescanDelay(
  now: number,
  firstScheduledAt: number,
  debounceMs: number,
  maxWaitMs: number,
): number {
  const trailingAt = now + debounceMs;
  const ceilingAt = firstScheduledAt + maxWaitMs;
  return Math.max(0, Math.min(trailingAt, ceilingAt) - now);
}

/**
 * A registered candidate image. `id` is stable for the lifetime of this
 * registration (a `src` swap produces a NEW candidate with a new id), so the
 * viewport queue and overlay manager can key off it safely.
 */
export interface Candidate {
  /** Stable registration id. */
  id: string;
  /** The element used for both identity and overlay geometry (`<img>` or a
   *  background-image host). */
  el: Element;
  /** The resolved, translatable image URL (see {@link classifyImageUrl}). */
  url: string;
}

/** Callbacks the scanner fires as the candidate set changes. */
export interface ScannerCallbacks {
  /** A new candidate appeared (page load, lazy load, or `src` swap). */
  onAdded(candidate: Candidate): void;
  /** A candidate went away (element removed, or its `src` swapped — the OLD
   *  candidate is reported; the replacement arrives via a fresh `onAdded`). */
  onRemoved(candidate: Candidate): void;
}

/** Injectable seams (defaults use the real DOM); metrics is the testable seam. */
export interface ScannerOptions extends ScannerCallbacks {
  /** Read metrics for an element; return null if it can't be measured. */
  readMetrics?: (el: Element) => CandidateMetrics | null;
  /** Resolve an element's translatable URL, or null to skip it. */
  resolveUrl?: (el: Element) => string | null;
  /** Enumerate candidate source elements in the document (defaults to a DOM walk). */
  collectElements?: () => Element[];
}

/** A live scanner; call {@link Scanner.start} to begin, {@link Scanner.stop} to tear down. */
export interface Scanner {
  /** Attach observers and run the first scan. Idempotent. */
  start(): void;
  /** Force a reconcile scan now (also used internally). */
  scan(): void;
  /** Detach observers/listeners and forget all candidates (does NOT fire onRemoved). */
  stop(): void;
}

/** Default DOM metrics reader for an `<img>` or background-image element. */
function defaultReadMetrics(el: Element): CandidateMetrics | null {
  const rect = el.getBoundingClientRect();
  const viewportW =
    window.innerWidth || document.documentElement.clientWidth || 0;
  if (el instanceof HTMLImageElement) {
    return {
      renderedW: rect.width,
      renderedH: rect.height,
      naturalW: el.naturalWidth,
      naturalH: el.naturalHeight,
      viewportW,
      centerX: rect.left + rect.width / 2,
    };
  }
  // Background-image host: no intrinsic size is available without loading the
  // image, so use the rendered box as a proxy (§7.1 v1). This makes the natural
  // check reduce to the rendered check — safe (won't translate tiny bg icons).
  return {
    renderedW: rect.width,
    renderedH: rect.height,
    naturalW: rect.width,
    naturalH: rect.height,
    viewportW,
    centerX: rect.left + rect.width / 2,
  };
}

/** Default DOM URL resolver: `currentSrc`/`src` for `<img>`, else background-image. */
function defaultResolveUrl(el: Element): string | null {
  if (el instanceof HTMLImageElement) {
    // WHY currentSrc: it reflects the srcset candidate the browser actually
    // chose; fall back to src when srcset isn't in play.
    return el.currentSrc || el.src || null;
  }
  const raw = parseCssUrl(getComputedStyle(el).backgroundImage);
  if (!raw) return null;
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return null;
  }
}

/** Default DOM element collector: every `<img>` plus elements with a bg image. */
function defaultCollectElements(): Element[] {
  const els: Element[] = Array.from(document.images);
  // Background-image hosts are rarer; a broad querySelector then a computed-style
  // check in resolveUrl keeps this cheap enough for a debounced rescan.
  for (const el of document.querySelectorAll<HTMLElement>("*")) {
    if (el instanceof HTMLImageElement) continue;
    // WHY rect before getComputedStyle: getComputedStyle is the expensive call on
    // a 10k-element DOM, while layout is already clean at this point, so a cheap
    // rect read lets us skip the sub-threshold majority (which isCandidate would
    // reject anyway) before ever touching computed style (item 4).
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_RENDERED_PX || rect.height < MIN_RENDERED_PX) continue;
    const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none" && bg.includes("url(")) els.push(el);
  }
  return els;
}

/**
 * Build the candidate scanner (§7.1). Reconciles the document's images against a
 * registry on every scan, firing {@link ScannerCallbacks.onAdded} /
 * {@link ScannerCallbacks.onRemoved} for the deltas. A debounced
 * MutationObserver (childList + subtree + `src`/`srcset`/`style` attributes) and
 * a `popstate` listener drive re-scans for lazy-loading readers and SPA soft
 * navigations.
 *
 * WHY no `history.pushState` monkey-patch: patching page globals from an
 * isolated content world is exactly the host-page interference handoff rule 6
 * forbids; the MutationObserver already catches the DOM swap a soft navigation
 * produces, and `popstate` covers back/forward.
 *
 * @param opts callbacks plus optional DOM seams (defaulted to real DOM access).
 */
export function createScanner(opts: ScannerOptions): Scanner {
  const readMetrics = opts.readMetrics ?? defaultReadMetrics;
  const resolveUrl = opts.resolveUrl ?? defaultResolveUrl;
  const collectElements = opts.collectElements ?? defaultCollectElements;

  /** Registry: element → its live candidate (with the URL we registered it at). */
  const registry = new Map<Element, Candidate>();
  let idCounter = 0;
  let started = false;

  let mutationObserver: MutationObserver | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the first mutation of the current un-run burst was seen (max-wait). */
  let firstScheduledAt: number | undefined;
  let onPopstate: (() => void) | undefined;

  const nextId = (): string => `mangalens-cand-${++idCounter}`;

  const scan = (): void => {
    const seen = new Set<Element>();
    // WHY not sorted by score: the viewport queue re-inserts every candidate into
    // document order (`insertInDocOrder`), so registration order has no observable
    // effect on prefetch or priority — a sort here would be dead code. scoreCandidate
    // is reserved for the §7.1 main-image ranking a later consumer will use (Phase 7).
    const found: Array<{ el: Element; url: string }> = [];

    for (const el of collectElements()) {
      const metrics = readMetrics(el);
      if (!metrics || !isCandidate(metrics)) continue;
      const url = resolveUrl(el);
      if (classifyImageUrl(url) !== "accept" || !url) continue;
      found.push({ el, url });
    }

    for (const { el, url } of found) {
      seen.add(el);
      const existing = registry.get(el);
      if (existing) {
        if (existing.url === url) continue; // unchanged — already registered
        // In-place `src` swap: tear down the old registration, register anew so
        // the stale overlay is dropped and the new image is re-translated.
        registry.delete(el);
        safe(() => opts.onRemoved(existing));
      }
      const candidate: Candidate = { id: nextId(), el, url };
      registry.set(el, candidate);
      safe(() => opts.onAdded(candidate));
    }

    // Prune candidates whose element vanished from the DOM or stopped qualifying.
    for (const [el, candidate] of [...registry]) {
      if (seen.has(el)) continue;
      registry.delete(el);
      safe(() => opts.onRemoved(candidate));
    }
  };

  const scheduleScan = (): void => {
    const now = Date.now();
    if (firstScheduledAt === undefined) firstScheduledAt = now;
    const delay = computeRescanDelay(
      now,
      firstScheduledAt,
      RESCAN_DEBOUNCE_MS,
      RESCAN_MAX_WAIT_MS,
    );
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      firstScheduledAt = undefined;
      safe(scan);
    }, delay);
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      safe(scan);

      mutationObserver = new MutationObserver((records) => {
        // Drop records produced by our own overlay hosts (the OverlayManager
        // rewrites host `style` on every scroll/resize sync); if a burst is
        // ENTIRELY our own hosts, it must not schedule a re-scan (item 4). A
        // real page mutation in the same burst still gets through.
        if (records.every((r) => isOwnOverlayHost(r.target))) return;
        scheduleScan();
      });
      mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "style"],
      });

      onPopstate = () => scheduleScan();
      window.addEventListener("popstate", onPopstate);
    },

    scan(): void {
      safe(scan);
    },

    stop(): void {
      started = false;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      firstScheduledAt = undefined;
      mutationObserver?.disconnect();
      mutationObserver = undefined;
      if (onPopstate) {
        window.removeEventListener("popstate", onPopstate);
        onPopstate = undefined;
      }
      registry.clear();
    },
  };
}

/**
 * Run `fn`, swallowing and console-grouping any throw. WHY: the scanner runs on
 * arbitrary, possibly hostile pages; an exception in a callback or a getter must
 * degrade to "no candidate", never break the host page (handoff rule 6).
 */
function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn("scanner step failed (degrading to no candidate)", err);
  }
}
