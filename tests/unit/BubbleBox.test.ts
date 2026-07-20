// @vitest-environment jsdom
/**
 * Phase 9.1 §6/§7 + Phase 9.2 DOM assertions for BubbleBox (the thin render
 * shell). Kept minimal per house style — the pure decisions live in
 * shapePath.test.ts/textFit.test.ts; here we only check the layering (fill under
 * every label), the fillColor-gated ellipse fallback, and the narrow-rect widen
 * call-site wiring, which the pure tables can't express.
 */
import { describe, expect, it } from "vitest";
import { renderBubbleBox } from "../../src/content/overlay/BubbleBox";
import type { FontSettings } from "../../src/shared/settings";
import type { PxRect } from "../../src/content/overlay/geometry";
import type { TranslatedRegion } from "../../src/shared/types";

const FONT: FontSettings = {
  family: "system-ui, sans-serif",
  sizeMode: "auto",
  fixedSizePx: 16,
  minSizePx: 8,
  maxSizePx: 40,
  color: "#111111",
  stroke: true,
  strokeColor: "#ffffff",
  bubbleFillColor: "#ffffff",
  bubbleFillOpacity: 0.92,
};

/** A measure factory that always "fits" so a label element is always produced. */
const makeMeasure = () => () => ({ w: 10, h: 10 });

/** A square 100×100 rect (aspect 1 → "roundish" for the §7 ellipse table). */
const RECT: PxRect = { left: 0, top: 0, width: 100, height: 100 };

function region(overrides: Partial<TranslatedRegion> = {}): TranslatedRegion {
  return {
    bbox: { x: 0, y: 0, w: 0.5, h: 0.5 },
    original: "こんにちは",
    translated: "Hello",
    isSfx: false,
    kind: "bubble",
    ...overrides,
  };
}

const SQUARE_SHAPE: Array<[number, number]> = [
  [0.05, 0.05],
  [0.45, 0.05],
  [0.45, 0.45],
  [0.05, 0.45],
];

describe("BubbleBox — §6 fill/label layering", () => {
  it("puts the fill at z-index 1, the label at z-index 2, and leaves the box's z-index unset", () => {
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure);
    const fill = box.children[0] as HTMLElement;
    const labelHost = box.children[1] as HTMLElement; // label (no shape → direct child)
    expect(fill.style.zIndex).toBe("1");
    expect(labelHost.style.zIndex).toBe("2");
    expect(box.style.zIndex).toBe(""); // auto — the box must NOT form a stacking context
  });

  it("keeps the layering with a shape (text wrapper at z-index 2, fill at 1)", () => {
    const box = renderBubbleBox(
      region({ shape: SQUARE_SHAPE, fillColor: "#ffffff" }),
      RECT,
      FONT,
      makeMeasure,
    );
    const fill = box.children[0] as HTMLElement;
    const textLayer = box.children[1] as HTMLElement;
    expect(fill.style.zIndex).toBe("1");
    expect(textLayer.style.zIndex).toBe("2");
    expect(textLayer.style.position).toBe("absolute"); // §5: positioned at the inscribed rect
    expect(box.style.zIndex).toBe("");
  });
});

