import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ProviderError,
  extractJsonObject,
  normalizeKind,
  normalizeSourceLang,
  parseBbox,
  parseModelJson,
  parseRetryAfter,
  sanitizePage,
  validatePageShape,
} from "../../src/background/providers/ProviderBase";

/** Load a golden fixture's raw text. */
function goldenText(name: string): string {
  return readFileSync(
    new URL(`../fixtures/golden/${name}`, import.meta.url),
    "utf8",
  );
}

/** Load + parse a golden JSON fixture. */
function goldenJson(name: string): unknown {
  return JSON.parse(goldenText(name));
}

/** parse → validate → sanitize, the whole pipeline over one parsed object. */
function pipeline(parsed: unknown) {
  return sanitizePage(validatePageShape(parsed));
}

describe("providers/ProviderBase — extractJsonObject / parseModelJson", () => {
  it("strips ```json fences and surrounding prose (fenced_json)", () => {
    const parsed = parseModelJson(goldenText("fenced_json.txt"));
    const { regions } = pipeline(parsed);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.translated).toBe("Hello");
  });

  it("trims trailing commentary via outermost-brace slice (trailing_commentary)", () => {
    const parsed = parseModelJson(goldenText("trailing_commentary.txt"));
    const { sourceLang, regions } = pipeline(parsed);
    expect(sourceLang).toBe("ko");
    expect(regions[0]?.translated).toBe("Hi");
  });

  it("returns the substring between the outermost braces", () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toBe('{"a":1}');
  });

  it("throws malformed when there is no JSON object at all", () => {
    expect(() => extractJsonObject("totally not json")).toThrow(ProviderError);
    try {
      parseModelJson("<html>nope</html>");
    } catch (err) {
      expect((err as ProviderError).kind).toBe("malformed");
    }
  });

  it("throws malformed on broken JSON syntax", () => {
    expect(() => parseModelJson('{"a": }')).toThrowError(
      expect.objectContaining({ kind: "malformed" }),
    );
  });
});

describe("providers/ProviderBase — validatePageShape", () => {
  it("accepts a well-formed page", () => {
    const page = validatePageShape({ source_lang: "ja", regions: [] });
    expect(page.source_lang).toBe("ja");
    expect(page.regions).toEqual([]);
  });

  it("defaults a missing source_lang to und", () => {
    expect(validatePageShape({ regions: [] }).source_lang).toBe("und");
  });

  it("throws malformed when regions is not an array", () => {
    expect(() => validatePageShape({ source_lang: "ja" })).toThrowError(
      expect.objectContaining({ kind: "malformed" }),
    );
    expect(() => validatePageShape("nope")).toThrowError(ProviderError);
  });
});

