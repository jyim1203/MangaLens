import { describe, expect, it } from "vitest";
import {
  clampBoxToRect,
  computeSnapSize,
  offsetPolygonOutward,
  shouldSnapKind,
  snapAllRegions,
  snapRegionToBubble,
  MIN_BLOB_BBOX_FILL,
  RESCUE_MIN_PROVIDER_OVERLAP,
  SHAPE_OUTWARD_OFFSET_PX,
  SHARED_BLOB_IOU,
  SNAP_CONFINE_EXPAND_LOOSE,
  SNAP_MAX_EDGE,
  SNAP_MIN_SHORT_EDGE,
  SNAP_VERSION,
  SWALLOW_COVERAGE,
  type SnapBitmap,
} from "../../src/background/bubbleSnap";
import type { BBox, RegionKind } from "../../src/shared/types";

// --- Synthetic-bitmap helpers (no DOM: fill grays/rects/ellipses into RGBA) ---

/** A width×height RGBA bitmap of a uniform gray (luminance = `lum` for gray). */
function grayBitmap(width: number, height: number, lum = 128): SnapBitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = lum;
    data[p * 4 + 1] = lum;
    data[p * 4 + 2] = lum;
    data[p * 4 + 3] = 255;
  }
  return { data, width, height };
}

/** Paint an inclusive rect [x0..x1] × [y0..y1] at gray `lum`. */
function fillRect(
  bmp: SnapBitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lum: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = (y * bmp.width + x) * 4;
      bmp.data[p] = lum;
      bmp.data[p + 1] = lum;
      bmp.data[p + 2] = lum;
      bmp.data[p + 3] = 255;
    }
  }
}

/** Paint a filled ellipse (center cx,cy; radii rx,ry) at gray `lum`. */
function fillEllipse(
  bmp: SnapBitmap,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  lum: number,
): void {
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const p = (y * bmp.width + x) * 4;
        bmp.data[p] = lum;
        bmp.data[p + 1] = lum;
        bmp.data[p + 2] = lum;
        bmp.data[p + 3] = 255;
      }
    }
  }
}

const WHITE = 255;
const GRAY = 128;

describe("bubbleSnap — snapRegionToBubble", () => {
  it("snaps a loose box onto a white ellipse (tightens to the ellipse bounds)", () => {
    // Ellipse: center (50,50), rx 25 ry 30 → x∈[25,75], y∈[20,80] on gray.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 25, 30, WHITE);
    // A loose box covering most of the image.
    const snapped = snapRegionToBubble(bmp, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(snapped).not.toBeNull();
    // Tightened to the ellipse (± the 1-px pad), well inside the loose box.
    expect(snapped!.bbox.x).toBeCloseTo(0.24, 2); // minX 25, padded → 24
    expect(snapped!.bbox.x + snapped!.bbox.w).toBeCloseTo(0.77, 2); // maxX 75, padded → 76 (+1)
    expect(snapped!.bbox.y).toBeCloseTo(0.19, 2);
    expect(snapped!.bbox.w).toBeLessThan(0.8);
    expect(snapped!.bbox.h).toBeLessThan(0.8);
  });

  it("shrinks an oversized seed box down to the bubble", () => {
    // White rect bubble [30..69] × [30..69] (40×40) on gray; box is 1.5× wider.
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 69, 69, WHITE);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x).toBeCloseTo(0.29, 2); // minX 30, padded → 29
    expect(snapped!.bbox.w).toBeCloseTo(0.42, 2); // (70 − 29 + 1)/100
    expect(snapped!.bbox.w).toBeLessThan(box.w); // it SHRANK
  });

  it("grows a too-small seed box up to the bubble (snap is bidirectional)", () => {
    // Bubble [33..67] × [33..67] (35×35, ≈3× the seed box, within the 4× cap).
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 33, 33, 67, 67, WHITE);
    const box: BBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }; // 20×20 in the middle
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x).toBeCloseTo(0.32, 2); // minX 33, padded → 32
    expect(snapped!.bbox.w).toBeGreaterThan(box.w); // it GREW
  });

  it("returns null when the fill leaks through an opening onto a white page", () => {
    // A large connected white region (66% of the image) → exceeds both leak caps.
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 10, 10, 90, 90, WHITE);
    const snapped = snapRegionToBubble(bmp, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    expect(snapped).toBeNull(); // provider box kept
  });

  it("rejects a glyph-counter center seed and recovers the real bubble from an offset seed", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    // Tiny white 'counter' at the box center (40,50) — isolated by gray.
    fillRect(bmp, 39, 49, 41, 51, WHITE);
    // The real bubble, offset right, separated from the counter by a gray column.
    fillRect(bmp, 43, 42, 60, 58, WHITE);
    const box: BBox = { x: 0.3, y: 0.4, w: 0.2, h: 0.2 }; // center (40,50)
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    // Snapped onto the bubble (x≈0.42), NOT the tiny counter (which sat at ≈0.38).
    expect(snapped!.bbox.x).toBeCloseTo(0.42, 2); // minX 43, padded → 42
    expect(snapped!.bbox.x + snapped!.bbox.w).toBeCloseTo(0.62, 2); // maxX 60, padded → 61 (+1)
  });

  it("returns null when every seed lands on dark pixels", () => {
    const bmp = grayBitmap(100, 100, 100); // all below LIGHT_FLOOR
    const snapped = snapRegionToBubble(bmp, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
    expect(snapped).toBeNull();
  });

  it("still fills an off-white (lum ~230) bubble interior via the relative tolerance", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, 230); // off-white paper, not pure white
    const snapped = snapRegionToBubble(bmp, { x: 0.15, y: 0.15, w: 0.7, h: 0.7 });
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x).toBeCloseTo(0.29, 2);
    expect(snapped!.bbox.x + snapped!.bbox.w).toBeCloseTo(0.72, 2); // maxX 70, padded → 71 (+1)
  });

  it("returns null for a degenerate bbox (w or h ≤ 0, or non-finite)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, WHITE);
    expect(snapRegionToBubble(bmp, { x: 0.5, y: 0.5, w: 0, h: 0.2 })).toBeNull();
    expect(snapRegionToBubble(bmp, { x: 0.5, y: 0.5, w: 0.2, h: -0.1 })).toBeNull();
    expect(snapRegionToBubble(bmp, { x: 0.5, y: 0.5, w: NaN, h: 0.2 })).toBeNull();
  });

  it("does not mutate the input bbox", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, WHITE);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const snapshot = { ...box };
    snapRegionToBubble(bmp, box);
    expect(box).toEqual(snapshot);
  });

  it("is deterministic (same bitmap + box → identical output)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, WHITE);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    expect(snapRegionToBubble(bmp, box)).toEqual(snapRegionToBubble(bmp, box));
  });

  it("returns null on a zero-size bitmap (guard)", () => {
    const bmp: SnapBitmap = { data: new Uint8ClampedArray(0), width: 0, height: 0 };
    expect(snapRegionToBubble(bmp, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })).toBeNull();
  });
});

