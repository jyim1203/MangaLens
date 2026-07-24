import { describe, expect, it } from "vitest";
import {
  expandPeeked,
  hitTestRegion,
  peekEquals,
  peekRepaintTargets,
  type PeekHover,
} from "../../src/content/overlay/peek";
import type { PxRect } from "../../src/content/overlay/geometry";

const rect = (left: number, top: number, width: number, height: number): PxRect => ({
  left,
  top,
  width,
  height,
});

describe("peek — hitTestRegion (F14 geometric hit-test)", () => {
  const rects = [rect(0, 0, 100, 100), rect(200, 0, 50, 50)];

  it("returns the index of the bubble under the point", () => {
    expect(hitTestRegion({ x: 50, y: 50 }, rects)).toBe(0);
    expect(hitTestRegion({ x: 220, y: 20 }, rects)).toBe(1);
  });

  it("returns null when the point is over no bubble", () => {
    expect(hitTestRegion({ x: 150, y: 150 }, rects)).toBeNull();
  });

  it("counts edges as inside (inclusive bounds)", () => {
    expect(hitTestRegion({ x: 0, y: 0 }, rects)).toBe(0);
    expect(hitTestRegion({ x: 100, y: 100 }, rects)).toBe(0);
  });

  it("picks the SMALLEST containing bubble when they nest/overlap", () => {
    // A big outer bubble with a tighter inner one at the same point.
    const nested = [rect(0, 0, 200, 200), rect(40, 40, 40, 40)];
    expect(hitTestRegion({ x: 50, y: 50 }, nested)).toBe(1);
    // A point only inside the outer one falls back to it.
    expect(hitTestRegion({ x: 150, y: 150 }, nested)).toBe(0);
  });

  it("returns null for an empty rect list", () => {
    expect(hitTestRegion({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe("peek — expandPeeked (Phase 10 §1 co-peek containment expansion)", () => {
  it("null hover → all-false", () => {
    const rects = [rect(0, 0, 100, 100), rect(200, 0, 50, 50)];
    expect(expandPeeked(null, rects)).toEqual([false, false]);
  });

  it("empty rect list → []", () => {
    expect(expandPeeked(0, [])).toEqual([]);
  });

  it("no containment relations → only the hovered index is true", () => {
    const rects = [rect(0, 0, 50, 50), rect(200, 0, 50, 50), rect(400, 0, 50, 50)];
    expect(expandPeeked(1, rects)).toEqual([false, true, false]);
  });

  it("an OUTER rect containing the hovered inner → both true", () => {
    const rects = [rect(0, 0, 200, 200), rect(40, 40, 40, 40)];
    expect(expandPeeked(1, rects)).toEqual([true, true]); // hover the inner, outer co-peeks
  });

  it("the hovered OUTER containing an inner → both true", () => {
    const rects = [rect(0, 0, 200, 200), rect(40, 40, 40, 40)];
    expect(expandPeeked(0, rects)).toEqual([true, true]); // hover the outer, inner co-peeks
  });

  it("exact-equal rects → both true (inclusive containment)", () => {
    const rects = [rect(10, 10, 80, 80), rect(10, 10, 80, 80)];
    expect(expandPeeked(0, rects)).toEqual([true, true]);
  });

  it("a PARTIAL (intersecting, non-containing) overlap is NOT expanded", () => {
    // Two boxes overlap in a corner but neither contains the other → only the hover.
    const rects = [rect(0, 0, 100, 100), rect(50, 50, 100, 100)];
    expect(expandPeeked(0, rects)).toEqual([true, false]);
  });

  it("a chain outer ⊇ mid ⊇ hover → all three true in one pass", () => {
    const rects = [rect(0, 0, 300, 300), rect(20, 20, 200, 200), rect(60, 60, 60, 60)];
    expect(expandPeeked(2, rects)).toEqual([true, true, true]); // hover innermost
    expect(expandPeeked(1, rects)).toEqual([true, true, true]); // hover middle
    expect(expandPeeked(0, rects)).toEqual([true, true, true]); // hover outermost
  });

  it("out-of-range or negative hover index → all-false (fail-soft)", () => {
    const rects = [rect(0, 0, 100, 100), rect(200, 0, 50, 50)];
    expect(expandPeeked(2, rects)).toEqual([false, false]); // == length
    expect(expandPeeked(5, rects)).toEqual([false, false]); // > length
    expect(expandPeeked(-1, rects)).toEqual([false, false]); // negative
  });
});

describe("peek — peekRepaintTargets (repaint only on transition)", () => {
  const a: PeekHover = { entryId: "img-a", regionIndex: 0 };
  const aOther: PeekHover = { entryId: "img-a", regionIndex: 1 };
  const b: PeekHover = { entryId: "img-b", regionIndex: 0 };

  it("enter (null → hover) repaints exactly the entered entry", () => {
    expect(peekRepaintTargets(null, a)).toEqual(["img-a"]);
  });

  it("leave (hover → null) repaints exactly the left entry", () => {
    expect(peekRepaintTargets(a, null)).toEqual(["img-a"]);
  });

  it("mousemove within the same bubble repaints nothing", () => {
    expect(peekRepaintTargets(a, a)).toEqual([]);
    expect(peekRepaintTargets(null, null)).toEqual([]);
  });

  it("moving to a different bubble in the SAME entry repaints it once", () => {
    expect(peekRepaintTargets(a, aOther)).toEqual(["img-a"]);
  });

  it("moving across entries repaints both the old and the new", () => {
    expect(peekRepaintTargets(a, b)).toEqual(["img-a", "img-b"]);
  });
});

describe("peek — peekEquals", () => {
  it("treats matching hovers (and both-null) as equal", () => {
    expect(peekEquals(null, null)).toBe(true);
    expect(
      peekEquals({ entryId: "x", regionIndex: 2 }, { entryId: "x", regionIndex: 2 }),
    ).toBe(true);
  });

  it("distinguishes different entry/index and null-vs-hover", () => {
    expect(peekEquals({ entryId: "x", regionIndex: 2 }, null)).toBe(false);
    expect(
      peekEquals({ entryId: "x", regionIndex: 2 }, { entryId: "x", regionIndex: 3 }),
    ).toBe(false);
    expect(
      peekEquals({ entryId: "x", regionIndex: 2 }, { entryId: "y", regionIndex: 2 }),
    ).toBe(false);
  });
});
