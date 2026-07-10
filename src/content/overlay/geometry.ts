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
