/**
 * Bubble snap (Phase 7.5): a local, deterministic pixel-refinement pass that
 * treats the vision provider's bbox as a *seed* and snaps it to the actual
 * speech-bubble blob via flood fill on the decoded bitmap. The VLM is good at
 * detection + OCR + translation but estimates coordinates on a coarse grid (the
 * 2026-07-11 Sonnet-5 capture: correct-but-loose boxes); this tightens them for
 * free — classic manga bubbles (near-white interior, dark outline) are the best
 * case, and every failure path falls back to the provider's box, so the worst
 * case is exactly the pre-7.5 behaviour (handoff rule 4).
 *
 * WHY background, not content: a content script cannot read pixels of a
 * cross-origin `<img>` (canvas taint, §7.3); the background already holds the
 * clean bytes on both the page and drag-select paths.
 *
 * Split like `imagePrep.ts`:
 *  1. PURE CORE (`snapRegionToBubble`, `shouldSnapKind`, `computeSnapSize`,
 *     `clampBoxToRect`, luminance) — no browser APIs, exhaustively Vitest-covered
 *     against synthetic {@link SnapBitmap} fixtures.
 *  2. `snapPageRegions` — the thin OffscreenCanvas decode shell. Untested for the
 *     same env reason as `prepareImage` (no `createImageBitmap`/`OffscreenCanvas`
 *     in the Node test runtime); kept minimal, fail-soft on any throw.
 *
 * All bboxes in/out are the normalized 0–1 {@link BBox} (handoff rule 5);
 * internally the core works in snap-bitmap pixels.
 */
import type { BBox, PageTranslation, RegionKind } from "../shared/types";

/**
 * A minimal RGBA bitmap — the shape `getImageData` returns, so the pure core can
 * be fed synthetic typed-array fixtures with no DOM.
 */
export interface SnapBitmap {
  /** RGBA bytes, 4 per pixel, row-major (as from `ImageData.data`). */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Minimum luminance (0–255) for a pixel to count as a bubble interior. A seed
 * below this landed on a stroke or artwork; the flood fill never crosses below
 * it either. WHY 160: comfortably above mid-gray screentone yet below off-white
 * paper, so a real bubble interior fills and inked art does not.
 */
export const LIGHT_FLOOR = 160;

/**
 * Relative luminance tolerance below the seed pixel the fill still accepts
 * (floored at {@link LIGHT_FLOOR}). WHY relative: tolerates off-white paper and
 * mild screentone inside a bubble without letting the fill wander onto darker art.
 */
export const SEED_TOLERANCE = 24;

/**
 * Reject a blob smaller than this fraction of the seed-box pixel area (the
 * glyph-counter trap): at snap resolution the white counter of a 口/O glyph is a
 * few px² while a real bubble interior is comparable to the seed box, so a tiny
 * fill means the seed landed inside a character — discard and try the next seed.
 */
export const MIN_BLOB_FRACTION = 0.25;

/**
 * Reject a blob larger than this multiple of the seed-box area (the open-outline
 * leak trap): a fill this much bigger than the provider's box escaped through an
 * outline gap / open tail into the page background. Also bounds how far snap may
 * GROW a too-small seed box (snap is bidirectional, up to this ratio).
 */
export const MAX_BLOB_BOX_RATIO = 4;

/**
 * Reject a blob covering more than this fraction of the whole bitmap — the
 * absolute leak backstop for when the seed box itself is large (e.g. a big
 * provider box whose 4× ratio would permit half the page).
 */
export const MAX_BLOB_IMAGE_FRACTION = 0.35;

/**
 * Phase 9.2: reject an accepted blob whose area fills less than this fraction
 * of its own pixel bounding box (the PARTIAL-leak trap). WHY: a fill that
 * escapes through an open/spiky outline into a bounded background pocket can
 * stay UNDER both leak caps above, and Phase 9 then traces the sprawl as a
 * weird-shaped "bubble" painted over art (2026-07-19 live pass). Real bubble
 * interiors are bbox-compact — a clean ellipse fills π/4 ≈ 0.79 of its bounds,
 * glyph holes drop that to ~0.6, tails and spiky bursts to ~0.4 — while a
 * sprawling leak's bounds are mostly not-blob. 0.3 rejects the sprawl and fails
 * soft to the provider box (rule 4: a loose box is less harm than a wrong shape).
 */
export const MIN_BLOB_BBOX_FILL = 0.3;

/**
 * Phase 9.3 §1: confinement window half-margin — the flood fill is hard-walled to
 * the provider box expanded by this fraction of the box's width/height PER SIDE
 * (⇒ a 2×-per-axis window), clamped to the bitmap. A fill that slams into a hard
 * confinement wall (there is fillable pixel BEYOND it — the fill wanted to keep
 * going) is rejected. WHY this is the worst-leak fix the area caps are blind to: a
 * fill that escapes a bubble through the WHITE page margin/gutter into a
 * neighbouring panel is SOLID white — it passes {@link MIN_BLOB_BBOX_FILL}, and
 * its area can stay under the 4×-box / 35 %-image caps — yet its OUTER contour
 * then swallows enclosed art (white paint over dark hair). WHY 0.5: snap growth
 * was already bounded at 4× box AREA (= 2× per axis when square), so the wall does
 * not tighten legitimate growth — a bubble that fills ≤ 2× its box per side snaps
 * byte-identically. WHY reject rather than accept-the-clip: a fill pressed against
 * the wall wanted to keep going, so its true region extends past 2× the box —
 * essentially never a real bubble for a roughly-placed provider box, and a
 * wall-clipped contour would render an artificial straight edge mid-art.
 */
export const SNAP_CONFINE_EXPAND = 0.5;

/**
 * Long-edge cap for the snap bitmap. WHY 768 (Phase 9.3; was 512): the ≤512
 * downsample self-closed 1–2 px outline gaps, but it paid for that by eroding
 * THIN PANEL BORDERS — which alias away at 512 and are the exact route the §1
 * cross-panel margin leaks escaped through — and by coarse edge quantization (1
 * snap-px ≈ 2–2.5 display px on an ~800×1200 page, limiting how tightly a fill
 * hugs the ink). At 768 those borders survive (fewer margin escapes at the
 * source) and quantization drops to ≈ 1.5–1.7 display px. Safe to raise NOW
 * because §1's confinement wall bounds the blast radius of any new outline-gap
 * leak the weaker blur no longer self-closes. Glyph strokes still blur toward
 * gray at 768 and bubbles stay hundreds of px². Snap cost grows ≈ 2.25× in
 * pixels — still one trivial pass per region, event-page local.
 */
export const SNAP_MAX_EDGE = 768;

/**
 * Floor on the SHORT edge of the snap bitmap. A webtoon strip's 512-on-the-long-
 * edge scale would crush an 800×20000 page to ~20 px wide and destroy every blob;
 * for extreme aspect ratios the cap is raised so the short edge stays ≥ this.
 */
export const SNAP_MIN_SHORT_EDGE = 256;

/** Region kinds snap refines — white-interior shapes only (see {@link shouldSnapKind}). */
const SNAP_KINDS: ReadonlySet<RegionKind> = new Set<RegionKind>(["bubble", "thought"]);

/**
 * Seed offsets as (dy, dx) fractions of the box added to the box CENTER, so the
 * candidates are the center plus the eight quarter points (±25% of width/height).
 * Center first — a bubble's center is the most likely clean interior hit.
 */
const SEED_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-0.25, -0.25],
  [-0.25, 0],
  [-0.25, 0.25],
  [0, -0.25],
  [0, 0.25],
  [0.25, -0.25],
  [0.25, 0],
  [0.25, 0.25],
];

/** Rec. 601 luma of the RGB at `pixel` (index in pixels, not bytes). 0–255. */
function luminanceAt(data: Uint8ClampedArray, pixel: number): number {
  const i = pixel * 4;
  return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
}

/** Clamp an integer coordinate into [0, size − 1]. */
function clampCoord(value: number, size: number): number {
  if (value < 0) return 0;
  if (value > size - 1) return size - 1;
  return value;
}

