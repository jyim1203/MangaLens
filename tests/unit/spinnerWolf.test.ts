// @vitest-environment jsdom
/**
 * Phase 9.8 §2 unit tests for the wolf spinner asset + factory. jsdom supplies the
 * DOMParser the happy path needs; the parse-failure fallback is exercised via the
 * exported parse seam and by removing DOMParser from the runtime.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  WOLF_SPINNER_SVG,
  createSpinnerBadge,
  parseSpinnerSvg,
} from "../../src/content/overlay/spinnerWolf";

describe("spinnerWolf — WOLF_SPINNER_SVG constant (verbatim asset)", () => {
  it("carries the handoff viewBox and the stroke/fill markers (not redrawn)", () => {
    expect(WOLF_SPINNER_SVG).toContain('viewBox="0 0 72 64"');
    expect(WOLF_SPINNER_SVG).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(WOLF_SPINNER_SVG).toContain('stroke-width="2.8"');
    expect(WOLF_SPINNER_SVG).toContain('stroke-linejoin="round"');
    // A couple of distinctive path fragments from the verbatim asset.
    expect(WOLF_SPINNER_SVG).toContain("M60 22 L68 28");
    expect(WOLF_SPINNER_SVG).toContain('fill="#000" stroke-width="1.4"');
  });
});

describe("spinnerWolf — createSpinnerBadge", () => {
  // In jsdom `globalThis === window`, so deleting globalThis.DOMParser also removes
  // window.DOMParser — capture the original up front and restore from it.
  const OriginalDOMParser = globalThis.DOMParser;
  afterEach(() => {
    globalThis.DOMParser = OriginalDOMParser;
  });

  it("returns a div.mangalens-spinner, aria-hidden, wrapping a parsed <svg>", () => {
    const badge = createSpinnerBadge(document);
    expect(badge.tagName).toBe("DIV");
    expect(badge.className).toBe("mangalens-spinner");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    const svg = badge.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 72 64");
  });

  it("falls back to a BARE badge div (no svg) when DOMParser is absent", () => {
    // @ts-expect-error simulate a runtime without DOMParser
    delete globalThis.DOMParser;
    const badge = createSpinnerBadge(document);
    expect(badge.className).toBe("mangalens-spinner");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.querySelector("svg")).toBeNull(); // no child — the CSS disc still reads
    expect(badge.childNodes).toHaveLength(0);
  });
});

describe("spinnerWolf — parseSpinnerSvg (fail-soft seam)", () => {
  it("parses the verbatim asset into an importable <svg> node", () => {
    const node = parseSpinnerSvg(document);
    expect(node).not.toBeNull();
    expect((node as Element).nodeName.toLowerCase()).toBe("svg");
  });

  it("returns null on malformed input rather than throwing", () => {
    expect(parseSpinnerSvg(document, "<<<not svg>>>")).toBeNull();
    expect(parseSpinnerSvg(document, "not markup at all")).toBeNull();
    expect(parseSpinnerSvg(document, "<svg><g></svg>")).toBeNull(); // mismatched tags
  });
});
