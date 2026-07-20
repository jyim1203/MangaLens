/**
 * Phase 9 §4/§5/§7 — the PURE render decisions behind shaped bubble fills.
 * BubbleBox stays a thin DOM shell; everything it decides about a shape lives
 * here, browser-free and unit-tested:
 *  - {@link shapeToBoxPath}: image-normalized contour → box-local smoothed SVG
 *    path (the fill layer's `clip-path`).
 *  - {@link inscribedInnerRect}: the largest centered text rect inside the shape.
 *  - {@link fallbackRadius} (§5): ellipse-vs-rounded decision for a
 *    bubble/thought region with NO shape (pre-Phase-9 cache entries, failed
 *    traces) — kept independent so a bad live pass can revert it alone.
 *  - {@link pickTextStyle} (§7): light-text-on-dark-fill flip for sampled fills.
 *
 * All inputs are the normalized 0–1 contract (handoff rule 5); conversion to
 * pixels happens here, at render time, and nowhere else.
 */
import type { FontSettings } from "../../shared/settings";
import type { BBox, RegionKind } from "../../shared/types";
import type { PxRect } from "./geometry";

/** Inner padding as a fraction of the box (§7.7). Lives here (pure module);
 *  BubbleBox re-exports it for its existing consumers. */
export const PADDING_RATIO = 0.06;

/** Smallest centered scale {@link inscribedInnerRect} may shrink the text box
 *  to — a ragged contour can't crush text below 0.6× of the padded inner box. */
export const INSCRIBE_FLOOR_SCALE = 0.6;

/** Aspect-ratio band (w/h) inside which an unshaped bubble/thought box reads as
 *  "roundish" and takes the §5 ellipse fallback; outside it (a wide caption-like
 *  strip or a tall sliver) the box keeps the 8 px rounded rect. */
export const ELLIPSE_MIN_ASPECT = 0.4;
export const ELLIPSE_MAX_ASPECT = 2.5;

/** Luma below which a sampled fill counts as DARK → light text + dark stroke (§7). */
export const DARK_FILL_LUMA = 128;

