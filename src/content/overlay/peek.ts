/**
 * Peek-original (F14) pure helpers — the two decisions the OverlayManager's
 * hover surface makes, extracted so they're browser-free and unit-tested:
 *
 *  1. {@link hitTestRegion} — which painted bubble (if any) the pointer is over.
 *  2. {@link peekRepaintTargets} — which overlay entries must repaint when the
 *     hovered bubble changes, so "no repaint when nothing changed" is a tested
 *     property (mousemove fires constantly; a repaint should happen only on an
 *     enter/leave transition — a repaint re-runs textFit, which is REQUIRED
 *     because the original text is often CJK and fits differently).
 *
 * The document-level mousemove/rAF plumbing and the actual repaint stay in the
 * OverlayManager shell (no pointer-events changes anywhere — §7.2 — so a manga
 * reader's page-forward-on-click keeps working; the whole peek is geometric).
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