// --- Phase 7.6: connected-bubble split (snapAllRegions) --------------------

/** coverage(a, b) = area(a ∩ b) / area(b) — fraction of b covered by a. */
function cov(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (b.w * b.h);
}

/** A vertical "peanut": two white ellipses joined by a light neck, on gray. */
function peanutV(): SnapBitmap {
  const bmp = grayBitmap(100, 100, GRAY);
  fillEllipse(bmp, 50, 30, 18, 16, WHITE); // top lobe  y∈[14,46]
  fillEllipse(bmp, 50, 72, 18, 16, WHITE); // bottom lobe y∈[56,88]
  fillRect(bmp, 45, 44, 55, 58, WHITE); // light neck bridging the gap
  return bmp;
}

/** A horizontal "peanut": the same, rotated 90°. */
function peanutH(): SnapBitmap {
  const bmp = grayBitmap(100, 100, GRAY);
  fillEllipse(bmp, 30, 50, 16, 18, WHITE); // left lobe  x∈[14,46]
  fillEllipse(bmp, 72, 50, 16, 18, WHITE); // right lobe x∈[56,88]
  fillRect(bmp, 44, 45, 58, 55, WHITE); // light neck
  return bmp;
}

const bubble = (bbox: BBox): { bbox: BBox; kind: RegionKind } => ({ bbox, kind: "bubble" });