/** One decimal place — SVG path coordinates don't need more. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Is `shape` a usable polygon (≥ 3 finite points)? */
function shapeUsable(
  shape: ReadonlyArray<readonly [number, number]> | undefined,
): shape is ReadonlyArray<readonly [number, number]> {
  return (
    Array.isArray(shape) &&
    shape.length >= 3 &&
    shape.every(
      (p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
  );
}

/**
 * Map image-normalized shape points into box-local pixels for a box rect of
 * `rectW` × `rectH` drawn from `bbox`. WHY this mapping is correct even for a
 * `trimOverlaps`-trimmed (or drag-select-clamped) bbox copy: the trimmed bbox
 * and the box rect describe the SAME displayed sub-rectangle, so the scale
 * factor `rectW / bbox.w` is the full displayed-image scale, and points outside
 * the trimmed bbox simply land outside [0, rectW]×[0, rectH] — where the box's
 * `overflow: hidden` crops them. Returns null on a degenerate bbox/rect.
 */
function mapShapeToBox(
  shape: ReadonlyArray<readonly [number, number]>,
  bbox: BBox,
  rectW: number,
  rectH: number,
): Array<[number, number]> | null {
  if (!(bbox.w > 0) || !(bbox.h > 0) || !(rectW > 0) || !(rectH > 0)) return null;
  const scaleX = rectW / bbox.w;
  const scaleY = rectH / bbox.h;
  return shape.map(([sx, sy]) => [(sx - bbox.x) * scaleX, (sy - bbox.y) * scaleY]);
}

/**
 * Build the fill layer's `clip-path` path string for a region's traced shape:
 * map each image-normalized point into box-local px, smooth the closed polygon
 * with Catmull-Rom → cubic Bézier (the traced contour is polygonal at snap-px
 * resolution; smoothing restores the drawn bubble's curvature), and emit a
 * closed SVG path rounded to 0.1 px.
 *
 * @param shape the region's traced outline (normalized full-image fractions).
 * @param bbox the region's bbox — possibly a trimmed/clamped copy (see
 *   {@link mapShapeToBox} for why that stays aligned).
 * @param rectW box width in px.
 * @param rectH box height in px.
 * @returns the path string, or null on degenerate input (< 3 points, non-finite
 *   values, zero-extent bbox/rect) — the caller falls back to the rounded rect.
 */
export function shapeToBoxPath(
  shape: ReadonlyArray<readonly [number, number]> | undefined,
  bbox: BBox,
  rectW: number,
  rectH: number,
): string | null {
  if (!shapeUsable(shape)) return null;
  const pts = mapShapeToBox(shape, bbox, rectW, rectH);
  if (!pts) return null;

  const n = pts.length;
  let d = `M ${round1(pts[0]![0])} ${round1(pts[0]![1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    // Catmull-Rom (uniform) → cubic Bézier control points.
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${round1(c1x)} ${round1(c1y)} ${round1(c2x)} ${round1(c2y)} ${round1(p2[0])} ${round1(p2[1])}`;
  }
  return `${d} Z`;
}

/** Standard ray-cast point-in-polygon (boundary counts as inside enough). */
function pointInPolygon(
  x: number,
  y: number,
  poly: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** The default padded inner text box for a `rectW` × `rectH` bubble box (§7.7). */
export function paddedInnerRect(rectW: number, rectH: number): PxRect {
  return {
    left: rectW * PADDING_RATIO,
    top: rectH * PADDING_RATIO,
    width: rectW * (1 - 2 * PADDING_RATIO),
    height: rectH * (1 - 2 * PADDING_RATIO),
  };
}

/** Shrink a rect around its center by `scale` (used by the §5 ellipse text box). */
export function shrinkCentered(rect: PxRect, scale: number): PxRect {
  const w = rect.width * scale;
  const h = rect.height * scale;
  return {
    left: rect.left + (rect.width - w) / 2,
    top: rect.top + (rect.height - h) / 2,
    width: w,
    height: h,
  };
}

/** Clamp `v` into the inclusive [lo, hi] range (lo wins if the range inverts). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The AREA centroid of a closed polygon, via the standard signed shoelace
 * formula. Falls back to the plain vertex average for a degenerate (near-zero-
 * area) ring. Pure. Phase 9.1 §5: {@link inscribedInnerRect} centers the text rect
 * here, not on the box center, so an off-center shape doesn't shove text out.
 * Exported for unit testing.
 */
export function polygonCentroid(
  poly: ReadonlyArray<readonly [number, number]>,
): [number, number] {
  const n = poly.length;
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % n]!;
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of poly) {
      sx += x;
      sy += y;
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * area2), cy / (3 * area2)];
}

/**
 * The text box for a shaped bubble: binary-search the largest scale of the padded
 * inner box — CENTERED ON THE POLYGON'S AREA CENTROID (Phase 9.1 §5), not the box
 * center — whose four corners all lie inside the shape polygon, floored at
 * {@link INSCRIBE_FLOOR_SCALE} (a ragged contour can't crush text to nothing). The
 * returned rect sits at the centroid, clamped so it stays inside the box. WHY the
 * centroid: for an asymmetric shape whose polygon is off-center in its bbox, a
 * box-centered search shrinks to the floor and lands text partly outside the
 * shape; the centroid keeps the rect in the shape's visual middle. A symmetric
 * shape's centroid IS the box center, so it reduces to the Phase 9 behaviour.
 * No/degenerate shape → today's padded inner box unchanged.
 *
 * @param shape the region's traced outline (normalized full-image fractions).
 * @param bbox the region's (possibly trimmed) bbox.
 * @param rectW box width in px.
 * @param rectH box height in px.
 * @returns the box-local px rect the text should be fitted into.
 */
