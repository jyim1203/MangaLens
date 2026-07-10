/**
 * Render-time region filters (applied by the OverlayManager, never mutating the
 * cached translation). Two independent drops:
 *
 *  1. Watermark post-filter (PROMPTS §9, deferred here from Phase 3): a `sign`
 *     region hugging an image edge whose text is a URL/domain is site chrome, not
 *     story text — drop it. Applied at render time because edge-proximity is only
 *     unambiguous against the FULL image (a middle tile's edge isn't a page edge),
 *     and edges are exactly what we have here.
 *  2. SFX filter (F19 default skip): drop `isSfx` regions unless the user opted to
 *     translate sound effects.
 *
 * All pure and unit-tested. WHY never mutate the cached `PageTranslation`: the
 * same cache entry must render unfiltered elsewhere if the rules (or the page
 * hostname) differ — the filter is a *view*, not a rewrite.
 */
import type { TranslatedRegion } from "../../shared/types";

/** A region within this fraction of any image edge counts as "at the edge". */
export const EDGE_THRESHOLD = 0.02;

/**
 * Match a URL or bare domain: an explicit scheme/`www.`, or a dotted host ending
 * in a 2+ letter TLD (e.g. `example.com`, `reader.manga.io`). Case-insensitive.
 * Kept intentionally loose — it only fires in combination with `kind === "sign"`
 * AND edge proximity, so a false match on non-chrome text is very unlikely.
 */
const URL_RE =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;

/**
 * Does `text` look like a URL / domain — or contain the page's own hostname?
 *
 * @param text region text (original or translated).
 * @param hostname the host page's hostname, matched literally (case-insensitive).
 */
export function looksLikeUrl(text: string, hostname?: string): boolean {
  if (!text) return false;
  if (hostname && text.toLowerCase().includes(hostname.toLowerCase())) {
    return true;
  }
  return URL_RE.test(text);
}

/**
 * Is the region's bbox within {@link EDGE_THRESHOLD} of any of the four image
 * edges? Pure.
 */
export function isNearEdge(
  region: Pick<TranslatedRegion, "bbox">,
  threshold = EDGE_THRESHOLD,
): boolean {
  const { x, y, w, h } = region.bbox;
  return (
    x <= threshold ||
    y <= threshold ||
    x + w >= 1 - threshold ||
    y + h >= 1 - threshold
  );
}

/**
 * Is this region a site watermark/chrome to drop (PROMPTS §9)? True iff it is a
 * `sign`, lies near an image edge, and its original OR translated text looks like
 * a URL/domain (or the page hostname).
 *
 * @param region the region to test.
 * @param hostname the host page hostname (enables literal-hostname matching).
 */
export function isWatermark(
  region: TranslatedRegion,
  hostname?: string,
): boolean {
  if (region.kind !== "sign") return false;
  if (!isNearEdge(region)) return false;
  return (
    looksLikeUrl(region.original, hostname) ||
    looksLikeUrl(region.translated, hostname)
  );
}

/** Options for {@link filterRegions}. */
export interface RegionFilterOptions {
  /** Host page hostname for watermark matching. */
  hostname?: string;
  /** F19: when false (default), drop SFX regions. */
  translateSfx: boolean;
}

/**
 * Apply both render-time filters and return the regions to actually draw. Does
 * not mutate the input array.
 *
 * @param regions the cached page's regions.
 * @param opts hostname (watermark) + SFX preference.
 */
export function filterRegions(
  regions: readonly TranslatedRegion[],
  opts: RegionFilterOptions,
): TranslatedRegion[] {
  return regions.filter((r) => {
    if (!opts.translateSfx && r.isSfx) return false;
    if (isWatermark(r, opts.hostname)) return false;
    return true;
  });
}