describe("bubbleSnap — snapAllRegions (connected bubbles)", () => {
  it("splits a vertically-joined pair so each result hugs its own lobe (twin snaps)", () => {
    // Symmetric loose boxes: BOTH independent snaps grab the shared union blob
    // (near-identical → IoU ≥ 0.8), so the group forms via the twin trigger.
    const regions = [
      bubble({ x: 0.28, y: 0.1, w: 0.44, h: 0.36 }), // top lobe, loose
      bubble({ x: 0.28, y: 0.54, w: 0.44, h: 0.36 }), // bottom lobe, loose
    ];
    const [top, bottom] = snapAllRegions(peanutV(), regions);
    expect(top).not.toBeNull();
    expect(bottom).not.toBeNull();
    // Each hugs one lobe (h well under the ~0.75 union height), not the pair.
    expect(top!.bbox.h).toBeLessThan(0.5);
    expect(bottom!.bbox.h).toBeLessThan(0.5);
    // Neither box covers the other's lobe.
    expect(cov(top!.bbox, bottom!.bbox)).toBeLessThan(0.2);
    expect(cov(bottom!.bbox, top!.bbox)).toBeLessThan(0.2);
    // Top is above bottom.
    expect(top!.bbox.y + top!.bbox.h).toBeLessThanOrEqual(bottom!.bbox.y + bottom!.bbox.h);
    expect(top!.bbox.y).toBeLessThan(bottom!.bbox.y);
  });

  it("splits a horizontally-joined pair (rotated) so each result hugs its lobe", () => {
    const regions = [
      bubble({ x: 0.1, y: 0.28, w: 0.36, h: 0.44 }), // left lobe
      bubble({ x: 0.54, y: 0.28, w: 0.36, h: 0.44 }), // right lobe
    ];
    const [left, right] = snapAllRegions(peanutH(), regions);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.bbox.w).toBeLessThan(0.5);
    expect(right!.bbox.w).toBeLessThan(0.5);
    expect(cov(left!.bbox, right!.bbox)).toBeLessThan(0.2);
    expect(left!.bbox.x).toBeLessThan(right!.bbox.x);
  });

  it("screenshot case: large box snaps the union, small leaks → swallow trigger splits both", () => {
    // The larger provider box fills the whole joined blob (accepts, under the 4×
    // cap); the smaller box's fill is > 4× ITS box → leaks to null. The stage-2
    // swallow trigger folds the leaked lobe into the group; stage 3 gives each a lobe.
    const regions = [
      bubble({ x: 0.28, y: 0.1, w: 0.44, h: 0.4 }), // large, over the top lobe
      bubble({ x: 0.4, y: 0.6, w: 0.2, h: 0.2 }), // smaller, over the bottom lobe
    ];
    const [large, small] = snapAllRegions(peanutV(), regions);
    expect(large).not.toBeNull();
    expect(small).not.toBeNull();
    // The large result no longer swallows the pair: it hugs the top lobe only.
    expect(large!.bbox.h).toBeLessThan(0.5);
    expect(small!.bbox.h).toBeLessThan(0.5);
    expect(cov(large!.bbox, small!.bbox)).toBeLessThan(0.2);
    expect(cov(small!.bbox, large!.bbox)).toBeLessThan(0.2);
    expect(large!.bbox.y).toBeLessThan(small!.bbox.y); // large=top, small=bottom
  });

  it("splits a 3-lobe vertical chain into three lobe boxes", () => {
    const bmp = grayBitmap(100, 120, GRAY);
    fillEllipse(bmp, 50, 20, 15, 13, WHITE); // lobe 1
    fillEllipse(bmp, 50, 60, 15, 13, WHITE); // lobe 2
    fillEllipse(bmp, 50, 100, 15, 13, WHITE); // lobe 3
    fillRect(bmp, 46, 30, 54, 50, WHITE); // neck 1-2
    fillRect(bmp, 46, 70, 54, 90, WHITE); // neck 2-3
    const regions = [
      bubble({ x: 0.3, y: 0.03, w: 0.4, h: 0.24 }),
      bubble({ x: 0.3, y: 0.36, w: 0.4, h: 0.24 }),
      bubble({ x: 0.3, y: 0.69, w: 0.4, h: 0.24 }),
    ];
    const snaps = snapAllRegions(bmp, regions);
    expect(snaps.every((s) => s !== null)).toBe(true);
    // Three vertically-ordered, non-overlapping lobes.
    expect(snaps[0]!.bbox.y).toBeLessThan(snaps[1]!.bbox.y);
    expect(snaps[1]!.bbox.y).toBeLessThan(snaps[2]!.bbox.y);
    expect(cov(snaps[0]!.bbox, snaps[2]!.bbox)).toBeLessThan(0.2);
  });

  it("reverts the WHOLE group to provider boxes when a member's slab is all-dark", () => {
    // Two boxes over ONE small ellipse → identical snaps (twin group). The box
    // area is tuned so the FULL ellipse fill clears min-area (stage-1 accepts,
    // forming the group) but each HALF-ellipse windowed re-fill is below min-area
    // → the split fails → all-or-nothing revert to provider boxes.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 8, 8, WHITE); // area ≈ 201; halves ≈ 100
    const regions = [
      bubble({ x: 0.335, y: 0.375, w: 0.25, h: 0.25 }), // center ≈ (46,50)
      bubble({ x: 0.415, y: 0.375, w: 0.25, h: 0.25 }), // center ≈ (54,50)
    ];
    const snaps = snapAllRegions(bmp, regions);
    expect(snaps).toEqual([null, null]); // both keep their provider boxes
  });

  it("stage-4 guard reverts a snap that NEWLY swallows a caption's box", () => {
    // A small bubble box grows (snap is bidirectional) to a big ellipse that
    // covers a caption region whose box the bubble's LOOSE box did not cover.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 15, 15, WHITE); // [35,65]²
    const regions = [
      bubble({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), // bubble, grows onto the ellipse
      { bbox: { x: 0.36, y: 0.36, w: 0.1, h: 0.1 }, kind: "caption" as RegionKind },
    ];
    const [bubbleSnap, captionSnap] = snapAllRegions(bmp, regions);
    expect(bubbleSnap).toBeNull(); // reverted — its snap swallowed the caption
    expect(captionSnap).toBeNull(); // captions never snap anyway
  });

  it("stage-4 guard does NOT revert when the provider boxes already overlapped", () => {
    // Same ellipse, but the bubble's LOOSE box already covered the caption box
    // (coverage is pre-existing, not introduced by the snap) → keep the snap.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 15, 15, WHITE);
    const regions = [
      bubble({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }), // loose box already over the caption
      { bbox: { x: 0.36, y: 0.36, w: 0.1, h: 0.1 }, kind: "caption" as RegionKind },
    ];
    const [bubbleSnap] = snapAllRegions(bmp, regions);
    expect(bubbleSnap).not.toBeNull(); // pre-existing overlap → guard leaves it
  });

  it("a single isolated bubble is byte-identical to the 7.5 per-region snap", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, WHITE);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const [only] = snapAllRegions(bmp, [bubble(box)]);
    expect(only).toEqual(snapRegionToBubble(bmp, box));
  });

  it("is deterministic and never mutates the input regions", () => {
    const bmp = peanutV();
    const regions = [
      bubble({ x: 0.28, y: 0.1, w: 0.44, h: 0.36 }),
      bubble({ x: 0.28, y: 0.54, w: 0.44, h: 0.36 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(regions));
    const a = snapAllRegions(bmp, regions);
    const b = snapAllRegions(bmp, regions);
    expect(a).toEqual(b);
    expect(regions).toEqual(snapshot); // inputs untouched
  });

  it("windowed fill: seeds clamp into the window and the fill cannot cross the cut", () => {
    // A wide white bar; a window over the LEFT half must confine the fill there,
    // even when the provider box sits in the right half (seed clamps in).
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 10, 40, 90, 60, WHITE);
    const rightBox: BBox = { x: 0.6, y: 0.4, w: 0.2, h: 0.2 }; // center at x≈70
    const snapped = snapRegionToBubble(bmp, rightBox, {
      window: { x: 0, y: 0, w: 0.5, h: 1 },
    });
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x + snapped!.bbox.w).toBeLessThanOrEqual(0.52); // never crosses x=0.5
  });

  it("exposes tunable group thresholds", () => {
    expect(SHARED_BLOB_IOU).toBeGreaterThan(0);
    expect(SWALLOW_COVERAGE).toBeGreaterThan(0);
  });
});

describe("bubbleSnap — shouldSnapKind", () => {
  it("snaps only bubble and thought (white-interior shapes)", () => {
    expect(shouldSnapKind("bubble")).toBe(true);
    expect(shouldSnapKind("thought")).toBe(true);
    expect(shouldSnapKind("caption")).toBe(false);
    expect(shouldSnapKind("sfx")).toBe(false);
    expect(shouldSnapKind("sign")).toBe(false);
    expect(shouldSnapKind("other")).toBe(false);
    expect(shouldSnapKind(undefined)).toBe(false);
  });
});

