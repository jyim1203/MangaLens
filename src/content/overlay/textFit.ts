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
 * Phase 9.2: the whitespace-delimited word of `text` with the most characters
 * (first wins a tie) — the wrap-limiting word for the narrow-rect widen decision
 * in BubbleBox. Character count is a proxy for rendered width; the exact extent
 * is the injected measurer's job. A string with no whitespace (single word, CJK
 * peek text) returns whole — CJK wraps cleanly at any width anyway, so the
 * caller's probe simply reports a large extent and widens, which is harmless.
 * Pure.
 */
export function longestWord(text: string): string {
  let best = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > best.length) best = word;
  }
  return best;
}

/**
 * Phase 9.3: the largest integer px in `[minPx, maxPx]` at which `word` renders
 * UNBROKEN within `widthPx`, or `null` when even `minPx` overflows. WHY this
 * exists: {@link fitTextSize}'s predicate measures with `word-break: break-word`
 * active, so a fragmented word still "fits" — the search happily maximizes px and
 * shreds a long word into a letter column ("Pleas e!"). Capping the auto-fit at
 * this value kills the fragmentation at the root. Pure binary search over the
 * same monotonic predicate as {@link fitTextSize}; the probe measurer is the
 * caller's business (the shell passes a wide-wrap measurer so the word never
 * wraps and `w` is its true unbroken extent). An empty word imposes NO cap
 * (returns `maxPx` — nothing to fragment).
 *
 * @param word the wrap-limiting word (see {@link longestWord}).
 * @param widthPx the rect width the word must fit unbroken.
 * @param minPx smallest allowed font size.
 * @param maxPx largest allowed font size.
 * @param probeMeasure a measurer bound to an effectively-infinite wrap width.
 * @returns the cap px, or `null` when the word overflows even at `minPx`.
 */
export function maxWordFitPx(
  word: string,
  widthPx: number,
  minPx: number,
  maxPx: number,
  probeMeasure: Measure,
): number | null {
  const maxI = Math.floor(maxPx);
  if (!word) return maxI; // no word → no cap
  const minI = Math.max(1, Math.floor(minPx));
  if (maxI < minI) return null; // degenerate bounds: cannot fit

  const fits = (px: number): boolean => probeMeasure(word, px).w <= widthPx;
  if (!fits(minI)) return null; // even the smallest size overflows → caller widens

  let best = minI;
  let lo = minI;
  let hi = maxI;
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
 * @param wordCapPx Phase 9.3: optional word-integrity cap (see
 *   {@link maxWordFitPx}). In AUTO mode the effective max becomes
 *   `min(font.maxSizePx, wordCapPx)`, so the search can never pick a size that
 *   fragments the longest word. FIXED mode IGNORES it — the user chose that size
 *   explicitly (the 9.2 widen still rescues them). WHY-note: undefined leaves the
 *   pre-9.3 behaviour untouched.
 * @returns the px size to render at (0 for empty text).
 */
export function resolveFontSize(
  font: FontSettings,
  text: string,
  boxW: number,
  boxH: number,
  measure: Measure,
  wordCapPx?: number,
): number {
  if (!text.trim()) return 0;
  if (font.sizeMode === "fixed") return font.fixedSizePx;
  const maxPx =
    wordCapPx !== undefined ? Math.min(font.maxSizePx, wordCapPx) : font.maxSizePx;
  return fitTextSize({
    text,
    boxW,
    boxH,
    minPx: font.minSizePx,
    maxPx,
    measure,
  });
}