/** Clamp `value` into the inclusive [lo, hi] range (used to pull a seed into a window). */
function clampToRange(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** The bounding box (inclusive pixel coords) + area of a flood-filled blob. */
interface FilledBlob {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * Phase 9 §3: one byte per pixel, 1 = part of the ACCEPTED blob. WHY a
   * separate record from `visited`: `visited` marks every *inspected* pixel
   * including dark boundary rejects, so it is not the blob.
   */
  filled: Uint8Array;
  /**
   * Phase 9.1 §2: per-channel 256-bin histograms over the filled pixels (one
   * increment per pixel per channel). WHY medians, not the Phase 9 running mean:
   * a handful of anti-aliased boundary pixels drag the MEAN grey (the mean of a
   * clean white blob sampled `#e6e6e6`), reading as a grey patch on white paper;
   * the MEDIAN is the blob's dominant color, immune to that fringe. Memory is
   * 3×256×4 B ≈ 3 KB per fill — trivial — and it stays one pass.
   */
  histR: Uint32Array;
  histG: Uint32Array;
  histB: Uint32Array;
  /**
   * Phase 9.3 §1: per-side flags — set when the fill was blocked by the WINDOW on
   * that side by a pixel that WOULD have been filled (fillable, just beyond the
   * window edge inside the bitmap). "The fill wanted to keep going here." The
   * caller (`accept`) rejects a fill that hit a side which is a HARD confinement
   * wall (a slab/opts.window edge that is hit is legitimate — a lobe touching its
   * group cut — and is NOT rejected). A window edge coincident with the bitmap
   * boundary is never hit (no pixel beyond it), so a page-edge bubble is safe.
   */
  hitMinX: boolean;
  hitMaxX: boolean;
  hitMinY: boolean;
  hitMaxY: boolean;
}

/**
 * Iterative 4-connected flood fill from (sx, sy) over pixels the polarity
 * accepts (light mode: luminance ≥ `threshold`; Phase 9 §7 dark mode: luminance
 * ≤ `threshold`), tracking the blob's pixel bounding box, area, filled mask
 * (§3), and mean-color sums (§7). Returns `"leak"` the instant the area exceeds
 * `leakArea` (an escaped fill — abort early rather than paint the whole
 * background). No recursion (a big bubble would blow the call stack); a
 * `visited` bitmap keeps it O(pixels).
 */
function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sy: number,
  threshold: number,
  leakArea: number,
  winMinX = 0,
  winMinY = 0,
  winMaxX = width - 1,
  winMaxY = height - 1,
  dark = false,
): FilledBlob | "leak" {
  const visited = new Uint8Array(width * height);
  const filled = new Uint8Array(width * height);
  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  const start = sy * width + sx;
  visited[start] = 1;
  const stack: number[] = [start];
  let area = 0;
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;
  // Phase 9.3 §1: did a fillable pixel just beyond a window edge block the fill?
  let hitMinX = false;
  let hitMaxX = false;
  let hitMinY = false;
  let hitMaxY = false;

  /** Would pixel `np` have been filled were it not out of window? */
  const fillableBeyond = (np: number): boolean => {
    const lum = luminanceAt(data, np);
    return dark ? lum <= threshold : lum >= threshold;
  };

  // Out-of-window pixels are walls (Phase 7.6 stage-3 windowed re-fill): the fill
  // can't cross the cut into a neighbouring lobe's slab. Phase 9.3 §1: record when
  // the blocked pixel was itself fillable — that side "wanted to keep going", the
  // signal the confinement wall-slam guard rejects on.
  const tryPush = (np: number, nx: number, ny: number): void => {
    if (nx < winMinX) {
      if (fillableBeyond(np)) hitMinX = true;
      return;
    }
    if (nx > winMaxX) {
      if (fillableBeyond(np)) hitMaxX = true;
      return;
    }
    if (ny < winMinY) {
      if (fillableBeyond(np)) hitMinY = true;
      return;
    }
    if (ny > winMaxY) {
      if (fillableBeyond(np)) hitMaxY = true;
      return;
    }
    if (visited[np]) return;
    visited[np] = 1;
    const lum = luminanceAt(data, np);
    if (dark ? lum <= threshold : lum >= threshold) stack.push(np);
  };

  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    area++;
    if (area > leakArea) return "leak";
    filled[p] = 1;
    const b = p * 4;
    histR[data[b]!]!++;
    histG[data[b + 1]!]!++;
    histB[data[b + 2]!]!++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0) tryPush(p - 1, x - 1, y);
    if (x < width - 1) tryPush(p + 1, x + 1, y);
    if (y > 0) tryPush(p - width, x, y - 1);
    if (y < height - 1) tryPush(p + width, x, y + 1);
  }
  return {
    area,
    minX,
    minY,
    maxX,
    maxY,
    filled,
    histR,
    histG,
    histB,
    hitMinX,
    hitMaxX,
    hitMinY,
    hitMaxY,
  };
}

// --- Phase 9 §3: contour capture (keep the outline the fill already traced) ---

/** A traced bubble outline: closed polygon of [x, y] full-image fractions. */
export type ShapePoints = Array<[number, number]>;

/** Max points a cached shape may carry (cache-size cap; simplify ONCE at ε, then
 *  uniform subsampling enforces the cap deterministically — Phase 9.1 §1 dropped
 *  the ε-doubling escape, which shaved convex detail exactly where the rim shows). */
export const SHAPE_MAX_POINTS = 64;

/** Douglas-Peucker tolerance for the contour, in snap-bitmap px. */
export const SHAPE_SIMPLIFY_EPSILON_PX = 1;

/**
 * Phase 9.1 §1 / Phase 9.2: outward vertex offset applied to the traced contour
 * (snap-px), to close the rim of original ink that survived around Phase 9
 * fills. The snap bitmap's long edge is capped at {@link SNAP_MAX_EDGE}, so
 * dilation (1 px, unchanged) + this offset is how far past the flood-filled blob
 * the painted edge lands. WHY 0.5 (Phase 9.2; was 1): at 1 the stack overshot on
 * the 2026-07-19 live pass — fills visibly painted over the drawn ink line; 0.5
 * still covers the anti-aliased halo while kissing the ink from inside. Sub-px
 * values are fine — the offset is float vertex math, not a raster op. Phase 9.3
 * NOTE: the whole stack is in SNAP-px, so the §3 cap raise (512 → 768) SHRINKS
 * the outward reach in DISPLAY px (≈ 1.5 snap-px ≈ 2–2.5 display px total) — the
 * desired direction after the 9.2 overshoot fix. This remains the tuning knob:
 * raise it if ink rims reappear at 768, lower toward 0 if outlines are erased.
 */
export const SHAPE_OUTWARD_OFFSET_PX = 0.5;

/**
 * Median luma at/above which a sampled fill snaps to pure white (Phase 9.1 §2).
 * WHY: manga paper is white; the median of a clean blob is already close, and
 * snapping removes the last seam against neighbouring untranslated bubbles' true
 * paper.
 */
export const PAPER_WHITE_LUMA = 245;

/** Median luma at/below which a sampled fill snaps to pure black (flash bubbles). */
export const PAPER_BLACK_LUMA = 12;

/**
 * Snap-logic version (Phase 9.1 §3). Bump this in any FUTURE phase that changes
 * snap OUTPUT (shape, bbox, or fillColor for a given input) — a cached entry
 * whose stored `snapVersion` is behind this and that kept its raw provider
 * regions (`CacheRecord.rawPage`) is re-snapped LOCALLY at hit time for ZERO
 * provider spend (see `translateHandlers` + `classifyResnap`). WHY it must NEVER
 * enter `buildCacheKey` (ground rule 8): folding it into the key would re-pay the
 * provider for every page on a snap change — the exact cost this eliminates.
 *
 * History: 1 = Phase 9.1 baseline; 2 = Phase 9.2 (outward offset 1 → 0.5 after
 * the 2026-07-19 overshoot pass, plus the {@link MIN_BLOB_BBOX_FILL} sprawl
 * guard); 3 = Phase 9.3 ({@link SNAP_CONFINE_EXPAND} flood-fill confinement +
 * wall-slam rejection, plus {@link SNAP_MAX_EDGE} 512 → 768 — both change snap
 * output for already-cached pages, re-snapped locally at zero provider spend).
 */
export const SNAP_VERSION = 3;

/**
 * Dilate a filled mask by 1 px (3×3 max) inside the blob's padded bounds.
 * Replaces the scalar 1-px bbox pad for the SHAPE (the bbox pad logic itself is
 * unchanged): the traced outline sits one pixel outside the blob, covering the
 * anti-aliased boundary ring exactly as the padded bbox does.
 */
