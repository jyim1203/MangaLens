/**
 * Peek (F14) pure helpers — the three decisions the OverlayManager's hover surface
 * makes, extracted so they're browser-free and unit-tested:
 *
 *  1. {@link hitTestRegion} — which painted bubble (if any) the pointer is over.
 *  2. {@link expandPeeked} — given the hovered bubble, the parallel boolean array
 *     of which painted bubbles must go transparent: the hovered one PLUS every
 *     contained/containing neighbour whose fill would otherwise be left covering
 *     the revealed art (co-peek).
 *  3. {@link peekRepaintTargets} — which overlay entries must repaint when the
 *     hovered bubble changes, so "no repaint when nothing changed" is a tested
 *     property (mousemove fires constantly; a repaint should happen only on an
 *     enter/leave transition — the repaint is REQUIRED on a transition because
 *     un-peeking a bubble must re-run textFit to restore its fitted translation,
 *     and the co-peek expansion may add or drop neighbours).
 *
 * Peek (Phase 10 §1, F14 v2) now REVEALS THE ART: the hovered bubble (and its
 * co-peeked neighbours) paint no fill and no label, so the untouched page `<img>`
 * underneath — original art AND source text — shows through under the cursor. This
 * replaces the old swap-to-`region.original` render. The document-level
 * mousemove/rAF plumbing and the actual repaint stay in the OverlayManager shell
 * (no pointer-events changes anywhere — §7.2 — so a manga reader's
 * page-forward-on-click keeps working; the whole peek is geometric).
 */
import type { PxRect } from "./geometry";

/** A pointer position in overlay-local pixels (relative to the image's top-left). */
export interface Point {
  x: number;
  y: number;
}

/** Is `point` inside `rect` (inclusive of edges)? */
function contains(point: Point, rect: PxRect): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

/**
 * Does `outer` fully contain `inner`? Inclusive edges — an exact-equal pair
 * contains each other, which the {@link expandPeeked} co-peek relies on to vanish
 * both members of a duplicate detection.
 */
function rectContains(outer: PxRect, inner: PxRect): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.left + outer.width >= inner.left + inner.width &&
    outer.top + outer.height >= inner.top + inner.height
  );
}

/**
 * The parallel boolean array of which painted bubbles a hover should render
 * transparent (Phase 10 §1). `true` at `hoverIndex` plus every OTHER index whose
 * rect fully CONTAINS or IS fully CONTAINED BY the hovered rect (both directions).
 * All-`false` for a `null`, out-of-range, or negative `hoverIndex` (fail-soft:
 * peek nothing rather than risk mis-hiding).
 *
 * // WHY expand at all: a containment pair is a duplicate detection under
 * `overlapTrim`'s own doctrine — the inner region's fill is SUPPRESSED
 * (`computeContainedFillSuppression`) because the OUTER fill already covers it, so
 * peeking only the inner would leave the outer's paint sitting over the revealed
 * art; and hovering the OUTER must likewise vanish the inner's floating label, which
 * would otherwise hang on raw art. // WHY containment, not intersection: after
 * `trimOverlaps` the remaining partial overlaps are slivers — blanking a whole
 * neighbouring bubble for a sliver would float ITS label on the raw page, which is
 * worse than a sliver of fill overhanging the peeked corner.
 *
 * Containment is transitive, so comparing every rect against the hovered rect in ONE
 * pass catches an A ⊇ B ⊇ C chain regardless of which link is hovered (if `hover ⊇ X`
 * and `X ⊇ Y` then `hover ⊇ Y`, and symmetrically upward).
 *
 * Known limitation (the recorded upgrade path): a DIAGONAL neighbour's grown cover
 * rect (`coverPad` clamps a fallback fill's growth only against span-sharing
 * neighbours, not diagonal ones) can overlap the peeked rect WITHOUT containing it,
 * so it stays painted over a corner of the revealed art. The fix, if it ever matters
 * live, is one line: swap the containment predicate here for an intersection test.
 *
 * @param hoverIndex the index of the hovered painted bubble, or null when none.
 * @param rects the painted bubble rects (the raw `coverRects`), in paint order.
 * @returns `peeked[i]` — true iff bubble `i` should render transparent.
 */
export function expandPeeked(
  hoverIndex: number | null,
  rects: readonly PxRect[],
): boolean[] {
  const peeked = new Array<boolean>(rects.length).fill(false);
  if (hoverIndex === null || hoverIndex < 0 || hoverIndex >= rects.length) {
    return peeked; // fail-soft: nothing to peek
  }
  const hovered = rects[hoverIndex];
  if (!hovered) return peeked;
  peeked[hoverIndex] = true;
  for (let i = 0; i < rects.length; i++) {
    if (i === hoverIndex) continue;
    const r = rects[i];
    if (!r) continue;
    if (rectContains(hovered, r) || rectContains(r, hovered)) peeked[i] = true;
  }
  return peeked;
}

/**
 * Index of the painted bubble the pointer is over, or null when none contains it.
 * When bubbles nest/overlap, the SMALLEST-area containing rect wins — the tighter
 * bubble is the one the user is pointing at.
 *
 * @param point pointer position in overlay-local px.
 * @param rects the painted bubble rects, in paint order.
 * @returns the winning index, or null.
 */
export function hitTestRegion(
  point: Point,
  rects: readonly PxRect[],
): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!rect || !contains(point, rect)) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      bestArea = area;
      best = i;
    }
  }
  return best;
}

/** Which bubble (image entry + region index) is currently peeked on hover. */
export interface PeekHover {
  entryId: string;
  regionIndex: number;
}

/** True when two hover states point at the exact same bubble (both null counts). */
export function peekEquals(a: PeekHover | null, b: PeekHover | null): boolean {
  if (a === null || b === null) return a === b;
  return a.entryId === b.entryId && a.regionIndex === b.regionIndex;
}

/**
 * The overlay entries that must repaint on a hover transition from `prev` to
 * `next`. Empty when nothing changed (the common mousemove case — pointer still
 * inside the same bubble, or still over no bubble). On a real change it is the
 * de-duplicated set of the old and new entries: the old entry restores its
 * translated text, the new entry shows its original.
 *
 * @param prev the hover state before this pointer move.
 * @param next the hover state after it.
 * @returns entry ids to repaint (0, 1, or 2 ids).
 */
export function peekRepaintTargets(
  prev: PeekHover | null,
  next: PeekHover | null,
): string[] {
  if (peekEquals(prev, next)) return [];
  const targets: string[] = [];
  if (prev) targets.push(prev.entryId);
  if (next && next.entryId !== prev?.entryId) targets.push(next.entryId);
  return targets;
}
