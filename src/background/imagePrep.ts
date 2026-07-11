/**
 * Image preparation: downscale, webtoon long-strip tiling, and JPEG encoding
 * (§7.4, §7.5). Runs in the BACKGROUND event page, which has a DOM and thus
 * `createImageBitmap` + `OffscreenCanvas` (Firefox MV3 event pages, unlike
 * content scripts, can decode our own fetched bytes without canvas tainting).
 *
 * Two layers, deliberately separated:
 *  1. PURE MATH (downscale dimensions, tile offsets/overlap, bbox remap, IoU
 *     dedupe) — no browser APIs, unit-tested exhaustively.
 *  2. `prepareImage` — the thin canvas driver that calls the math and does the
 *     actual pixel work. Not unit-tested (needs a real canvas); kept minimal so
 *     the untested surface is small.
 *
 * All coordinates that leave this module are normalized 0–1 relative to the
 * ORIGINAL full image (handoff rule 5). A tile's {@link PreparedTile.offset} is
 * where that tile sits in the full image; provider bboxes come back relative to
 * the tile and are lifted to full-image space with {@link remapBboxFromTile}.
 */
import type { BBox } from "../shared/types";

/** Default per-tile height for long strips, in px of the downscaled image (§7.4). */
export const DEFAULT_TILE_HEIGHT_PX = 1024;

/** Default fractional overlap between adjacent tiles (§7.4: "10% overlap"). */
export const DEFAULT_TILE_OVERLAP = 0.1;

/**
 * Aspect ratio (height / width) above which an image is treated as a webtoon
 * long strip and tiled (§7.4: "height/width ratio > 3").
 */
export const LONG_STRIP_RATIO = 3;

/** Default IoU above which two tiled regions are considered the same bubble (§7.4). */
export const TILE_DEDUPE_IOU = 0.5;

/** Result of the downscale-dimension calculation. `scale` ≤ 1 (never upscales). */
export interface DownscaledSize {
  width: number;
  height: number;
  /** Multiplier applied to the natural size, in (0, 1]. */
  scale: number;
}

/**
 * Compute the target size for downscaling so the LONG edge is at most
 * `maxEdgePx`, preserving aspect ratio and never upscaling (§7.5).
 *
 * @param naturalWidthPx source width in px.
 * @param naturalHeightPx source height in px.
 * @param maxEdgePx cap on the longer edge (settings.maxImageEdgePx, default 1200).
 * @returns integer target dims + the scale factor. Degenerate/≤0 inputs pass
 *   through at scale 1 (caller should have rejected them upstream).
 */
export function computeDownscaledSize(
  naturalWidthPx: number,
  naturalHeightPx: number,
  maxEdgePx: number,
): DownscaledSize {
  const longEdge = Math.max(naturalWidthPx, naturalHeightPx);
  if (
    !Number.isFinite(longEdge) ||
    longEdge <= 0 ||
    maxEdgePx <= 0 ||
    longEdge <= maxEdgePx
  ) {
    return { width: naturalWidthPx, height: naturalHeightPx, scale: 1 };
  }
  const scale = maxEdgePx / longEdge;
  return {
    width: Math.max(1, Math.round(naturalWidthPx * scale)),
    height: Math.max(1, Math.round(naturalHeightPx * scale)),
    scale,
  };
}

/**
 * True if an image should be tiled as a long strip: height/width exceeds
 * `ratio` (§7.4). Scale-invariant, so it can be called on natural or scaled
 * dimensions interchangeably.
 */
export function isLongStrip(
  widthPx: number,
  heightPx: number,
  ratio: number = LONG_STRIP_RATIO,
): boolean {
  if (widthPx <= 0) return false;
  return heightPx / widthPx > ratio;
}

/** One computed tile: a horizontal slice of the (downscaled) full image. */
export interface Tile {
  index: number;
  /** Inclusive top row in downscaled px. */
  yStartPx: number;
  /** Exclusive bottom row in downscaled px. */
  yEndPx: number;
  /** `yEndPx - yStartPx`. */
  heightPx: number;
  /** Position of this tile within the full image, normalized 0–1. */
  offset: BBox;
}

/** Options for {@link computeTiles}. */
export interface TileOptions {
  tileHeightPx?: number;
  /** Fractional overlap between neighbours, clamped to [0, 0.95]. */
  overlap?: number;
}