function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const y0 = Math.max(0, minY - 1);
  const y1 = Math.min(height - 1, maxY + 1);
  const x0 = Math.max(0, minX - 1);
  const x1 = Math.min(width - 1, maxX + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let set = 0;
      for (let dy = -1; dy <= 1 && !set; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            set = 1;
            break;
          }
        }
      }
      if (set) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * Marching-squares walk of the OUTER boundary of a mask (outer contour only —
 * glyph holes inside the blob are covered automatically because the walk never
 * enters the interior). Starts at the topmost-then-leftmost set pixel's top-left
 * corner and walks clockwise, emitting corner-lattice points; saddle cells are
 * disambiguated by the previous step. Returns `null` on any non-boundary state
 * or if the walk exceeds `maxSteps` (a trace bug must fail soft, rule 6).
 */
function traceOuterContour(
  mask: Uint8Array,
  width: number,
  height: number,
  maxSteps: number,
): Array<[number, number]> | null {
  // Topmost-then-leftmost set pixel — guarantees the start corner state is 8
  // (only BR set), so the walk always begins moving right.
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null; // empty mask

  const isSet = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;

  const pts: Array<[number, number]> = [];
  let x = sx;
  let y = sy;
  let prev: "up" | "down" | "left" | "right" | "none" = "none";
  do {
    const state =
      (isSet(x - 1, y - 1) ? 1 : 0) |
      (isSet(x, y - 1) ? 2 : 0) |
      (isSet(x - 1, y) ? 4 : 0) |
      (isSet(x, y) ? 8 : 0);
    let dir: "up" | "down" | "left" | "right";
    switch (state) {
      case 1:
      case 3:
      case 11:
        dir = "left";
        break;
      case 2:
      case 10:
      case 14:
        dir = "up";
        break;
      case 4:
      case 5:
      case 7:
        dir = "down";
        break;
      case 8:
      case 12:
      case 13:
        dir = "right";
        break;
      case 6: // saddle (TR+BL): keep the region on the right of travel
        dir = prev === "left" ? "up" : "down";
        break;
      case 9: // saddle (TL+BR)
        dir = prev === "down" ? "left" : "right";
        break;
      default:
        return null; // 0/15: the walk fell off the boundary — abort, keep bbox
    }
    pts.push([x, y]);
    if (dir === "up") y--;
    else if (dir === "down") y++;
    else if (dir === "left") x--;
    else x++;
    prev = dir;
    if (pts.length > maxSteps) return null;
  } while (x !== sx || y !== sy);
  return pts.length >= 3 ? pts : null;
}

/** Perpendicular distance from point `p` to the segment a→b (fallback: to `a`). */
function perpendicularDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const cross = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]);
  return cross / Math.sqrt(lenSq);
}

/** Iterative Douglas-Peucker over `pts[first..last]`, marking survivors in `keep`. */
function dpMark(
  pts: ReadonlyArray<readonly [number, number]>,
  first: number,
  last: number,
  epsilon: number,
  keep: Uint8Array,
): void {
  // Explicit stack — a long raw contour would overflow recursive DP.
  const ranges: Array<[number, number]> = [[first, last]];
  while (ranges.length > 0) {
    const [lo, hi] = ranges.pop()!;
    if (hi - lo < 2) continue;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularDistance(pts[i]!, pts[lo]!, pts[hi]!);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon && maxIdx > 0) {
      keep[maxIdx] = 1;
      ranges.push([lo, maxIdx], [maxIdx, hi]);
    }
  }
}

/**
 * Simplify a CLOSED contour with Douglas-Peucker at `epsilon`: anchor at point 0
 * and the point farthest from it (a closed ring has no natural endpoints), DP
 * each half, keep the survivors in order.
 */
function simplifyClosed(
  pts: ReadonlyArray<readonly [number, number]>,
  epsilon: number,
): Array<[number, number]> {
  const n = pts.length;
  if (n <= 4) return pts.map((p) => [p[0], p[1]]);
  let farIdx = 1;
  let farDist = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]);
    if (d > farDist) {
      farDist = d;
      farIdx = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[farIdx] = 1;
  dpMark(pts, 0, farIdx, epsilon, keep);
  // Second half wraps: run DP on the doubled index range [farIdx .. n] where
  // index n aliases point 0, then fold the marks back.
  const wrapped = pts.slice(farIdx).concat([pts[0]!]);
  const wrapKeep = new Uint8Array(wrapped.length);
  dpMark(wrapped, 0, wrapped.length - 1, epsilon, wrapKeep);
  for (let i = 1; i < wrapped.length - 1; i++) {
    if (wrapKeep[i]) keep[farIdx + i] = 1;
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([pts[i]![0], pts[i]![1]]);
  return out;
}

/**
 * Outward UNIT normal of the edge a→b, oriented by the ring's winding `sign`.
 * `(dy, −dx)` is the right-hand normal of the travel direction; `sign` (from the
 * ring's signed area) flips it so it always points AWAY from the interior. A
 * zero-length edge yields the zero vector (contributes nothing to the average).
 */
function edgeNormal(
  a: readonly [number, number],
  b: readonly [number, number],
  sign: number,
): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 0];
  return [(dy / len) * sign, (-dx / len) * sign];
}

/**
 * Phase 9.1 §1: push every vertex of a CLOSED ring outward by `offsetPx` along
 * its vertex normal — the average of its two incident edge normals. WHY the
 * signed area (not a centroid) orients "outward": a concave contour has vertices
 * on the far side of any centroid, so a centroid-based "outward" would pull those
 * vertices INWARD; the ring's winding is the only reliable orientation. Simple
 * averaged-normal offset (not a miter), so a convex corner moves diagonally by
 * `offsetPx` — enough to cover the AA halo at this scale. Self-intersection risk
 * at a 1-px offset is negligible for blob-scale contours and accepted (a
 * degenerate result still renders inside the box, bounded by `overflow: hidden`).
 * Pure; a degenerate/too-short ring is returned unchanged.
 */
export function offsetPolygonOutward(
  points: ReadonlyArray<readonly [number, number]>,
  offsetPx: number,
): Array<[number, number]> {
  const n = points.length;
  if (n < 3 || !Number.isFinite(offsetPx) || offsetPx === 0) {
    return points.map((p) => [p[0], p[1]]);
  }
  // Signed area (shoelace ×2): its sign is the ring's winding, which orients the
  // right-hand edge normal outward.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % n]!;
    area2 += x1 * y2 - x2 * y1;
  }
  const sign = area2 >= 0 ? 1 : -1;

  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!;
    const curr = points[i]!;
    const next = points[(i + 1) % n]!;
    const n1 = edgeNormal(prev, curr, sign);
    const n2 = edgeNormal(curr, next, sign);
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) {
      out.push([curr[0], curr[1]]); // opposite edges cancel — leave the vertex put
      continue;
    }
    nx /= len;
    ny /= len;
    out.push([curr[0] + nx * offsetPx, curr[1] + ny * offsetPx]);
  }
  return out;
}

/**
 * Phase 9 §3 / Phase 9.1 §1: turn an accepted blob's filled mask into the
 * region's cached shape — dilate 1 px, trace the outer boundary, simplify ONCE at
 * ε ≈ 1 snap-px (Phase 9.1 dropped the ε-doubling escape — it shaved convex
 * detail exactly where the rim shows; over the cap now goes straight to uniform
 * subsampling, which keeps vertices ON the traced boundary), push the ring
 * outward by {@link SHAPE_OUTWARD_OFFSET_PX} to close the ink rim, then convert to
 * full-image fractions clamped [0, 1] (handoff rule 5, the offset happens in
 * snap-px BEFORE normalization), rounded to 4 decimals (keeps a 64-point shape
 * ≈ 1 KB in the cache's JSON sizing). Returns `undefined` on ANY trace failure —
 * the caller keeps the snapped bbox (rule 6). Pure.
 */