describe("bubbleSnap — computeSnapSize", () => {
  it("leaves an image within the long-edge cap unscaled", () => {
    expect(computeSnapSize(500, 300)).toEqual({ width: 500, height: 300, scale: 1 });
  });

  it("caps the long edge at SNAP_MAX_EDGE for a normal large page", () => {
    // Derived from the constant so the §3 512 → 768 raise needs no hard-coded edit.
    const s = computeSnapSize(1024, 768);
    const scale = SNAP_MAX_EDGE / 1024;
    expect(Math.max(s.width, s.height)).toBe(SNAP_MAX_EDGE);
    expect(s.width).toBe(SNAP_MAX_EDGE);
    expect(s.height).toBe(Math.round(768 * scale));
    expect(s.scale).toBeCloseTo(scale, 6);
  });

  it("raises the cap for an extreme strip so the short edge holds its floor", () => {
    const s = computeSnapSize(800, 20000); // webtoon strip
    expect(s.width).toBe(SNAP_MIN_SHORT_EDGE); // short edge pinned to 256, not crushed
    expect(s.height).toBe(6400);
    expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(SNAP_MIN_SHORT_EDGE);
  });

  it("never upscales a small image and passes degenerate dims through", () => {
    expect(computeSnapSize(100, 100)).toEqual({ width: 100, height: 100, scale: 1 });
    expect(computeSnapSize(0, 100)).toEqual({ width: 0, height: 100, scale: 1 });
  });
});

describe("bubbleSnap — clampBoxToRect", () => {
  it("leaves a fully-contained box unchanged", () => {
    const box: BBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const clamped = clampBoxToRect(box, { x: 0, y: 0, w: 1, h: 1 });
    expect(clamped).not.toBeNull();
    expect(clamped!.x).toBeCloseTo(0.1, 6);
    expect(clamped!.y).toBeCloseTo(0.1, 6);
    expect(clamped!.w).toBeCloseTo(0.2, 6);
    expect(clamped!.h).toBeCloseTo(0.2, 6);
  });

  it("clips a box that overflows the rect to the intersection", () => {
    const box: BBox = { x: 0.4, y: 0.4, w: 0.4, h: 0.4 }; // → 0.8
    const rect: BBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }; // → 0.75
    const clamped = clampBoxToRect(box, rect);
    expect(clamped).not.toBeNull();
    expect(clamped!.x).toBeCloseTo(0.4, 6);
    expect(clamped!.w).toBeCloseTo(0.35, 6); // 0.75 − 0.4
    expect(clamped!.h).toBeCloseTo(0.35, 6);
  });

  it("returns null for a box disjoint from the rect", () => {
    expect(
      clampBoxToRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }),
    ).toBeNull();
  });
});

// --- Phase 9 §3: contour capture ---------------------------------------------

/** Normalized radial value of a shape point vs. an analytic ellipse (1 = on it). */
function ellipseRadial(
  [fx, fy]: [number, number],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  size = 100,
): number {
  const dx = (fx * size - cx) / rx;
  const dy = (fy * size - cy) / ry;
  return Math.sqrt(dx * dx + dy * dy);
}

describe("bubbleSnap — contour capture (Phase 9 §3)", () => {
  it("traces a white ellipse: ≤ 64 points, all near the analytic boundary, within bbox+offset, normalized", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 25, 30, WHITE);
    const snapped = snapRegionToBubble(bmp, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(snapped).not.toBeNull();
    const shape = snapped!.shape;
    expect(shape).toBeDefined();
    expect(shape!.length).toBeGreaterThanOrEqual(3);
    expect(shape!.length).toBeLessThanOrEqual(64);
    // Phase 9.1 §1: the outward offset can push a point up to ~1 snap-px past the
    // (unchanged) padded bbox; a 100-px bitmap → 1 snap-px = 0.01 normalized, plus
    // half-px rounding slack.
    const pad = (SHAPE_OUTWARD_OFFSET_PX + 0.51) / 100;
    for (const pt of shape!) {
      // Near the ellipse boundary (dilation + marching-squares corners + offset).
      const v = ellipseRadial(pt, 50, 50, 25, 30);
      expect(v).toBeGreaterThan(0.8);
      expect(v).toBeLessThan(1.3);
      // Normalized + clamped, and within the padded bbox plus the §1 offset.
      expect(pt[0]).toBeGreaterThanOrEqual(0);
      expect(pt[0]).toBeLessThanOrEqual(1);
      expect(pt[1]).toBeGreaterThanOrEqual(0);
      expect(pt[1]).toBeLessThanOrEqual(1);
      expect(pt[0]).toBeGreaterThanOrEqual(snapped!.bbox.x - pad);
      expect(pt[0]).toBeLessThanOrEqual(snapped!.bbox.x + snapped!.bbox.w + pad);
      expect(pt[1]).toBeGreaterThanOrEqual(snapped!.bbox.y - pad);
      expect(pt[1]).toBeLessThanOrEqual(snapped!.bbox.y + snapped!.bbox.h + pad);
    }
  });

  it("glyph holes inside the blob do not perforate the outer contour", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 25, 25, WHITE);
    // A dark glyph blob INSIDE the bubble, off-center so the center seed stays white.
    fillRect(bmp, 38, 40, 43, 58, 40);
    const snapped = snapRegionToBubble(bmp, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(snapped).not.toBeNull();
    const shape = snapped!.shape;
    expect(shape).toBeDefined();
    // Every contour point sits near the OUTER ellipse boundary — none dips into
    // the glyph hole (which would show as radial values ≈ 0.3–0.6).
    for (const pt of shape!) {
      expect(ellipseRadial(pt, 50, 50, 25, 25)).toBeGreaterThan(0.8);
    }
  });

  it("peanut split yields per-lobe contours confined to each slab", () => {
    const regions = [
      bubble({ x: 0.28, y: 0.1, w: 0.44, h: 0.36 }),
      bubble({ x: 0.28, y: 0.54, w: 0.44, h: 0.36 }),
    ];
    const [top, bottom] = snapAllRegions(peanutV(), regions);
    expect(top!.shape).toBeDefined();
    expect(bottom!.shape).toBeDefined();
    // The cut sits at the midpoint of the member centers (y ≈ 0.5): each lobe's
    // contour stays on its own side (± dilation + rounding).
    for (const [, fy] of top!.shape!) expect(fy).toBeLessThanOrEqual(0.55);
    for (const [, fy] of bottom!.shape!) expect(fy).toBeGreaterThanOrEqual(0.45);
  });
});

