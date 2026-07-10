/**
 * Shadow-DOM overlay manager: one host element per translated image (§7.2).
 *
 * Thin browser shell — every *decision* it makes is delegated to a tested pure
 * helper ({@link regionToPx}, {@link filterRegions}, {@link errorKindToMessage},
 * {@link resolveFontSize} via BubbleBox). It owns the DOM lifecycle: host
 * creation/teardown, position sync, and state (pending / done / error).
 *
 * WHY host appended to `document.body`, not a sibling of the image: inserting a
 * sibling mutates the reader's own layout (`:last-child`, flex/grid item counts)
 * — handoff rule 6 forbids observable interference. WHY an OPEN shadow root:
 * debuggability; `closed` buys nothing against a page that can already see the
 * host node. Styles live only inside each shadow root (never the page document).
 */
import styles from "../styles.css?inline";
import { createLogger } from "../../shared/log";
import { OVERLAY_HOST_ATTR } from "../../shared/constants";
import type { Settings } from "../../shared/settings";
import type { PageTranslation } from "../../shared/types";
import type { Candidate } from "../scanner";
import { displayedSizeChanged, regionToPx, type Size } from "./geometry";
import { filterRegions } from "./regionFilter";
import { errorKindToMessage } from "./errorMessages";
import { createShadowMeasurer, renderBubbleBox } from "./BubbleBox";
import type { ProviderErrorKind } from "../../shared/types";

const log = createLogger("overlay");

/** Options for {@link OverlayManager}. */
export interface OverlayManagerOptions {
  settings: Settings;
  /** Host page hostname, for the watermark filter (PROMPTS §9). */
  hostname: string;
  /** Called when an overlay notices its image left the DOM (viewport queue then
   *  cancels + unregisters). */
  onImageGone?: (candidateId: string) => void;
}

type OverlayState = "pending" | "done" | "error";

interface OverlayEntry {
  candidate: Candidate;
  host: HTMLElement;
  shadow: ShadowRoot;
  container: HTMLElement;
  measureEl: HTMLElement;
  resizeObserver?: ResizeObserver;
  onImgLoad?: () => void;
  state: OverlayState;
  /** Last rendered page, kept so a font/settings change can re-render in place. */
  page?: PageTranslation;
  /** Displayed image size at the last {@link OverlayManager.paint}, so a resize
   *  (window/zoom/re-flow) can re-run layout only when it actually changed
   *  (item 1). Undefined until the entry has been painted at least once. */
  lastPaintedSize?: Size;
}

/**
 * Manages all image overlays for the active page. Satisfies the viewport queue's
 * `OverlaySink` ({@link setPending} / {@link render} / {@link setError} /
 * {@link clear}).
 */
export class OverlayManager {
  private settings: Settings;
  private readonly hostname: string;
  private readonly onImageGone?: (candidateId: string) => void;
  private readonly entries = new Map<string, OverlayEntry>();
  private started = false;

  /** rAF coalescing state for position syncs (item 1). */
  private syncScheduled = false;
  private rafHandle: number | undefined;

  // WHY coalesce through one rAF: the capture-phase scroll listener and every
  // per-image ResizeObserver would otherwise do a getBoundingClientRect + style
  // write *per event*. We instead mark dirty and sync once per frame — one rect
  // read + style write per entry per frame, which also throttles the repaint
  // churn a continuous drag-resize's ResizeObserver loop would produce.
  private readonly onScrollOrResize = (): void => this.scheduleSync();

  constructor(opts: OverlayManagerOptions) {
    this.settings = opts.settings;
    this.hostname = opts.hostname;
    this.onImageGone = opts.onImageGone;
  }

  /** Attach the shared scroll/resize listeners. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // One passive listener pair shared by ALL overlays (§7.2 — not per-overlay).
    window.addEventListener("scroll", this.onScrollOrResize, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", this.onScrollOrResize, { passive: true });
  }

  /** Show the pending skeleton for a candidate (creating its host if needed). */
  setPending(candidate: Candidate): void {
    const entry = this.ensure(candidate);
    if (!entry) return;
    entry.state = "pending";
    entry.page = undefined;
    this.clearContent(entry);
    const skeleton = document.createElement("div");
    skeleton.className = "mangalens-skeleton";
    entry.container.appendChild(skeleton);
    this.positionEntry(entry);
  }

