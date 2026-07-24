/**
 * Per-page "translating" indicator asset (Phase 9.8 §2): the spinning wolf badge
 * shown in the TOP-LEFT corner of a pending overlay while its translation is in
 * flight, so the reader can tell "being worked on" from "never dispatched". The
 * badge sits over the skeleton shimmer — the shimmer says "this page area", the wolf
 * says "actively translating" (a deliberate both-at-once, flagged in PROGRESS).
 *
 * Pure-ish factory: {@link createSpinnerBadge} builds the DOM node; the SVG is parsed
 * (never `innerHTML`-injected — `web-ext lint` flags innerHTML sinks) and fails soft
 * to a bare badge div. The CSS disc + spin animation live in `styles.css`
 * (`.mangalens-spinner`).
 */

/**
 * The wolf spinner SVG, pasted VERBATIM from the Phase 9.8 handoff. Do NOT redraw or
 * "improve" it — the artwork is a fixed asset. The `styles.css` `.mangalens-spinner
 * svg` rule sizes it (22×22) and applies the rotation; the SVG itself carries no
 * animation so reduced-motion can freeze it to a still, still-legible badge.
 */
export const WOLF_SPINNER_SVG = `<svg viewBox="0 0 72 64" xmlns="http://www.w3.org/2000/svg">
  <g fill="#fff" stroke="#000" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round">
    <path d="M60 22 L68 28 L64 32 L69 38 L64 41 L67 48 L60 50 L62 44 L58 40 L60 35 L56 28 Z"/>
    <path d="M51 34 L51 53 Q51 56 48 56 L46 56 L46 34 Z"/>
    <path d="M58 32 L58 51 Q58 54 55 54 L53 54 L53 32 Z"/>
    <path d="M33 34 L33 53 Q33 56 30 56 L28 56 L28 34 Z"/>
    <path d="M40 34 L40 51 Q40 54 37 54 L35 54 L35 32 Z"/>
    <path d="M27 26 L22 30 L27 32 L22 36 L27 37 Q26 40 30 40 L41 40 Q44 36.5 47 40 L54 40 Q60 40 60 33 L61 26 Q61 19 56 16 L53 14 L51 10 L47 13 L42 12 L39 8 L36 12 Q30 13 27 18 Z"/>
    <path d="M12 12 L11 2 L17 8 Q20 7 24 8 L30 2 L29 12 L36 16 L31 18 L37 22 L31 24 L34 28 L28 28 L23 32 L20.5 33 L18 32 L13 28 L7 28 L10 24 L4 22 L10 18 L5 16 Z"/>
    <path d="M14 9 L14 5 L17 8 M24 8 L27 5 L27 9" fill="none" stroke-width="2"/>
    <path d="M13 17 L17 19 M28 17 L24 19" fill="none" stroke-width="2.6"/>
    <path d="M17.5 24 L23.5 24 L20.5 27.5 Z" fill="#000" stroke-width="1.4"/>
    <path d="M20.5 27.5 L20.5 29 M16.5 29.5 Q18.5 31 20.5 29 Q22.5 31 24.5 29.5" fill="none" stroke-width="1.8"/>
  </g>
</svg>`;

/**
 * Parse {@link WOLF_SPINNER_SVG} (or an injected `svgText`, for the fallback test)
 * into a node importable into `doc`, or `null` on ANY failure — a parse error, a
 * non-`<svg>` root, or a runtime without `DOMParser`. WHY `DOMParser` + `importNode`
 * and not `innerHTML`: `web-ext lint` flags innerHTML/insertAdjacentHTML sinks;
 * parsing keeps the badge markup out of any HTML-sink lint rule. Exported so the
 * parse-failure path is directly unit-testable (rule 5 fail-soft).
 *
 * @param doc the document to import the parsed node into.
 * @param svgText the SVG source; defaults to the verbatim wolf asset.
 * @returns an imported SVG node, or `null` to fall back to a bare badge.
 */
export function parseSpinnerSvg(
  doc: Document,
  svgText: string = WOLF_SPINNER_SVG,
): Node | null {
  try {
    if (typeof DOMParser === "undefined") return null;
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root) return null;
    // A malformed source yields a <parsererror> element (or a non-<svg> root) rather
    // than throwing in some engines — treat either as a parse failure.
    if (root.getElementsByTagName("parsererror").length > 0) return null;
    if (root.nodeName.toLowerCase() !== "svg") return null;
    return doc.importNode(root, true);
  } catch {
    return null; // no DOMParser / import failure → bare-badge fallback
  }
}

/**
 * Build the spinner badge: a `div.mangalens-spinner` (`aria-hidden="true"` — it is
 * decorative; the pending state is conveyed structurally, not to AT) wrapping the
 * parsed wolf SVG. On a parse failure the badge is returned WITHOUT the SVG — the CSS
 * disc alone still reads as "working" (fail-soft, rule 5). Never throws.
 *
 * @param doc the owning document (so the caller controls the node's document).
 * @returns the badge element to append into an overlay container.
 */
export function createSpinnerBadge(doc: Document): HTMLElement {
  const badge = doc.createElement("div");
  badge.className = "mangalens-spinner";
  badge.setAttribute("aria-hidden", "true");
  const svg = parseSpinnerSvg(doc);
  if (svg) badge.appendChild(svg);
  return badge;
}