// --- Phase 9.1 §1: outward polygon offset -----------------------------------

describe("bubbleSnap — offsetPolygonOutward (Phase 9.1 §1)", () => {
  it("moves each diamond vertex outward by the offset along the axis normal (exact)", () => {
    // A clockwise (screen-space) diamond centered at (5,5).
    const diamond: Array<[number, number]> = [
      [5, 0], // top
      [10, 5], // right
      [5, 10], // bottom
      [0, 5], // left
    ];
    const out = offsetPolygonOutward(diamond, 1);
    // Axis-aligned vertex normals → each vertex moves exactly 1 px straight out.
    expect(out[0]![0]).toBeCloseTo(5, 6);
    expect(out[0]![1]).toBeCloseTo(-1, 6); // top → up
    expect(out[1]![0]).toBeCloseTo(11, 6); // right → right
    expect(out[1]![1]).toBeCloseTo(5, 6);
    expect(out[2]![1]).toBeCloseTo(11, 6); // bottom → down
    expect(out[3]![0]).toBeCloseTo(-1, 6); // left → left
  });

  it("grows a convex square outward (every vertex moves away from the center)", () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const out = offsetPolygonOutward(square, 1);
    const cx = 5;
    const cy = 5;
    for (let i = 0; i < 4; i++) {
      const before = Math.hypot(square[i]![0] - cx, square[i]![1] - cy);
      const after = Math.hypot(out[i]![0] - cx, out[i]![1] - cy);
      expect(after).toBeGreaterThan(before); // pushed away from the centroid
    }
  });

  it("moves a concave vertex the correct way (signed-area orientation, not centroid)", () => {
    // An L-shape (clockwise) covering the top bar + left column; the removed part
    // is the bottom-right quadrant (10,10)–(20,20). Vertex [10,10] is the REFLEX
    // (concave) inner corner: "outward" (away from the interior, growing the shape
    // into its notch) means moving toward the removed quadrant, i.e. BOTH coords
    // increase — the case a centroid-based orientation would get backwards.
    const ell: Array<[number, number]> = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10], // reflex corner
      [10, 20],
      [0, 20],
    ];
    const out = offsetPolygonOutward(ell, 1);
    const reflex = out[3]!;
    expect(reflex[0]).toBeGreaterThan(10);
    expect(reflex[1]).toBeGreaterThan(10);
  });

  it("returns the ring unchanged for a degenerate/zero offset (determinism)", () => {
    const tri: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [2, 3],
    ];
    expect(offsetPolygonOutward(tri, 0)).toEqual(tri);
    expect(offsetPolygonOutward([[0, 0], [1, 1]], 1)).toEqual([[0, 0], [1, 1]]); // < 3 pts
    expect(offsetPolygonOutward(tri, 1)).toEqual(offsetPolygonOutward(tri, 1));
  });

  it("the offset grows the traced ellipse shape vs a hypothetical un-offset trace", () => {
    // A larger ellipse gives more contour points; the offset must widen the span.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 25, 30, WHITE);
    const snapped = snapRegionToBubble(bmp, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    const xs = snapped!.shape!.map((p) => p[0]);
    const ys = snapped!.shape!.map((p) => p[1]);
    // The traced span exceeds the analytic ellipse (dilation + offset push it out).
    expect(Math.min(...xs)).toBeLessThan(0.25); // analytic minX = 25 px = 0.25
    expect(Math.max(...xs)).toBeGreaterThan(0.75);
    expect(Math.min(...ys)).toBeLessThan(0.2); // analytic minY = 20 px = 0.20
    expect(Math.max(...ys)).toBeGreaterThan(0.8);
  });
});

// --- Phase 9.1 §2: median fill color + paper-white/black snap ----------------

describe("bubbleSnap — median color + paper snap (Phase 9.1 §2)", () => {
  it("a near-white median snaps to pure #ffffff (paper snap)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, 248); // uniform 248 → luma 248 ≥ 245 → snap white
    const snapped = snapRegionToBubble(bmp, { x: 0.15, y: 0.15, w: 0.7, h: 0.7 });
    expect(snapped!.fillColor).toBe("#ffffff"); // NOT #f8f8f8
  });

  it("median (not mean) resists an AA-grey fringe: majority-white blob → #ffffff", () => {
    // ~48 % of the fill is grey (231, just fillable) and ~52 % is pure white. The
    // MEAN drops to ≈243 (#f3f3f3, a visible grey patch); the MEDIAN stays 255 →
    // #ffffff after the paper snap. Rows 25–48 grey, 49–74 white (seed at 50 white).
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 25, 25, 74, 74, 255);
    fillRect(bmp, 25, 25, 74, 48, 231); // 24 of 50 rows grey → minority
    const snapped = snapRegionToBubble(bmp, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(snapped).not.toBeNull();
    expect(snapped!.fillColor).toBe("#ffffff");
  });

  it("a genuine mid-grey screentone stays its median grey (no snap)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, 180); // uniform screentone grey
    const snapped = snapRegionToBubble(bmp, { x: 0.15, y: 0.15, w: 0.7, h: 0.7 });
    expect(snapped!.fillColor).toBe("#b4b4b4"); // 180 = 0xb4, no paper snap
  });

  it("a near-black median snaps to pure #000000 (flash bubble, inverse path)", () => {
    const bmp = grayBitmap(100, 100, 255); // white page
    fillEllipse(bmp, 50, 50, 30, 30, 8); // near-black flash interior (luma 8 ≤ 12)
    const snapped = snapRegionToBubble(bmp, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(snapped!.fillColor).toBe("#000000"); // NOT #080808
  });

  it("is deterministic (histogram medians, same bitmap → identical color)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, 200);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    expect(snapRegionToBubble(bmp, box)!.fillColor).toBe(
      snapRegionToBubble(bmp, box)!.fillColor,
    );
  });
});