/**
 * Slice a tall image into vertically-overlapping tiles (§7.4).
 *
 * The tiles are uniform height (`tileHeightPx`, except a whole image shorter
 * than one tile), the first starts at y=0, the LAST ends exactly at the image
 * bottom, and every adjacent pair overlaps by at least `overlap * tileHeightPx`.
 * WHY even spacing with a pinned last tile: it avoids a thin, mostly-empty
 * sliver tile at the end (which wastes a provider call) while guaranteeing full
 * coverage with no gaps.
 *
 * @param fullWidthPx width of the downscaled image (tiles span the full width).
 * @param fullHeightPx height of the downscaled image.
 * @returns tiles in top-to-bottom order; a single full-image tile when the
 *   image is no taller than one tile.
 */
export function computeTiles(
  fullWidthPx: number,
  fullHeightPx: number,
  options: TileOptions = {},
): Tile[] {
  const tileHeightPx = options.tileHeightPx ?? DEFAULT_TILE_HEIGHT_PX;
  const overlap = Math.min(0.95, Math.max(0, options.overlap ?? DEFAULT_TILE_OVERLAP));

  const fullTile = (): Tile[] => [
    {
      index: 0,
      yStartPx: 0,
      yEndPx: fullHeightPx,
      heightPx: fullHeightPx,
      offset: { x: 0, y: 0, w: 1, h: 1 },
    },
  ];

  if (tileHeightPx <= 0 || fullHeightPx <= 0 || fullHeightPx <= tileHeightPx) {
    return fullTile();
  }

  const overlapPx = tileHeightPx * overlap;
  // Number of uniform, overlapping windows needed to cover [0, fullHeight].
  const n = Math.max(
    1,
    Math.ceil((fullHeightPx - overlapPx) / (tileHeightPx - overlapPx)),
  );
  if (n === 1) return fullTile();

  // Even top-edge spacing so tile 0 starts at 0 and tile n-1 ends at fullHeight.
  const stride = (fullHeightPx - tileHeightPx) / (n - 1);
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    let yStartPx: number;
    let yEndPx: number;
    if (i === n - 1) {
      // Pin the last tile flush to the bottom (exact coverage, integer bounds).
      yEndPx = fullHeightPx;
      yStartPx = fullHeightPx - tileHeightPx;
    } else {
      yStartPx = Math.round(i * stride);
      yEndPx = yStartPx + tileHeightPx;
      if (yEndPx > fullHeightPx) {
        // Rounding pushed us past the edge — keep full tile height, clamp to bottom.
        yEndPx = fullHeightPx;
        yStartPx = fullHeightPx - tileHeightPx;
      }
    }
    const heightPx = yEndPx - yStartPx;
    tiles.push({
      index: i,
      yStartPx,
      yEndPx,
      heightPx,
      offset: {
        x: 0,
        y: yStartPx / fullHeightPx,
        w: 1,
        h: heightPx / fullHeightPx,
      },
    });
  }
  return tiles;
}

/**
 * Lift a bbox from tile-local normalized space into full-image normalized space
 * using the tile's {@link Tile.offset} (§7.4 remap). The inverse of tiling: a
 * provider sees only the tile, so its bboxes are relative to the tile; this maps
 * them back onto the original page.
 *
 * @param regionBbox bbox as returned by the provider, relative to the tile.
 * @param tileOffset the tile's position in the full image.
 * @returns the bbox relative to the full original image.
 */
export function remapBboxFromTile(regionBbox: BBox, tileOffset: BBox): BBox {
  return {
    x: tileOffset.x + regionBbox.x * tileOffset.w,
    y: tileOffset.y + regionBbox.y * tileOffset.h,
    w: regionBbox.w * tileOffset.w,
    h: regionBbox.h * tileOffset.h,
  };
}

/**
 * Intersection-over-union of two normalized bboxes: intersection area divided by
 * union area, in [0, 1]. 0 when they don't overlap. Used to dedupe the same
 * bubble appearing in two overlapping tiles (§7.4) and, later, provider-side
 * duplicate detection (PROMPTS.md §6).
 */
