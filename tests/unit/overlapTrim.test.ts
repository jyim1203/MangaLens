import { describe, expect, it } from "vitest";
import { trimOverlaps } from "../../src/content/overlay/overlapTrim";
import type { BBox, TranslatedRegion } from "../../src/shared/types";

/** A minimal region at `bbox` (text/flags irrelevant to the geometry). */
function region(bbox: BBox, original = "x"): TranslatedRegion {
  return { bbox, original, translated: original.toUpperCase(), isSfx: false };
}

describe("overlay/overlapTrim — trimOverlaps (Phase 7.4 item 3)", () => {
  it("leaves disjoint boxes untouched", () => {
    const a = region({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const b = region({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
    const out = trimOverlaps([a, b]);
    expect(out[0]!.bbox).toEqual(a.bbox);
    expect(out[1]!.bbox).toEqual(b.bbox);
  });

  it("splits a horizontal-neighbour overlap evenly on x (smaller overlap axis)", () => {
    // A: x 0.1–0.4, B: x 0.3–0.6, same full-height y overlap → x overlap (0.1) is
    // smaller, so trim x; each gives up half (0.05) and their edges meet at 0.35.
    const out = trimOverlaps([
      region({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }),
      region({ x: 0.3, y: 0.1, w: 0.3, h: 0.2 }),
    ]);
    expect(out[0]!.bbox.w).toBeCloseTo(0.25, 6); // left box: right edge pulled in
    expect(out[1]!.bbox.x).toBeCloseTo(0.35, 6); // right box: left edge pushed in
    expect(out[1]!.bbox.w).toBeCloseTo(0.25, 6);
    // y untouched (the wider overlap axis).
    expect(out[0]!.bbox.h).toBeCloseTo(0.2, 6);
    // No overlap remains.
    expect(out[0]!.bbox.x + out[0]!.bbox.w).toBeCloseTo(out[1]!.bbox.x, 6);
  });

  it("splits a vertical-neighbour overlap evenly on y", () => {
    const out = trimOverlaps([
      region({ x: 0.1, y: 0.1, w: 0.2, h: 0.3 }),
      region({ x: 0.1, y: 0.3, w: 0.2, h: 0.3 }),
    ]);
    expect(out[0]!.bbox.h).toBeCloseTo(0.25, 6);
    expect(out[1]!.bbox.y).toBeCloseTo(0.35, 6);
    expect(out[1]!.bbox.h).toBeCloseTo(0.25, 6);
    // x untouched.
    expect(out[0]!.bbox.w).toBeCloseTo(0.2, 6);
  });

  it("trims the axis with the smaller overlap (a wide-flat overlap trims y)", () => {
    // Boxes overlap widely in x (0.4) but only thinly in y (0.05) → trim y.
    const out = trimOverlaps([
      region({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }),
      region({ x: 0.2, y: 0.25, w: 0.5, h: 0.2 }),
    ]);
    // x geometry untouched, y separated.
    expect(out[0]!.bbox.x).toBeCloseTo(0.1, 6);
    expect(out[0]!.bbox.w).toBeCloseTo(0.5, 6);
    expect(out[1]!.bbox.x).toBeCloseTo(0.2, 6);
    expect(out[0]!.bbox.h).toBeCloseTo(0.175, 6); // 0.2 − 0.05/2
    expect(out[1]!.bbox.y).toBeCloseTo(0.275, 6); // 0.25 + 0.05/2
  });

  it("leaves a deep overlap alone once trimming would exceed the 30% cap", () => {
    // Overlap 0.15 on x → each would give 0.075, but the cap is 0.3·0.2 = 0.06.
    const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const b = { x: 0.15, y: 0.1, w: 0.2, h: 0.2 };
    const out = trimOverlaps([region(a), region(b)]);
    expect(out[0]!.bbox).toEqual(a);
    expect(out[1]!.bbox).toEqual(b);
  });

  it("leaves a contained box (duplicate detection) untouched", () => {
    const a = { x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
    const b = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 };
    const out = trimOverlaps([region(a), region(b)]);
    expect(out[0]!.bbox).toEqual(a);
    expect(out[1]!.bbox).toEqual(b);
  });

  it("does not mutate the input regions or their bboxes", () => {
    const a = region({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
    const b = region({ x: 0.3, y: 0.1, w: 0.3, h: 0.2 });
    const input = [a, b];
    const snapshot = JSON.parse(JSON.stringify(input));
    trimOverlaps(input);
    expect(input).toEqual(snapshot);
  });

  it("is deterministic (same input → same output)", () => {
    const input = [
      region({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }),
      region({ x: 0.3, y: 0.1, w: 0.3, h: 0.2 }),
      region({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }),
    ];
    expect(trimOverlaps(input)).toEqual(trimOverlaps(input));
  });
});
