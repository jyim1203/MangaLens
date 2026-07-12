/**
 * Object-fit-aware drawn-bitmap geometry (Phase 7.3).
 *
 * A replaced element (`<img>`/`<canvas>`) does NOT necessarily draw its bitmap
 * across its whole element box: under `object-fit: contain`/`cover`/`none`/
 * `scale-down` the bitmap is scaled and letterboxed/overflowed inside the content
 * box, positioned by `object-position`. Every overlay geometry consumer used to
 * treat the element box (`getBoundingClientRect`) as the drawn bitmap — true only
 * under the default `object-fit: fill`. On a "Fit Both" reader (`contain`) that
 * stretched every normalized bbox across the whole element box, so bubbles landed
 * off the artwork and spilled into the letterbox bars. This module computes where
 * the bitmap actually draws.
 *
 * Split per the repo's pure-core / thin-shell rule:
 *  - PURE, exhaustively tested: {@link computeContentBox} (the CSS object-fit
 *    math), {@link parseObjectPosition} (computed-value parse), and
 *    {@link insetContentBox} (border-box → content-box). All browser-free.
 *  - THIN, untested shell: {@link readContentBox} — the ONE place that reads the
 *    DOM (`getBoundingClientRect` + one `getComputedStyle`) and delegates every
 *    decision to the pure functions. Fails soft to the element rect (rule 4: the
 *    fallback IS the pre-Phase-7.3 status quo).
 */
import type { PxRect } from "./geometry";

/** The CSS `object-fit` values we resolve. */
export type ObjectFit = "fill" | "contain" | "cover" | "none" | "scale-down";

/**
 * One resolved `object-position` component: either a fraction of the free space
 * (a `%` value, e.g. `50%` → `0.5`) or an absolute px offset. Same semantics as a
 * `background-position` component.
 */
export type PositionComponent =
  | { kind: "fraction"; value: number }
  | { kind: "px"; value: number };

/** A rectangle in some local coordinate space (px). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The four edge widths of a border or padding (CSS px). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Center default for a missing/unparseable position component. */
const CENTER: PositionComponent = { kind: "fraction", value: 0.5 };

/** Resolve one position component against the free space along its axis. */
function resolvePosition(component: PositionComponent, free: number): number {
  // WHY no special-case for negative free: under cover/none the drawn bitmap is
  // larger than the box so `free` is negative; `fraction × free` then yields a
  // negative offset (the bitmap overflows), which is exactly correct.
  return component.kind === "fraction" ? component.value * free : component.value;
}

/**
 * Where a replaced element draws its bitmap inside its CONTENT box, per the CSS
 * `object-fit`/`object-position` spec. Offsets are in the content box's local
 * coordinates (0,0 = content box top-left) and can be negative under
 * `cover`/`none` when the bitmap overflows.
 *
 * Degenerate inputs (natural or box size ≤ 0, or any non-finite value) return the
 * full content box — i.e. the `fill` result. // WHY: that equals the pre-Phase-7.3
 * behavior, so a broken/undecoded image can never render WORSE than the status quo
 * (rule 4).
 *
 * @param boxW content-box width (CSS px).
 * @param boxH content-box height (CSS px).
 * @param naturalW intrinsic bitmap width (px).
 * @param naturalH intrinsic bitmap height (px).
 * @param fit the resolved `object-fit`.
 * @param posX resolved horizontal `object-position` component.
 * @param posY resolved vertical `object-position` component.
 * @returns the drawn bitmap rect in content-box-local coordinates.
 */
export function computeContentBox(
  boxW: number,
  boxH: number,
  naturalW: number,
  naturalH: number,
  fit: ObjectFit,
  posX: PositionComponent,
  posY: PositionComponent,
): Box {
  const fillResult: Box = { left: 0, top: 0, width: boxW, height: boxH };
  if (
    !Number.isFinite(boxW) ||
    !Number.isFinite(boxH) ||
    !Number.isFinite(naturalW) ||
    !Number.isFinite(naturalH) ||
    boxW <= 0 ||
    boxH <= 0 ||
    naturalW <= 0 ||
    naturalH <= 0
  ) {
    return fillResult;
  }
  if (fit === "fill") return fillResult;

  const containScale = Math.min(boxW / naturalW, boxH / naturalH);
  let scale: number;
  switch (fit) {
    case "contain":
      scale = containScale;
      break;
    case "cover":
      scale = Math.max(boxW / naturalW, boxH / naturalH);
      break;
    case "none":
      scale = 1;
      break;
    case "scale-down":
      scale = Math.min(1, containScale);
      break;
    default:
      // Unknown fit → fill (fail soft; TypeScript makes this unreachable).
      return fillResult;
  }

  const drawnW = naturalW * scale;
  const drawnH = naturalH * scale;
  return {
    left: resolvePosition(posX, boxW - drawnW),
    top: resolvePosition(posY, boxH - drawnH),
    width: drawnW,
    height: drawnH,
  };
}

/** Parse ONE computed `object-position` token (`"50%"`, `"12px"`, or garbage). */
function parseComponent(raw: string | undefined): PositionComponent {
  if (!raw) return CENTER;
  if (raw.endsWith("%")) {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? { kind: "fraction", value: n / 100 } : CENTER;
  }
  if (raw.endsWith("px")) {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? { kind: "px", value: n } : CENTER;
  }
  // calc(), keywords that didn't resolve, exotic units → center fallback.
  return CENTER;
}

