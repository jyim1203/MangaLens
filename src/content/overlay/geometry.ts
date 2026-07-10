/**
 * The ONE bbox → pixel conversion in the codebase (handoff rule 5). Every region
 * bbox is normalized 0–1 against the ORIGINAL image; here — and only here — it
 * becomes overlay-local pixels, using the image's *currently displayed* size.
 *
 * Because bboxes are normalized, responsive resizing is free: re-running this
 * with the new displayed size is the entire resize story (§7.2). Pure and
 * unit-tested; the OverlayManager shell reads the displayed size from the DOM.
 */
import type { BBox } from "../../shared/types";

/** An overlay-local pixel rectangle. */
export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Convert a normalized {@link BBox} to overlay-local pixels for an image
 * displayed at `displayedW` × `displayedH`.
 *
 * @param bbox normalized region box (fractions of the original image).
 * @param displayedW current rendered image width in px.
 * @param displayedH current rendered image height in px.
 * @returns the pixel rect. A degenerate (0-size) displayed image yields an
 *   all-zero rect rather than NaN.
 */
export function regionToPx(
  bbox: BBox,
  displayedW: number,
  displayedH: number,
): PxRect {
  return {
    left: bbox.x * displayedW,
    top: bbox.y * displayedH,
    width: bbox.w * displayedW,
    height: bbox.h * displayedH,
  };
}

/** A displayed image size in CSS px. */
export interface Size {
  w: number;
  h: number;
}

/** Epsilon (px) below which a displayed-size delta is treated as no change. */
export const SIZE_EPSILON_PX = 0.5;

/**
 * Has the displayed image size changed enough to require a re-paint (item 1)?
 *
 * BubbleBoxes are laid out in absolute pixels computed from the displayed size at
 * *paint* time, so a size change (window resize, responsive re-flow, browser
 * zoom) makes them stale — {@link regionToPx} + textFit must re-run against the
 * new size. This pure predicate decides when: it compares within an epsilon so
 * sub-pixel jitter (scroll rounding, `ResizeObserver` noise) doesn't thrash
 * re-paints. A missing previous size (never painted) counts as changed.
 *
 * @param prev the displayed size at last paint, or undefined if never painted.
 * @param next the current displayed size.
 * @param epsilon tolerance in px (default {@link SIZE_EPSILON_PX}).
 * @returns true when a re-paint is warranted.
 */
export function displayedSizeChanged(
  prev: Size | undefined,
  next: Size,
  epsilon: number = SIZE_EPSILON_PX,
): boolean {
  if (!prev) return true;
  return (
    Math.abs(prev.w - next.w) > epsilon || Math.abs(prev.h - next.h) > epsilon
  );
}
