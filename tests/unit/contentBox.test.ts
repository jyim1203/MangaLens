import { describe, expect, it } from "vitest";
import {
  computeContentBox,
  insetContentBox,
  parseObjectPosition,
  type ObjectFit,
  type PositionComponent,
} from "../../src/content/overlay/contentBox";

const CENTER: PositionComponent = { kind: "fraction", value: 0.5 };
const TOPLEFT: PositionComponent = { kind: "fraction", value: 0 };
const BOTTOMRIGHT: PositionComponent = { kind: "fraction", value: 1 };

/** Convenience wrapper: contain/cover/etc centered. */
const box = (
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  fit: ObjectFit,
  posX: PositionComponent = CENTER,
  posY: PositionComponent = CENTER,
) => computeContentBox(boxW, boxH, natW, natH, fit, posX, posY);

describe("computeContentBox — fill (the identity / status-quo path)", () => {
  it("returns the whole content box regardless of intrinsic size", () => {
    expect(box(800, 480, 800, 1130, "fill")).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 480,
    });
  });
});

describe("computeContentBox — contain", () => {
  it("letterboxes a PORTRAIT bitmap in a WIDE box (THE Fit-Both reader case)", () => {
    // 820×480 element box, 800×1130 portrait bitmap. contain scales by the
    // limiting axis (height): s = 480/1130. Drawn width < box width → horizontal
    // letterbox bars, bitmap centered.
    const s = 480 / 1130;
    const drawnW = 800 * s;
    const r = box(820, 480, 800, 1130, "contain");
    expect(r.height).toBeCloseTo(480);
    expect(r.width).toBeCloseTo(drawnW);
    expect(r.top).toBeCloseTo(0);
    // Centered: half the horizontal free space on the left.
    expect(r.left).toBeCloseTo((820 - drawnW) / 2);
    // The smoking gun: the drawn bitmap must NOT reach the element's right edge.
    expect(r.left + r.width).toBeLessThan(820);
  });

  it("pillarboxes a LANDSCAPE bitmap in a TALL box (offsets on the vertical axis)", () => {
    // 400×800 box, 1000×500 landscape bitmap. contain scales by width: s = 400/1000.
    const s = 400 / 1000;
    const drawnH = 500 * s;
    const r = box(400, 800, 1000, 500, "contain");
    expect(r.width).toBeCloseTo(400);
    expect(r.height).toBeCloseTo(drawnH);
    expect(r.left).toBeCloseTo(0);
    expect(r.top).toBeCloseTo((800 - drawnH) / 2);
  });
});

describe("computeContentBox — cover (bitmap overflows → negative offsets)", () => {
  it("scales by the larger ratio and centers with negative offsets on both axes", () => {
    // 400×400 box, 800×1000 bitmap. cover: s = max(400/800, 400/1000) = 0.5.
    // Drawn = 400×500 → taller than the box, so top free = 400-500 = -100,
    // centered → top = -50. Width fills exactly (left = 0).
    const r = box(400, 400, 800, 1000, "cover");
    expect(r.width).toBeCloseTo(400);
    expect(r.height).toBeCloseTo(500);
    expect(r.left).toBeCloseTo(0);
    expect(r.top).toBeCloseTo(-50);
  });

  it("overflows horizontally for a landscape bitmap in a square box", () => {
    // 400×400 box, 1000×500 bitmap. cover: s = max(0.4, 0.8) = 0.8 → 800×400.
    const r = box(400, 400, 1000, 500, "cover");
    expect(r.width).toBeCloseTo(800);
    expect(r.height).toBeCloseTo(400);
    expect(r.left).toBeCloseTo(-200);
    expect(r.top).toBeCloseTo(0);
  });
});

describe("computeContentBox — none (intrinsic size, no scaling)", () => {
  it("draws the bitmap at natural size when SMALLER than the box (centered, positive offsets)", () => {
    const r = box(400, 400, 200, 100, "none");
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    expect(r.left).toBeCloseTo(100); // (400-200)/2
    expect(r.top).toBeCloseTo(150); // (400-100)/2
  });

  it("overflows at natural size when LARGER than the box (negative offsets)", () => {
    const r = box(400, 400, 800, 600, "none");
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    expect(r.left).toBeCloseTo(-200);
    expect(r.top).toBeCloseTo(-100);
  });
});

describe("computeContentBox — scale-down (min of none and contain)", () => {
  it("acts like NONE when the bitmap already fits (contain would upscale)", () => {
    // Bitmap 200×100 fits in 400×400: contain scale 2 > 1, so scale-down picks 1.
    const r = box(400, 400, 200, 100, "scale-down");
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
  });

  it("acts like CONTAIN when the bitmap is too big (must shrink)", () => {
    // Bitmap 800×1130 in 820×480: contain scale 480/1130 < 1 → scale-down shrinks.
    const contain = box(820, 480, 800, 1130, "contain");
    const scaleDown = box(820, 480, 800, 1130, "scale-down");
    expect(scaleDown).toEqual(contain);
  });
});

