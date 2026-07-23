/**
 * Region-kind predicates shared across contexts (Phase 9.4). Kept here — a
 * runtime-free data helper alongside {@link import("./types").RegionKind} — so
 * both the background snap layer ({@link import("../background/bubbleSnap").shouldSnapKind})
 * and the content render shell ({@link import("../content/overlay/BubbleBox").effectiveFillOpacity})
 * key the "is this a white-interior speech bubble?" decision off ONE set, with
 * no cross-layer import (background ⇸ content would be a bundling wrong-way edge).
 */
import type { RegionKind } from "./types";

/**
 * Kinds whose interior is a paper/white speech bubble flood fill was designed
 * for — `bubble` and `thought`. WHY only these two: `caption`/`sfx`/`sign`/
 * `other` sit on artwork, where a fill leaks or lands on ink; they keep the
 * provider box (snap) and stay art-visible / translucent (fill). This is the
 * single source of truth for both the snap-eligibility and the §1 opaque-
 * fallback decision.
 */
const BUBBLE_KINDS: ReadonlySet<RegionKind> = new Set<RegionKind>(["bubble", "thought"]);

/**
 * Is `kind` a white-interior speech-bubble kind (`bubble`/`thought`)? Undefined
 * and every non-bubble kind → `false`.
 */
export function isBubbleKind(kind?: RegionKind): boolean {
  return kind !== undefined && BUBBLE_KINDS.has(kind);
}