function traceBlobShape(
  blob: FilledBlob,
  width: number,
  height: number,
): ShapePoints | undefined {
  try {
    const dilated = dilateMask(
      blob.filled,
      width,
      height,
      blob.minX,
      blob.minY,
      blob.maxX,
      blob.maxY,
    );
    const raw = traceOuterContour(dilated, width, height, width * height * 4);
    if (!raw) return undefined;
    let simplified = simplifyClosed(raw, SHAPE_SIMPLIFY_EPSILON_PX);
    if (simplified.length > SHAPE_MAX_POINTS) {
      // Deterministic uniform subsample down to the cap (keeps the ring closed).
      // WHY not double ε first: doubling shaves convex detail exactly where the
      // rim shows; subsampling keeps every kept vertex ON the traced boundary.
      const step = simplified.length / SHAPE_MAX_POINTS;
      const capped: Array<[number, number]> = [];
      for (let i = 0; i < SHAPE_MAX_POINTS; i++) {
        capped.push(simplified[Math.floor(i * step)]!);
      }
      simplified = capped;
    }
    if (simplified.length < 3) return undefined;
    // §1: kiss the ink line — offset in snap-px BEFORE normalization (rule 5).
    const offset = offsetPolygonOutward(simplified, SHAPE_OUTWARD_OFFSET_PX);
    return offset.map(([px, py]) => [
      clampFraction(Math.round((px / width) * 10000) / 10000),
      clampFraction(Math.round((py / height) * 10000) / 10000),
    ]);
  } catch {
    return undefined; // rule 6: a trace fault degrades to the bbox
  }
}

/** Clamp a fraction into [0, 1]. */
function clampFraction(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Median channel value (0–255) from a 256-bin histogram over `area` pixels. */
function channelMedian(hist: Uint32Array, area: number): number {
  const half = area / 2;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v]!;
    if (cum >= half) return v;
  }
  return 255;
}

/**
 * Phase 9.1 §2: the accepted blob's per-channel MEDIAN color as `#rrggbb`, with a
 * paper snap. The median (not the Phase 9 mean) is the blob's dominant color,
 * immune to the anti-aliased fringe that dragged the mean grey. WHY the paper
 * snap: manga paper is white and flash fills are black; a median luma ≥
 * {@link PAPER_WHITE_LUMA} → `#ffffff`, ≤ {@link PAPER_BLACK_LUMA} → `#000000`,
 * so a near-white fill reads as clean paper with no grey patch or seam against a
 * neighbouring untranslated bubble. A genuine mid-grey screentone stays its
 * median grey (no snap).
 */
function blobFillHex(blob: FilledBlob): string {
  const area = Math.max(1, blob.area);
  const r = channelMedian(blob.histR, area);
  const g = channelMedian(blob.histG, area);
  const b = channelMedian(blob.histB, area);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma >= PAPER_WHITE_LUMA) return "#ffffff";
  if (luma <= PAPER_BLACK_LUMA) return "#000000";
  const hex = (v: number): string => v.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// --- Phase 9.1 §4: seed rescue for offset provider boxes --------------------

/** Rescue grid dimension (N×N seeds over the expanded provider bbox). */
const RESCUE_GRID = 5;

/** Fraction of the provider box each side is expanded by before the rescue grid
 *  is sampled (25 % per side ⇒ a 1.5× box). */
const RESCUE_EXPAND = 0.25;

/**
 * Minimum coverage of the ORIGINAL provider bbox by a rescued blob's bbox
 * (area(blob ∩ provider) / area(provider)) for the rescue to be accepted. WHY:
 * the provider's box is evidence of where the text is; a rescue whose blob
 * doesn't cover ≥ this much of it wandered onto a NEIGHBOURING bubble, so it is
 * rejected and today's loose box is kept (rule 6).
 */
export const RESCUE_MIN_PROVIDER_OVERLAP = 0.4;

/**
 * Phase 9 §7: seed luminance AT/below which a seed counts as "dark". When ALL
 * nine seeds are dark the fill re-runs with inverted polarity (fill pixels ≤
 * seedLum + tolerance) so flash/inverted-flash bubbles — dark interior, every
 * light seed fails — get a dark shaped fill instead of a white rectangle
 * punched into black art. WHY 80: comfortably below mid-gray screentone, so a
 * gray caption panel can't trigger the inverse mode; mixed light/dark seeds
 * keep today's light-path-only behavior.
 */
export const DARK_CEILING = 80;

/** Overridable thresholds for {@link snapRegionToBubble} (defaults = the constants). */
export interface SnapOptions {
  lightFloor?: number;
  seedTolerance?: number;
  minBlobFraction?: number;
  maxBlobBoxRatio?: number;
  maxBlobImageFraction?: number;
  /** Phase 9.2 sprawl guard threshold (default {@link MIN_BLOB_BBOX_FILL}). */
  minBlobBboxFill?: number;
  /**
   * Phase 9.3 §1 confinement half-margin (default {@link SNAP_CONFINE_EXPAND}).
   * The flood fill is hard-walled to the provider box expanded by this fraction
   * per side; a fill that slams a hard wall is rejected. `Number.POSITIVE_INFINITY`
   * disables confinement entirely (the window becomes the whole bitmap / the
   * `window` slab) — used by {@link snapAllRegions}'s un-confined shared-blob
   * detection pass and by tests that exercise OTHER guards in isolation.
   */
  confineExpand?: number;
  /** Phase 9 §7 all-seeds-dark trigger threshold (default {@link DARK_CEILING}). */
  darkCeiling?: number;
  /**
   * Confine the flood fill to this normalized sub-rectangle (Phase 7.6 stage 3):
   * pixels outside it are walls, and seed coordinates are clamped into it, so a
   * shared-blob member fills only its own lobe/slab. Omitted → the whole bitmap.
   */
  window?: BBox;
  /** IoU at/above which two accepted snaps are grouped as one blob ({@link snapAllRegions} stage 2). */
  sharedBlobIou?: number;
  /** Coverage at/above which a snap "swallows" a neighbour ({@link snapAllRegions} stages 2 & 4). */
  swallowCoverage?: number;
}

/**
 * What an accepted snap yields (Phase 9 §3 — module-local API): the tightened
 * bbox, plus the traced blob outline (`shape`, absent on any trace failure) and
 * the sampled interior mean color (§7). Callers that only need the geometry
 * read `.bbox` exactly where they used the bare box before.
 */
export interface SnapResult {
  bbox: BBox;
  shape?: ShapePoints;
  fillColor?: string;
}

/**
 * Phase 9.3 §1: an effective flood-fill window (inclusive pixel bounds) plus which
 * of its four edges are HARD confinement walls — a fill that slams one is rejected.
 */
interface Window4 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hardMinX: boolean;
  hardMaxX: boolean;
  hardMinY: boolean;
  hardMaxY: boolean;
}

/**
 * Phase 9.3 §1: intersect the opts.window slab `[ow*]` (already the whole bitmap
 * when absent) with the CONFINEMENT window — the source box `(boxX,boxY,boxW,boxH)`
 * px expanded `expand` per side, clamped to the bitmap — and mark which effective
 * edges are HARD confinement walls. An edge is hard iff confinement binds it
 * STRICTLY tighter than the slab: a slab edge (a 7.6 lobe's group cut) is never
 * hard, so lobes may legitimately touch it. "Strictly inside the bitmap" is
 * implied — `cfMin > owMin ≥ 0` forces `cfMin > 0` (and symmetrically on the max
 * side), so a page-edge window edge is never hard. If the two windows are DISJOINT
 * on an axis (the box sits outside its slab — a contrived-but-valid 7.6 case)
 * confinement is inert there: defer to the slab, no hard walls. `expand =
 * Number.POSITIVE_INFINITY` yields the whole-bitmap confinement (⇒ no hard walls),
 * i.e. confinement disabled. Pure.
 */
