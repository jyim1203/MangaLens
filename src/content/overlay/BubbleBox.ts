/**
 * Render ONE {@link TranslatedRegion} into the overlay (Architecture §7.7). This
 * is a thin DOM shell: it builds a positioned box (fill layer + centered,
 * auto-fitted text) and delegates every real decision to pure helpers — the font
 * size to {@link resolveFontSize}, and (Phase 9) the shaped fill's clip path,
 * inscribed text rect, ellipse fallback, and dark-fill text flip to
 * `shapePath.ts`. Horizontal text regardless of source direction (§7.7 normal
 * case). `pointer-events: none` throughout — F14 peek REVEALS THE ART via a
 * REPAINT (see {@link RenderBubbleOptions.peek}), not interactivity, so
 * page-forward-on-click still reaches the reader (§7.2).
 *
 * WHY a separate fill layer instead of an rgba background: it renders the fill
 * opacity without fading the text and without parsing arbitrary CSS colors —
 * `bubbleFillColor` can be any CSS color and the layer's `opacity` does the rest.
 * Phase 9: the shape clips the FILL LAYER ONLY (text is never clipped), so a
 * ragged contour can dent the paper, never the words. Resize repaints re-run
 * this whole function, so shaped fills recompute per repaint for free — no new
 * listeners, no cached px.
 */
import type { FontSettings } from "../../shared/settings";
import type { RegionKind, TranslatedRegion } from "../../shared/types";
import { isBubbleKind } from "../../shared/regionKind";
import type { PxRect } from "./geometry";
import { longestWord, maxWordFitPx, resolveFontSize, type Measure } from "./textFit";
import {
  PADDING_RATIO,
  fallbackRadius,
  hexLuma,
  inscribedInnerRect,
  paddedInnerRect,
  pickTextStyle,
  shapeToBoxPath,
  shrinkCentered,
  widenLabelRect,
} from "./shapePath";

// Re-exported for existing consumers; the constant itself moved to the pure
// shapePath module (Phase 9) so inscribedInnerRect can use it browser-free.
export { PADDING_RATIO };

/** Wrap width handed to the measurer when probing a single word's UNBROKEN
 *  extent (Phase 9.2 narrow-rect rescue) — wide enough that no word wraps. */
const WORD_PROBE_WIDTH = 100000;

/** Memoized `-webkit-text-stroke` support probe (constant per engine). */
let strokeSupportedMemo: boolean | undefined;

/**
 * Does the engine support the prefixed `-webkit-text-stroke` property? Gates the
 * text-shadow halo fallback so it isn't drawn *alongside* a real stroke (item 8).
 * Memoized; degrades to `false` (use the shadow) if `CSS.supports` is unavailable.
 */
function strokeSupported(): boolean {
  if (strokeSupportedMemo === undefined) {
    strokeSupportedMemo =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("-webkit-text-stroke", "1px red");
  }
  return strokeSupportedMemo;
}

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

/** Options for {@link renderBubbleBox}. */
export interface RenderBubbleOptions {
  /**
   * Peek (F14 v2, Phase 10 §1): REVEAL THE ART — paint no fill and no label so the
   * untouched page `<img>` underneath (original art AND source text) shows through;
   * a hairline dashed outline is the only cue. WHY the transparency comes from ABSENT
   * CHILDREN, never `opacity`/`visibility` on the box: the §6 stacking-context
   * contract (the layering comment above `Object.assign(box.style, …)`) forbids
   * giving this box its own opacity/transform, and an empty box carrying only an
   * `outline` creates no stacking context — so peeking one bubble can never re-order
   * another's fill/label. A repaint (this whole function) is still how peek toggles;
   * see {@link import("./peek").peekRepaintTargets}.
   */
  peek?: boolean;
  /**
   * Phase 9.4 §3: skip the fill layer entirely (paint the label only). Set by the
   * overlay when this region's draw box is fully contained by another's (see
   * {@link import("./overlapTrim").computeContainedFillSuppression}): the OUTER
   * fill already covers this area, so an inner fill can only double-paint /
   * patch-fight. The label is unaffected — a suppressed region still renders its
   * translation. Defaults to drawing the fill.
   */
  suppressFill?: boolean;
  /**
   * Phase 9.5 §3: the overlay-local px rect to lay the box out at, when it differs
   * from `rect`. Set by {@link import("./coverPad").computeFallbackCoverRects} for a
   * snap-FAILURE bubble: the outward-padded cover rect, so the opaque fallback fill
   * AND the derived inner text rect both grow toward balloon size (giving the
   * English room and covering the source rim). Defaults to `rect` — every snapped /
   * shaped / non-bubble region passes its own rect through, so that path is
   * untouched. The bbox→px mapping ({@link regionToPx}) is still the caller's; this
   * is purely the box-geometry rect.
   */
  drawRect?: PxRect;
}