export function iou(a: BBox, b: BBox): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  if (intersection <= 0) return 0;

  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Minimal shape {@link dedupeRegions} needs: a bbox and an optional confidence. */
export interface DedupableRegion {
  bbox: BBox;
  confidence?: number;
}

/**
 * Drop duplicate regions that overlap by more than `iouThreshold`, keeping the
 * higher-confidence copy (§7.4: "IoU > 0.5 keep higher confidence"). Intended
 * for merging the results of overlapping webtoon tiles after each tile's bboxes
 * have been lifted to full-image space with {@link remapBboxFromTile}.
 *
 * WHY confidence, not the §4.4 "farther from the cut edge" heuristic: this
 * operates on already-remapped, tile-agnostic regions and matches the simpler
 * Architecture §7.4 rule; the cut-edge refinement can layer on later if needed.
 *
 * Order-stable: the first region of each overlap group anchors its slot, and the
 * kept survivor sits in that slot. Missing confidence counts as 0.
 *
 * @param regions regions in full-image coordinates.
 * @param iouThreshold overlap above which two regions are "the same" (default 0.5).
 * @returns the deduped regions, preserving first-seen order.
 */
export function dedupeRegions<T extends DedupableRegion>(
  regions: readonly T[],
  iouThreshold: number = TILE_DEDUPE_IOU,
): T[] {
  const kept: T[] = [];
  for (const region of regions) {
    let overlapIndex = -1;
    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];
      if (existing && iou(region.bbox, existing.bbox) > iouThreshold) {
        overlapIndex = i;
        break;
      }
    }
    if (overlapIndex === -1) {
      kept.push(region);
      continue;
    }
    const existing = kept[overlapIndex];
    if (existing && (region.confidence ?? 0) > (existing.confidence ?? 0)) {
      kept[overlapIndex] = region;
    }
  }
  return kept;
}

/** Options for {@link planPrep}. */
export interface PlanOptions {
  /** Cap on the constraining edge (settings.maxImageEdgePx; see {@link planPrep}). */
  maxEdgePx: number;
  tileHeightPx?: number;
  tileOverlap?: number;
  longStripRatio?: number;
}

/** The complete prep geometry for one image — all the decisions, none of the pixels. */
export interface PrepPlan {
  /** True when the image was treated as a webtoon long strip (§7.4). */
  strip: boolean;
  /** Multiplier applied to the natural size, in (0, 1]. */
  scale: number;
  scaledWidthPx: number;
  scaledHeightPx: number;
  /** Tiles in top-to-bottom order; a single full-image tile for normal pages. */
  tiles: Tile[];
}

/** Downscale so the WIDTH is at most `maxWidthPx` (aspect preserved, never upscales). */
function scaleToWidth(
  naturalWidthPx: number,
  naturalHeightPx: number,
  maxWidthPx: number,
): DownscaledSize {
  if (
    !Number.isFinite(naturalWidthPx) ||
    naturalWidthPx <= 0 ||
    maxWidthPx <= 0 ||
    naturalWidthPx <= maxWidthPx
  ) {
    return { width: naturalWidthPx, height: naturalHeightPx, scale: 1 };
  }
  const scale = maxWidthPx / naturalWidthPx;
  return {
    width: Math.max(1, Math.round(naturalWidthPx * scale)),
    height: Math.max(1, Math.round(naturalHeightPx * scale)),
    scale,
  };
}

/**
 * Decide the full prep geometry for an image: the pure counterpart of
 * {@link prepareImage}, so every scaling/tiling decision is unit-testable.
 *
 * Normal pages: long edge capped at `maxEdgePx`, one full-image tile.
 *
 * Long strips: the cap applies to the WIDTH only, and the strip is tiled.
 * WHY: §7.5's "max 1200 px on the long side" is *per tile* for strips —
 * capping the whole strip's long edge (its height) would crush an 800×20000
 * webtoon to 48×1200 and destroy the text. Width-capping plus clamping the
 * tile height to `maxEdgePx` guarantees every emitted tile fits the cap.
 *
 * @param naturalWidthPx decoded image width in px.
 * @param naturalHeightPx decoded image height in px.
 * @param options cap + tiling parameters (tile height/overlap/ratio default to
 *   the module constants).
 * @returns scale, scaled dimensions, and the tile layout.
 */
