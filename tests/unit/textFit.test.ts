import { describe, expect, it, vi } from "vitest";
import {
  fitTextSize,
  longestWord,
  maxWordFitPx,
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

describe("textFit — maxWordFitPx (Phase 9.3 word-integrity cap)", () => {
  it("returns the exact largest integer px at which the word fits unbroken", () => {
    // "Besides" = 7 glyphs, w = 7·0.6·px = 4.2·px ≤ 52.8 ⇒ px ≤ 12.57 ⇒ 12.
    expect(maxWordFitPx("Besides", 52.8, 8, 40, measure)).toBe(12);
    // Sanity on the boundary the search must respect.
    expect(measure("Besides", 12).w).toBeLessThanOrEqual(52.8);
    expect(measure("Besides", 13).w).toBeGreaterThan(52.8);
  });

  it("returns null when even minPx overflows (fragmentation unavoidable → widen)", () => {
    // "Extraordinary" = 13 glyphs, at minPx 8: 13·0.6·8 = 62.4 > 52.8 ⇒ null.
    expect(maxWordFitPx("Extraordinary", 52.8, 8, 40, measure)).toBeNull();
  });

  it("an empty word imposes no cap (returns maxPx)", () => {
    expect(maxWordFitPx("", 10, 8, 28, measure)).toBe(28);
  });

  it("returns null on degenerate bounds (maxPx < minPx)", () => {
    expect(maxWordFitPx("a", 1e6, 20, 10, measure)).toBeNull();
  });

  it("is monotonic in width and deterministic", () => {
    const narrow = maxWordFitPx("Besides", 40, 8, 40, measure);
    const wide = maxWordFitPx("Besides", 80, 8, 40, measure);
    expect(narrow).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(wide!).toBeGreaterThanOrEqual(narrow!);
    expect(maxWordFitPx("Besides", 52.8, 8, 40, measure)).toBe(
      maxWordFitPx("Besides", 52.8, 8, 40, measure),
    );
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

  it("auto mode honors a word cap below maxSizePx (min(maxSizePx, cap))", () => {
    // Huge box → uncapped fit hits maxSizePx (28); the cap 15 binds instead.
    expect(
      resolveFontSize(font({ sizeMode: "auto" }), "hi", 1e6, 1e6, measure),
    ).toBe(28);
    expect(
      resolveFontSize(font({ sizeMode: "auto" }), "hi", 1e6, 1e6, measure, 15),
    ).toBe(15);
  });

  it("a cap ABOVE maxSizePx does not raise the size (min order)", () => {
    expect(
      resolveFontSize(font({ sizeMode: "auto", maxSizePx: 28 }), "hi", 1e6, 1e6, measure, 100),
    ).toBe(28);
  });

  it("fixed mode ignores the word cap (the user chose that size)", () => {
    expect(
      resolveFontSize(font({ sizeMode: "fixed", fixedSizePx: 24 }), "hi", 100, 100, measure, 8),
    ).toBe(24);
  });
});

describe("textFit — longestWord (Phase 9.2 narrow-rect rescue)", () => {
  it("returns the word with the most characters", () => {
    expect(longestWord("That determination of yours, I admit—")).toBe(
      "determination",
    );
  });

  it("first word wins a tie; single word and empty/whitespace degrade cleanly", () => {
    expect(longestWord("abc def")).toBe("abc");
    expect(longestWord("Impressive.")).toBe("Impressive.");
    expect(longestWord("")).toBe("");
    expect(longestWord("   ")).toBe("");
  });

  it("splits on ANY whitespace run (newlines/tabs included)", () => {
    expect(longestWord("my\n unbreakable\tsword")).toBe("unbreakable");
  });

  it("a no-whitespace CJK string returns whole (the caller widens, harmlessly)", () => {
    expect(longestWord("これは長い台詞です")).toBe("これは長い台詞です");
  });
});
