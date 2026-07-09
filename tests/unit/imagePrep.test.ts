import { describe, expect, it } from "vitest";
import type { BBox } from "../../src/shared/types";
import {
  computeDownscaledSize,
  computeTiles,
  dedupeRegions,
  DEFAULT_TILE_HEIGHT_PX,
  DEFAULT_TILE_OVERLAP,
  iou,
  isLongStrip,
  LONG_STRIP_RATIO,
  planPrep,
  remapBboxFromTile,
} from "../../src/background/imagePrep";

describe("background/imagePrep — computeDownscaledSize", () => {
  it("does not upscale when the image is already within the cap (happy path)", () => {
    expect(computeDownscaledSize(800, 600, 1200)).toEqual({
      width: 800,
      height: 600,
      scale: 1,
    });
  });

  it("scales the long edge down to the cap, preserving aspect ratio", () => {
    // 2400×1200, cap 1200 → half size.
    const out = computeDownscaledSize(2400, 1200, 1200);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(600);
    expect(out.scale).toBeCloseTo(0.5, 10);
  });

  it("keys off the longer edge when the image is portrait", () => {
    const out = computeDownscaledSize(900, 1800, 1200);
    expect(out.height).toBe(1200);
    expect(out.width).toBe(600);
  });

  it("rounds to integer pixels and never returns below 1 (edge: extreme ratio)", () => {
    const out = computeDownscaledSize(10000, 3, 1200);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(1); // 3 * 0.12 = 0.36 → clamped up to 1
    expect(Number.isInteger(out.width)).toBe(true);
    expect(Number.isInteger(out.height)).toBe(true);
  });

  it("passes degenerate/zero dimensions through at scale 1 (edge: guard)", () => {
    expect(computeDownscaledSize(0, 0, 1200)).toEqual({
      width: 0,
      height: 0,
      scale: 1,
    });
  });
});

describe("background/imagePrep — isLongStrip", () => {
  it("flags a webtoon strip whose height/width exceeds the ratio", () => {
    expect(isLongStrip(800, 8000)).toBe(true);
  });

  it("does not flag a normal page", () => {
    expect(isLongStrip(800, 1200)).toBe(false);
  });

  it("uses the boundary strictly (== ratio is not a strip)", () => {
    expect(isLongStrip(100, 100 * LONG_STRIP_RATIO)).toBe(false);
    expect(isLongStrip(100, 100 * LONG_STRIP_RATIO + 1)).toBe(true);
  });

  it("returns false for zero width (edge: guard)", () => {
    expect(isLongStrip(0, 5000)).toBe(false);
  });
});