describe("computeContentBox — object-position", () => {
  it("pins the bitmap to the top-left at 0% 0%", () => {
    const r = box(820, 480, 800, 1130, "contain", TOPLEFT, TOPLEFT);
    expect(r.left).toBeCloseTo(0);
    expect(r.top).toBeCloseTo(0);
  });

  it("pins the bitmap to the bottom-right at 100% 100%", () => {
    const s = 480 / 1130;
    const drawnW = 800 * s;
    const r = box(820, 480, 800, 1130, "contain", BOTTOMRIGHT, BOTTOMRIGHT);
    expect(r.left).toBeCloseTo(820 - drawnW);
    expect(r.top).toBeCloseTo(0); // vertical free space is 0 (fits by height)
  });

  it("applies an absolute px offset verbatim", () => {
    const r = box(820, 480, 800, 1130, "contain", { kind: "px", value: 30 }, {
      kind: "px",
      value: 10,
    });
    expect(r.left).toBeCloseTo(30);
    expect(r.top).toBeCloseTo(10);
  });

  it("handles negative free space with cover (fraction × negative free)", () => {
    // 400×400 box, 800×1000 bitmap, cover → drawn 400×500, vertical free = -100.
    // object-position 100% → the bottom of the bitmap aligns to the bottom edge.
    const r = box(400, 400, 800, 1000, "cover", CENTER, BOTTOMRIGHT);
    expect(r.top).toBeCloseTo(-100); // 1.0 × (400-500)
    // 0% would align the top edge.
    const top0 = box(400, 400, 800, 1000, "cover", CENTER, TOPLEFT);
    expect(top0.top).toBeCloseTo(0);
  });
});

describe("computeContentBox — degenerate inputs fall back to fill", () => {
  it("returns the content box when the bitmap is undecoded (natural 0)", () => {
    expect(box(800, 480, 0, 0, "contain")).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 480,
    });
  });

  it("returns the (degenerate) content box when the box is 0", () => {
    expect(box(0, 0, 800, 1130, "contain")).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });

  it("returns the content box for any non-finite input", () => {
    expect(box(NaN, 480, 800, 1130, "contain")).toEqual({
      left: 0,
      top: 0,
      width: NaN,
      height: 480,
    });
    expect(box(800, 480, Infinity, 1130, "contain")).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 480,
    });
  });
});

describe("parseObjectPosition", () => {
  it("parses two percentages", () => {
    expect(parseObjectPosition("50% 50%")).toEqual([
      { kind: "fraction", value: 0.5 },
      { kind: "fraction", value: 0.5 },
    ]);
    expect(parseObjectPosition("0% 100%")).toEqual([
      { kind: "fraction", value: 0 },
      { kind: "fraction", value: 1 },
    ]);
  });

  it("parses two px lengths", () => {
    expect(parseObjectPosition("0px 12px")).toEqual([
      { kind: "px", value: 0 },
      { kind: "px", value: 12 },
    ]);
  });

  it("parses a mixed % / px value", () => {
    expect(parseObjectPosition("25% 10px")).toEqual([
      { kind: "fraction", value: 0.25 },
      { kind: "px", value: 10 },
    ]);
  });

  it("defaults a missing second component to center (50%)", () => {
    expect(parseObjectPosition("0%")).toEqual([
      { kind: "fraction", value: 0 },
      { kind: "fraction", value: 0.5 },
    ]);
  });

  it("falls back to center for garbage / unparseable values", () => {
    expect(parseObjectPosition("calc(10% + 3px)")).toEqual([
      { kind: "fraction", value: 0.5 },
      { kind: "fraction", value: 0.5 },
    ]);
    expect(parseObjectPosition("")).toEqual([
      { kind: "fraction", value: 0.5 },
      { kind: "fraction", value: 0.5 },
    ]);
    // A negative px offset is a real value (not garbage).
    expect(parseObjectPosition("-5px 50%")).toEqual([
      { kind: "px", value: -5 },
      { kind: "fraction", value: 0.5 },
    ]);
  });
});

describe("insetContentBox — border/padding shrink the drawing area", () => {
  it("subtracts border + padding from the border-box rect", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    const content = insetContentBox(
      rect,
      { top: 2, right: 2, bottom: 2, left: 2 }, // 2px border all round
      { top: 8, right: 8, bottom: 8, left: 8 }, // 8px padding all round
    );
    expect(content).toEqual({
      left: 110, // 100 + 2 + 8
      top: 60, // 50 + 2 + 8
      width: 380, // 400 - (2+8)*2
      height: 280, // 300 - (2+8)*2
    });
  });

  it("is the identity when there is no border or padding", () => {
    const rect = { left: 10, top: 20, width: 100, height: 200 };
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(insetContentBox(rect, zero, zero)).toEqual(rect);
  });

  it("handles asymmetric insets (a 1px left border shifts the origin right)", () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    const content = insetContentBox(
      rect,
      { top: 0, right: 0, bottom: 0, left: 1 },
      { top: 0, right: 0, bottom: 0, left: 0 },
    );
    expect(content).toEqual({ left: 1, top: 0, width: 99, height: 100 });
  });
});