// --- Phase 9.1 §4: seed rescue for offset provider boxes ---------------------

describe("bubbleSnap — seed rescue (Phase 9.1 §4)", () => {
  it("recovers an offset bubble via the rescue when the main fill overflows the 2× wall", () => {
    // Offset box: its center (40,36) sits OFF the bubble, and a main seed that DOES
    // land on the bubble fills a blob overflowing the box's 2× confinement (the
    // ellipse reaches x=75, past the wall at x≈64) → §1 wall-slams the main path.
    // The 5×5 rescue grid, confined to the EXPANDED box (which contains the whole
    // ellipse), then recovers it and its ≥40 % provider-overlap (~53 %) accepts.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 55, 50, 20, 18, WHITE); // bubble [35,75]×[32,68]
    const box: BBox = { x: 0.28, y: 0.24, w: 0.24, h: 0.24 }; // center (40,36), off the bubble
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    // Snapped onto the ellipse bounds (≈[35,75]×[32,68], ± pad), not the loose box.
    expect(snapped!.bbox.x).toBeCloseTo(0.34, 2);
    expect(snapped!.bbox.x + snapped!.bbox.w).toBeCloseTo(0.77, 2);
    expect(snapped!.shape).toBeDefined();
    // The recovery is confinement-agnostic here (the ellipse fits the rescue's
    // expanded window): disabling confinement yields the identical box.
    expect(snapRegionToBubble(bmp, box, { confineExpand: Number.POSITIVE_INFINITY })).toEqual(
      snapped,
    );
  });

  it("§1 keeps the provider box for a bubble past 2× the box that the rescue can't anchor (< 40 %)", () => {
    // The pre-9.3 build recovered this via a lucky main seed; §1 now walls that
    // fill (the ellipse overflows the box's 2× window) and the rescue's ≥40 %
    // overlap guard rejects it (the offset box covers only ~32 % of the ellipse),
    // so it fails soft to the provider box (rule 4). confineExpand: Infinity pins
    // the change on the wall — un-confined, the main path still snaps the ellipse.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 60, 55, 14, 14, WHITE);
    const box: BBox = { x: 0.32, y: 0.33, w: 0.24, h: 0.24 };
    expect(snapRegionToBubble(bmp, box)).toBeNull();
    expect(
      snapRegionToBubble(bmp, box, { confineExpand: Number.POSITIVE_INFINITY }),
    ).not.toBeNull();
  });

  it("returns null when even the expanded rescue grid misses the bubble", () => {
    // The bubble is far outside the box + 25 % expansion → no rescue seed reaches it.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 85, 85, 8, 8, WHITE);
    const box: BBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }; // center (20,20), far away
    expect(snapRegionToBubble(bmp, box)).toBeNull();
  });

  it("rejects a rescue that covers < 40 % of the provider box (wandered to a neighbour)", () => {
    // A small bubble sits at the corner of the expanded grid; a rescue seed fills
    // it, but its bbox overlaps the ORIGINAL provider box by well under 40 % → the
    // guard rejects it and the loose box is kept.
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 78, 50, 6, 6, WHITE); // neighbour bubble far to the right
    const box: BBox = { x: 0.35, y: 0.44, w: 0.24, h: 0.12 }; // center (47,50)
    expect(snapRegionToBubble(bmp, box)).toBeNull();
  });

  it("an on-box bubble never enters the rescue path (standard seeds snap it)", () => {
    // A normal, well-placed box → the center seed hits the bubble immediately, so
    // the result is identical to a run where rescue could not possibly help.
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 35, 35, 65, 65, WHITE);
    const box: BBox = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x).toBeCloseTo(0.34, 2); // minX 35, padded → 34
  });

  it("exposes the rescue overlap threshold", () => {
    expect(RESCUE_MIN_PROVIDER_OVERLAP).toBeGreaterThan(0);
    expect(RESCUE_MIN_PROVIDER_OVERLAP).toBeLessThan(1);
  });
});

// --- Phase 9 §7: sampled fill color + dark-bubble polarity -------------------

describe("bubbleSnap — sampled color + dark polarity (Phase 9 §7)", () => {
  it("reports the median interior color of an accepted fill", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 70, 70, 230); // uniform off-white paper (below the paper snap)
    const snapped = snapRegionToBubble(bmp, { x: 0.15, y: 0.15, w: 0.7, h: 0.7 });
    expect(snapped).not.toBeNull();
    expect(snapped!.fillColor).toBe("#e6e6e6"); // 230 = 0xe6, exact (uniform blob)
  });

  it("snaps a dark ellipse on white ground via the inverted-polarity path", () => {
    const bmp = grayBitmap(100, 100, 255); // white page
    fillEllipse(bmp, 50, 50, 30, 30, 30); // dark flash-bubble interior
    const snapped = snapRegionToBubble(bmp, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(snapped).not.toBeNull();
    // Tightened to the ellipse bounds [20,80] ± pad.
    expect(snapped!.bbox.x).toBeCloseTo(0.19, 2);
    expect(snapped!.bbox.w).toBeCloseTo(0.63, 2);
    expect(snapped!.fillColor).toBe("#1e1e1e"); // 30 = 0x1e — a DARK fill
    expect(snapped!.shape).toBeDefined();
    for (const pt of snapped!.shape!) {
      expect(ellipseRadial(pt, 50, 50, 30, 30)).toBeGreaterThan(0.8);
      expect(ellipseRadial(pt, 50, 50, 30, 30)).toBeLessThan(1.25);
    }
  });

  it("mixed light/dark seeds keep today's light-path-only behavior (null)", () => {
    // Mid-gray ground (above DARK_CEILING, below LIGHT_FLOOR) with a dark patch
    // under the center seed: no light seed, but not ALL seeds dark → no inverse.
    const bmp = grayBitmap(100, 100, 100);
    fillRect(bmp, 45, 45, 55, 55, 30);
    expect(snapRegionToBubble(bmp, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 })).toBeNull();
  });

  it("dark mode fires the same leak guard (dark region escaping the box → null)", () => {
    const bmp = grayBitmap(100, 100, 255);
    fillRect(bmp, 10, 10, 90, 90, 30); // 66% of the image is dark
    expect(snapRegionToBubble(bmp, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBeNull();
  });

  it("dark mode fires the same min-area guard (dark speck under every seed → null)", () => {
    const bmp = grayBitmap(100, 100, 255);
    fillRect(bmp, 41, 41, 59, 59, 30); // 19×19 dark speck covering all seeds
    // Box 32×32 px: seeds spread ±8 px, all inside the speck. Blob area 361 <
    // 0.5 × 1024 with the raised fraction → every dark seed rejects → null.
    expect(
      snapRegionToBubble(
        bmp,
        { x: 0.34, y: 0.34, w: 0.32, h: 0.32 },
        { minBlobFraction: 0.5 },
      ),
    ).toBeNull();
  });

  it("dark path is deterministic and never mutates inputs", () => {
    const bmp = grayBitmap(100, 100, 255);
    fillEllipse(bmp, 50, 50, 30, 30, 30);
    const box: BBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const snapshot = { ...box };
    expect(snapRegionToBubble(bmp, box)).toEqual(snapRegionToBubble(bmp, box));
    expect(box).toEqual(snapshot);
  });
});