function confineWindow(
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  expand: number,
  owMinX: number,
  owMinY: number,
  owMaxX: number,
  owMaxY: number,
  width: number,
  height: number,
): Window4 {
  // Round the confinement OUTWARD (floor min, ceil max, no half-open −1) — the
  // window must never falsely clip a bubble that legitimately fills up to 2× its
  // box; the wall-slam only fires on a pixel strictly BEYOND this generous edge.
  const cfMinX = clampCoord(Math.floor(boxX - expand * boxW), width);
  const cfMaxX = clampCoord(Math.ceil(boxX + boxW + expand * boxW), width);
  const cfMinY = clampCoord(Math.floor(boxY - expand * boxH), height);
  const cfMaxY = clampCoord(Math.ceil(boxY + boxH + expand * boxH), height);

  const axis = (
    cfMin: number,
    cfMax: number,
    owMin: number,
    owMax: number,
  ): { min: number; max: number; hardMin: boolean; hardMax: boolean } => {
    const min = Math.max(owMin, cfMin);
    const max = Math.min(owMax, cfMax);
    if (min > max) return { min: owMin, max: owMax, hardMin: false, hardMax: false };
    return { min, max, hardMin: cfMin > owMin, hardMax: cfMax < owMax };
  };

  const x = axis(cfMinX, cfMaxX, owMinX, owMaxX);
  const y = axis(cfMinY, cfMaxY, owMinY, owMaxY);
  return {
    minX: x.min,
    maxX: x.max,
    minY: y.min,
    maxY: y.max,
    hardMinX: x.hardMin,
    hardMaxX: x.hardMax,
    hardMinY: y.hardMin,
    hardMaxY: y.hardMax,
  };
}

/**
 * Snap one provider bbox to the speech-bubble blob it sits on, or return `null`
 * to keep the provider box (handoff rule 4 — a wrong snap is worse than a loose
 * box, so every ambiguous case fails soft).
 *
 * Algorithm (all thresholds in {@link SnapOptions}, defaults = the module
 * constants). Phase 9.3 §1: the whole fill is hard-walled to the provider box
 * expanded {@link SNAP_CONFINE_EXPAND} per side (∩ any `opts.window` slab); a fill
 * that slams a hard confinement wall — its true region runs past 2× the box, i.e.
 * a cross-panel margin leak — is rejected (`confineExpand: Infinity` disables it):
 *  1. Try the box center then 8 quarter-point seeds (center first).
 *  2. A seed must be LIGHT (luminance ≥ `lightFloor`); a dark seed skips.
 *  3. Flood-fill light pixels (luminance ≥ `max(lightFloor, seedLum −
 *     seedTolerance)`) from the seed.
 *  4. Reject a blob smaller than `minBlobFraction` × seed-box area (glyph-counter
 *     trap) → try the next seed.
 *  5. Reject a blob exceeding `maxBlobBoxRatio` × seed-box area OR
 *     `maxBlobImageFraction` × bitmap area (open-outline leak) → abandon ALL seeds
 *     and return null (a leak from one seed leaks from every seed in that blob).
 *  6. Phase 9.2: reject a blob filling less than `minBlobBboxFill` of its own
 *     pixel bounds (a sprawling PARTIAL leak that stayed under the step-5 caps)
 *     → try the next seed; if every seed lands in the same sprawl, fail soft.
 *  7. Accept the blob's bounding box, padded 1 px, back in fractional space —
 *     plus (Phase 9) the blob's traced outline and sampled mean color.
 *  8. Phase 9 §7 inverse mode: when EVERY seed was dark (luminance ≤
 *     `darkCeiling`), re-run the seed loop with inverted polarity (fill pixels
 *     with luminance ≤ min(darkCeiling, seedLum + tolerance)), same
 *     min-area/leak guards — an accepted dark fill yields a dark `fillColor` so
 *     the overlay renders dark-with-light-text. Mixed light/dark seeds keep the
 *     light path only.
 *  9. Phase 9.1 §4 rescue: when steps 1–8 all fail (an OFFSET provider box whose
 *     nine seeds all landed on art), probe a `RESCUE_GRID`×`RESCUE_GRID` grid over
 *     the box expanded `RESCUE_EXPAND` per side with the light-path fill, and
 *     accept the first blob covering ≥ `RESCUE_MIN_PROVIDER_OVERLAP` of the
 *     provider box (a rescue that wanders to a neighbour is rejected → null).
 *
 * @param img the decoded RGBA snap bitmap.
 * @param bbox the provider box, normalized 0–1.
 * @param opts optional threshold overrides (tests tune these).
 * @returns the {@link SnapResult}, or `null` when no seed accepts.
 */
