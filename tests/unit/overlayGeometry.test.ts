import { describe, expect, it } from "vitest";
import {
  displayedSizeChanged,
  regionToPx,
} from "../../src/content/overlay/geometry";

describe("overlay — regionToPx (the one bbox→pixel conversion, rule 5)", () => {
  it("scales a normalized bbox to displayed pixels", () => {
    expect(regionToPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 800, 1200)).toEqual({
      left: 200,
      top: 600,
      width: 400,
      height: 300,
    });
  });

  it("round-trips at several display sizes (normalized ⇒ resize is free)", () => {
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    for (const [w, h] of [
      [800, 1200],
      [400, 600],
      [1600, 900],
    ] as const) {
      const px = regionToPx(bbox, w, h);
      expect(px.left / w).toBeCloseTo(0.1);
      expect(px.top / h).toBeCloseTo(0.2);
      expect(px.width / w).toBeCloseTo(0.3);
      expect(px.height / h).toBeCloseTo(0.4);
    }
  });

  it("returns an all-zero rect for a degenerate 0-size display (no NaN)", () => {
    expect(regionToPx({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 0, 0)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("overlay — displayedSizeChanged (repaint-on-resize predicate, item 1)", () => {
  it("is true when either dimension changes beyond the epsilon", () => {
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 900, h: 1200 })).toBe(true);
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 800, h: 1100 })).toBe(true);
  });

  it("is false for a sub-epsilon jitter (scroll rounding / RO noise)", () => {
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 800.3, h: 1199.7 })).toBe(
      false,
    );
    // Exactly at the epsilon boundary is NOT "beyond" it.
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 800.5, h: 1200 })).toBe(
      false,
    );
  });

  it("treats a never-painted (undefined) previous size as changed", () => {
    expect(displayedSizeChanged(undefined, { w: 800, h: 1200 })).toBe(true);
  });

  it("handles degenerate zero sizes without NaN issues", () => {
    expect(displayedSizeChanged({ w: 0, h: 0 }, { w: 0, h: 0 })).toBe(false);
    expect(displayedSizeChanged({ w: 0, h: 0 }, { w: 800, h: 1200 })).toBe(true);
  });

  it("respects a custom epsilon", () => {
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 803, h: 1200 }, 5)).toBe(
      false,
    );
    expect(displayedSizeChanged({ w: 800, h: 1200 }, { w: 806, h: 1200 }, 5)).toBe(
      true,
    );
  });
});
