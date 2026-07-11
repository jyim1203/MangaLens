/**
 * Drag-select region translation (F10) — the universal fallback (§7.3, Phase 5
 * scoping). The user drags a rectangle over ANY image (including the `blob:` /
 * `<canvas>` sources the scanner skips), and just that crop is translated.
 *
 * Split per the pure-core / thin-shell rule:
 *  - PURE, unit-tested: the rect math ({@link normalizeDragRect},
 *    {@link selectionToImageBbox}, {@link pickTargetImage}, {@link isClickNotDrag}).
 *    Source classification + byte acquisition live in the shared
 *    {@link import("./imageSource")} module (Phase 7.2 — the auto pipeline reuses
 *    them for blob-sourced pages), not here. All browser-free.
 *  - THIN shell: {@link createRegionSelector} — the full-viewport marquee overlay
 *    (the FIRST deliberately-interactive surface we put on a host page, §7.2
 *    exception), pointer/keyboard listeners, byte acquisition (fetch/canvas), and
 *    the send → overlay wiring. Reuses {@link OverlaySink} (the overlay manager),
 *    so region results render exactly like auto-detected pages (Phase 7 item 4).
 *
 * WHY the anchor is stored in PAGE coordinates, not client: if the user scrolls
 * mid-drag (wheel while holding the button), a client-coord anchor would silently
 * shift the selection relative to the page content. Page coords are
 * scroll-invariant, so the crop stays glued to the artwork (the §8 "scrolled
 * pages" case).
 */
import { createLogger } from "../shared/log";
import { sendToBackground } from "../shared/messages";
import { OVERLAY_HOST_ATTR } from "../shared/constants";
import { t as defaultT } from "../shared/i18n";
import type { BBox, ProviderErrorKind } from "../shared/types";
import { MIN_RENDERED_PX, parseCssUrl, type Candidate } from "./scanner";
import {
  acquireBlobBytes,
  acquireCanvasBytes,
  acquisitionPlan,
  sourceKindForUrl,
  type SourceKind,
} from "./imageSource";
import type { OverlaySink } from "./viewportQueue";
import { withTimeout } from "./withTimeout";

const log = createLogger("region-select");

/** A page-space rectangle (CSS px, document-origin — includes scroll). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A page-space point (CSS px). */
export interface Point {
  x: number;
  y: number;
}

/** A drag smaller than this on either side is a click, not a selection. */
export const MIN_DRAG_PX = 8;

/** Generous timeout around the region `translateRegion` await (gap #8). */
export const REGION_REQUEST_TIMEOUT_MS = 120_000;

// --- Pure geometry ----------------------------------------------------------

/**
 * Build a normalized page-space rect from two drag points in ANY direction
 * (up-left drags must work). Pure.
 */
export function normalizeDragRect(anchor: Point, current: Point): Rect {
  return {
    left: Math.min(anchor.x, current.x),
    top: Math.min(anchor.y, current.y),
    width: Math.abs(current.x - anchor.x),
    height: Math.abs(current.y - anchor.y),
  };
}

/** True when a drag rect is too small to be a real selection (a click → cancel). */
export function isClickNotDrag(rect: Rect, minPx: number = MIN_DRAG_PX): boolean {
  return rect.width < minPx || rect.height < minPx;
}

/** Clamp a value to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Area of the intersection of two page-space rects (0 when disjoint). */
function intersectionArea(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return ix * iy;
}

/**
 * Convert a page-space selection into a normalized crop {@link BBox} relative to
 * an image's displayed rect (both in page CSS px, so browser zoom cancels out —
 * the §8 "zoomed pages" case). Clipped to the intersection; returns null when the
 * image is degenerate or the selection doesn't overlap it.
 *
 * @param selection the drag rect in page space.
 * @param image the image's rect in page space.
 * @returns the crop BBox (0–1 within the image), or null.
 */
