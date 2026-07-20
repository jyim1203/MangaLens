/**
 * Phase 9 §4/§5/§7 render decisions (shapePath.ts): contour → box-local path,
 * inscribed text rect, ellipse fallback table, and the dark-fill text flip.
 * BubbleBox is a thin shell over these, so DOM assertions stay out of scope.
 */
import { describe, expect, it } from "vitest";
import {
  DARK_FILL_LUMA,
  ELLIPSE_MAX_ASPECT,
  ELLIPSE_MIN_ASPECT,
  INSCRIBE_FLOOR_SCALE,
  PADDING_RATIO,
  fallbackRadius,
  hexLuma,
  inscribedInnerRect,
  paddedInnerRect,
  pickTextStyle,
  polygonCentroid,
  shapeToBoxPath,
  shrinkCentered,
  widenLabelRect,
} from "../../src/content/overlay/shapePath";
import type { FontSettings } from "../../src/shared/settings";
import type { BBox } from "../../src/shared/types";

const FULL: BBox = { x: 0, y: 0, w: 1, h: 1 };

/** Parse the ON-CURVE points of a `M … (C c1 c2 p)* Z` path (every 3rd C pair). */
function onCurvePoints(path: string): Array<[number, number]> {
  const nums = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const pts: Array<[number, number]> = [[nums[0]!, nums[1]!]];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    pts.push([nums[i + 4]!, nums[i + 5]!]);
  }
  return pts;
}

describe("shapeToBoxPath (§4)", () => {
  const square: Array<[number, number]> = [
    [0.2, 0.2],
    [0.6, 0.2],
    [0.6, 0.6],
    [0.2, 0.6],
  ];

  it("maps a diamond's points into box-local px (closed path, one C per vertex)", () => {
    const diamond: Array<[number, number]> = [
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ];
    const path = shapeToBoxPath(diamond, FULL, 200, 100);
    expect(path).not.toBeNull();
    expect(path).toMatch(/^M /);
    expect(path).toMatch(/ Z$/);
    expect(path!.match(/C /g)).toHaveLength(4);
    // On-curve endpoints land exactly on the mapped vertices (closed: last = first).
    const pts = onCurvePoints(path!);
    expect(pts[0]).toEqual([100, 0]);
    expect(pts[1]).toEqual([200, 50]);
    expect(pts[2]).toEqual([100, 100]);
    expect(pts[3]).toEqual([0, 50]);
    expect(pts[4]).toEqual([100, 0]);
  });

  it("rounds every coordinate to 0.1 px", () => {
    const path = shapeToBoxPath(
      [
        [0.1234, 0.5678],
        [0.9876, 0.1234],
        [0.5555, 0.9999],
      ],
      FULL,
      333,
      777,
    );
    expect(path).not.toBeNull();
    for (const n of path!.match(/-?\d+(?:\.\d+)?/g)!) {
      expect(n).toMatch(/^-?\d+(\.\d)?$/); // at most one decimal
    }
  });

  it("keeps a trimmed-bbox copy aligned: same displayed scale, shifted origin", () => {
    // The same square rendered from the FULL region bbox…
    const fullBox: BBox = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const fullPath = shapeToBoxPath(square, fullBox, 100, 100)!;
    // …and from a trimOverlaps-style trimmed copy (left edge pushed in 0.1):
    // the box rect shrinks with it, so the px-per-image-fraction scale is equal.
    const trimmedBox: BBox = { x: 0.3, y: 0.2, w: 0.3, h: 0.4 };
    const trimmedPath = shapeToBoxPath(square, trimmedBox, 75, 100)!;
    const full = onCurvePoints(fullPath);
    const trimmed = onCurvePoints(trimmedPath);
    // Every trimmed point is the full point shifted left by the trimmed 25 px —
    // including points that now sit OUTSIDE the box (overflow:hidden crops them).
    for (let i = 0; i < full.length; i++) {
      expect(trimmed[i]![0]).toBeCloseTo(full[i]![0] - 25, 5);
      expect(trimmed[i]![1]).toBeCloseTo(full[i]![1], 5);
    }
    expect(Math.min(...trimmed.map((p) => p[0]))).toBeLessThan(0); // cropped side
  });

  it("returns null on degenerate input", () => {
    expect(shapeToBoxPath(undefined, FULL, 100, 100)).toBeNull();
    expect(shapeToBoxPath([[0, 0], [1, 1]], FULL, 100, 100)).toBeNull(); // < 3 points
    expect(shapeToBoxPath([[0, 0], [NaN, 1], [1, 1]], FULL, 100, 100)).toBeNull();
    expect(shapeToBoxPath(square, { x: 0, y: 0, w: 0, h: 1 }, 100, 100)).toBeNull();
    expect(shapeToBoxPath(square, FULL, 0, 100)).toBeNull();
  });
});