export function planPrep(
  naturalWidthPx: number,
  naturalHeightPx: number,
  options: PlanOptions,
): PrepPlan {
  const strip = isLongStrip(
    naturalWidthPx,
    naturalHeightPx,
    options.longStripRatio ?? LONG_STRIP_RATIO,
  );

  const scaled = strip
    ? scaleToWidth(naturalWidthPx, naturalHeightPx, options.maxEdgePx)
    : computeDownscaledSize(naturalWidthPx, naturalHeightPx, options.maxEdgePx);

  let tiles: Tile[];
  if (strip) {
    const nominalTileHeight = options.tileHeightPx ?? DEFAULT_TILE_HEIGHT_PX;
    tiles = computeTiles(scaled.width, scaled.height, {
      // Keep the per-tile long-edge promise even when the user's cap is below
      // the default tile height.
      tileHeightPx:
        options.maxEdgePx > 0
          ? Math.min(nominalTileHeight, options.maxEdgePx)
          : nominalTileHeight,
      overlap: options.tileOverlap ?? DEFAULT_TILE_OVERLAP,
    });
  } else {
    // Non-strips are never sliced: force a single full-image tile.
    tiles = computeTiles(scaled.width, scaled.height, {
      tileHeightPx: scaled.height,
    });
  }

  return {
    strip,
    scale: scaled.scale,
    scaledWidthPx: scaled.width,
    scaledHeightPx: scaled.height,
    tiles,
  };
}

// --- Region crop (F10 drag-select, §7.3) -----------------------------------

/** Below this many source px on a side, a crop is too small to translate usefully. */
export const MIN_CROP_PX = 16;

/** The integer source rect + capped output dims for one drag-select crop. */
export interface RegionCropPlan {
  /** Source rectangle in the ORIGINAL image, integer px, clamped to bounds. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output (downscaled) dimensions, long edge ≤ `maxEdgePx`, never upscaled. */
  outWidthPx: number;
  outHeightPx: number;
}

/**
 * Plan the crop for a drag-select region (F10). Converts the normalized crop to
 * an integer source rect clamped to the image, and long-edge-caps the output at
 * `maxEdgePx` without upscaling. Unlike {@link planPrep} there is NO tiling — a
 * user selection is one region by construction; an extreme-aspect crop just
 * takes the long-edge cap.
 *
 * @param naturalWidthPx decoded image width in px.
 * @param naturalHeightPx decoded image height in px.
 * @param crop normalized crop (0–1) in full-image space.
 * @param maxEdgePx cap on the output long edge (settings.maxImageEdgePx).
 * @returns the crop plan, or null when the crop is degenerate or smaller than
 *   {@link MIN_CROP_PX} on a side after clamping (caller fails soft with a
 *   "selection too small" message).
 */
export function planRegionCrop(
  naturalWidthPx: number,
  naturalHeightPx: number,
  crop: BBox,
  maxEdgePx: number,
): RegionCropPlan | null {
  if (
    !Number.isFinite(naturalWidthPx) ||
    !Number.isFinite(naturalHeightPx) ||
    naturalWidthPx <= 0 ||
    naturalHeightPx <= 0
  ) {
    return null;
  }

  // Clamp the crop fractions to [0,1] first, then to integer pixel bounds so the
  // source rect never reaches past the image (a slightly-out-of-range drag from
  // rounding/zoom can't overrun the bitmap).
  const x = clampFraction(crop.x);
  const y = clampFraction(crop.y);
  const w = clampFraction(crop.w);
  const h = clampFraction(crop.h);

  let sx = Math.round(x * naturalWidthPx);
  let sy = Math.round(y * naturalHeightPx);
  let sw = Math.round(w * naturalWidthPx);
  let sh = Math.round(h * naturalHeightPx);
  sx = Math.min(Math.max(0, sx), naturalWidthPx - 1);
  sy = Math.min(Math.max(0, sy), naturalHeightPx - 1);
  sw = Math.min(sw, naturalWidthPx - sx);
  sh = Math.min(sh, naturalHeightPx - sy);

  if (sw < MIN_CROP_PX || sh < MIN_CROP_PX) return null;

  const longEdge = Math.max(sw, sh);
  const scale = maxEdgePx > 0 && longEdge > maxEdgePx ? maxEdgePx / longEdge : 1;
  const outWidthPx = Math.max(1, Math.round(sw * scale));
  const outHeightPx = Math.max(1, Math.round(sh * scale));

  return { sx, sy, sw, sh, outWidthPx, outHeightPx };
}