  /** Render a finished translation (filters + fits + draws bubbles). */
  render(candidate: Candidate, page: PageTranslation): void {
    const entry = this.ensure(candidate);
    if (!entry) return;
    entry.state = "done";
    entry.page = page;
    this.paint(entry);
  }

  /** Show the ⚠ error badge; `aborted` renders nothing (silent). */
  setError(candidate: Candidate, errorKind: ProviderErrorKind): void {
    const message = errorKindToMessage(errorKind);
    if (message === null) {
      // aborted → render nothing; drop any host we may have created.
      this.clear(candidate);
      return;
    }
    const entry = this.ensure(candidate);
    if (!entry) return;
    entry.state = "error";
    entry.page = undefined;
    this.clearContent(entry);
    const badge = document.createElement("div");
    badge.className = "mangalens-badge";
    badge.textContent = "⚠";
    badge.title = message;
    entry.container.appendChild(badge);
    this.positionEntry(entry);
  }

  /** Remove a candidate's overlay entirely (teardown). */
  clear(candidate: Candidate): void {
    this.teardownEntry(candidate.id);
  }

  /**
   * Apply new settings. Font/rendering changes re-render existing `done`
   * overlays in place (§7.2 restyle path); the hostname is fixed for the page.
   */
  setSettings(settings: Settings): void {
    this.settings = settings;
    for (const entry of this.entries.values()) {
      if (entry.state === "done" && entry.page) this.paint(entry);
    }
  }