/**
 * Phase 9.4 §1: the fill layer's effective opacity. A snap-FAILURE fallback on a
 * bubble kind — an {@link isBubbleKind} region whose snap accepted no blob
 * (`fillColor === undefined`) — paints FULLY OPAQUE (1); everything else keeps the
 * user's `bubbleFillOpacity`.
 *
 * WHY opaque only for the bubble fallback: `fillColor === undefined` on a bubble
 * means "we could not find the paper here," so the fallback is the raw provider
 * box — fully hiding the source Chinese under the English is strictly better than
 * the default 0.92 letting ~8 % of the source ink bleed through. A SUCCESSFULLY
 * snapped bubble (`fillColor` set) legitimately honors the user's art-peek
 * translucency, and every non-bubble kind (SFX/narration) must stay translucent
 * so its artwork shows — so both keep `userOpacity`. Pure/deterministic.
 *
 * @param kind the region's classification (undefined counts as non-bubble).
 * @param fillColor the snapped interior color, or undefined when no blob snapped.
 * @param userOpacity the user's configured `bubbleFillOpacity`.
 */
export function effectiveFillOpacity(
  kind: RegionKind | undefined,
  fillColor: string | undefined,
  userOpacity: number,
): number {
  return isBubbleKind(kind) && fillColor === undefined ? 1 : userOpacity;
}

/**
 * Render one region as a positioned overlay box.
 *
 * @param region the region to draw.
 * @param rect overlay-local pixel rect from {@link regionToPx}.
 * @param font user font settings (family/color/stroke/fill).
 * @param makeMeasure a factory from {@link createShadowMeasurer} for auto-fit.
 * @param options peek toggle (F14); defaults to showing the translation.
 * @returns the box element (caller appends it to the overlay container).
 */