describe("inscribedInnerRect (§4)", () => {
  /** A 32-gon approximating the circle inscribed in the unit box. */
  const circle: Array<[number, number]> = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * 2 * Math.PI;
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
  });

  it("a circle yields ~1/√2 of the padded inner box, centered", () => {
    const rect = inscribedInnerRect(circle, FULL, 100, 100);
    const padded = paddedInnerRect(100, 100);
    // Analytic: corners at 44√2·s ≤ 50 → s ≈ 0.803 → width ≈ 70.7 (the 32-gon
    // sits slightly inside the true circle).
    expect(rect.width).toBeGreaterThan(64);
    expect(rect.width).toBeLessThan(padded.width * 0.82);
    expect(rect.left + rect.width / 2).toBeCloseTo(50, 1); // centered
    expect(rect.top + rect.height / 2).toBeCloseTo(50, 1);
  });

  it("a full-box slab keeps the padded inner box unchanged", () => {
    const slab: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    // §5 computes the rect from the polygon centroid (= box center for the slab),
    // a different arithmetic path than paddedInnerRect → compare within FP epsilon.
    const r = inscribedInnerRect(slab, FULL, 200, 80);
    const p = paddedInnerRect(200, 80);
    expect(r.left).toBeCloseTo(p.left, 6);
    expect(r.top).toBeCloseTo(p.top, 6);
    expect(r.width).toBeCloseTo(p.width, 6);
    expect(r.height).toBeCloseTo(p.height, 6);
  });

  it("the 0.6× floor kicks in on a starved concave shape", () => {
    // A razor-thin horizontal diamond: no centered box's corners ever fit.
    const sliver: Array<[number, number]> = [
      [0.5, 0.45],
      [1, 0.5],
      [0.5, 0.55],
      [0, 0.5],
    ];
    const rect = inscribedInnerRect(sliver, FULL, 100, 100);
    const floored = shrinkCentered(paddedInnerRect(100, 100), INSCRIBE_FLOOR_SCALE);
    expect(rect.left).toBeCloseTo(floored.left, 6);
    expect(rect.top).toBeCloseTo(floored.top, 6);
    expect(rect.width).toBeCloseTo(floored.width, 6);
    expect(rect.height).toBeCloseTo(floored.height, 6);
  });

  it("no/degenerate shape → the padded inner box (identity)", () => {
    expect(inscribedInnerRect(undefined, FULL, 100, 60)).toEqual(paddedInnerRect(100, 60));
    expect(inscribedInnerRect([[0, 0], [1, 1]], FULL, 100, 60)).toEqual(
      paddedInnerRect(100, 60),
    );
  });
});

describe("polygonCentroid + centroid-centered rect (§5)", () => {
  it("computes the exact area centroid of known polygons", () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const [sx, sy] = polygonCentroid(square);
    expect(sx).toBeCloseTo(5, 6);
    expect(sy).toBeCloseTo(5, 6);
    const triangle: Array<[number, number]> = [[0, 0], [6, 0], [0, 3]];
    const [tx, ty] = polygonCentroid(triangle);
    expect(tx).toBeCloseTo(2, 6); // vertex average for a triangle
    expect(ty).toBeCloseTo(1, 6);
  });

  it("a symmetric circle is a regression: rect stays centered on the box center", () => {
    const circle: Array<[number, number]> = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * 2 * Math.PI;
      return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
    });
    const rect = inscribedInnerRect(circle, FULL, 100, 100);
    expect(rect.left + rect.width / 2).toBeCloseTo(50, 1);
    expect(rect.top + rect.height / 2).toBeCloseTo(50, 1);
  });

  it("an off-center shape centers the text rect on the shape, NOT the box", () => {
    // A tall rectangle occupying the LEFT part of the box (centroid x ≈ 0.335).
    const leftRect: Array<[number, number]> = [
      [0.02, 0.05],
      [0.65, 0.05],
      [0.65, 0.95],
      [0.02, 0.95],
    ];
    const rect = inscribedInnerRect(leftRect, FULL, 100, 100);
    const cx = rect.left + rect.width / 2;
    expect(cx).toBeLessThan(45); // pulled left toward the shape, off the box center (50)
    expect(cx).toBeGreaterThan(25);
    expect(rect.top + rect.height / 2).toBeCloseTo(50, 0); // vertically centered
    // Stays inside the box after any clamp.
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
  });

  it("floor case: an off-center starved shape floors AND clamps inside the box", () => {
    // A small circle in the left half → the search floors at 0.6× and the rect,
    // centered on the off-center circle, is clamped so it never leaves the box.
    const smallLeft: Array<[number, number]> = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [0.2 + 0.15 * Math.cos(a), 0.5 + 0.15 * Math.sin(a)];
    });
    const rect = inscribedInnerRect(smallLeft, FULL, 100, 100);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(100);
    // Floor scale: the rect is the 0.6× padded box size.
    expect(rect.width).toBeCloseTo(paddedInnerRect(100, 100).width * INSCRIBE_FLOOR_SCALE, 4);
  });
});

