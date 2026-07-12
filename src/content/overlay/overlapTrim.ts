/**
 * Render-time overlap trim (Phase 7.4 item 3) — a small, deterministic, PURE
 * post-step the overlay applies after {@link import("./regionFilter").filterRegions}
 * and before painting. Adjacent returned boxes routinely overlap: the model
 * estimates coordinates on a coarse ~0.05 grid, and the 2026-07-11 HAR showed
 * true duplicate detections at slightly different positions. This nudges
 * overlapping neighbours apart so the rendered bubbles stop stacking on the
 * artwork.
 *
 * WHY a view-layer fix (like `filterRegions`), not a sanitize-time rewrite: the
 * cache must keep the provider's HONEST boxes so the same entry can render
 * correctly if the rules change; this is a *view*, applied on copies, never
 * mutating the cached page. WHY trim, not merge: merging two different-text
 * regions would invent a bubble that doesn't exist.
 */
import type { TranslatedRegion } from "../../shared/types";

/** Max fraction of a box's original extent (per axis) it may cumulatively give up. */
const MAX_SHRINK_FRACTION = 0.3;

/** 1-D overlap length of [a, a+aw] and [b, b+bw]; ≤ 0 when disjoint/touching. */
function overlap1d(a: number, aw: number, b: number, bw: number): number {
  return Math.min(a + aw, b + bw) - Math.max(a, b);
}

/** Does `outer` fully contain `inner`? (2-D, inclusive.) */
function contains(
  outer: TranslatedRegion["bbox"],
  inner: TranslatedRegion["bbox"],
): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

/**
 * Nudge overlapping neighbours apart. For each ordered pair (i < j, reading
 * order) whose bboxes intersect with positive area, shrink BOTH boxes along the
 * single axis with the SMALLER overlap extent, each giving up half the overlap
 * (split the difference) so their shared edge meets in the middle.
 *
 * Two guards leave a pair overlapping rather than mangling it:
 *  - **Cap:** each box may cumulatively shrink at most {@link MAX_SHRINK_FRACTION}
 *    of its ORIGINAL size per axis; if applying half the overlap would exceed the
 *    cap for either box, the pair is skipped.
 *  - **Containment:** if one box fully contains the other, it is a duplicate
 *    detection error trimming would distort — draw order already stacks them
 *    readably, so leave it.
 *
 * Pure: works on copies, never mutates the input regions or their bboxes, and is
 * deterministic (same input → same output).
 *
 * @param regions the (already filtered) regions to draw, in reading order.
 * @returns a new array of regions with trimmed bbox copies.
 */
export function trimOverlaps(
  regions: readonly TranslatedRegion[],
): TranslatedRegion[] {
  const out = regions.map((r) => ({ ...r, bbox: { ...r.bbox } }));
  const original = regions.map((r) => r.bbox);
  const shrunkX = new Array<number>(out.length).fill(0);
  const shrunkY = new Array<number>(out.length).fill(0);

  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]!.bbox;
      const b = out[j]!.bbox;
      const ox = overlap1d(a.x, a.w, b.x, b.w);
      const oy = overlap1d(a.y, a.h, b.y, b.h);
      if (ox <= 0 || oy <= 0) continue; // disjoint (or merely touching)
      if (contains(original[i]!, original[j]!) || contains(original[j]!, original[i]!)) {
        continue;
      }

      if (ox <= oy) {
        // Smaller overlap is horizontal → separate along x.
        const give = ox / 2;
        if (
          shrunkX[i]! + give > MAX_SHRINK_FRACTION * original[i]!.w ||
          shrunkX[j]! + give > MAX_SHRINK_FRACTION * original[j]!.w
        ) {
          continue;
        }
        const aIsLeft = a.x + a.w / 2 <= b.x + b.w / 2;
        const left = aIsLeft ? a : b;
        const right = aIsLeft ? b : a;
        left.w -= give; // pull the left box's right edge in
        right.x += give; // push the right box's left edge in
        right.w -= give;
        shrunkX[i]! += give;
        shrunkX[j]! += give;
      } else {
        // Smaller overlap is vertical → separate along y.
        const give = oy / 2;
        if (
          shrunkY[i]! + give > MAX_SHRINK_FRACTION * original[i]!.h ||
          shrunkY[j]! + give > MAX_SHRINK_FRACTION * original[j]!.h
        ) {
          continue;
        }
        const aIsTop = a.y + a.h / 2 <= b.y + b.h / 2;
        const top = aIsTop ? a : b;
        const bottom = aIsTop ? b : a;
        top.h -= give; // pull the top box's bottom edge up
        bottom.y += give; // push the bottom box's top edge down
        bottom.h -= give;
        shrunkY[i]! += give;
        shrunkY[j]! += give;
      }
    }
  }
  return out;
}
