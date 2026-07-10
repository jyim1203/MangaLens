import { describe, expect, it, vi } from "vitest";
import {
  fitTextSize,
  resolveFontSize,
  type Measure,
} from "../../src/content/overlay/textFit";
import type { FontSettings } from "../../src/shared/settings";

// A deterministic, fixed-advance measurer: each glyph is 0.6·px wide, one line
// tall (1.2·px). Monotonic in px, which is all the binary search needs.
const ADVANCE = 0.6;
const measure: Measure = (text, px) => ({
  w: text.length * px * ADVANCE,
  h: px * 1.2,
});

function font(overrides: Partial<FontSettings> = {}): FontSettings {
  return {
    family: "sans-serif",
    sizeMode: "auto",
    fixedSizePx: 22,
    minSizePx: 8,
    maxSizePx: 28,
    color: "#000",
    stroke: false,
    strokeColor: "#fff",
    bubbleFillColor: "#fff",
    bubbleFillOpacity: 0.92,
    ...overrides,
  };
}

describe("textFit — fitTextSize (pure binary search)", () => {
  it("converges to the largest integer size that fits", () => {
    // "hello" = 5 glyphs; w = 3·px ≤ 100 ⇒ px ≤ 33.3 ⇒ 33.
    expect(
      fitTextSize({ text: "hello", boxW: 100, boxH: 1000, minPx: 8, maxPx: 40, measure }),
    ).toBe(33);
  });

  it("respects the max bound when the box is huge", () => {
    expect(
      fitTextSize({ text: "a", boxW: 1e6, boxH: 1e6, minPx: 8, maxPx: 28, measure }),
    ).toBe(28);
  });

  it("clamps to min when the text never fits (single word wider than the box)", () => {
    expect(
      fitTextSize({ text: "unbreakable", boxW: 1, boxH: 1, minPx: 10, maxPx: 28, measure }),
    ).toBe(10);
  });

  it("returns 0 for empty / whitespace-only text", () => {
    expect(
      fitTextSize({ text: "   ", boxW: 100, boxH: 100, minPx: 8, maxPx: 28, measure }),
    ).toBe(0);
  });

  it("is monotonic: a bigger box yields a font size ≥ the smaller box's", () => {
    const small = fitTextSize({
      text: "hello world",
      boxW: 100,
      boxH: 50,
      minPx: 6,
      maxPx: 40,
      measure,
    });
    const big = fitTextSize({
      text: "hello world",
      boxW: 300,
      boxH: 200,
      minPx: 6,
      maxPx: 40,
      measure,
    });
    expect(big).toBeGreaterThanOrEqual(small);
  });

  it("returns minPx when min > max (misconfigured bounds)", () => {
    expect(
      fitTextSize({ text: "x", boxW: 100, boxH: 100, minPx: 20, maxPx: 10, measure }),
    ).toBe(20);
  });
});

describe("textFit — resolveFontSize", () => {
  it("fixed mode bypasses the search entirely", () => {
    const spy = vi.fn(measure);
    expect(
      resolveFontSize(font({ sizeMode: "fixed", fixedSizePx: 19 }), "hello", 100, 100, spy),
    ).toBe(19);
    expect(spy).not.toHaveBeenCalled();
  });

  it("auto mode runs the search", () => {
    expect(
      resolveFontSize(font({ sizeMode: "auto" }), "hi", 100, 1000, measure),
    ).toBeGreaterThan(0);
  });

  it("empty text returns 0 even in fixed mode", () => {
    expect(
      resolveFontSize(font({ sizeMode: "fixed" }), "   ", 100, 100, measure),
    ).toBe(0);
  });
});