describe("fallbackRadius (§5 decision table)", () => {
  it("roundish bubble/thought boxes take the ellipse", () => {
    expect(fallbackRadius("bubble", 1)).toBe("ellipse");
    expect(fallbackRadius("thought", 0.5)).toBe("ellipse");
    expect(fallbackRadius("bubble", ELLIPSE_MIN_ASPECT)).toBe("ellipse");
    expect(fallbackRadius("bubble", ELLIPSE_MAX_ASPECT)).toBe("ellipse");
  });

  it("extreme aspects keep the rounded rect (usually a mis-kinded caption)", () => {
    expect(fallbackRadius("bubble", 0.39)).toBe("rounded");
    expect(fallbackRadius("bubble", 2.6)).toBe("rounded");
    expect(fallbackRadius("thought", 10)).toBe("rounded");
    expect(fallbackRadius("bubble", NaN)).toBe("rounded");
    expect(fallbackRadius("bubble", Infinity)).toBe("rounded");
  });

  it("non-bubble kinds never take the ellipse", () => {
    expect(fallbackRadius("caption", 1)).toBe("rounded");
    expect(fallbackRadius("sfx", 1)).toBe("rounded");
    expect(fallbackRadius("sign", 1)).toBe("rounded");
    expect(fallbackRadius("other", 1)).toBe("rounded");
    expect(fallbackRadius(undefined, 1)).toBe("rounded");
  });
});

describe("pickTextStyle + hexLuma (§7)", () => {
  const font = {
    color: "#111111",
    strokeColor: "#ffffff",
  } as FontSettings;

  it("hexLuma parses #rrggbb and rejects everything else", () => {
    expect(hexLuma("#ffffff")).toBeCloseTo(255, 5);
    expect(hexLuma("#000000")).toBe(0);
    expect(hexLuma("#1e1e1e")).toBeCloseTo(30, 5);
    expect(hexLuma("#ff0000")).toBeCloseTo(76.245, 2); // 0.299 × 255
    expect(hexLuma("#fff")).toBeUndefined(); // shorthand not produced by snap
    expect(hexLuma("white")).toBeUndefined();
    expect(hexLuma(undefined)).toBeUndefined();
  });

  it(`flips to light-on-dark below luma ${DARK_FILL_LUMA}, keeps user settings otherwise`, () => {
    expect(pickTextStyle(30, font)).toEqual({ color: "#ffffff", strokeColor: "#000000" });
    expect(pickTextStyle(DARK_FILL_LUMA - 1, font)).toEqual({
      color: "#ffffff",
      strokeColor: "#000000",
    });
    expect(pickTextStyle(DARK_FILL_LUMA, font)).toEqual({
      color: font.color,
      strokeColor: font.strokeColor,
    });
    expect(pickTextStyle(255, font)).toEqual({
      color: font.color,
      strokeColor: font.strokeColor,
    });
    expect(pickTextStyle(undefined, font)).toEqual({
      color: font.color,
      strokeColor: font.strokeColor,
    });
  });
});

describe("shrinkCentered + paddedInnerRect helpers", () => {
  it("padded inner rect uses PADDING_RATIO on both axes", () => {
    expect(paddedInnerRect(100, 50)).toEqual({
      left: 100 * PADDING_RATIO,
      top: 50 * PADDING_RATIO,
      width: 100 * (1 - 2 * PADDING_RATIO),
      height: 50 * (1 - 2 * PADDING_RATIO),
    });
  });

  it("shrinkCentered keeps the center fixed", () => {
    const r = shrinkCentered({ left: 10, top: 20, width: 80, height: 40 }, 0.5);
    expect(r.width).toBe(40);
    expect(r.height).toBe(20);
    expect(r.left + r.width / 2).toBeCloseTo(50, 6);
    expect(r.top + r.height / 2).toBeCloseTo(40, 6);
  });
});

describe("widenLabelRect (Phase 9.2 narrow-rect rescue)", () => {
  it("widens a narrow rect to the padded-box width, keeping vertical placement", () => {
    const narrow = { left: 35, top: 24, width: 30, height: 52 };
    const wide = widenLabelRect(narrow, 100, 100);
    const padded = paddedInnerRect(100, 100);
    expect(wide.left).toBe(padded.left);
    expect(wide.width).toBe(padded.width);
    expect(wide.top).toBe(24); // vertical placement untouched
    expect(wide.height).toBe(52);
  });

  it("returns the SAME rect (reference no-op) when already padded-box wide", () => {
    const padded = paddedInnerRect(100, 100);
    expect(widenLabelRect(padded, 100, 100)).toBe(padded);
    // A rect WIDER than the padded box (degenerate caller) is also left alone.
    const wider = { left: 0, top: 0, width: 100, height: 100 };
    expect(widenLabelRect(wider, 100, 100)).toBe(wider);
  });
});