/** Clamp a value to [0, 1]; non-finite → 0. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// --- Browser-only layer (canvas driver) ------------------------------------
// Everything below needs a real OffscreenCanvas + createImageBitmap and so runs
// only in the event page, not in unit tests. It is a thin shell over the pure
// math above.

/** MIME type of the encoded output — JPEG for small uploads / fewer tokens (§7.5). */
export const OUTPUT_MIME = "image/jpeg";

/** Options for {@link prepareImage}, sourced from user settings + tiling constants. */
export interface PrepareOptions {
  /** Cap on the longer edge before sending (settings.maxImageEdgePx). */
  maxEdgePx: number;
  /** JPEG quality 0–1 (settings.jpegQuality). */
  jpegQuality: number;
  tileHeightPx?: number;
  tileOverlap?: number;
  longStripRatio?: number;
}

/** One ready-to-send tile: encoded bytes plus where it sits in the full image. */
export interface PreparedTile {
  index: number;
  /** JPEG-encoded, downscaled tile bytes — ready for a {@link import("../shared/types").TranslateJob}. */
  blob: Blob;
  /** Tile position in the full ORIGINAL image, normalized (→ `TranslateJob.tileOffset`). */
  offset: BBox;
  widthPx: number;
  heightPx: number;
}

/** Full output of {@link prepareImage}: one tile for a normal page, several for a strip. */
export interface PreparedImage {
  tiles: PreparedTile[];
  naturalWidthPx: number;
  naturalHeightPx: number;
  scaledWidthPx: number;
  scaledHeightPx: number;
  /** True when the image was sliced into multiple tiles. */
  tiled: boolean;
}

/** Draw a scaled band of `bitmap` onto a fresh OffscreenCanvas and JPEG-encode it. */
async function renderTile(
  bitmap: ImageBitmap,
  scaledWidthPx: number,
  scaledHeightPx: number,
  yStartPx: number,
  heightPx: number,
  jpegQuality: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(scaledWidthPx, heightPx);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for image prep");
  // WHY the white fill: JPEG has no alpha channel, so transparent pixels (some
  // PNG pages have transparent backgrounds) would otherwise encode as black
  // and drown the text; white matches paper.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, scaledWidthPx, heightPx);
  // WHY draw the whole image shifted up by yStartPx rather than using a source
  // rect: it scales the full bitmap to the target width/height in one step and
  // lets the canvas clip the band, avoiding source-rectangle rounding drift.
  ctx.drawImage(bitmap, 0, -yStartPx, scaledWidthPx, scaledHeightPx);
  // WHY clamp: per spec an out-of-range quality is treated as unspecified, so a
  // bad setting would silently fall back to the encoder default.
  const quality = Number.isFinite(jpegQuality)
    ? Math.min(1, Math.max(0, jpegQuality))
    : undefined;
  return canvas.convertToBlob({ type: OUTPUT_MIME, quality });
}

/**
 * Decode, downscale, (optionally) tile, and JPEG-encode a fetched image into
 * ready-to-send bytes (§7.4/§7.5).
 *
 * A normal page yields one tile spanning the whole image, downscaled so its
 * long edge is ≤ `maxEdgePx`; a webtoon long strip (aspect > `longStripRatio`)
 * is width-capped instead and sliced into several overlapping tiles (see
 * {@link planPrep} for why). Every tile is encoded as JPEG at `jpegQuality`.
 *
 * Browser-only (uses `createImageBitmap`/`OffscreenCanvas`); the caller fetches
 * the blob via `imageFetcher.ts` and hashes each tile via `hash.ts`.
 *
 * @param blob raw image bytes from {@link import("./imageFetcher").fetchImageBytes}.
 * @param options downscale + tiling parameters.
 * @returns the prepared tiles and dimension metadata.
 * @throws if the bytes can't be decoded (propagates `createImageBitmap` errors).
 */