  /** Reposition (and re-paint if resized) every overlay now, synchronously. */
  syncPositions(): void {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.candidate.el.isConnected) {
        // Image left the DOM: tear down and let the queue cancel + unregister.
        this.teardownEntry(id);
        try {
          this.onImageGone?.(id);
        } catch (err) {
          log.warn("onImageGone handler threw", err);
        }
        continue;
      }
      this.syncEntry(entry);
    }
  }

  /** Mark positions dirty and flush once on the next animation frame (item 1). */
  private scheduleSync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = undefined;
        this.syncScheduled = false;
        this.syncPositions();
      });
    } else {
      // No rAF (non-browser/test env): fall back to a synchronous sync.
      this.syncScheduled = false;
      this.syncPositions();
    }
  }

  /**
   * Position one entry's host and, if it's a `done` overlay whose displayed size
   * changed since its last paint, re-paint it (item 1). WHY re-paint, not a CSS
   * transform-scale of the container: `auto`-size text must re-fit to the new box
   * and `fixed`-size text must NOT visually scale — only re-running textFit per
   * region gets both right. The size-changed test is the pure
   * {@link displayedSizeChanged}.
   */
  private syncEntry(entry: OverlayEntry): void {
    this.positionEntry(entry);
    if (entry.state !== "done" || !entry.page) return;
    const rect = entry.candidate.el.getBoundingClientRect();
    if (displayedSizeChanged(entry.lastPaintedSize, { w: rect.width, h: rect.height })) {
      this.paint(entry);
    }
  }

  /** Tear down every overlay and drop the shared listeners. */
  stop(): void {
    if (this.rafHandle !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = undefined;
    this.syncScheduled = false;
    for (const id of [...this.entries.keys()]) this.teardownEntry(id);
    if (this.started) {
      window.removeEventListener("scroll", this.onScrollOrResize, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("resize", this.onScrollOrResize);
      this.started = false;
    }
  }

  // --- internals -----------------------------------------------------------

  /** Get or create the overlay host for a candidate. Returns null on failure. */
  private ensure(candidate: Candidate): OverlayEntry | null {
    const existing = this.entries.get(candidate.id);
    if (existing) return existing;
    try {
      const host = document.createElement("div");
      // Marker the scanner uses to skip our own hosts' style mutations (item 4).
      host.setAttribute(OVERLAY_HOST_ATTR, candidate.id);
      Object.assign(host.style, {
        position: "absolute",
        margin: "0",
        padding: "0",
        border: "0",
        zIndex: "2147483646",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);

      const shadow = host.attachShadow({ mode: "open" });
      const styleEl = document.createElement("style");
      styleEl.textContent = styles;
      shadow.appendChild(styleEl);

      const container = document.createElement("div");
      container.className = "mangalens-container";
      shadow.appendChild(container);

      // Offscreen measuring element for auto-fit (BubbleBox reads scroll size).
      const measureEl = document.createElement("div");
      Object.assign(measureEl.style, {
        position: "absolute",
        left: "-99999px",
        top: "0",
        visibility: "hidden",
        whiteSpace: "normal",
        wordBreak: "break-word",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      shadow.appendChild(measureEl);

      document.body.appendChild(host);

      const entry: OverlayEntry = {
        candidate,
        host,
        shadow,
        container,
        measureEl,
        state: "pending",
      };

      // Re-sync on the image's own resize + late decode (load changes the rect).
      // Both route through the rAF-batched sync so a `done` overlay re-paints
      // (not just re-positions) when the displayed size changed (item 1).
      if (typeof ResizeObserver !== "undefined") {
        entry.resizeObserver = new ResizeObserver(() => this.scheduleSync());
        entry.resizeObserver.observe(candidate.el);
      }
      if (candidate.el instanceof HTMLImageElement) {
        entry.onImgLoad = () => this.scheduleSync();
        candidate.el.addEventListener("load", entry.onImgLoad);
      }

      this.entries.set(candidate.id, entry);
      this.positionEntry(entry);
      return entry;
    } catch (err) {
      // Fail soft (rule 6): no overlay, but never break the page.
      log.warn("failed to create overlay host", err);
      return null;
    }
  }

  /** Filter → fit → draw the bubbles for a `done` entry. */
  private paint(entry: OverlayEntry): void {
    const page = entry.page;
    if (!page) return;
    this.clearContent(entry);
    this.positionEntry(entry);

    const regions = filterRegions(page.regions, {
      hostname: this.hostname,
      translateSfx: this.settings.translateSfx,
    });
    const rect = entry.candidate.el.getBoundingClientRect();
    const displayedW = rect.width;
    const displayedH = rect.height;
    // Record the size we're painting against so a later resize re-paints only
    // when it actually changed (item 1, via displayedSizeChanged in syncEntry).
    entry.lastPaintedSize = { w: displayedW, h: displayedH };
    const makeMeasure = createShadowMeasurer(entry.measureEl, this.settings.font);

    for (const region of regions) {
      try {
        const px = regionToPx(region.bbox, displayedW, displayedH);
        const box = renderBubbleBox(region, px, this.settings.font, makeMeasure);
        entry.container.appendChild(box);
      } catch (err) {
        log.warn("failed to render region (skipping)", err);
      }
    }
  }

  /** Position an entry's host over its image (rect + page scroll offset, §7.2). */
  private positionEntry(entry: OverlayEntry): void {
    try {
      const rect = entry.candidate.el.getBoundingClientRect();
      // WHY rect + scroll: this assumes the host's containing block is the initial
      // one, anchored at the document origin. That holds while the host is a plain
      // body child, but breaks whenever `<body>`/`<html>` establishes a containing
      // block (e.g. `position: relative` on body, even the UA-default 8 px body
      // margin, or a transform/filter on body). Content-level transforms are fine —
      // the image's rect already reflects them and our host is outside that subtree.
      let left = rect.left + window.scrollX;
      let top = rect.top + window.scrollY;
      Object.assign(entry.host.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      } satisfies Partial<CSSStyleDeclaration>);

      // Item 2: measure the residual error and correct it — robust to every
      // containing-block cause at once, and idempotent (a correct position yields
      // a zero delta, so re-running does nothing). With the rAF batching above the
      // extra rect read is once per frame, not per scroll event.
      const hostRect = entry.host.getBoundingClientRect();
      const dx = hostRect.left - rect.left;
      const dy = hostRect.top - rect.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        left -= dx;
        top -= dy;
        entry.host.style.left = `${left}px`;
        entry.host.style.top = `${top}px`;
      }
    } catch (err) {
      log.warn("failed to position overlay", err);
    }
  }

  /** Remove all child content from an entry's container. */
  private clearContent(entry: OverlayEntry): void {
    entry.container.replaceChildren();
  }

  /** Fully tear down one entry: listeners, observer, and host node. */
  private teardownEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try {
      entry.resizeObserver?.disconnect();
      if (entry.onImgLoad && entry.candidate.el instanceof HTMLImageElement) {
        entry.candidate.el.removeEventListener("load", entry.onImgLoad);
      }
      entry.host.remove();
    } catch (err) {
      log.warn("failed to tear down overlay", err);
    }
  }
}