/**
 * Parse a COMPUTED `object-position` value into its two components.
 *
 * The input is the getComputedStyle value, which Firefox has already resolved to
 * lengths/percentages (e.g. `"50% 50%"`, `"0px 12px"`, `"25% 10px"`) — keywords
 * like `left`/`top` are gone by computed-value time, so we only handle `%` and
 * `px`. A missing second component defaults to `50%`; anything unparseable
 * (`calc(...)`, exotic units) falls back to center. // WHY parse the computed
 * value rather than author keywords: getComputedStyle already did the keyword →
 * percentage resolution, so re-implementing `left top` handling would be dead code.
 *
 * @param computed the computed `object-position` string.
 * @returns the `[x, y]` components.
 */
export function parseObjectPosition(
  computed: string,
): [PositionComponent, PositionComponent] {
  const parts = computed.trim().split(/\s+/);
  const x = parseComponent(parts[0]);
  const y = parts.length > 1 ? parseComponent(parts[1]) : CENTER;
  return [x, y];
}

/**
 * Convert a border-box rect (from `getBoundingClientRect`) to the element's
 * CONTENT box by subtracting the border + padding widths. `object-fit` lays out
 * within the content box, not the border box; manga readers rarely pad an `<img>`,
 * but a 1 px border shifting every bubble is exactly the off-by-a-little this
 * phase exists to kill.
 *
 * @param rect the border-box rect (client coords).
 * @param borders the four border widths.
 * @param paddings the four padding widths.
 * @returns the content-box rect (client coords).
 */
export function insetContentBox(rect: Box, borders: Insets, paddings: Insets): Box {
  return {
    left: rect.left + borders.left + paddings.left,
    top: rect.top + borders.top + paddings.top,
    width: rect.width - borders.left - borders.right - paddings.left - paddings.right,
    height: rect.height - borders.top - borders.bottom - paddings.top - paddings.bottom,
  };
}

/** Coerce a computed `object-fit` string to a known value (unknown → `fill`). */
function normalizeObjectFit(value: string): ObjectFit {
  switch (value) {
    case "contain":
    case "cover":
    case "none":
    case "scale-down":
      return value;
    default:
      // "fill" and anything unexpected → the identity (status quo) path.
      return "fill";
  }
}

/** Read one computed px length; non-numeric (e.g. "auto") → 0. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The drawn bitmap's rect in CLIENT coordinates for an element — the ONE DOM read
 * for object-fit geometry.
 *
 * For `<img>` (intrinsic size from `naturalWidth/Height`; 0 while undecoded falls
 * through to {@link computeContentBox}'s fill fallback) and `<canvas>` (from
 * `width/height` — object-fit applies to canvas too, and drag-select accepts
 * canvas targets), it reads `getBoundingClientRect()` + one `getComputedStyle()`
 * (objectFit, objectPosition, border + padding widths), insets to the content box,
 * and returns the bitmap's client rect. For every other element (background-image
 * hosts have no intrinsic size we can read without loading) it returns the plain
 * element rect unchanged.
 *
 * Fails soft (rule 4): any throw degrades to the element rect — the status quo. //
 * WHY client coords: both overlay call sites (positioning, peek hit-testing) work
 * in client space; regionSelect adds scroll itself, exactly as it does today.
 *
 * @param el the element to measure.
 * @returns the drawn-bitmap client rect, or null if even the element rect can't be
 *   read.
 */
export function readContentBox(el: Element): PxRect | null {
  try {
    const rect = el.getBoundingClientRect();
    const border: Box = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };

    let naturalW: number;
    let naturalH: number;
    if (el instanceof HTMLImageElement) {
      naturalW = el.naturalWidth;
      naturalH = el.naturalHeight;
    } else if (el instanceof HTMLCanvasElement) {
      naturalW = el.width;
      naturalH = el.height;
    } else {
      // Background-image host or other: no readable intrinsic size → element rect.
      return border;
    }

    const cs = getComputedStyle(el);
    const fit = normalizeObjectFit(cs.objectFit);
    const [posX, posY] = parseObjectPosition(cs.objectPosition);
    const borders: Insets = {
      top: px(cs.borderTopWidth),
      right: px(cs.borderRightWidth),
      bottom: px(cs.borderBottomWidth),
      left: px(cs.borderLeftWidth),
    };
    const paddings: Insets = {
      top: px(cs.paddingTop),
      right: px(cs.paddingRight),
      bottom: px(cs.paddingBottom),
      left: px(cs.paddingLeft),
    };

    const content = insetContentBox(border, borders, paddings);
    const drawn = computeContentBox(
      content.width,
      content.height,
      naturalW,
      naturalH,
      fit,
      posX,
      posY,
    );
    // computeContentBox offsets are content-box-local; lift them into client coords.
    return {
      left: content.left + drawn.left,
      top: content.top + drawn.top,
      width: drawn.width,
      height: drawn.height,
    };
  } catch {
    // Fail soft: the element rect is the pre-Phase-7.3 behavior.
    try {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }
}
