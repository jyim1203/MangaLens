/**
 * Phase 9.5 §3 — snap-failure fallback cover-pad (render safety net). A small,
 * deterministic, PURE render-time helper, a sibling of {@link import("./overlapTrim")}
 * (both are view-layer geometry the overlay applies after filter/trim and before
 * painting). WHY a separate module, not an extension of `overlapTrim.ts`: this
 * works in overlay-local PIXELS ({@link PxRect}) at paint time, while `overlapTrim`
 * works in normalized 0–1 bbox space on the cached page — keeping the two
 * coordinate systems in separate files avoids a class of confusion, and this one
 * needs the {@link isBubbleKind} predicate `overlapTrim` does not.
 *
 * The problem (Phase 9.5 §3): §1's whole-balloon boxes make most bubbles snap or
 * at least box the balloon, but a page where the model still boxes tight falls to
 * the Phase 9.4 opaque fallback — an opaque patch SMALLER than the balloon, with
 * the English cramped/off-centre and a rim of source ink around it. This grows the
 * fallback fill outward toward balloon size, with a neighbour-aware clamp so it can
 * never spill INTO an adjacent region's box (the risk the 9.4 handoff deferred it
 * over). It reaches cached pages on the next repaint — pure render, no re-snap.
 */
import type { TranslatedRegion } from "../../shared/types";
import { isBubbleKind } from "../../shared/regionKind";
import type { PxRect } from "./geometry";

/**
 * Default per-side outward expansion of a snap-failure bubble's fallback fill, as
 * a fraction of the box extent (so a wide box grows more in px than a narrow one).
 * WHY 0.12: it covers a typical text-strip→balloon margin without being reckless.
 * It is THE tuning knob for §3 — lower it if any spill appears, raise it if tight
 * boxes still show a CJK rim past the fill.
 */
export const FALLBACK_COVER_PAD = 0.12;

/** Options for {@link computeFallbackCoverRects}. */
export interface FallbackCoverOptions {
  /** Overlay/image bounds in px — no returned rect leaves [0, 0, width, height]. */
  width: number;
  height: number;
  /** Per-side pad as a fraction of the box extent (default {@link FALLBACK_COVER_PAD}). */
  pad?: number;
}

/** Whether a region is a snap-FAILURE bubble (a bubble/thought kind that snapped
 *  no blob, so `fillColor` is undefined) — the only kind the cover-pad grows. */
function isSnapFailureBubble(region: TranslatedRegion): boolean {
  return isBubbleKind(region.kind) && region.fillColor === undefined;
}

/**
 * Compute a PxRect[] **parallel** to `rects` (same seam as Phase 9.4's
 * `suppressFill`): the rect each region's fallback fill + text box should draw at.
 *
 * For a snap-FAILURE bubble ({@link isSnapFailureBubble}) the rect is grown outward
 * by `pad` on every side, then CLAMPED per edge so it neither (a) leaves the
 * image/overlay bounds nor (b) crosses INTO another region's draw rect lying in
 * that direction (the nearest such neighbour, sharing the perpendicular span, is
 * the binding limit). Every other region — a successfully snapped bubble, or any
 * non-bubble kind — returns its own rect UNCHANGED, so the shaped/ellipse/snapped
 * render path is never touched.
 *
 * Pure and deterministic: reads only `rects` + each region's kind/fillColor,
 * mutates nothing, same input → same output.
 *
 * @param regions the trimmed regions, in draw order.
 * @param rects the overlay-local px rects of those regions ({@link regionToPx}),
 *   index-aligned to `regions`.
 * @param opts image/overlay bounds and the optional pad override.
 * @returns `coverRects[i]` — the (possibly grown) draw rect for region `i`.
 */
export function computeFallbackCoverRects(
  regions: readonly TranslatedRegion[],
  rects: readonly PxRect[],
  opts: FallbackCoverOptions,
): PxRect[] {
  const pad = opts.pad ?? FALLBACK_COVER_PAD;
  const out: PxRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i] as PxRect;
    const region = regions[i];
    if (!region || !isSnapFailureBubble(region)) {
      out.push(rect);
      continue;
    }

    const left = rect.left;
    const top = rect.top;
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const padX = pad * rect.width;
    const padY = pad * rect.height;

    // Grow outward, then clamp to the image/overlay bounds.
    let newLeft = Math.max(0, left - padX);
    let newTop = Math.max(0, top - padY);
    let newRight = Math.min(opts.width, right + padX);
    let newBottom = Math.min(opts.height, bottom + padY);

    // Neighbour clamp: per edge, never move past the near edge of another region
    // whose box lies in that direction and shares the perpendicular span. The
    // Math.max/min against the original edge keeps the check to strictly-outward
    // neighbours (an already-overlapping neighbour never constrains).
    for (let j = 0; j < rects.length; j++) {
      if (j === i) continue;
      const n = rects[j] as PxRect;
      const nLeft = n.left;
      const nTop = n.top;
      const nRight = n.left + n.width;
      const nBottom = n.top + n.height;
      const sharesV = nTop < bottom && nBottom > top; // overlaps R's vertical span
      const sharesH = nLeft < right && nRight > left; // overlaps R's horizontal span
      if (sharesV) {
        if (nRight <= left) newLeft = Math.max(newLeft, nRight); // neighbour to the left
        if (nLeft >= right) newRight = Math.min(newRight, nLeft); // neighbour to the right
      }
      if (sharesH) {
        if (nBottom <= top) newTop = Math.max(newTop, nBottom); // neighbour above
        if (nTop >= bottom) newBottom = Math.min(newBottom, nTop); // neighbour below
      }
    }

    out.push({
      left: newLeft,
      top: newTop,
      width: newRight - newLeft,
      height: newBottom - newTop,
    });
  }
  return out;
}