export function inscribedInnerRect(
  shape: ReadonlyArray<readonly [number, number]> | undefined,
  bbox: BBox,
  rectW: number,
  rectH: number,
): PxRect {
  const fallback = paddedInnerRect(rectW, rectH);
  if (!shapeUsable(shape)) return fallback;
  const poly = mapShapeToBox(shape, bbox, rectW, rectH);
  if (!poly) return fallback;

  const [cx, cy] = polygonCentroid(poly);
  const halfW = fallback.width / 2;
  const halfH = fallback.height / 2;
  const fits = (s: number): boolean => {
    const dx = halfW * s;
    const dy = halfH * s;
    return (
      pointInPolygon(cx - dx, cy - dy, poly) &&
      pointInPolygon(cx + dx, cy - dy, poly) &&
      pointInPolygon(cx - dx, cy + dy, poly) &&
      pointInPolygon(cx + dx, cy + dy, poly)
    );
  };

  // The rect of scale `s` centered at the centroid, clamped inside the box so a
  // centroid near an edge never pushes the rect out of the drawn box (the floor
  // rect especially, which may not fit the shape at all).
  const rectAt = (s: number): PxRect => {
    const w = fallback.width * s;
    const h = fallback.height * s;
    return {
      left: clamp(cx - w / 2, 0, Math.max(0, rectW - w)),
      top: clamp(cy - h / 2, 0, Math.max(0, rectH - h)),
      width: w,
      height: h,
    };
  };

  if (fits(1)) return rectAt(1); // the whole padded box already fits the shape
  let lo = INSCRIBE_FLOOR_SCALE;
  let hi = 1;
  // WHY floor even when infeasible: 0.6× of the inner box always renders; textFit
  // then clamps to minPx and `overflow: hidden` crops — same policy as tiny boxes.
  if (!fits(lo)) return rectAt(INSCRIBE_FLOOR_SCALE);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return rectAt(lo);
}

/**
 * Phase 9.2: the horizontally-widened label rect for a text rect that turned out
 * narrower than the translation's longest word — full padded-box width, original
 * vertical placement (top/height kept, so the label stays at the shape's visual
 * middle). WHY: a tall vertical-CJK bubble's inscribed rect is often narrower
 * than any horizontal English word, so `word-break: break-word` shreds words
 * into a letter column ("imp ress ive"); whole words reaching past the shape's
 * edge — still clipped by the box — read far better than fragments inside it.
 * Returns the input rect UNCHANGED (same reference) when it is already at least
 * as wide as the padded box, so callers can cheaply detect the no-op. Pure.
 */
export function widenLabelRect(inner: PxRect, rectW: number, rectH: number): PxRect {
  const padded = paddedInnerRect(rectW, rectH);
  if (padded.width <= inner.width) return inner;
  return { left: padded.left, top: inner.top, width: padded.width, height: inner.height };
}

/** What the §5 fallback decision yields for a no-shape region. */
export type FallbackFill = "ellipse" | "rounded";

/**
 * §5 ellipse fallback for an UNSHAPED region: `bubble`/`thought` boxes with a
 * roundish aspect (w/h ∈ [{@link ELLIPSE_MIN_ASPECT}, {@link ELLIPSE_MAX_ASPECT}])
 * render `border-radius: 50%` (with the text box at 1/√2 of the inner rect);
 * anything else — other kinds, extreme aspects (usually a mis-kinded caption),
 * non-finite aspect — keeps the 8 px rounded rect. A region WITH a shape never
 * consults this (the shape wins). Pure; deliberately independent of §3/§4 so it
 * can be reverted alone.
 */
export function fallbackRadius(
  kind: RegionKind | undefined,
  aspect: number,
): FallbackFill {
  if (kind !== "bubble" && kind !== "thought") return "rounded";
  if (!Number.isFinite(aspect)) return "rounded";
  if (aspect < ELLIPSE_MIN_ASPECT || aspect > ELLIPSE_MAX_ASPECT) return "rounded";
  return "ellipse";
}

/** Rec. 601 luma (0–255) of a `#rrggbb` hex, or undefined when unparsable. */
export function hexLuma(hex: string | undefined): number | undefined {
  if (typeof hex !== "string") return undefined;
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** The text colors a bubble renders with (§7). */
export interface TextStyle {
  color: string;
  strokeColor: string;
}

/**
 * §7: choose text colors for a bubble fill. A DARK sampled fill (luma <
 * {@link DARK_FILL_LUMA}) flips to light text + dark stroke so an
 * inverted-flash bubble stays legible; otherwise (light fill, no sampled color,
 * unparsable color) the user's font settings apply unchanged. Pure.
 *
 * @param fillLuma the fill's luma 0–255, or undefined when no sampled color.
 * @param font the user's font settings.
 */
export function pickTextStyle(
  fillLuma: number | undefined,
  font: FontSettings,
): TextStyle {
  if (fillLuma !== undefined && fillLuma < DARK_FILL_LUMA) {
    return { color: "#ffffff", strokeColor: "#000000" };
  }
  return { color: font.color, strokeColor: font.strokeColor };
}
