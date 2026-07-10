/**
 * Auto-fit font sizing (Architecture §7.7). The PURE binary search that finds
 * the largest integer px size at which the wrapped text fits a box, given an
 * injected {@link Measure} callback. The DOM measurer (an offscreen element in
 * the shadow root, or canvas `measureText` + line-height math) is the thin shell
 * in BubbleBox; here everything is testable with a synthetic measurer.
 */
import type { FontSettings } from "../../shared/settings";

/** Measured pixel extent of `text` rendered at `px` inside the fitting box. */
export interface Measured {
  w: number;
  h: number;
}

/**
 * Measure wrapped text at a font size. Implementations wrap at the box's inner
 * width, so `w` is bounded by the box except when a single unbreakable word is
 * wider than the box (which the caller handles by clamping to min).
 */
export type Measure = (text: string, px: number) => Measured;

/** Inputs to {@link fitTextSize}. */
export interface FitInput {
  text: string;
  /** Inner box width in px (after padding). */
  boxW: number;
  /** Inner box height in px (after padding). */
  boxH: number;
  /** Smallest allowed font size. */
  minPx: number;
  /** Largest allowed font size. */
  maxPx: number;
  measure: Measure;
}

/**
 * Largest integer font size in `[minPx, maxPx]` whose wrapped text fits `boxW` ×
 * `boxH`. Pure binary search over the (monotonic) fits/doesn't-fit predicate.
 *
 * Edge cases:
 *  - Empty/whitespace text → `0` (the caller renders nothing).
 *  - Text that never fits (not even at `minPx`, e.g. a single word wider than the
 *    box) → clamps to `minPx` and lets `overflow: hidden` crop it. WHY: an
 *    unreadably tiny overlay is worse than a cropped one.
 *  - `minPx > maxPx` (misconfigured) → returns `minPx`.
 *
 * @returns the chosen integer px size (0 for empty text).
 */
export function fitTextSize(input: FitInput): number {
  if (!input.text.trim()) return 0;

  const minPx = Math.max(1, Math.floor(input.minPx));
  const maxPx = Math.floor(input.maxPx);
  if (maxPx < minPx) return minPx;

  const fits = (px: number): boolean => {
    const { w, h } = input.measure(input.text, px);
    return w <= input.boxW && h <= input.boxH;
  };

  // Default to minPx (the clamp case: even the smallest size doesn't fit).
  let best = minPx;
  let lo = minPx;
  let hi = maxPx;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Resolve the font size for a region given the user's {@link FontSettings}:
 * `fixed` mode bypasses the search and returns `fixedSizePx`; `auto` runs
 * {@link fitTextSize}. Pure — this is the whole size decision, so the "fixed
 * bypasses" branch is unit-testable without any DOM.
 *
 * @param font the user's font settings.
 * @param text the region text.
 * @param boxW inner box width (px).
 * @param boxH inner box height (px).
 * @param measure the (injected) text measurer.
 * @returns the px size to render at (0 for empty text).
 */
export function resolveFontSize(
  font: FontSettings,
  text: string,
  boxW: number,
  boxH: number,
  measure: Measure,
): number {
  if (!text.trim()) return 0;
  if (font.sizeMode === "fixed") return font.fixedSizePx;
  return fitTextSize({
    text,
    boxW,
    boxH,
    minPx: font.minSizePx,
    maxPx: font.maxSizePx,
    measure,
  });
}