// --- Phase 9.2: sprawl guard (partial leaks under the leak caps) -------------

describe("bubbleSnap — sprawl guard (Phase 9.2)", () => {
  /** A white "+" through the whole bitmap: the sprawl archetype — connected,
   *  under both leak caps for the box below, but filling only ~12 % of its own
   *  bounds (a fill that escaped along thin corridors). */
  function crossBitmap(): SnapBitmap {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 0, 47, 99, 52, WHITE); // horizontal bar
    fillRect(bmp, 47, 0, 52, 99, WHITE); // vertical bar
    return bmp;
  }
  // Box 40×40 centered: seed-box area 1600 → leak cap min(4×1600, 3500) = 3500;
  // cross area ≈ 1164 stays UNDER it, and over min-area 400 — only the sprawl
  // guard can reject this blob.
  const BOX: BBox = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };

  it("rejects a sprawling blob that stays under the leak caps (fail soft → null)", () => {
    expect(snapRegionToBubble(crossBitmap(), BOX)).toBeNull();
  });

  it("the rejection is the guard's (threshold 0 accepts the same fixture)", () => {
    const snapped = snapRegionToBubble(crossBitmap(), BOX, { minBlobBboxFill: 0 });
    expect(snapped).not.toBeNull();
    // With the guard disabled the cross snaps to (nearly) the whole bitmap —
    // exactly the weird sprawl-shaped fill the guard exists to reject.
    expect(snapped!.bbox.w).toBeGreaterThan(0.9);
    expect(snapped!.bbox.h).toBeGreaterThan(0.9);
  });

  it("also guards the rescue path (offset box over the same sprawl → null)", () => {
    // Box at x/y 57: all nine standard seeds (67/77/87) land on gray, but the
    // expanded rescue grid starts at 57 − 10 = 47 — ON the cross bars — so only
    // the rescue path reaches the sprawl.
    const offsetBox: BBox = { x: 0.57, y: 0.57, w: 0.4, h: 0.4 };
    expect(snapRegionToBubble(crossBitmap(), offsetBox)).toBeNull();
    // Phase 9.3: the §1 confinement wall ALSO rejects the rescue fill (the cross
    // bars run past the wall), so disabling only the sprawl guard still yields
    // null…
    expect(
      snapRegionToBubble(crossBitmap(), offsetBox, { minBlobBboxFill: 0 }),
    ).toBeNull();
    // …the control that proves the SPRAWL guard (not a grid miss) rejected the
    // default run must disable BOTH: un-confined + guard off, the cross fills the
    // whole bitmap and rescue-accepts (provider-box coverage 1.0). [Phase 9.3
    // sanctioned edit: confineExpand: Infinity isolates the sprawl guard.]
    expect(
      snapRegionToBubble(crossBitmap(), offsetBox, {
        minBlobBboxFill: 0,
        confineExpand: Number.POSITIVE_INFINITY,
      }),
    ).not.toBeNull();
  });

  it("a compact interior is untouched: ellipse fill ratio π/4 clears the 0.3 bar", () => {
    // Regression pin for the threshold choice: a clean ellipse (the common
    // bubble) fills ~0.79 of its bounds — comfortably above MIN_BLOB_BBOX_FILL.
    expect(MIN_BLOB_BBOX_FILL).toBeLessThan(Math.PI / 4);
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 25, 30, WHITE);
    const snapped = snapRegionToBubble(bmp, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(snapped).not.toBeNull();
    expect(snapped!.shape).toBeDefined();
  });

  it("is deterministic (same sprawl bitmap → same null, no partial state)", () => {
    expect(snapRegionToBubble(crossBitmap(), BOX)).toEqual(
      snapRegionToBubble(crossBitmap(), BOX),
    );
  });
});

// --- Phase 9.3 §1: flood-fill confinement + wall-slam rejection --------------