export function snapRegionToBubble(
  img: SnapBitmap,
  bbox: BBox,
  opts: SnapOptions = {},
): SnapResult | null {
  const { data, width, height } = img;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;

  const lightFloor = opts.lightFloor ?? LIGHT_FLOOR;
  const seedTolerance = opts.seedTolerance ?? SEED_TOLERANCE;
  const minBlobFraction = opts.minBlobFraction ?? MIN_BLOB_FRACTION;
  const maxBlobBoxRatio = opts.maxBlobBoxRatio ?? MAX_BLOB_BOX_RATIO;
  const maxBlobImageFraction = opts.maxBlobImageFraction ?? MAX_BLOB_IMAGE_FRACTION;
  const minBlobBboxFill = opts.minBlobBboxFill ?? MIN_BLOB_BBOX_FILL;
  const darkCeiling = opts.darkCeiling ?? DARK_CEILING;
  const confineExpand = opts.confineExpand ?? SNAP_CONFINE_EXPAND;

  // Degenerate box → nothing to snap; caller keeps it (rule 4).
  if (
    !Number.isFinite(bbox.x) ||
    !Number.isFinite(bbox.y) ||
    !Number.isFinite(bbox.w) ||
    !Number.isFinite(bbox.h) ||
    bbox.w <= 0 ||
    bbox.h <= 0
  ) {
    return null;
  }

  const boxX = bbox.x * width;
  const boxY = bbox.y * height;
  const boxW = bbox.w * width;
  const boxH = bbox.h * height;
  const seedBoxArea = boxW * boxH;
  if (seedBoxArea <= 0) return null;

  const imageArea = width * height;
  // A fill exceeding EITHER cap is a leak (rule 5); the tighter one is the abort
  // threshold the fill watches.
  const leakArea = Math.min(
    maxBlobBoxRatio * seedBoxArea,
    maxBlobImageFraction * imageArea,
  );
  const minArea = minBlobFraction * seedBoxArea;

  // Optional stage-3 slab (Phase 7.6): the base window before §1 confinement,
  // confining the fill to a sub-rectangle so a group member fills only its own
  // lobe. Defaults to the whole bitmap.
  let owMinX = 0;
  let owMinY = 0;
  let owMaxX = width - 1;
  let owMaxY = height - 1;
  if (opts.window) {
    owMinX = clampCoord(Math.floor(opts.window.x * width), width);
    owMinY = clampCoord(Math.floor(opts.window.y * height), height);
    owMaxX = clampCoord(Math.ceil((opts.window.x + opts.window.w) * width) - 1, width);
    owMaxY = clampCoord(Math.ceil((opts.window.y + opts.window.h) * height) - 1, height);
    if (owMaxX < owMinX || owMaxY < owMinY) return null; // degenerate window
  }

  // Phase 9.3 §1: hard-wall the fill to the provider box expanded per side,
  // intersected with the slab. Seeds clamp into this effective window exactly as
  // they did into the slab; a fill that slams a hard wall is rejected in `accept`.
  const mainWin = confineWindow(
    boxX,
    boxY,
    boxW,
    boxH,
    confineExpand,
    owMinX,
    owMinY,
    owMaxX,
    owMaxY,
    width,
    height,
  );

  // Precompute the (clamped) seed coordinates + luminances once — the light
  // loop consumes them exactly as before, and the §7 all-seeds-dark trigger
  // needs the full set.
  const seeds = SEED_OFFSETS.map(([dy, dx]) => {
    const sx = clampToRange(
      clampCoord(Math.round(boxX + boxW * (0.5 + dx)), width),
      mainWin.minX,
      mainWin.maxX,
    );
    const sy = clampToRange(
      clampCoord(Math.round(boxY + boxH * (0.5 + dy)), height),
      mainWin.minY,
      mainWin.maxY,
    );
    return { sx, sy, lum: luminanceAt(data, sy * width + sx) };
  });

  /** Build the accepted result: padded bbox + §3 shape + §7 sampled color. */
  const accept = (blob: FilledBlob, win: Window4): SnapResult | null => {
    // Phase 9.3 §1 wall-slam guard, BEFORE the trace: the fill was blocked by a
    // HARD confinement wall by a pixel that would have filled — its true region
    // runs past 2× the box (a cross-panel margin leak, essentially never a real
    // bubble for a roughly-placed box), so reject and fail soft (rule 4). A slab
    // (opts.window) edge is not hard, so a 7.6 lobe touching its group cut passes.
    if (
      (win.hardMinX && blob.hitMinX) ||
      (win.hardMaxX && blob.hitMaxX) ||
      (win.hardMinY && blob.hitMinY) ||
      (win.hardMaxY && blob.hitMaxY)
    ) {
      return null;
    }
    // Phase 9.2 sprawl guard, BEFORE the trace (don't pay for tracing a reject):
    // a partial leak that stayed under the leak caps fills only a sliver of its
    // own bounds — reject it and let the caller move to its next seed/grid point
    // (every seed inside the same sprawl re-rejects, bounded by the seed count).
    const blobBoundsArea =
      (blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1);
    if (blob.area < minBlobBboxFill * blobBoundsArea) return null;
    // Accept: the blob bounds padded 1 snap-px, converted back to fractions.
    const padMinX = Math.max(0, blob.minX - 1);
    const padMinY = Math.max(0, blob.minY - 1);
    const padMaxX = Math.min(width - 1, blob.maxX + 1);
    const padMaxY = Math.min(height - 1, blob.maxY + 1);
    const snapped: BBox = {
      x: padMinX / width,
      y: padMinY / height,
      w: (padMaxX - padMinX + 1) / width,
      h: (padMaxY - padMinY + 1) / height,
    };
    // Sanity pin (trivially true by construction): the snapped box has positive
    // extent and contains the winning seed. Bail to the next seed if not.
    if (snapped.w <= 0 || snapped.h <= 0) return null;
    // §3: shape trace failure keeps the bbox (shape stays undefined, rule 6).
    return { bbox: snapped, shape: traceBlobShape(blob, width, height), fillColor: blobFillHex(blob) };
  };

  for (const { sx, sy, lum: seedLum } of seeds) {
    if (seedLum < lightFloor) continue; // dark seed (stroke/art) — next

    const threshold = Math.max(lightFloor, seedLum - seedTolerance);
    const blob = floodFill(
      data,
      width,
      height,
      sx,
      sy,
      threshold,
      leakArea,
      mainWin.minX,
      mainWin.minY,
      mainWin.maxX,
      mainWin.maxY,
    );
    if (blob === "leak") return null; // rule 5: give up on every seed
    if (blob.area < minArea) continue; // rule 4: glyph counter / speck — next seed
    const result = accept(blob, mainWin);
    if (result) return result;
  }

  // Phase 9 §7 inverse mode, strictly behind the all-seeds-dark trigger: only a
  // uniformly dark interior (flash/inverted-flash) re-runs inverted; any seed
  // above the ceiling (mixed panel) keeps today's light-only outcome.
  if (seeds.every((s) => s.lum <= darkCeiling)) {
    for (const { sx, sy, lum: seedLum } of seeds) {
      // WHY min() mirrors the light path's max(): the fill may not wander onto
      // pixels lighter than the ceiling even from an unusually dark seed.
      const threshold = Math.min(darkCeiling, seedLum + seedTolerance);
      const blob = floodFill(
        data,
        width,
        height,
        sx,
        sy,
        threshold,
        leakArea,
        mainWin.minX,
        mainWin.minY,
        mainWin.maxX,
        mainWin.maxY,
        true,
      );
      if (blob === "leak") return null; // same rule-5 abandon as the light path
      if (blob.area < minArea) continue;
      const result = accept(blob, mainWin);
      if (result) return result;
    }
  }

  // Phase 9.1 §4 rescue: the provider bbox is OFFSET from the drawn bubble, so
  // every standard seed landed on art and both loops above failed. Sample a fixed
  // RESCUE_GRID×RESCUE_GRID grid over the provider bbox expanded RESCUE_EXPAND per
  // side (clamped to the image / window) and try the LIGHT-path fill from each
  // qualifying seed. WHY light-only: the dark path exists for flash bubbles, which
  // are rare and rarely offset — keep the new surface minimal. Deterministic
  // row-major order; the first ACCEPTED blob whose bbox covers ≥
  // RESCUE_MIN_PROVIDER_OVERLAP of the provider box wins.
  const expandX = boxW * RESCUE_EXPAND;
  const expandY = boxH * RESCUE_EXPAND;
  const rescueOriginX = boxX - expandX;
  const rescueOriginY = boxY - expandY;
  const rescueSpanX = boxW + 2 * expandX;
  const rescueSpanY = boxH + 2 * expandY;
  // §1: the rescue's confinement is derived from the RESCUE-expanded box (the
  // 1.25×-per-side grid box), not the raw provider box — confining to the raw box
  // would wall off the very bubble the offset grid is reaching for; the ≥ 40 %
  // provider-overlap guard below still anchors the accepted result to the box.
  const rescueWin = confineWindow(
    rescueOriginX,
    rescueOriginY,
    rescueSpanX,
    rescueSpanY,
    confineExpand,
    owMinX,
    owMinY,
    owMaxX,
    owMaxY,
    width,
    height,
  );
  for (let gy = 0; gy < RESCUE_GRID; gy++) {
    for (let gx = 0; gx < RESCUE_GRID; gx++) {
      const px = rescueOriginX + (rescueSpanX * gx) / (RESCUE_GRID - 1);
      const py = rescueOriginY + (rescueSpanY * gy) / (RESCUE_GRID - 1);
      const sx = clampToRange(clampCoord(Math.round(px), width), rescueWin.minX, rescueWin.maxX);
      const sy = clampToRange(clampCoord(Math.round(py), height), rescueWin.minY, rescueWin.maxY);
      const seedLum = luminanceAt(data, sy * width + sx);
      if (seedLum < lightFloor) continue; // dark grid point (stroke/art) — next
      const threshold = Math.max(lightFloor, seedLum - seedTolerance);
      const blob = floodFill(
        data,
        width,
        height,
        sx,
        sy,
        threshold,
        leakArea,
        rescueWin.minX,
        rescueWin.minY,
        rescueWin.maxX,
        rescueWin.maxY,
      );
      // WHY continue (not return null) on a leak here, unlike the main loops: the
      // provider box is OFFSET, so a grid point on the page background leaking
      // says nothing about the target bubble — a later grid point may still land
      // inside it (min-area rejects likewise skip to the next point).
      if (blob === "leak" || blob.area < minArea) continue;
      const result = accept(blob, rescueWin);
      // §4 acceptance guard: reject a rescue that wandered to a neighbour.
      if (result && coverage(result.bbox, bbox) >= RESCUE_MIN_PROVIDER_OVERLAP) {
        return result;
      }
    }
  }

  return null;
}

/**
 * Whether a region kind should be snapped. Snap ONLY `bubble` and `thought` —
 * the white-interior shapes flood fill was designed for. `caption`/`sfx`/`sign`/
 * `other`/undefined sit on artwork where a fill leaks or lands dark, so they keep
 * the provider box. WHY conservative: a wrong snap is worse than a loose box.
 */
export function shouldSnapKind(kind?: RegionKind): boolean {
  return kind !== undefined && SNAP_KINDS.has(kind);
}

/** The snap-bitmap dimensions for a decoded image (see {@link computeSnapSize}). */
export interface SnapSize {
  width: number;
  height: number;
  /** Multiplier applied to the natural size, in (0, 1]. */
  scale: number;
}

/**
 * Compute the snap-bitmap size: long edge capped at {@link SNAP_MAX_EDGE}, never
 * upscaling, but with the SHORT edge floored at {@link SNAP_MIN_SHORT_EDGE} for
 * extreme aspect ratios (webtoon strips) so a 512-on-the-long-edge scale can't
 * crush the strip to a few px wide. WHY raise-the-cap over per-tile snapping:
 * simpler, and a 256×N bitmap is cheap enough to fill whole (implementer's call
 * per the handoff — flagged in PROGRESS).
 */
export function computeSnapSize(naturalW: number, naturalH: number): SnapSize {
  if (
    !Number.isFinite(naturalW) ||
    !Number.isFinite(naturalH) ||
    naturalW <= 0 ||
    naturalH <= 0
  ) {
    return { width: naturalW, height: naturalH, scale: 1 };
  }
  const longEdge = Math.max(naturalW, naturalH);
  const shortEdge = Math.min(naturalW, naturalH);
  if (longEdge <= SNAP_MAX_EDGE) {
    return { width: naturalW, height: naturalH, scale: 1 };
  }
  let scale = SNAP_MAX_EDGE / longEdge;
  if (shortEdge * scale < SNAP_MIN_SHORT_EDGE) {
    // Raise the cap so the short edge holds its floor; never upscale (min with 1).
    scale = Math.min(1, SNAP_MIN_SHORT_EDGE / shortEdge);
  }
  return {
    width: Math.max(1, Math.round(naturalW * scale)),
    height: Math.max(1, Math.round(naturalH * scale)),
    scale,
  };
}

