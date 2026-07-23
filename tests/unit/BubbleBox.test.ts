// @vitest-environment jsdom
/**
 * Phase 9.1 §6/§7 + Phase 9.2 DOM assertions for BubbleBox (the thin render
 * shell). Kept minimal per house style — the pure decisions live in
 * shapePath.test.ts/textFit.test.ts; here we only check the layering (fill under
 * every label), the fillColor-gated ellipse fallback, and the narrow-rect widen
 * call-site wiring, which the pure tables can't express.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveFillOpacity,
  renderBubbleBox,
} from "../../src/content/overlay/BubbleBox";
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

describe("BubbleBox — Phase 9.4 §1 effectiveFillOpacity (opaque snap-failure fallback)", () => {
  it("a bubble whose snap accepted no blob (undefined fillColor) → opaque 1", () => {
    expect(effectiveFillOpacity("bubble", undefined, 0.92)).toBe(1);
  });

  it("a thought bubble with no fillColor also → opaque 1", () => {
    expect(effectiveFillOpacity("thought", undefined, 0.92)).toBe(1);
  });

  it("a successfully-snapped bubble (fillColor set) keeps the user opacity", () => {
    expect(effectiveFillOpacity("bubble", "#ffffff", 0.92)).toBe(0.92);
  });

  it("non-bubble kinds with no fillColor keep the user opacity (art stays visible)", () => {
    expect(effectiveFillOpacity("sfx", undefined, 0.92)).toBe(0.92);
    expect(effectiveFillOpacity("caption", undefined, 0.92)).toBe(0.92);
    expect(effectiveFillOpacity(undefined, undefined, 0.92)).toBe(0.92);
  });

  it("is deterministic", () => {
    expect(effectiveFillOpacity("bubble", undefined, 0.5)).toBe(
      effectiveFillOpacity("bubble", undefined, 0.5),
    );
  });

  it("renders a fallback bubble's fill node fully opaque", () => {
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure); // bubble, no fillColor
    const fill = box.children[0] as HTMLElement;
    expect(fill.style.opacity).toBe("1");
  });

  it("renders a snapped bubble's fill node at the user opacity", () => {
    const box = renderBubbleBox(region({ fillColor: "#ffffff" }), RECT, FONT, makeMeasure);
    const fill = box.children[0] as HTMLElement;
    expect(fill.style.opacity).toBe("0.92");
  });

  it("renders an SFX fallback at the user opacity (never whited out)", () => {
    const box = renderBubbleBox(region({ kind: "sfx" }), RECT, FONT, makeMeasure);
    const fill = box.children[0] as HTMLElement;
    expect(fill.style.opacity).toBe("0.92");
  });
});

describe("BubbleBox — Phase 9.4 §3 suppressFill (contained-fill suppression)", () => {
  it("omits the fill node but still paints the label when suppressFill is set", () => {
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure, { suppressFill: true });
    // No fill node — the only child is the label.
    expect(box.children.length).toBe(1);
    const label = box.children[0] as HTMLElement;
    expect(label.style.zIndex).toBe("2"); // it's the label, not a fill
    expect(label.textContent).toBe("Hello");
  });

  it("draws the fill node by default (suppressFill unset)", () => {
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure);
    expect(box.children.length).toBe(2); // fill + label
    expect((box.children[0] as HTMLElement).style.zIndex).toBe("1");
  });
});

describe("BubbleBox — Phase 9.5 §3 drawRect (fallback cover-pad geometry)", () => {
  it("lays the box out at the supplied cover rect (wider fill + larger text rect)", () => {
    const drawRect: PxRect = { left: 10, top: 10, width: 150, height: 150 };
    const box = renderBubbleBox(region(), RECT, FONT, makeMeasure, { drawRect });
    // The box element uses the cover rect, not the (smaller) region px rect.
    expect(box.style.left).toBe("10px");
    expect(box.style.top).toBe("10px");
    expect(box.style.width).toBe("150px");
    expect(box.style.height).toBe("150px");
    // The derived inner text rect grows with the box, so the label gets more room.
    const label = box.children[1] as HTMLElement; // no shape → label is a direct child
    const boxNoPad = renderBubbleBox(region(), RECT, FONT, makeMeasure);
    const labelNoPad = boxNoPad.children[1] as HTMLElement;
    expect(parseFloat(label.style.width)).toBeGreaterThan(parseFloat(labelNoPad.style.width));
  });

  it("uses the region's own rect when no drawRect is supplied (snapped/unchanged path)", () => {
    const box = renderBubbleBox(region({ fillColor: "#ffffff" }), RECT, FONT, makeMeasure);
    expect(box.style.left).toBe("0px");
    expect(box.style.width).toBe("100px"); // RECT, untouched
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
