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

/** Exact equality of two bboxes (Phase 9.4 §3 tie-break for mutual containment). */
function boxesEqual(
  a: TranslatedRegion["bbox"],
  b: TranslatedRegion["bbox"],
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Phase 9.4 §3: decide, per region, whether its FILL should be suppressed because
 * another region's (trimmed) draw box fully contains it. Returns a parallel
 * boolean array (index-aligned to `regions`, the output of {@link trimOverlaps}) —
 * NOT a `TranslatedRegion` field, so the {@link import("../../shared/types").TranslatedRegion}
 * contract is untouched; the overlay threads it into `renderBubbleBox`'s
 * `suppressFill` option.
 *
 * A region is suppressed iff some OTHER region's draw box `contains` it. WHY
 * suppress the inner fill: two stacked fills double-paint / patch-fight and read
 * as a smeared overlap in the Phase 9 fill era (`trimOverlaps` deliberately leaves
 * containment pairs alone — a duplicate detection it won't distort — and relies on
 * draw order). The OUTER fill already covers the inner region's area, so dropping
 * the inner fill can only ever remove a redundant double-cover; the inner LABEL is
 * untouched (the two detections may carry different text — a model split or a
 * double-OCR — so dropping the region would lose a translation). WHY not merge:
 * merging invents a bubble that doesn't exist ({@link trimOverlaps}' own rule).
 *
 * Tie-stable for EXACT-equal boxes (mutual containment): suppress the LATER one in
 * reading order only — never both, which would expose the artwork with no paint.
 *
 * Pure and deterministic (same input → same output); does not read or mutate the
 * regions beyond their bboxes.
 *
 * @param regions the trimmed regions, in reading (draw) order.
 * @returns `suppressFill[i]` — true iff region `i`'s fill should be skipped.
 */
export function computeContainedFillSuppression(
  regions: readonly TranslatedRegion[],
): boolean[] {
  const suppress = new Array<boolean>(regions.length).fill(false);
  for (let i = 0; i < regions.length; i++) {
    const bi = regions[i]!.bbox;
    for (let j = 0; j < regions.length; j++) {
      if (j === i) continue;
      const bj = regions[j]!.bbox;
      if (!contains(bj, bi)) continue; // j must fully contain i
      if (boxesEqual(bi, bj)) {
        // Mutual containment: suppress the LATER index only (i suppressed iff an
        // equal partner sits EARLIER in reading order — j < i).
        if (j < i) {
          suppress[i] = true;
          break;
        }
        continue; // an equal partner at j > i leaves the earlier i painting
      }
      // Strict containment: j is the larger outer box → suppress the inner i.
      suppress[i] = true;
      break;
    }
  }
  return suppress;
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