export async function prepareImage(
  blob: Blob,
  options: PrepareOptions,
): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const naturalWidthPx = bitmap.width;
    const naturalHeightPx = bitmap.height;
    const plan = planPrep(naturalWidthPx, naturalHeightPx, {
      maxEdgePx: options.maxEdgePx,
      tileHeightPx: options.tileHeightPx,
      tileOverlap: options.tileOverlap,
      longStripRatio: options.longStripRatio,
    });

    const tiles: PreparedTile[] = [];
    for (const spec of plan.tiles) {
      const tileBlob = await renderTile(
        bitmap,
        plan.scaledWidthPx,
        plan.scaledHeightPx,
        spec.yStartPx,
        spec.heightPx,
        options.jpegQuality,
      );
      tiles.push({
        index: spec.index,
        blob: tileBlob,
        offset: spec.offset,
        widthPx: plan.scaledWidthPx,
        heightPx: spec.heightPx,
      });
    }

    return {
      tiles,
      naturalWidthPx,
      naturalHeightPx,
      scaledWidthPx: plan.scaledWidthPx,
      scaledHeightPx: plan.scaledHeightPx,
      tiled: tiles.length > 1,
    };
  } finally {
    // Release decoded pixels promptly — event-page memory is precious.
    bitmap.close();
  }
}

/** Options for {@link prepareRegionCrop}. */
export interface RegionCropOptions {
  /** Cap on the output long edge (settings.maxImageEdgePx). */
  maxEdgePx: number;
  /** JPEG quality 0–1 (settings.jpegQuality). */
  jpegQuality: number;
}

/** A ready-to-send crop plus the exact region it covers in full-image space. */
export interface PreparedRegion {
  /** JPEG-encoded, downscaled crop bytes — ready for a region {@link import("../shared/types").TranslateJob}. */
  blob: Blob;
  /**
   * The crop's ACTUAL position in the full ORIGINAL image, normalized — set as
   * the job's `tileOffset` so {@link remapBboxFromTile} lifts crop-local bboxes
   * back to full-image space (a crop is geometrically a tile). Derived from the
   * integer source rect, so it reflects any pixel-clamping {@link planRegionCrop}
   * applied rather than the raw requested crop.
   */
  offset: BBox;
  widthPx: number;
  heightPx: number;
}

/**
 * Decode, crop, downscale, and JPEG-encode one drag-select region into
 * ready-to-send bytes (F10, §7.3). Browser-only (uses `createImageBitmap`/
 * `OffscreenCanvas`); all geometry lives in the pure {@link planRegionCrop}.
 *
 * @param blob the full source image bytes.
 * @param crop normalized crop (0–1) in full-image space.
 * @param options long-edge cap + JPEG quality.
 * @returns the prepared crop, or null when the crop is too small to translate
 *   (propagates {@link planRegionCrop}'s null).
 * @throws if the bytes can't be decoded (propagates `createImageBitmap` errors).
 */
export async function prepareRegionCrop(
  blob: Blob,
  crop: BBox,
  options: RegionCropOptions,
): Promise<PreparedRegion | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const plan = planRegionCrop(bitmap.width, bitmap.height, crop, options.maxEdgePx);
    if (!plan) return null;

    const canvas = new OffscreenCanvas(plan.outWidthPx, plan.outHeightPx);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context for region crop");
    // WHY white underlay: JPEG has no alpha, so transparent pixels would encode
    // black and drown the text (Phase 2.1's rule); white matches paper.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, plan.outWidthPx, plan.outHeightPx);
    // One source-rect draw: crop and downscale in a single step.
    ctx.drawImage(
      bitmap,
      plan.sx,
      plan.sy,
      plan.sw,
      plan.sh,
      0,
      0,
      plan.outWidthPx,
      plan.outHeightPx,
    );
    const quality = Number.isFinite(options.jpegQuality)
      ? Math.min(1, Math.max(0, options.jpegQuality))
      : undefined;
    const outBlob = await canvas.convertToBlob({ type: OUTPUT_MIME, quality });

    return {
      blob: outBlob,
      offset: {
        x: plan.sx / bitmap.width,
        y: plan.sy / bitmap.height,
        w: plan.sw / bitmap.width,
        h: plan.sh / bitmap.height,
      },
      widthPx: plan.outWidthPx,
      heightPx: plan.outHeightPx,
    };
  } finally {
    bitmap.close();
  }
}