/**
 * Intersect `box` with `rect`, both normalized 0–1, returning the overlap as a
 * {@link BBox} or `null` when they don't overlap with positive area. Used on the
 * drag-select path so a snapped box (which may GROW past the user's selection)
 * never paints outside what the user selected.
 */
export function clampBoxToRect(box: BBox, rect: BBox): BBox | null {
  const x1 = Math.max(box.x, rect.x);
  const y1 = Math.max(box.y, rect.y);
  const x2 = Math.min(box.x + box.w, rect.x + rect.w);
  const y2 = Math.min(box.y + box.h, rect.y + rect.h);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return null;
  return { x: x1, y: y1, w, h };
}

// --- Phase 7.6: connected-bubble shared-blob split + swallow guard ----------
// A single connected light blob (two speech bubbles joined by a light neck — a
// common manga idiom) is filled identically by BOTH bubbles' seeds. The 7.5
// per-region core then either snaps both to the union bounding box (leak cap
// missed, because ~1.5–2.5× the seed box is under the 4× cap) or leaks the
// smaller one to null — one huge box swallowing the pair, or a huge box + a
// loose box stacked. These pure helpers model that case: detect the shared-blob
// claim, split it between claimants with axis-aligned cuts + windowed re-fills,
// and back everything with a guard that reverts any snap that swallows a
// neighbour. The overlay only draws rectangles, so this gives each region its
// own lobe box — it does NOT attempt shaped fitting.

/** IoU at/above which two accepted snaps are treated as the SAME filled blob
 *  (connected-bubble twin snaps) and grouped. Tunable via {@link SnapOptions}. */
export const SHARED_BLOB_IOU = 0.8;

/** Coverage (area(a∩b)/area(b)) at/above which a snap is judged to "swallow" a
 *  neighbour — the group trigger (stage 2) and the final guard (stage 4). */
export const SWALLOW_COVERAGE = 0.65;

/** Area of a normalized box (non-negative). */
function boxArea(b: BBox): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