export function selectionToImageBbox(selection: Rect, image: Rect): BBox | null {
  if (image.width <= 0 || image.height <= 0) return null;
  const ix1 = Math.max(selection.left, image.left);
  const iy1 = Math.max(selection.top, image.top);
  const ix2 = Math.min(selection.left + selection.width, image.left + image.width);
  const iy2 = Math.min(selection.top + selection.height, image.top + image.height);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return null;
  return {
    x: clamp01((ix1 - image.left) / image.width),
    y: clamp01((iy1 - image.top) / image.height),
    w: clamp01(iw / image.width),
    h: clamp01(ih / image.height),
  };
}

/**
 * Index of the image whose rect best matches the selection: the largest
 * intersection area wins, ties broken by the larger image (its area) — the more
 * page-like target. Returns null when the selection intersects nothing. Pure.
 *
 * WHY area-tiebreak rather than the scanner's `scoreCandidate`: that scorer needs
 * viewport/centered metrics a bare {@link Rect} doesn't carry, and its dominant
 * term is rendered area anyway; the tie is a near-impossible edge (two images with
 * an identical intersection area), so the simpler proxy is honest here.
 *
 * @param selection the drag rect in page space.
 * @param imageRects candidate image rects in page space (see {@link RegionTarget}).
 */
export function pickTargetImage(
  selection: Rect,
  imageRects: readonly Rect[],
): number | null {
  let best: number | null = null;
  let bestArea = 0;
  let bestSize = 0;
  for (let i = 0; i < imageRects.length; i++) {
    const rect = imageRects[i];
    if (!rect) continue;
    const area = intersectionArea(selection, rect);
    if (area <= 0) continue;
    const size = rect.width * rect.height;
    if (area > bestArea || (area === bestArea && size > bestSize)) {
      best = i;
      bestArea = area;
      bestSize = size;
    }
  }
  return best;
}

// --- Shell (untested) -------------------------------------------------------

/** One drag-select target: an element + its page rect + how to acquire its bytes. */
export interface RegionTarget {
  el: Element;
  rect: Rect;
  kind: SourceKind;
  /** Source URL for `img-*` kinds (absent for canvas). */
  url?: string;
}

/** The byte payload for a `translateRegion` message, minus the crop/requestId. */
type RegionSource =
  | { imageUrl: string }
  | { imageBytes: ArrayBuffer; imageMime: string };

/** A live region-select controller. */
export interface RegionSelector {
  /** Enter selection mode (one-shot; ignored if already selecting). */
  start(): void;
  /** Tear down any in-progress selection AND cancel in-flight region requests. */
  stop(): void;
  /** True while the crosshair overlay is showing. */
  isActive(): boolean;
}

/** Options for {@link createRegionSelector}. */
export interface RegionSelectorOptions {
  /** Overlay sink (the OverlayManager) — region results render like pages. */
  overlay: OverlaySink;
  /** Toast an actionable provider error (auth/rate-limit) — policy applies. */
  onError?: (kind: ProviderErrorKind) => void;
  /** Toast a one-off notice ("no image under selection", "can't access this image"). */
  onNotice?: (message: string) => void;
  /** Enumerate drag-select targets (default: DOM walk of img/canvas/bg-image). */
  collectTargets?: () => RegionTarget[];
  /** Read a blob/canvas target's bytes (default: fetch / canvas.toBlob). Seam for tests. */
  acquireSource?: (target: RegionTarget) => Promise<RegionSource>;
  /** Request-id factory (default `crypto.randomUUID()`). */
  makeRequestId?: () => string;
  /** Per-request timeout (ms); default {@link REGION_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** i18n lookup (default the shared {@link defaultT}). */
  t?: typeof defaultT;
}

/**
 * Build the drag-select controller (F10). Only meaningful while the gate is
 * active — the content composition root creates it on activate and {@link stop}s
 * it on deactivate (which also tears down an in-progress selection, handoff item 1).
 */