describe("BubbleBox — Phase 9.2 narrow-rect rescue", () => {
  // Fixed-advance measurer that emulates the shadow measurer: at a normal box
  // width it wraps (break-word: width clamps to the box, height grows in lines);
  // at the huge probe width it reports the longest word's UNBROKEN extent.
  const ADVANCE = 0.6;
  const wordMeasure = (boxW: number) => (text: string, px: number) => {
    const longest = Math.max(0, ...text.split(/\s+/).map((w) => w.length));
    if (boxW >= 1000) return { w: longest * px * ADVANCE, h: px * 1.2 };
    const totalW = text.length * px * ADVANCE;
    return {
      w: Math.min(totalW, boxW),
      h: px * 1.2 * Math.max(1, Math.ceil(totalW / boxW)),
    };
  };

  // A tall narrow shape (x 0.2–0.3 of a 0.5-wide bbox → 40..60 px in the 100 px
  // box): the inscribed search can't fit and floors at 0.6× → a 52.8 px column.
  const NARROW_SHAPE: Array<[number, number]> = [
    [0.2, 0.05],
    [0.3, 0.05],
    [0.3, 0.45],
    [0.2, 0.45],
  ];

  it("widens the label to the padded-box width when the longest word can't fit", () => {
    const box = renderBubbleBox(
      region({ shape: NARROW_SHAPE, fillColor: "#ffffff", translated: "Extraordinary" }),
      RECT,
      FONT,
      wordMeasure,
    );
    const textLayer = box.children[1] as HTMLElement;
    // Widened: full padded-box width (88 px, left 6), vertical placement kept
    // (the floor rect's top 23.6, height 52.8 — the shape's visual middle).
    expect(parseFloat(textLayer.style.left)).toBeCloseTo(6, 5);
    expect(parseFloat(textLayer.style.width)).toBeCloseTo(88, 5);
    expect(parseFloat(textLayer.style.top)).toBeCloseTo(23.6, 5);
    expect(parseFloat(textLayer.style.height)).toBeCloseTo(52.8, 5);
  });

  it("keeps the inscribed rect when every word fits it (no gratuitous widening)", () => {
    const box = renderBubbleBox(
      region({ shape: NARROW_SHAPE, fillColor: "#ffffff", translated: "No." }),
      RECT,
      FONT,
      wordMeasure,
    );
    const textLayer = box.children[1] as HTMLElement;
    expect(parseFloat(textLayer.style.width)).toBeCloseTo(52.8, 5); // floor rect, unwidened
    expect(parseFloat(textLayer.style.left)).toBeCloseTo(23.6, 5);
  });

  // Phase 9.3: cap-then-widen. A word that FITS the narrow rect at a small px now
  // renders small AND whole INSIDE the bubble, rather than widening (the 9.2
  // eager-widen would have overhung the shape). Only a word that can't fit at
  // minPx still widens.
  it("caps a fitting word to a small size in the narrow rect — does NOT widen (9.3)", () => {
    // "Besides" (7 glyphs) fits 52.8 px unbroken only up to 12 px (7·0.6·13 > 52.8);
    // under 9.2 the fitted-then-probed size overflowed and widened — 9.3 caps instead.
    const box = renderBubbleBox(
      region({ shape: NARROW_SHAPE, fillColor: "#ffffff", translated: "Besides" }),
      RECT,
      FONT,
      wordMeasure,
    );
    const textLayer = box.children[1] as HTMLElement;
    const label = textLayer.children[0] as HTMLElement;
    expect(parseFloat(textLayer.style.width)).toBeCloseTo(52.8, 5); // inscribed width, unwidened
    expect(parseFloat(textLayer.style.left)).toBeCloseTo(23.6, 5);
    expect(parseFloat(label.style.fontSize)).toBe(12); // capped to the word-fit size
  });

  it("widens AND caps when the word can't fit even at minPx (9.3 fallback)", () => {
    // "Extraordinary" (13) overflows 52.8 px at minPx 8 → widen to 88 px, then the
    // recomputed cap (13·0.6·11 ≤ 88 < 13·0.6·12) fixes the refit at 11 px.
    const box = renderBubbleBox(
      region({ shape: NARROW_SHAPE, fillColor: "#ffffff", translated: "Extraordinary" }),
      RECT,
      FONT,
      wordMeasure,
    );
    const textLayer = box.children[1] as HTMLElement;
    const label = textLayer.children[0] as HTMLElement;
    expect(parseFloat(textLayer.style.width)).toBeCloseTo(88, 5); // widened
    expect(parseFloat(label.style.fontSize)).toBe(11); // capped on the widened width
  });
});

describe("BubbleBox — §7 ellipse gate (snapped regions only)", () => {
  it("a snapped-but-shapeless roundish bubble (fillColor, no shape) takes the ellipse", () => {
    const box = renderBubbleBox(
      region({ fillColor: "#ffffff" }), // no shape, aspect 1
      RECT,
      FONT,
      makeMeasure,
    );
    expect(box.style.borderRadius).toBe("50%");
  });

  it("an UNSNAPPED roundish bubble (no fillColor) keeps the 8 px rounded rect", () => {
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure); // no fillColor
    expect(box.style.borderRadius).toBe("8px");
  });

  it("a shaped region draws the clip-path and drops the box radius to 0 (never fallback)", () => {
    const box = renderBubbleBox(
      region({ shape: SQUARE_SHAPE, fillColor: "#ffffff" }),
      RECT,
      FONT,
      makeMeasure,
    );
    const fill = box.children[0] as HTMLElement;
    expect(fill.style.clipPath).toContain("path(");
    expect(box.style.borderRadius).toBe("0px");
  });
});
