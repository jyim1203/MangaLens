import { describe, expect, it } from "vitest";
import {
  filterRegions,
  isNearEdge,
  isWatermark,
  looksLikeUrl,
} from "../../src/content/overlay/regionFilter";
import type { TranslatedRegion } from "../../src/shared/types";

function region(
  o: Partial<TranslatedRegion> & { bbox: TranslatedRegion["bbox"] },
): TranslatedRegion {
  return { original: "", translated: "", isSfx: false, ...o };
}

const HOST = "reader.example.com";

describe("regionFilter — looksLikeUrl", () => {
  it("matches the page hostname literally and generic URL/domain forms", () => {
    expect(looksLikeUrl("reader.example.com", HOST)).toBe(true);
    expect(looksLikeUrl("visit mangasite.io for more", HOST)).toBe(true);
    expect(looksLikeUrl("https://foo.bar/baz", HOST)).toBe(true);
    expect(looksLikeUrl("www.example.org", HOST)).toBe(true);
  });

  it("does not match ordinary text", () => {
    expect(looksLikeUrl("STORE", HOST)).toBe(false);
    expect(looksLikeUrl("It's over 9000!", HOST)).toBe(false);
    expect(looksLikeUrl("", HOST)).toBe(false);
  });
});

describe("regionFilter — isNearEdge", () => {
  it("is true within 2% of any edge, false in the middle", () => {
    expect(isNearEdge({ bbox: { x: 0.0, y: 0.5, w: 0.1, h: 0.1 } })).toBe(true); // left
    expect(isNearEdge({ bbox: { x: 0.5, y: 0.99, w: 0.1, h: 0.005 } })).toBe(true); // bottom
    expect(isNearEdge({ bbox: { x: 0.985, y: 0.5, w: 0.01, h: 0.1 } })).toBe(true); // right
    expect(isNearEdge({ bbox: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } })).toBe(false); // middle
  });
});

describe("regionFilter — isWatermark (PROMPTS §9)", () => {
  it("drops a sign at the edge whose text is the page hostname", () => {
    const r = region({
      bbox: { x: 0.8, y: 0.97, w: 0.19, h: 0.02 },
      kind: "sign",
      original: "reader.example.com",
    });
    expect(isWatermark(r, HOST)).toBe(true);
  });

  it("drops a sign at the edge whose text is a generic URL/domain", () => {
    const r = region({
      bbox: { x: 0, y: 0, w: 0.2, h: 0.03 },
      kind: "sign",
      translated: "mangasite.io",
    });
    expect(isWatermark(r, HOST)).toBe(true);
  });

  it("keeps a sign in the MIDDLE of the image (not near an edge)", () => {
    const r = region({
      bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 },
      kind: "sign",
      original: "example.com",
    });
    expect(isWatermark(r, HOST)).toBe(false);
  });

  it("keeps an edge caption (kind is not sign)", () => {
    const r = region({
      bbox: { x: 0, y: 0.97, w: 0.3, h: 0.02 },
      kind: "caption",
      original: "example.com",
    });
    expect(isWatermark(r, HOST)).toBe(false);
  });

  it("keeps an edge sign whose text is not a URL", () => {
    const r = region({
      bbox: { x: 0, y: 0.97, w: 0.2, h: 0.02 },
      kind: "sign",
      original: "STORE",
    });
    expect(isWatermark(r, HOST)).toBe(false);
  });
});

describe("regionFilter — filterRegions (watermark + SFX, render time)", () => {
  const bubble = region({ bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 }, translated: "hi" });
  const sfx = region({
    bbox: { x: 0.4, y: 0.3, w: 0.1, h: 0.1 },
    isSfx: true,
    translated: "BOOM",
  });

  it("drops SFX when translateSfx is false (F19 default skip)", () => {
    expect(filterRegions([sfx, bubble], { translateSfx: false })).toEqual([bubble]);
  });

  it("keeps SFX when translateSfx is true", () => {
    expect(filterRegions([sfx, bubble], { translateSfx: true })).toHaveLength(2);
  });

  it("drops a watermark sign regardless of the SFX setting", () => {
    const wm = region({
      bbox: { x: 0, y: 0.98, w: 0.2, h: 0.01 },
      kind: "sign",
      original: "example.com",
    });
    expect(
      filterRegions([wm, bubble], { translateSfx: true, hostname: "example.com" }),
    ).toEqual([bubble]);
  });

  it("does not mutate the input array", () => {
    const input = [sfx, bubble];
    filterRegions(input, { translateSfx: false });
    expect(input).toHaveLength(2);
  });
});