export function createRegionSelector(opts: RegionSelectorOptions): RegionSelector {
  const overlay = opts.overlay;
  const tr = opts.t ?? defaultT;
  const makeRequestId = opts.makeRequestId ?? (() => crypto.randomUUID());
  const collectTargets = opts.collectTargets ?? defaultCollectTargets;
  const acquireSource = opts.acquireSource ?? defaultAcquireSource;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REGION_REQUEST_TIMEOUT_MS;

  // Marquee session state (only one selection at a time).
  let host: HTMLElement | undefined;
  let marquee: HTMLElement | undefined;
  let anchor: Point | undefined;
  let lastClient: Point | undefined;
  let pointerId: number | undefined;
  /** Region requestIds still in flight, so stop()/deactivate can cancel them. */
  const inflight = new Set<string>();

  /** Draw the marquee from the current page-space end point. */
  const drawMarquee = (currentPage: Point): void => {
    if (!marquee || !anchor) return;
    const rect = normalizeDragRect(anchor, currentPage);
    // The marquee lives in the fixed host (viewport space) → subtract scroll.
    Object.assign(marquee.style, {
      left: `${rect.left - window.scrollX}px`,
      top: `${rect.top - window.scrollY}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: "block",
    } satisfies Partial<CSSStyleDeclaration>);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (anchor) return; // already dragging
    // WHY primary/left-only: a right-button drag would start a marquee UNDER the
    // native context menu opening on top of the crosshair, and a non-primary
    // pointer (a second finger) shouldn't anchor a fresh drag.
    if (!e.isPrimary || e.button !== 0) return;
    anchor = { x: e.pageX, y: e.pageY };
    lastClient = { x: e.clientX, y: e.clientY };
    pointerId = e.pointerId;
    // WHY setPointerCapture: a drag that leaves the window still delivers
    // move/up to the host so the selection finishes cleanly.
    try {
      host?.setPointerCapture(e.pointerId);
    } catch {
      /* not fatal — capture is a nicety */
    }
    drawMarquee(anchor);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!anchor) return;
    // Ignore a different pointer (multi-touch): only the anchored one drives the drag.
    if (pointerId !== undefined && e.pointerId !== pointerId) return;
    lastClient = { x: e.clientX, y: e.clientY };
    drawMarquee({ x: e.pageX, y: e.pageY });
  };

  const onScroll = (): void => {
    // Scrolling mid-drag: the pointer stayed put in client space but the page
    // moved under it — recompute the end point in page space so the marquee stays
    // glued to the artwork.
    if (!anchor || !lastClient) return;
    drawMarquee({
      x: lastClient.x + window.scrollX,
      y: lastClient.y + window.scrollY,
    });
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!anchor) return;
    // A second finger's pointerup (different pointerId) must not finalize the
    // FIRST finger's in-progress drag using the wrong coordinates.
    if (pointerId !== undefined && e.pointerId !== pointerId) return;
    const end: Point = { x: e.pageX, y: e.pageY };
    const rect = normalizeDragRect(anchor, end);
    teardown();
    // A tiny click-drag is an escape, not a 2-px translation request.
    if (isClickNotDrag(rect)) return;
    void finalizeSelection(rect);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    // WHY handle pointercancel (invisible in mouse-only testing): if the browser
    // cancels the pointer mid-drag — touch scroll/pinch takeover, the OS stealing
    // the pointer, capture loss — `pointerup` never arrives and `anchor` would stay
    // set. The marquee would then follow a button-less mouse on every move, and the
    // NEXT plain click would finalize a selection the user thought was dead (an
    // unintended paid translation). Treat it exactly like Esc: full teardown (the
    // mode is one-shot anyway).
    if (!anchor || (pointerId !== undefined && e.pointerId !== pointerId)) return;
    teardown();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      teardown();
    }
  };

  /** Resolve the target + crop and fire the region translation. */
  async function finalizeSelection(selection: Rect): Promise<void> {
    let targets: RegionTarget[];
    try {
      targets = collectTargets();
    } catch (err) {
      log.warn("collecting drag-select targets failed", err);
      return;
    }
    const idx = pickTargetImage(selection, targets.map((tg) => tg.rect));
    if (idx === null) {
      opts.onNotice?.(tr("regionNoImage", undefined, "MangaLens: no image under the selection"));
      return;
    }
    const target = targets[idx];
    if (!target) return;
    const crop = selectionToImageBbox(selection, target.rect);
    if (!crop) {
      opts.onNotice?.(tr("regionTooSmall", undefined, "MangaLens: selection too small"));
      return;
    }
    await translateCrop(target, crop);
  }

  /** Acquire bytes/URL, send `translateRegion`, and render the result. */
  async function translateCrop(target: RegionTarget, crop: BBox): Promise<void> {
    const candidate: Candidate = {
      id: `region-${makeRequestId()}`,
      el: target.el,
      url: target.url ?? "region:",
    };
    safe(() => overlay.setPending(candidate));

    let source: RegionSource;
    try {
      source = await acquireSource(target);
    } catch (err) {
      // Tainted canvas / unreadable blob (§7.3): fail soft with a notice.
      log.warn("region byte acquisition failed", err);
      safe(() => overlay.clear(candidate));
      opts.onNotice?.(tr("regionCantAccess", undefined, "MangaLens: can't access this image"));
      return;
    }

    const requestId = makeRequestId();
    inflight.add(requestId);
    try {
      const result = await withTimeout(
        sendToBackground("translateRegion", { ...source, crop, requestId }),
        requestTimeoutMs,
      );
      inflight.delete(requestId);
      if (result.ok) {
        safe(() => overlay.render(candidate, result.page));
      } else if (result.errorKind === "aborted") {
        safe(() => overlay.clear(candidate)); // cancelled — silent
      } else {
        safe(() => overlay.setError(candidate, result.errorKind));
        if (opts.onError) safe(() => opts.onError!(result.errorKind));
      }
    } catch (err) {
      // Timeout / channel death (event page unloaded mid-request, gap #8).
      inflight.delete(requestId);
      log.warn("region translate request failed", err);
      safe(() => overlay.clear(candidate));
      // WHY also cancel: if the event page is alive but merely slow/saturated (not
      // dead), the provider call keeps running — and unlike the viewport queue's
      // timeout path a region result is NEVER cached, so that orphan run is pure
      // wasted spend for a result nobody will render. Fire-and-forget, same pattern
      // as stop(); a truly-dead event page makes the unknown id a silent no-op (the
      // existing cancelTranslation contract).
      void sendToBackground("cancelTranslation", { requestId }).catch((e) =>
        log.warn("region cancelTranslation failed", e),
      );
    }
  }

  /** Build the crosshair overlay + wire listeners. */
  function open(): void {
    host = document.createElement("div");
    host.setAttribute(OVERLAY_HOST_ATTR, "region-select"); // scanner skips our hosts
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      // WHY interactive (the §7.2 exception): this surface must receive the drag.
      pointerEvents: "auto",
      // Do NOT trap scroll — the page must keep scrolling under the overlay.
    } satisfies Partial<CSSStyleDeclaration>);

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = REGION_STYLES;
    shadow.appendChild(style);

    marquee = document.createElement("div");
    marquee.className = "mangalens-marquee";
    marquee.style.display = "none";
    shadow.appendChild(marquee);

    const hint = document.createElement("div");
    hint.className = "mangalens-region-hint";
    hint.textContent = tr("regionSelectHint", undefined, "Drag to select · Esc to cancel");
    shadow.appendChild(hint);

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
    // Passive scroll: we redraw the marquee, never preventDefault (page scrolls on).
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });

    document.body.appendChild(host);
  }

  /** Remove the crosshair overlay + listeners (does NOT cancel in-flight requests). */
  function teardown(): void {
    if (!host) return;
    if (pointerId !== undefined) {
      try {
        host.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, {
      capture: true,
    } as EventListenerOptions);
    try {
      host.remove();
    } catch (err) {
      log.warn("failed to remove region-select host", err);
    }
    host = undefined;
    marquee = undefined;
    anchor = undefined;
    lastClient = undefined;
    pointerId = undefined;
  }

  return {
    start(): void {
      if (host) return; // one-shot; already selecting
      safe(open);
    },
    stop(): void {
      teardown();
      // Cancel any in-flight region requests (teardown/disable, item 4 parity).
      for (const requestId of inflight) {
        void sendToBackground("cancelTranslation", { requestId }).catch((err) =>
          log.warn("region cancelTranslation failed", err),
        );
      }
      inflight.clear();
    },
    isActive(): boolean {
      return host !== undefined;
    },
  };
}

/** Default DOM target collector: `<img>` + `<canvas>` + background-image hosts. */
function defaultCollectTargets(): RegionTarget[] {
  const targets: RegionTarget[] = [];
  const sx = window.scrollX;
  const sy = window.scrollY;

  const add = (el: Element, kind: SourceKind, url?: string): void => {
    if (kind === "unsupported") return;
    const r = el.getBoundingClientRect();
    // Reuse the scanner's rendered-size floor; drag-select drops the natural-size
    // check (canvas/blob may have no intrinsic size).
    if (r.width < MIN_RENDERED_PX || r.height < MIN_RENDERED_PX) return;
    targets.push({
      el,
      kind,
      url,
      rect: { left: r.left + sx, top: r.top + sy, width: r.width, height: r.height },
    });
  };

  for (const img of Array.from(document.images)) {
    const url = img.currentSrc || img.src || "";
    add(img, sourceKindForUrl(url), url || undefined);
  }
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    add(canvas, "canvas");
  }
  // Background-image hosts (the scanner accepts these; resolve their URL scheme).
  for (const el of document.querySelectorAll<HTMLElement>("*")) {
    if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) continue;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_RENDERED_PX || r.height < MIN_RENDERED_PX) continue;
    const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none" || !bg.includes("url(")) continue;
    const raw = parseCssUrl(bg);
    if (!raw) continue;
    let abs: string;
    try {
      abs = new URL(raw, document.baseURI).href;
    } catch {
      continue;
    }
    add(el, sourceKindForUrl(abs), abs);
  }
  return targets;
}

/**
 * Default byte acquisition: URL for http/data, read bytes for blob/canvas — a
 * thin dispatcher over the shared {@link import("./imageSource")} primitives
 * (identical behavior to pre-7.2; the primitives just moved).
 */
async function defaultAcquireSource(target: RegionTarget): Promise<RegionSource> {
  const plan = acquisitionPlan(target.kind);
  if (plan.send === "url") {
    return { imageUrl: target.url as string };
  }
  if (plan.send === "bytes") {
    return target.kind === "canvas"
      ? acquireCanvasBytes(target.el as HTMLCanvasElement)
      : acquireBlobBytes(target.url as string);
  }
  throw new Error("unsupported region source");
}

/** Swallow + log any throw so a listener can never break the host page (rule 6). */
function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn("region-select step failed", err);
  }
}

/** Crosshair-overlay styles, injected into the region-select shadow root only. */
const REGION_STYLES = `
.mangalens-marquee {
  position: absolute;
  border: 1.5px solid #6c74f2;
  background: rgba(108, 116, 242, 0.18);
  pointer-events: none;
  box-sizing: border-box;
}
.mangalens-region-hint {
  position: fixed;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  background: rgba(20, 20, 24, 0.88);
  color: #f2f2f5;
  font: 12px/1.4 system-ui, sans-serif;
  padding: 6px 12px;
  border-radius: 999px;
  pointer-events: none;
  user-select: none;
}
`;
