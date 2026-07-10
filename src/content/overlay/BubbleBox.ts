/**
 * Render ONE {@link TranslatedRegion} into the overlay (Architecture §7.7). This
 * is a thin DOM shell: it builds a positioned box (rounded-rect fill + centered,
 * auto-fitted text) and delegates the only real decision — the font size — to the
 * pure {@link resolveFontSize}. Horizontal text regardless of source direction
 * (§7.7 normal case). `pointer-events: none` throughout (no interactive bits this
 * phase — F14 peek-original is Phase 7).
 *
 * WHY a separate fill layer instead of an rgba background: it renders the fill
 * opacity without fading the text and without parsing arbitrary CSS colors —
 * `bubbleFillColor` can be any CSS color and the layer's `opacity` does the rest.
 */
import type { FontSettings } from "../../shared/settings";
import type { TranslatedRegion } from "../../shared/types";
import type { PxRect } from "./geometry";
import { resolveFontSize, type Measure } from "./textFit";

/** Inner padding as a fraction of the box (§7.7). */
export const PADDING_RATIO = 0.06;

/**
 * Build a hidden measuring element's `Measure` factory bound to the shadow root's
 * styling context, so measurements match what will actually render. The element
 * is reused across boxes; each call reconfigures its width and font.
 *
 * @param measureEl an offscreen element already placed in the shadow root.
 * @param font the font settings to measure with.
 * @returns a factory: `(innerBoxWidth) => Measure`.
 */
export function createShadowMeasurer(
  measureEl: HTMLElement,
  font: FontSettings,
): (boxW: number) => Measure {
  return (boxW: number): Measure =>
    (text: string, px: number): { w: number; h: number } => {
      measureEl.style.width = `${boxW}px`;
      measureEl.style.fontFamily = font.family;
      measureEl.style.fontSize = `${px}px`;
      measureEl.style.lineHeight = "1.15";
      measureEl.textContent = text;
      return { w: measureEl.scrollWidth, h: measureEl.scrollHeight };
    };
}

/**
 * Render one region as a positioned overlay box.
 *
 * @param region the region to draw (its `translated` text is shown).
 * @param rect overlay-local pixel rect from {@link regionToPx}.
 * @param font user font settings (family/color/stroke/fill).
 * @param makeMeasure a factory from {@link createShadowMeasurer} for auto-fit.
 * @returns the box element (caller appends it to the overlay container).
 */
export function renderBubbleBox(
  region: TranslatedRegion,
  rect: PxRect,
  font: FontSettings,
  makeMeasure: (boxW: number) => Measure,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "mangalens-bubble";
  Object.assign(box.style, {
    position: "absolute",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    overflow: "hidden",
    borderRadius: "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  // Fill layer: separate node so opacity doesn't touch the text.
  const fill = document.createElement("div");
  Object.assign(fill.style, {
    position: "absolute",
    inset: "0",
    background: font.bubbleFillColor,
    opacity: String(font.bubbleFillOpacity),
    borderRadius: "inherit",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  box.appendChild(fill);

  const text = region.translated;
  const innerW = rect.width * (1 - 2 * PADDING_RATIO);
  const innerH = rect.height * (1 - 2 * PADDING_RATIO);
  const px = resolveFontSize(font, text, innerW, innerH, makeMeasure(innerW));
  if (px <= 0) return box; // empty/whitespace text: fill only.

  const label = document.createElement("div");
  label.textContent = text;
  Object.assign(label.style, {
    position: "relative",
    padding: `${rect.height * PADDING_RATIO}px ${rect.width * PADDING_RATIO}px`,
    fontFamily: font.family,
    fontSize: `${px}px`,
    lineHeight: "1.15",
    color: font.color,
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  if (font.stroke) {
    // paint-order: stroke keeps the outline behind the glyph fill; width scales
    // with the font so it stays legible small and doesn't swallow big text.
    const strokeW = Math.max(1, Math.round(px * 0.08));
    label.style.setProperty("-webkit-text-stroke", `${strokeW}px ${font.strokeColor}`);
    label.style.setProperty("paint-order", "stroke fill");
    // Fallback for engines without text-stroke: a tight shadow halo.
    label.style.textShadow = `0 0 ${strokeW}px ${font.strokeColor}`;
  }

  box.appendChild(label);
  return box;
}