describe("background/imagePrep — computeTiles", () => {
  it("returns a single full-image tile when shorter than one tile (happy path)", () => {
    const tiles = computeTiles(800, 1000, { tileHeightPx: 1024 });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.offset).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(tiles[0]?.yStartPx).toBe(0);
    expect(tiles[0]?.yEndPx).toBe(1000);
  });

  it("covers a tall strip fully: first starts at 0, last ends at the bottom", () => {
    const H = 5000;
    const tiles = computeTiles(800, H, {
      tileHeightPx: 1024,
      overlap: 0.1,
    });
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles[0]?.yStartPx).toBe(0);
    expect(tiles.at(-1)?.yEndPx).toBe(H);
  });

  it("produces uniform-height, monotonically-advancing, overlapping tiles", () => {
    const H = 5000;
    const tileHeightPx = 1024;
    const overlap = 0.1;
    const tiles = computeTiles(800, H, { tileHeightPx, overlap });

    const minOverlapPx = tileHeightPx * overlap;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i]!;
      // Every tile is exactly one tile-height tall.
      expect(t.heightPx).toBe(tileHeightPx);
      // Stays within the image.
      expect(t.yStartPx).toBeGreaterThanOrEqual(0);
      expect(t.yEndPx).toBeLessThanOrEqual(H);
      if (i > 0) {
        const prev = tiles[i - 1]!;
        // Advances downward…
        expect(t.yStartPx).toBeGreaterThan(prev.yStartPx);
        // …but overlaps the previous tile by at least the nominal overlap (no gap).
        expect(prev.yEndPx - t.yStartPx).toBeGreaterThanOrEqual(minOverlapPx);
      }
    }
  });

  it("emits normalized offsets consistent with the pixel bounds", () => {
    const H = 4096;
    const tiles = computeTiles(800, H, { tileHeightPx: 1024, overlap: 0.1 });
    for (const t of tiles) {
      expect(t.offset.x).toBe(0);
      expect(t.offset.w).toBe(1);
      expect(t.offset.y).toBeCloseTo(t.yStartPx / H, 10);
      expect(t.offset.h).toBeCloseTo(t.heightPx / H, 10);
    }
    // Offsets in order span the whole [0,1] range.
    expect(tiles[0]?.offset.y).toBe(0);
    const last = tiles.at(-1)!;
    expect(last.offset.y + last.offset.h).toBeCloseTo(1, 10);
  });

  it("defaults tile height and overlap to the documented constants", () => {
    const withDefaults = computeTiles(800, 6000);
    const explicit = computeTiles(800, 6000, {
      tileHeightPx: DEFAULT_TILE_HEIGHT_PX,
      overlap: DEFAULT_TILE_OVERLAP,
    });
    expect(withDefaults).toEqual(explicit);
  });
});

describe("background/imagePrep — planPrep", () => {
  it("caps a normal page's long edge and emits a single full-image tile (happy path)", () => {
    const plan = planPrep(2400, 1200, { maxEdgePx: 1200 });
    expect(plan.strip).toBe(false);
    expect(plan.scale).toBeCloseTo(0.5, 10);
    expect(plan.scaledWidthPx).toBe(1200);
    expect(plan.scaledHeightPx).toBe(600);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]?.offset).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("does NOT long-edge-crush a webtoon strip: height survives, strip is tiled", () => {
    // REGRESSION: capping the long edge of an 800×20000 strip would yield
    // 48×1200 — the strip must be width-capped instead (§7.5 per-tile cap).
    const plan = planPrep(800, 20000, { maxEdgePx: 1200 });
    expect(plan.strip).toBe(true);
    expect(plan.scale).toBe(1); // width 800 already under the cap
    expect(plan.scaledWidthPx).toBe(800);
    expect(plan.scaledHeightPx).toBe(20000);
    expect(plan.tiles.length).toBeGreaterThan(1);
    for (const t of plan.tiles) expect(t.heightPx).toBe(1024);
    expect(plan.tiles.at(-1)?.yEndPx).toBe(20000);
  });

  it("width-caps a strip that is wider than the max edge", () => {
    const plan = planPrep(1600, 16000, { maxEdgePx: 1200 });
    expect(plan.strip).toBe(true);
    expect(plan.scale).toBeCloseTo(0.75, 10);
    expect(plan.scaledWidthPx).toBe(1200);
    expect(plan.scaledHeightPx).toBe(12000);
  });

  it("clamps the tile height to maxEdgePx so every tile honours the per-tile cap", () => {
    // Cap below the default 1024 tile height: tiles must shrink to match.
    const plan = planPrep(700, 9000, { maxEdgePx: 800 });
    expect(plan.strip).toBe(true);
    for (const t of plan.tiles) {
      expect(t.heightPx).toBeLessThanOrEqual(800);
      expect(Math.max(plan.scaledWidthPx, t.heightPx)).toBeLessThanOrEqual(800);
    }
  });

  it("keeps a tall-but-not-strip page as one tile (edge: ratio below threshold)", () => {
    const plan = planPrep(1000, 2500, { maxEdgePx: 1200 }); // ratio 2.5 < 3
    expect(plan.strip).toBe(false);
    expect(plan.scaledWidthPx).toBe(480);
    expect(plan.scaledHeightPx).toBe(1200);
    expect(plan.tiles).toHaveLength(1);
  });

  it("passes degenerate dimensions through without tiling (edge: guard)", () => {
    const plan = planPrep(0, 0, { maxEdgePx: 1200 });
    expect(plan.strip).toBe(false);
    expect(plan.scale).toBe(1);
    expect(plan.tiles).toHaveLength(1);
  });
});