describe("bubbleSnap — confinement wall-slam (Phase 9.3 §1)", () => {
  /** A bubble that leaks through a thin white margin corridor to a far white
   *  region ENTIRELY beyond 2× (and 3×) the box — the cross-panel margin leak.
   *  Solid white throughout, so it clears the sprawl guard and both leak caps. */
  function marginLeak(): SnapBitmap {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 15, 40, 35, 55, WHITE); // the bubble (over the box)
    fillRect(bmp, 35, 47, 90, 48, WHITE); // thin margin corridor across the wall
    fillRect(bmp, 70, 40, 88, 55, WHITE); // neighbouring-panel white region
    return bmp;
  }
  const LEAK_BOX: BBox = { x: 0.15, y: 0.4, w: 0.15, h: 0.15 };

  it("rejects a fill that slams a hard wall (margin leak → provider box)", () => {
    expect(snapRegionToBubble(marginLeak(), LEAK_BOX)).toBeNull();
  });

  it("the rejection is the wall's: confineExpand Infinity accepts the same leak", () => {
    // Un-confined, the solid leak clears the sprawl guard + both leak caps, so it
    // is ACCEPTED as one giant cross-panel blob — pinning the null on the wall,
    // not another guard. (This IS the shape §1 exists to reject.)
    const open = snapRegionToBubble(marginLeak(), LEAK_BOX, {
      confineExpand: Number.POSITIVE_INFINITY,
    });
    expect(open).not.toBeNull();
    expect(open!.bbox.w).toBeGreaterThan(0.7); // spans well past 2× the box
  });

  it("a bubble fully inside the window snaps byte-identically with/without confinement", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 15, 15, WHITE); // [35,65] — inside the box's 2× window [20,80]
    const box: BBox = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
    const confined = snapRegionToBubble(bmp, box);
    const open = snapRegionToBubble(bmp, box, { confineExpand: Number.POSITIVE_INFINITY });
    expect(confined).not.toBeNull();
    expect(confined).toEqual(open); // no wall touched → identical SnapResult
  });

  it("a page-edge bubble still snaps (a clamped image-boundary edge is not a hard wall)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 0, 0, 20, 20, WHITE); // bubble in the top-left corner, touching both edges
    const box: BBox = { x: 0.02, y: 0.02, w: 0.15, h: 0.15 };
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.x).toBe(0); // hugs the corner the confinement clamps to the edge
    expect(snapped!.bbox.y).toBe(0);
  });

  it("is deterministic (same leak bitmap → same null)", () => {
    expect(snapRegionToBubble(marginLeak(), LEAK_BOX)).toEqual(
      snapRegionToBubble(marginLeak(), LEAK_BOX),
    );
  });

  it("the margin leak STILL returns null at the looser 1.0 wall (leak defense held)", () => {
    // Phase 9.4 §2 pins the safety property: loosening the wall 0.5 → 1.0 must NOT
    // reopen the 9.3 cross-panel leak. The far white region sits beyond 3× the box
    // too, so the fill slams the 1.0 wall exactly as it slammed the 0.5 wall — the
    // rejection is still the wall's, not a coincidence of the tighter setting.
    expect(snapRegionToBubble(marginLeak(), LEAK_BOX, { confineExpand: 1.0 })).toBeNull();
  });
});

// --- Phase 9.4 §2: bounded confinement cascade (recover real bubbles) --------

describe("bubbleSnap — confinement cascade (Phase 9.4 §2)", () => {
  /**
   * An undersized+offset provider box on a real, COMPACT white bubble whose true
   * extent runs past the 2× wall on the top/left but stays within 3×. The box
   * center sits off the bubble (on art), but a quarter-point seed lands on it, so
   * the MAIN path fills — and slams the 2× wall at 0.5. The rescue at 0.5 reaches
   * the bubble too, but the blob covers only ~25 % of the provider box, so the
   * ≥40 % rescue guard rejects it → null at 0.5. At the looser 1.0 wall the main
   * fill no longer slams (the bubble is inside the 3× window) and accepts — no
   * coverage guard on the main path. This is exactly the bubble §2 recovers.
   */
  function undersizedOffset(): SnapBitmap {
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 43, 43, 55, 55, WHITE); // compact 13×13 bubble
    return bmp;
  }
  // Box center (57,57) is off the bubble; the quarter seed (55,55) is on it.
  const OFFSET_BOX: BBox = { x: 0.52, y: 0.52, w: 0.1, h: 0.1 };

  it("returns null at the tight 0.5 wall (main slams, rescue guard rejects)", () => {
    expect(snapRegionToBubble(undersizedOffset(), OFFSET_BOX)).toBeNull();
  });

  it("snaps at the looser 1.0 wall (the bubble is inside the 3× window)", () => {
    const loose = snapRegionToBubble(undersizedOffset(), OFFSET_BOX, {
      confineExpand: SNAP_CONFINE_EXPAND_LOOSE,
    });
    expect(loose).not.toBeNull();
    // It hugs the real bubble (~[0.42,0.57] after the 1 px pad), not the box.
    expect(loose!.bbox.x).toBeCloseTo(0.42, 6);
    expect(loose!.bbox.w).toBeCloseTo(0.15, 6);
  });

  it("the Stage-1b cascade in snapAllRegions recovers it end-to-end", () => {
    // Old behaviour (0.5 only) → null → §1 fallback; the cascade retries at 1.0.
    const [snapped] = snapAllRegions(undersizedOffset(), [bubble(OFFSET_BOX)]);
    expect(snapped).not.toBeNull();
    expect(snapped!.bbox.w).toBeCloseTo(0.15, 6);
  });

  it("a fully-inside bubble is byte-identical at 0.5 and 1.0 (cascade never runs pass 2)", () => {
    const bmp = grayBitmap(100, 100, GRAY);
    fillEllipse(bmp, 50, 50, 15, 15, WHITE); // [35,65] — inside the box's 2× window
    const box: BBox = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
    const tight = snapRegionToBubble(bmp, box); // default 0.5
    const loose = snapRegionToBubble(bmp, box, { confineExpand: SNAP_CONFINE_EXPAND_LOOSE });
    expect(tight).not.toBeNull();
    expect(tight).toEqual(loose); // first pass accepts → identical result
  });

  it("SNAP_VERSION is 4 (the cascade changes snap output; delivered via free re-snap)", () => {
    expect(SNAP_VERSION).toBe(4);
  });

  it("is deterministic (same bitmap → same recovered box)", () => {
    expect(snapRegionToBubble(undersizedOffset(), OFFSET_BOX, { confineExpand: 1.0 })).toEqual(
      snapRegionToBubble(undersizedOffset(), OFFSET_BOX, { confineExpand: 1.0 }),
    );
  });
});