describe("providers/ProviderBase — sanitizePage (golden fixtures)", () => {
  it("passes a clean 8-region page through untouched (clean_single_page)", () => {
    const { sourceLang, regions } = pipeline(goldenJson("clean_single_page.json"));
    expect(sourceLang).toBe("ja");
    expect(regions).toHaveLength(8);
    // SFX regions are kept (overlay filters at render time), flag preserved.
    expect(regions.some((r) => r.isSfx)).toBe(true);
    expect(regions.find((r) => r.kind === "sign")?.translated).toBe("EXIT");
  });

  it("clamps out-of-range bbox values into [0,1] (out_of_range_bbox)", () => {
    const { regions } = pipeline(goldenJson("out_of_range_bbox.json"));
    const first = regions[0]?.bbox;
    expect(first?.x).toBe(1);
    expect(first?.y).toBe(0);
    // The over-wide box's width clamps to 1 (area 0.1, still valid).
    expect(regions[1]?.bbox.w).toBe(1);
  });

  it("drops a whole-page region but keeps the normal one (whole_page_bbox)", () => {
    const { regions } = pipeline(goldenJson("whole_page_bbox.json"));
    expect(regions).toHaveLength(1);
    expect(regions[0]?.translated).toBe("A normal bubble");
  });

  it("dedupes IoU>0.85 identical-original regions, keeping the first (duplicate_regions)", () => {
    const { regions } = pipeline(goldenJson("duplicate_regions.json"));
    expect(regions).toHaveLength(2);
    const dup = regions.find((r) => r.original === "だぶり");
    expect(dup?.confidence).toBe(0.9); // first (higher-confidence) copy kept
  });

  it("yields zero regions for an empty page (empty_page)", () => {
    const { sourceLang, regions } = pipeline(goldenJson("empty_page.json"));
    expect(sourceLang).toBe("und");
    expect(regions).toHaveLength(0);
  });

  it("drops regions with empty/whitespace original text (not counted toward retry)", () => {
    const { regions } = pipeline({
      source_lang: "ja",
      regions: [
        { bbox: [0.1, 0.1, 0.2, 0.1], original: "   ", translated: "x", is_sfx: false },
        { bbox: [0.5, 0.5, 0.2, 0.1], original: "よい", translated: "Good", is_sfx: false },
      ],
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]?.translated).toBe("Good");
  });

  it("treats >30% missing-translation regions as malformed (triggers repair)", () => {
    expect(() =>
      pipeline({
        source_lang: "ja",
        regions: [
          { bbox: [0.1, 0.1, 0.1, 0.1], original: "a", translated: "", is_sfx: false },
          { bbox: [0.3, 0.3, 0.1, 0.1], original: "b", translated: "", is_sfx: false },
          { bbox: [0.5, 0.5, 0.1, 0.1], original: "c", translated: "C", is_sfx: false },
        ],
      }),
    ).toThrowError(expect.objectContaining({ kind: "malformed" }));
  });

  it("keeps regions when missing translations are under the 30% threshold", () => {
    const { regions } = pipeline({
      source_lang: "ja",
      regions: [
        { bbox: [0.1, 0.1, 0.1, 0.1], original: "a", translated: "A", is_sfx: false },
        { bbox: [0.3, 0.3, 0.1, 0.1], original: "b", translated: "B", is_sfx: false },
        { bbox: [0.5, 0.5, 0.1, 0.1], original: "c", translated: "C", is_sfx: false },
        { bbox: [0.7, 0.7, 0.1, 0.1], original: "d", translated: "", is_sfx: false },
      ],
    });
    expect(regions).toHaveLength(3); // the empty one dropped, no throw
  });
});

describe("providers/ProviderBase — parseBbox", () => {
  it("parses the canonical [x,y,w,h] array", () => {
    expect(parseBbox([0.1, 0.2, 0.3, 0.4])).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it("also accepts an {x,y,w,h} object", () => {
    expect(parseBbox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    });
  });

  it("clamps components to [0,1]", () => {
    expect(parseBbox([-1, 2, 0.5, 0.5])).toEqual({ x: 0, y: 1, w: 0.5, h: 0.5 });
  });

  it("returns null for non-finite or malformed input", () => {
    expect(parseBbox([0.1, 0.2, NaN, 0.4])).toBeNull();
    expect(parseBbox([0.1, 0.2])).toBeNull();
    expect(parseBbox("nope")).toBeNull();
  });
});

describe("providers/ProviderBase — normalizeSourceLang (iso639 variants)", () => {
  it("normalizes 3-letter, region-tagged, and cased codes to 2-letter", () => {
    expect(normalizeSourceLang("jpn")).toBe("ja");
    expect(normalizeSourceLang("JA")).toBe("ja");
    expect(normalizeSourceLang("ja-JP")).toBe("ja");
  });

  it("preserves the und sentinel and unknown codes best-effort", () => {
    expect(normalizeSourceLang("und")).toBe("und");
    expect(normalizeSourceLang("")).toBe("und");
    expect(normalizeSourceLang("ko")).toBe("ko");
  });
});

describe("providers/ProviderBase — normalizeKind", () => {
  it("passes through the five canonical kinds and existing other", () => {
    expect(normalizeKind("bubble")).toBe("bubble");
    expect(normalizeKind("sign")).toBe("sign");
    expect(normalizeKind("other")).toBe("other");
  });

  it("maps the OpenAI strict-mode 'none' sentinel and absent kind to undefined", () => {
    expect(normalizeKind("none")).toBeUndefined();
    expect(normalizeKind(undefined)).toBeUndefined();
    expect(normalizeKind(123)).toBeUndefined();
  });

  it("collapses an unknown provider kind to other", () => {
    expect(normalizeKind("banner")).toBe("other");
  });
});

describe("providers/ProviderBase — parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });

  it("returns undefined for a missing/garbage header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