describe("background/imagePrep — remapBboxFromTile", () => {
  it("is the identity for a full-image tile offset (happy path)", () => {
    const region: BBox = { x: 0.2, y: 0.3, w: 0.4, h: 0.1 };
    const full: BBox = { x: 0, y: 0, w: 1, h: 1 };
    expect(remapBboxFromTile(region, full)).toEqual(region);
  });

  it("lifts a tile-local bbox into full-image space using the offset", () => {
    // Tile occupies the vertical band [0.5, 0.75] of the full image.
    const offset: BBox = { x: 0, y: 0.5, w: 1, h: 0.25 };
    // A region at the top-half of the tile.
    const region: BBox = { x: 0.1, y: 0, w: 0.2, h: 0.5 };
    expect(remapBboxFromTile(region, offset)).toEqual({
      x: 0.1,
      y: 0.5,
      w: 0.2,
      h: 0.125, // 0.5 * 0.25
    });
  });
});

describe("background/imagePrep — iou", () => {
  it("is 1 for identical boxes", () => {
    const b: BBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(iou(b, { ...b })).toBeCloseTo(1, 10);
  });

  it("is 0 for disjoint boxes", () => {
    const a: BBox = { x: 0, y: 0, w: 0.1, h: 0.1 };
    const b: BBox = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    expect(iou(a, b)).toBe(0);
  });

  it("computes a known partial overlap", () => {
    // Two unit-fraction boxes overlapping in a quarter each.
    const a: BBox = { x: 0, y: 0, w: 0.2, h: 0.2 };
    const b: BBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    // intersection = 0.1×0.1 = 0.01; union = 0.04+0.04-0.01 = 0.07.
    expect(iou(a, b)).toBeCloseTo(0.01 / 0.07, 10);
  });
});

describe("background/imagePrep — dedupeRegions", () => {
  it("keeps non-overlapping regions untouched (happy path)", () => {
    const regions = [
      { bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } },
      { bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ];
    expect(dedupeRegions(regions)).toHaveLength(2);
  });

  it("drops a near-duplicate, keeping the higher-confidence copy", () => {
    const low = {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      confidence: 0.4,
      original: "low",
    };
    const high = {
      bbox: { x: 0.105, y: 0.105, w: 0.2, h: 0.2 },
      confidence: 0.9,
      original: "high",
    };
    const out = dedupeRegions([low, high]);
    expect(out).toHaveLength(1);
    expect(out[0]?.original).toBe("high");
  });

  it("treats missing confidence as 0 and preserves first-seen slot order", () => {
    const first = { bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, original: "first" };
    const dupHigher = {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      confidence: 0.8,
      original: "dup",
    };
    const other = { bbox: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, original: "other" };
    const out = dedupeRegions([first, dupHigher, other]);
    expect(out).toHaveLength(2);
    // The higher-confidence duplicate wins the first slot; order preserved.
    expect(out[0]?.original).toBe("dup");
    expect(out[1]?.original).toBe("other");
  });

  it("respects a custom IoU threshold (edge: strict threshold keeps both)", () => {
    const a = { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, confidence: 0.5 };
    const b = { bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 0.5 };
    // IoU ≈ 0.143 — below 0.5 so both survive, above 0.1 so a low threshold merges.
    expect(dedupeRegions([a, b], 0.5)).toHaveLength(2);
    expect(dedupeRegions([a, b], 0.1)).toHaveLength(1);
  });
});
