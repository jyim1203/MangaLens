import { describe, expect, it } from "vitest";
import {
  clampBoxToRect,
  computeSnapSize,
  shouldSnapKind,
  snapAllRegions,
  snapRegionToBubble,
  SHARED_BLOB_IOU,
  SNAP_MAX_EDGE,
  SNAP_MIN_SHORT_EDGE,
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
    expect(snapped!.x).toBeCloseTo(0.24, 2); // minX 25, padded → 24
    expect(snapped!.x + snapped!.w).toBeCloseTo(0.77, 2); // maxX 75, padded → 76 (+1)
    expect(snapped!.y).toBeCloseTo(0.19, 2);
    expect(snapped!.w).toBeLessThan(0.8);
    expect(snapped!.h).toBeLessThan(0.8);
  });

  it("shrinks an oversized seed box down to the bubble", () => {
    // White rect bubble [30..69] × [30..69] (40×40) on gray; box is 1.5× wider.
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 30, 30, 69, 69, WHITE);
    const box: BBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.x).toBeCloseTo(0.29, 2); // minX 30, padded → 29
    expect(snapped!.w).toBeCloseTo(0.42, 2); // (70 − 29 + 1)/100
    expect(snapped!.w).toBeLessThan(box.w); // it SHRANK
  });

  it("grows a too-small seed box up to the bubble (snap is bidirectional)", () => {
    // Bubble [33..67] × [33..67] (35×35, ≈3× the seed box, within the 4× cap).
    const bmp = grayBitmap(100, 100, GRAY);
    fillRect(bmp, 33, 33, 67, 67, WHITE);
    const box: BBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }; // 20×20 in the middle
    const snapped = snapRegionToBubble(bmp, box);
    expect(snapped).not.toBeNull();
    expect(snapped!.x).toBeCloseTo(0.32, 2); // minX 33, padded → 32
    expect(snapped!.w).toBeGreaterThan(box.w); // it GREW
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
    expect(snapped!.x).toBeCloseTo(0.42, 2); // minX 43, padded → 42
    expect(snapped!.x + snapped!.w).toBeCloseTo(0.62, 2); // maxX 60, padded → 61 (+1)
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
    expect(snapped!.x).toBeCloseTo(0.29, 2);
    expect(snapped!.x + snapped!.w).toBeCloseTo(0.72, 2); // maxX 70, padded → 71 (+1)
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
    expect(top!.h).toBeLessThan(0.5);
    expect(bottom!.h).toBeLessThan(0.5);
    // Neither box covers the other's lobe.
    expect(cov(top!, bottom!)).toBeLessThan(0.2);
    expect(cov(bottom!, top!)).toBeLessThan(0.2);
    // Top is above bottom.
    expect(top!.y + top!.h).toBeLessThanOrEqual(bottom!.y + bottom!.h);
    expect(top!.y).toBeLessThan(bottom!.y);
  });

  it("splits a horizontally-joined pair (rotated) so each result hugs its lobe", () => {
    const regions = [
      bubble({ x: 0.1, y: 0.28, w: 0.36, h: 0.44 }), // left lobe
      bubble({ x: 0.54, y: 0.28, w: 0.36, h: 0.44 }), // right lobe
    ];
    const [left, right] = snapAllRegions(peanutH(), regions);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.w).toBeLessThan(0.5);
    expect(right!.w).toBeLessThan(0.5);
    expect(cov(left!, right!)).toBeLessThan(0.2);
    expect(left!.x).toBeLessThan(right!.x);
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
    expect(large!.h).toBeLessThan(0.5);
    expect(small!.h).toBeLessThan(0.5);
    expect(cov(large!, small!)).toBeLessThan(0.2);
    expect(cov(small!, large!)).toBeLessThan(0.2);
    expect(large!.y).toBeLessThan(small!.y); // large=top, small=bottom
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
    expect(snaps[0]!.y).toBeLessThan(snaps[1]!.y);
    expect(snaps[1]!.y).toBeLessThan(snaps[2]!.y);
    expect(cov(snaps[0]!, snaps[2]!)).toBeLessThan(0.2);
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
    expect(snapped!.x + snapped!.w).toBeLessThanOrEqual(0.52); // never crosses x=0.5
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
    const s = computeSnapSize(1024, 768);
    expect(Math.max(s.width, s.height)).toBe(SNAP_MAX_EDGE);
    expect(s.width).toBe(512);
    expect(s.height).toBe(384);
    expect(s.scale).toBeCloseTo(0.5, 6);
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