/** Area of the intersection of two normalized boxes (0 when disjoint). */
function intersectArea(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = x2 - x1;
  const h = y2 - y1;
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection-over-union of two normalized boxes (0 when disjoint/degenerate). */
function boxIou(a: BBox, b: BBox): number {
  const inter = intersectArea(a, b);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of `b` covered by `a`: area(a ∩ b) / area(b). */
function coverage(a: BBox, b: BBox): number {
  const bArea = boxArea(b);
  return bArea > 0 ? intersectArea(a, b) / bArea : 0;
}

/** The bounding box that contains both `a` and `b`. */
function unionBox(a: BBox, b: BBox): BBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Stage 2 — group snap-eligible regions that filled ONE shared blob, by two
 * triggers over normalized boxes:
 *  - *twin snaps*: accepted snaps with pairwise IoU ≥ `iouThresh` (both filled
 *    the same union);
 *  - *swallowed neighbour*: region i's snap NEWLY covers region j's box
 *    (`coverage(snapᵢ, boxⱼ) ≥ covThresh` while `coverage(origᵢ, origⱼ) <
 *    covThresh`, boxⱼ = snapⱼ ?? origⱼ) — i snapped the union, j is its lobe.
 * Only eligible regions (with, for the anchor, an accepted snap) can group.
 * Returns member-index groups of size ≥ 2; singletons are not groups.
 */
function detectSharedBlobGroups(
  orig: readonly BBox[],
  snaps: readonly (BBox | null)[],
  eligible: readonly boolean[],
  iouThresh: number,
  covThresh: number,
): number[][] {
  const n = orig.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let i = 0; i < n; i++) {
    const snapI = snaps[i];
    if (!eligible[i] || !snapI) continue; // a group anchor must have an accepted snap
    for (let j = 0; j < n; j++) {
      if (j === i || !eligible[j]) continue; // only eligible regions join groups
      const snapJ = snaps[j];
      // Twin snaps: i and j filled near-identical boxes → the same blob.
      if (snapJ && boxIou(snapI, snapJ) >= iouThresh) {
        union(i, j);
        continue;
      }
      // Swallowed neighbour: i's snap covers j's box, and that coverage is NEW
      // (not already present in the loose provider boxes) → i snapped the union.
      const boxJ = snapJ ?? orig[j]!;
      if (
        coverage(snapI, boxJ) >= covThresh &&
        coverage(orig[i]!, orig[j]!) < covThresh
      ) {
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!eligible[i]) continue;
    const list = byRoot.get(find(i)) ?? [];
    list.push(i);
    byRoot.set(find(i), list);
  }
  return [...byRoot.values()].filter((g) => g.length >= 2);
}

/**
 * Stage 3 — split one shared-blob group into per-lobe boxes with windowed
 * re-fills. Cut along the axis with the larger spread of member ORIGINAL-box
 * centers (the snapped boxes are the identical union — only the provider boxes
 * know which lobe is whose), at the midpoints between consecutive centers; each
 * member re-fills confined to its slab window. Returns each member's lobe box,
 * or `null` if ANY member's windowed fill fails — all-or-nothing, so a group
 * built on bad evidence reverts wholesale to provider boxes rather than cutting
 * a real bubble in half.
 */
function splitGroup(
  img: SnapBitmap,
  group: readonly number[],
  orig: readonly BBox[],
  snaps: readonly (BBox | null)[],
  opts: SnapOptions,
): { index: number; result: SnapResult }[] | null {
  const { width, height } = img;
  // Group blob box = union of members' snapped (or, for a leaked member, provider) boxes.
  let blobBox = snaps[group[0]!] ?? orig[group[0]!]!;
  for (const idx of group) blobBox = unionBox(blobBox, snaps[idx] ?? orig[idx]!);

  // Cut axis: the larger spread of member centers, measured in BITMAP px so the
  // image's aspect ratio doesn't distort the choice.
  const centerXpx = (i: number): number => (orig[i]!.x + orig[i]!.w / 2) * width;
  const centerYpx = (i: number): number => (orig[i]!.y + orig[i]!.h / 2) * height;
  const xs = group.map(centerXpx);
  const ys = group.map(centerYpx);
  const axisX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);

  // Sort members by their normalized center along the cut axis; cut at midpoints.
  const centerN = (i: number): number =>
    axisX ? orig[i]!.x + orig[i]!.w / 2 : orig[i]!.y + orig[i]!.h / 2;
  const sorted = [...group].sort((a, b) => centerN(a) - centerN(b));
  const lo = axisX ? blobBox.x : blobBox.y;
  const hi = axisX ? blobBox.x + blobBox.w : blobBox.y + blobBox.h;

  const out: { index: number; result: SnapResult }[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const member = sorted[k]!;
    const slabLo = k === 0 ? lo : (centerN(sorted[k - 1]!) + centerN(member)) / 2;
    const slabHi =
      k === sorted.length - 1 ? hi : (centerN(member) + centerN(sorted[k + 1]!)) / 2;
    // Window = the group blob box, clamped on the cut axis to this member's slab.
    const window: BBox = axisX
      ? { x: slabLo, y: blobBox.y, w: slabHi - slabLo, h: blobBox.h }
      : { x: blobBox.x, y: slabLo, w: blobBox.w, h: slabHi - slabLo };
    // Phase 9 §3: the windowed re-fill produces this member's PER-LOBE contour
    // (and sampled color) with zero extra mechanism — the fill can't cross the cut.
    const result = snapRegionToBubble(img, orig[member]!, { ...opts, window });
    if (!result) return null; // dark/degenerate slab → revert the whole group
    out.push({ index: member, result });
  }
  return out;
}

/**
 * Stage 4 — the final safety net over ALL results: revert any accepted snap that
 * NEWLY swallows a neighbour (eligible or not) — coverage the snap introduced,
 * not already present in the provider's loose boxes. Catches everything stage 3
 * couldn't split (a lobe still over a caption, a group revert that left a twin in
 * place, future drift). A false revert costs only the status quo; a false accept
 * costs the screenshot. Computed over a snapshot so it is order-independent.
 */
function applySwallowGuard(
  results: readonly (SnapResult | null)[],
  orig: readonly BBox[],
  covThresh: number,
): (SnapResult | null)[] {
  const out = results.slice();
  for (let i = 0; i < results.length; i++) {
    const ri = results[i];
    if (!ri) continue; // only an accepted snap can swallow
    for (let j = 0; j < results.length; j++) {
      if (j === i) continue;
      const boxJ = results[j]?.bbox ?? orig[j]!;
      if (
        coverage(ri.bbox, boxJ) >= covThresh &&
        coverage(orig[i]!, orig[j]!) < covThresh
      ) {
        out[i] = null;
        break;
      }
    }
  }
  return out;
}

/**
 * Snap every region of a page, handling connected bubbles (Phase 7.6). The
 * per-region loop is PURE — this is the tested orchestrator that
 * {@link snapPageRegions} decodes into. Stages: (1a) un-confined DETECTION snaps,
 * (2) shared-blob group detection, (1b) confined FINAL snaps for the non-grouped
 * regions, (3) slab split with windowed (confined) re-fills, (4) a swallow guard.
 * WHY detection is un-confined but the final result is confined (Phase 9.3 §1):
 * confinement walls each region's fill at ~2× its own box and rejects a
 * wall-slam, which is exactly right for a single-bubble margin leak but would
 * reject BOTH members of a legitimately-connected pair (the shared blob spans
 * more than 2× either box) — so shared blobs are DETECTED un-confined and split,
 * while lone regions get the confined result. Returns one entry per input
 * region — a {@link SnapResult} (tighter bbox + Phase 9 shape/fillColor), or
 * `null` to keep that region's provider box. A single isolated bubble is
 * byte-identical to a direct {@link snapRegionToBubble}. Never mutates the input.
 *
 * @param img the decoded RGBA snap bitmap.
 * @param regions the page's regions (bbox + optional kind), normalized 0–1.
 * @param opts threshold overrides (tests tune {@link SHARED_BLOB_IOU} /
 *   {@link SWALLOW_COVERAGE} and the 7.5 fill thresholds through here).
 */
export function snapAllRegions(
  img: SnapBitmap,
  regions: readonly { bbox: BBox; kind?: RegionKind }[],
  opts: SnapOptions = {},
): (SnapResult | null)[] {
  const iouThresh = opts.sharedBlobIou ?? SHARED_BLOB_IOU;
  const covThresh = opts.swallowCoverage ?? SWALLOW_COVERAGE;
  const orig = regions.map((r) => r.bbox);
  const eligible = regions.map((r) => shouldSnapKind(r.kind));

  // Stage 1a — DETECTION: independent snaps with §1 confinement DISABLED, so a
  // connected multi-bubble blob is still filled (and thus DETECTED) as one union
  // by every member's seed. A confined pass would wall each member at ~2× its own
  // box and reject the wall-slam, hiding the shared blob (see the header WHY).
  const detectOpts: SnapOptions = { ...opts, confineExpand: Number.POSITIVE_INFINITY };
  const detect: (SnapResult | null)[] = regions.map((r, i) =>
    eligible[i] ? snapRegionToBubble(img, r.bbox, detectOpts) : null,
  );
  const detectBoxes = detect.map((r) => r?.bbox ?? null);

  // Stage 2: group regions that filled one shared blob (from the un-confined snaps).
  const groups = detectSharedBlobGroups(orig, detectBoxes, eligible, iouThresh, covThresh);
  const grouped = new Set<number>(groups.flat());

  // Stage 1b — FINAL independent results: a non-grouped eligible region re-snaps
  // WITH §1 confinement (this is where a single-bubble margin leak is rejected); a
  // grouped region holds its un-confined detection snap until the split replaces it.
  const results: (SnapResult | null)[] = regions.map((r, i) => {
    if (!eligible[i]) return null;
    if (grouped.has(i)) return detect[i] ?? null;
    return snapRegionToBubble(img, r.bbox, opts);
  });

  // Stage 3: split each group into per-lobe boxes (all-or-nothing per group). The
  // union blob box comes from the un-confined detection snaps; each member's
  // windowed re-fill IS confined (default opts), but the slab binds tighter than
  // the confinement wall, so the lobe fill touches only the slab (not a hard wall)
  // and is accepted. Groups are a disjoint partition.
  for (const group of groups) {
    const lobes = splitGroup(img, group, orig, detectBoxes, opts);
    if (lobes) {
      for (const { index, result } of lobes) results[index] = result;
    } else {
      for (const index of group) results[index] = null; // revert to provider boxes
    }
  }

  // Stage 4: revert any result that still swallows a neighbour.
  return applySwallowGuard(results, orig, covThresh);
}

// --- Browser-only layer (OffscreenCanvas decode shell) ---------------------
// Everything below needs `createImageBitmap` + `OffscreenCanvas` and so runs
// only in the event page, not in unit tests. It is a thin shell over the pure
// core above and returns the page UNCHANGED on any failure (handoff rule 4).

/**
 * Refine a page's `bubble`/`thought` region boxes by snapping each to its speech-
 * bubble blob (see {@link snapRegionToBubble}). Decodes `blob` once, downscaled to
 * a {@link computeSnapSize} bitmap, and runs the pure core per eligible region.
 *
 * Returns a NEW {@link PageTranslation} (never mutates the input); non-eligible
 * regions and regions no seed accepted keep their provider box. On ANY throw
 * (decode failure, no canvas context, degenerate input) the INPUT page is
 * returned unchanged — snap can only ever tighten, never break, a translation.
 *
 * @param blob the ORIGINAL full-image bytes (both provider paths hold them).
 * @param page the merged provider result, region bboxes in full-image space.
 * @param clampRect optional selection rect (drag-select) — a snapped box is
 *   additionally clamped to it so a grown bubble can't paint outside the user's
 *   selection; a snapped box that clamps to nothing falls back to the provider box.
 * @returns the page with snapped boxes, or the input page unchanged on failure.
 */
export async function snapPageRegions(
  blob: Blob,
  page: PageTranslation,
  clampRect?: BBox,
): Promise<PageTranslation> {
  // Nothing eligible → skip the decode entirely (a caption/SFX-only page, or the
  // drag-select of a non-bubble, pays zero snap cost).
  if (!page.regions.some((r) => shouldSnapKind(r.kind))) return page;

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const size = computeSnapSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return page;
    // White underlay: a transparent PNG page would otherwise decode as black and
    // read as all-dark, making every seed fail (mirrors renderTile in imagePrep).
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const imageData = ctx.getImageData(0, 0, size.width, size.height);
    const snapBitmap: SnapBitmap = {
      data: imageData.data,
      width: size.width,
      height: size.height,
    };

    // Pure orchestrator: independent snaps → shared-blob split → swallow guard.
    const snaps = snapAllRegions(snapBitmap, page.regions);
    const regions = page.regions.map((region, i) => {
      const snapped = snaps[i];
      if (!snapped) return region; // non-eligible / no accept / reverted → provider box
      // Drag-select: clamp only the BBOX to the selection. WHY the shape is NOT
      // polygon-clipped: shape points outside the clamped box land outside
      // [0, rectW]×[0, rectH] at render time and the box's `overflow: hidden`
      // crops them — identical result, zero clipping code (Phase 9 §3).
      const box = clampRect ? clampBoxToRect(snapped.bbox, clampRect) : snapped.bbox;
      if (!box) return region; // snapped entirely outside the selection — keep it
      // Phase 9: stamp the traced shape + sampled fill color so the cache
      // replays shaped fills with zero spend (deterministic memoization, the
      // 7.5 precedent — NOT a provider claim). Absent fields stay absent.
      return {
        ...region,
        bbox: box,
        ...(snapped.shape ? { shape: snapped.shape } : {}),
        ...(snapped.fillColor ? { fillColor: snapped.fillColor } : {}),
      };
    });

    return { ...page, regions };
  } catch {
    // Fail soft: any decode/canvas fault degrades to the provider's geometry.
    return page;
  } finally {
    bitmap?.close();
  }
}