export function renderBubbleBox(
  region: TranslatedRegion,
  rect: PxRect,
  font: FontSettings,
  makeMeasure: (boxW: number) => Measure,
  options: RenderBubbleOptions = {},
): HTMLElement {
  // Phase 9.5 §3: lay the box out at the cover rect when the overlay supplied one
  // (a snap-failure bubble's outward-padded fallback); otherwise the region's own
  // px rect. All geometry below (box position/size, padded inner rect, widen) reads
  // this. For every snapped/shaped/non-bubble region `drawRect === rect`, so their
  // render is byte-identical to before.
  const drawRect = options.drawRect ?? rect;

  // Phase 9 §4/§5: geometry mode. A traced shape yields a clip path for the fill
  // and an inscribed text rect; a shape-less bubble/thought may take the ellipse
  // fallback; everything else keeps the pre-Phase-9 rounded rect + padded box.
  const path = region.shape
    ? shapeToBoxPath(region.shape, region.bbox, drawRect.width, drawRect.height)
    : null;
  let boxRadius = "8px";
  let inner: PxRect = paddedInnerRect(drawRect.width, drawRect.height);
  if (path) {
    // WHY radius 0 with a shape: the box's rounded corners crop children via
    // `overflow: hidden`, and a near-rectangular traced bubble legitimately
    // reaches the box corners — only the shape may sculpt the fill.
    boxRadius = "0px";
    inner = inscribedInnerRect(region.shape, region.bbox, drawRect.width, drawRect.height);
  } else if (
    // Phase 9.1 §7: gate the ellipse fallback to SNAPPED regions. `fillColor` is
    // set exactly when the snap accepted a blob, so it is a reliable "this bbox is
    // tight" proxy (no new contract field) — a loose, UNSNAPPED provider box would
    // paint a big white oval spilling over neighbours. Unsnapped bubble/thought
    // boxes keep the pre-Phase-9 8 px rounded rect (small spill, soft corners —
    // strictly less harm than an ellipse on a loose box).
    region.fillColor !== undefined &&
    fallbackRadius(region.kind, drawRect.width / drawRect.height) === "ellipse"
  ) {
    boxRadius = "50%";
    inner = shrinkCentered(inner, Math.SQRT1_2); // corners of a 1/√2 box touch the ellipse
  }

  const box = document.createElement("div");
  box.className = "mangalens-bubble";
  // Phase 9.1 §6 layering contract: the box stays `z-index: auto` with NO
  // transform/filter/opacity, so it does NOT create a stacking context — every
  // box's fill (z-index 1) and label (z-index 2) interleave in the ONE overlay
  // root context, putting EVERY label above EVERY fill. Adding z-index/transform/
  // filter to THIS box would isolate its children and let a later box's fill paint
  // over an earlier box's text (the clipped-"Ev" bug). Do not.
  Object.assign(box.style, {
    position: "absolute",
    left: `${drawRect.left}px`,
    top: `${drawRect.top}px`,
    width: `${drawRect.width}px`,
    height: `${drawRect.height}px`,
    overflow: "hidden",
    borderRadius: boxRadius,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  if (options.peek) {
    // Phase 10 §1: peek REVEALS THE ART. Return the bare box now — no fill layer, no
    // textFit pipeline, no label — carrying only a hairline dashed cue, so the
    // untouched page `<img>` (original art + source text) shows through while the box
    // still lays out at the draw rect for hover hit-testing. WHY a cue at all: with
    // zero affordance the vanish reads as a rendering glitch; a 1px dashed line hugs
    // the balloon's own inked rim and obscures near-nothing. WHY thinner/fainter than
    // the old 2px cue: it now sits over revealed art, not over our own fill.
    box.style.outline = "1px dashed rgba(90, 90, 90, 0.65)";
    box.style.outlineOffset = "-1px";
    return box;
  }

  // Fill layer: separate node so opacity doesn't touch the text. Phase 9 §7:
  // a sampled fillColor wins over the user's bubbleFillColor — it IS the
  // bubble's actual paper color (visually identical for the common white
  // bubble); §4: the shape clips ONLY this layer. Phase 9.4 §3: a contained
  // region skips the fill entirely (the outer fill already covers it), still
  // painting its label below. Phase 9.4 §1: a snap-failure bubble fallback fills
  // fully opaque so no source ink bleeds under the English.
  if (!options.suppressFill) {
    const fill = document.createElement("div");
    Object.assign(fill.style, {
      position: "absolute",
      inset: "0",
      background: region.fillColor ?? font.bubbleFillColor,
      opacity: String(
        effectiveFillOpacity(region.kind, region.fillColor, font.bubbleFillOpacity),
      ),
      borderRadius: "inherit",
      zIndex: "1", // §6: below EVERY label (which sit at z-index 2) across all boxes
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    if (path) fill.style.clipPath = `path("${path}")`;
    box.appendChild(fill);
  }

  const text = region.translated;
  if (!text.trim()) return box; // empty/whitespace text: fill only.

  // Phase 9.3 word-integrity cap-then-widen (replaces the 9.2 probe-after-fit):
  // the shadow measurer has `word-break: break-word`, so fitTextSize is BLIND to
  // fragmentation — it maximizes px and shreds the longest word into a letter
  // column ("Pleas e!"). Fix at the root: cap the auto-fit at the largest px
  // where the longest word renders UNBROKEN in the current rect. WHY probe at
  // WORD_PROBE_WIDTH: the measurer character-breaks at whatever width it's given,
  // so only an effectively-infinite width reveals the word's true unbroken extent.
  const probeMeasure = makeMeasure(WORD_PROBE_WIDTH);
  const longest = longestWord(text);
  let cap = maxWordFitPx(longest, inner.width, font.minSizePx, font.maxSizePx, probeMeasure);
  // cap === null: the whole word cannot fit the inscribed/ellipse rect at ANY
  // legal size. Only THEN widen to the full padded box (keeping the shape's
  // vertical placement; the box still clips) and recompute the cap on the new
  // width — the 9.2 widen, demoted from lead to fallback. WHY cap-then-widen: a
  // word that fits the narrow rect at a SMALLER size now renders small AND whole
  // inside the bubble, instead of large and overhanging; a still-null cap after
  // widening means fragmentation is unavoidable at minPx, so accept it (undefined
  // cap → today's floor-and-crop). minSizePx stays the legibility floor throughout.
  if (cap === null) {
    const widened = widenLabelRect(inner, drawRect.width, drawRect.height);
    if (widened !== inner) {
      inner = widened;
      cap = maxWordFitPx(longest, inner.width, font.minSizePx, font.maxSizePx, probeMeasure);
    }
  }
  const px = resolveFontSize(
    font,
    text,
    inner.width,
    inner.height,
    makeMeasure(inner.width),
    cap ?? undefined,
  );
  if (px <= 0) return box; // defensive: non-empty text always fits ≥ minPx.

  // §7: a dark sampled fill flips to light text + dark stroke (pure decision).
  const textStyle = pickTextStyle(hexLuma(region.fillColor), font);

  const label = document.createElement("div");
  label.textContent = text;
  Object.assign(label.style, {
    width: `${inner.width}px`,
    fontFamily: font.family,
    fontSize: `${px}px`,
    lineHeight: "1.15",
    color: textStyle.color,
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  if (font.stroke) {
    // paint-order: stroke keeps the outline behind the glyph fill; width scales
    // with the font so it stays legible small and doesn't swallow big text.
    const strokeW = Math.max(1, Math.round(px * 0.08));
    label.style.setProperty("-webkit-text-stroke", `${strokeW}px ${textStyle.strokeColor}`);
    label.style.setProperty("paint-order", "stroke fill");
    // WHY gate the shadow fallback: Firefox (our only target) supports the
    // prefixed -webkit-text-stroke, so applying the shadow halo *alongside* it
    // double-renders the outline (stroke + halo) and visibly thickens it. Only
    // fall back to the shadow where text-stroke is unsupported (item 8).
    if (!strokeSupported()) {
      label.style.textShadow = `0 0 ${strokeW}px ${textStyle.strokeColor}`;
    }
  }

  if (path) {
    // Phase 9.1 §5: a shaped bubble's inscribed rect is centered on the polygon
    // CENTROID, which may be off the box center — so position the text at that
    // rect EXPLICITLY (a wrapper at the inner rect that flex-centers the label)
    // rather than relying on the box's flex centering. §6: z-index 2 keeps every
    // label above every fill.
    const textLayer = document.createElement("div");
    Object.assign(textLayer.style, {
      position: "absolute",
      left: `${inner.left}px`,
      top: `${inner.top}px`,
      width: `${inner.width}px`,
      height: `${inner.height}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "2",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    textLayer.appendChild(label);
    box.appendChild(textLayer);
  } else {
    // No-shape paths (padded rect, ellipse): the inner rect is CENTERED in the box
    // by construction, so the box's flex centering places the fixed-width label
    // exactly inside it (unchanged). §6: z-index 2 keeps it above every fill.
    label.style.position = "relative";
    label.style.zIndex = "2";
    box.appendChild(label);
  }
  return box;
}
