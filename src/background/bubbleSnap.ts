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
 * Long-edge cap for the snap bitmap. WHY downsampling is load-bearing (not just
 * cheap): at ≤512 px a 1–2 px outline gap closes by itself and glyph strokes blur
 * toward gray (fewer false-light seeds), while bubbles stay hundreds of px².
 */
export const SNAP_MAX_EDGE = 512;

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
}

/**
 * Iterative 4-connected flood fill from (sx, sy) over pixels with luminance ≥
 * `threshold`, tracking the blob's pixel bounding box and area. Returns `"leak"`
 * the instant the area exceeds `leakArea` (an escaped fill — abort early rather
 * than paint the whole background). No recursion (a big bubble would blow the
 * call stack); a `visited` bitmap keeps it O(pixels).
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
): FilledBlob | "leak" {
  const visited = new Uint8Array(width * height);
  const start = sy * width + sx;
  visited[start] = 1;
  const stack: number[] = [start];
  let area = 0;
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  // Out-of-window pixels are walls (Phase 7.6 stage-3 windowed re-fill): the fill
  // can't cross the cut into a neighbouring lobe's slab.
  const tryPush = (np: number, nx: number, ny: number): void => {
    if (nx < winMinX || nx > winMaxX || ny < winMinY || ny > winMaxY) return;
    if (visited[np]) return;
    visited[np] = 1;
    if (luminanceAt(data, np) >= threshold) stack.push(np);
  };

  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    area++;
    if (area > leakArea) return "leak";
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0) tryPush(p - 1, x - 1, y);
    if (x < width - 1) tryPush(p + 1, x + 1, y);
    if (y > 0) tryPush(p - width, x, y - 1);
    if (y < height - 1) tryPush(p + width, x, y + 1);
  }
  return { area, minX, minY, maxX, maxY };
}

/** Overridable thresholds for {@link snapRegionToBubble} (defaults = the constants). */
export interface SnapOptions {
  lightFloor?: number;
  seedTolerance?: number;
  minBlobFraction?: number;
  maxBlobBoxRatio?: number;
  maxBlobImageFraction?: number;
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
 * Snap one provider bbox to the speech-bubble blob it sits on, or return `null`
 * to keep the provider box (handoff rule 4 — a wrong snap is worse than a loose
 * box, so every ambiguous case fails soft).
 *
 * Algorithm (all thresholds in {@link SnapOptions}, defaults = the module
 * constants):
 *  1. Try the box center then 8 quarter-point seeds (center first).
 *  2. A seed must be LIGHT (luminance ≥ `lightFloor`); a dark seed skips.
 *  3. Flood-fill light pixels (luminance ≥ `max(lightFloor, seedLum −
 *     seedTolerance)`) from the seed.
 *  4. Reject a blob smaller than `minBlobFraction` × seed-box area (glyph-counter
 *     trap) → try the next seed.
 *  5. Reject a blob exceeding `maxBlobBoxRatio` × seed-box area OR
 *     `maxBlobImageFraction` × bitmap area (open-outline leak) → abandon ALL seeds
 *     and return null (a leak from one seed leaks from every seed in that blob).
 *  6. Accept the blob's bounding box, padded 1 px, back in fractional space.
 *
 * @param img the decoded RGBA snap bitmap.
 * @param bbox the provider box, normalized 0–1.
 * @param opts optional threshold overrides (tests tune these).
 * @returns a tighter normalized {@link BBox}, or `null` when no seed accepts.
 */
export function snapRegionToBubble(
  img: SnapBitmap,
  bbox: BBox,
  opts: SnapOptions = {},
): BBox | null {
  const { data, width, height } = img;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;

  const lightFloor = opts.lightFloor ?? LIGHT_FLOOR;
  const seedTolerance = opts.seedTolerance ?? SEED_TOLERANCE;
  const minBlobFraction = opts.minBlobFraction ?? MIN_BLOB_FRACTION;
  const maxBlobBoxRatio = opts.maxBlobBoxRatio ?? MAX_BLOB_BOX_RATIO;
  const maxBlobImageFraction = opts.maxBlobImageFraction ?? MAX_BLOB_IMAGE_FRACTION;

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

  // Optional stage-3 window (Phase 7.6): confine the fill to a sub-rectangle and
  // clamp every seed into it, so a group member fills only its own lobe. Defaults
  // to the whole bitmap.
  let winMinX = 0;
  let winMinY = 0;
  let winMaxX = width - 1;
  let winMaxY = height - 1;
  if (opts.window) {
    winMinX = clampCoord(Math.floor(opts.window.x * width), width);
    winMinY = clampCoord(Math.floor(opts.window.y * height), height);
    winMaxX = clampCoord(Math.ceil((opts.window.x + opts.window.w) * width) - 1, width);
    winMaxY = clampCoord(Math.ceil((opts.window.y + opts.window.h) * height) - 1, height);
    if (winMaxX < winMinX || winMaxY < winMinY) return null; // degenerate window
  }

  for (const [dy, dx] of SEED_OFFSETS) {
    const sx = clampToRange(
      clampCoord(Math.round(boxX + boxW * (0.5 + dx)), width),
      winMinX,
      winMaxX,
    );
    const sy = clampToRange(
      clampCoord(Math.round(boxY + boxH * (0.5 + dy)), height),
      winMinY,
      winMaxY,
    );
    const seedLum = luminanceAt(data, sy * width + sx);
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
      winMinX,
      winMinY,
      winMaxX,
      winMaxY,
    );
    if (blob === "leak") return null; // rule 5: give up on every seed
    if (blob.area < minArea) continue; // rule 4: glyph counter / speck — next seed

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
    if (snapped.w <= 0 || snapped.h <= 0) continue;
    return snapped;
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
): { index: number; box: BBox }[] | null {
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

  const out: { index: number; box: BBox }[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const member = sorted[k]!;
    const slabLo = k === 0 ? lo : (centerN(sorted[k - 1]!) + centerN(member)) / 2;
    const slabHi =
      k === sorted.length - 1 ? hi : (centerN(member) + centerN(sorted[k + 1]!)) / 2;
    // Window = the group blob box, clamped on the cut axis to this member's slab.
    const window: BBox = axisX
      ? { x: slabLo, y: blobBox.y, w: slabHi - slabLo, h: blobBox.h }
      : { x: blobBox.x, y: slabLo, w: blobBox.w, h: slabHi - slabLo };
    const box = snapRegionToBubble(img, orig[member]!, { ...opts, window });
    if (!box) return null; // dark/degenerate slab → revert the whole group
    out.push({ index: member, box });
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
  results: readonly (BBox | null)[],
  orig: readonly BBox[],
  covThresh: number,
): (BBox | null)[] {
  const out = results.slice();
  for (let i = 0; i < results.length; i++) {
    const ri = results[i];
    if (!ri) continue; // only an accepted snap can swallow
    for (let j = 0; j < results.length; j++) {
      if (j === i) continue;
      const boxJ = results[j] ?? orig[j]!;
      if (coverage(ri, boxJ) >= covThresh && coverage(orig[i]!, orig[j]!) < covThresh) {
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
 * {@link snapPageRegions} decodes into. Four stages: (1) independent 7.5 snaps,
 * (2) shared-blob group detection, (3) slab split with windowed re-fills, (4) a
 * swallow guard. Returns one entry per input region — a tighter {@link BBox}, or
 * `null` to keep that region's provider box (exactly as {@link snapRegionToBubble}
 * alone). A single isolated bubble is byte-identical to the 7.5 result. Never
 * mutates the input.
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
): (BBox | null)[] {
  const iouThresh = opts.sharedBlobIou ?? SHARED_BLOB_IOU;
  const covThresh = opts.swallowCoverage ?? SWALLOW_COVERAGE;
  const orig = regions.map((r) => r.bbox);
  const eligible = regions.map((r) => shouldSnapKind(r.kind));

  // Stage 1: independent snaps (null for non-eligible / no seed accepted).
  const results: (BBox | null)[] = regions.map((r, i) =>
    eligible[i] ? snapRegionToBubble(img, r.bbox, opts) : null,
  );

  // Stage 2: group regions that filled one shared blob.
  const groups = detectSharedBlobGroups(orig, results, eligible, iouThresh, covThresh);

  // Stage 3: split each group into per-lobe boxes (all-or-nothing per group).
  // Groups are a disjoint partition, so mutating one never disturbs another's
  // blob-box computation.
  for (const group of groups) {
    const lobes = splitGroup(img, group, orig, results, opts);
    if (lobes) {
      for (const { index, box } of lobes) results[index] = box;
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
      const box = clampRect ? clampBoxToRect(snapped, clampRect) : snapped;
      if (!box) return region; // snapped entirely outside the selection — keep it
      return { ...region, bbox: box };
    });

    return { ...page, regions };
  } catch {
    // Fail soft: any decode/canvas fault degrades to the provider's geometry.
    return page;
  } finally {
    bitmap?.close();
  }
}
