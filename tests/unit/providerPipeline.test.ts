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

  it("drops out-of-range legacy w/h boxes as noisy corners (Phase 9.5 §2, out_of_range_bbox)", () => {
    // Both rows have a degenerate corners reading, so they fall to the legacy w/h
    // reading — but both OVERFLOW the frame there (row 1 x+w = 1.25, row 2
    // x+w = 1.50). The §2 plausibility guard treats that heavy overflow as the tell
    // that the row was corners-with-noise, not a genuine w/h box, and drops it
    // rather than clamping a garbage rectangle onto the panel. (The joint clamp
    // still applies to overflowing CORNER boxes — see the parseBbox suite.)
    const { regions } = pipeline(goldenJson("out_of_range_bbox.json"));
    expect(regions).toHaveLength(0);
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

describe("providers/ProviderBase — sanitizePage §2 duplicate/degenerate cleanup", () => {
  /** One raw region; bbox is corner-format unless a w/h object is passed. */
  function raw(
    bbox: unknown,
    original: string,
    kind?: string,
    isSfx = false,
  ): Record<string, unknown> {
    return { bbox, original, translated: `→${original}`, is_sfx: isSfx, ...(kind ? { kind } : {}) };
  }

  it("collapses two OVERLAPPING identical-text bubbles to the larger; a DISJOINT copy survives", () => {
    const { regions } = pipeline({
      source_lang: "zh",
      regions: [
        raw([0.10, 0.10, 0.30, 0.30], "與此類似", "bubble"), // {0.10,0.10,0.20,0.20}
        raw([0.12, 0.12, 0.37, 0.37], "與此類似", "bubble"), // {0.12,0.12,0.25,0.25} larger, IoU≈0.46
        raw([0.60, 0.60, 0.80, 0.80], "與此類似", "bubble"), // disjoint {0.60,0.60,0.20,0.20}
      ],
    });
    expect(regions).toHaveLength(2);
    const byX = [...regions].sort((a, b) => a.bbox.x - b.bbox.x);
    // The overlapping pair collapsed to the LARGER box (kept x 0.12, w 0.25); the
    // smaller (w 0.20 at x 0.10) is gone.
    expect(byX[0]!.bbox.x).toBeCloseTo(0.12, 6);
    expect(byX[0]!.bbox.w).toBeCloseTo(0.25, 6);
    // The disjoint copy (x 0.60) intentionally survives.
    expect(byX[1]!.bbox.x).toBeCloseTo(0.6, 6);
  });

  it("keeps BOTH overlapping identical-text SFX regions (kind exemption)", () => {
    // sfx repeats verbatim at different spots; IoU≈0.46 is under the strict 0.85
    // gate and sfx is off the lower-threshold path, so neither collapses.
    const { regions } = pipeline({
      source_lang: "ja",
      regions: [
        raw([0.10, 0.10, 0.30, 0.30], "パチ", "sfx", true),
        raw([0.12, 0.12, 0.37, 0.37], "パチ", "sfx", true),
      ],
    });
    expect(regions).toHaveLength(2);
  });

  it("keeps two overlapping bubbles with DIFFERENT text (never merges distinct dialogue)", () => {
    const { regions } = pipeline({
      source_lang: "zh",
      regions: [
        raw([0.10, 0.10, 0.30, 0.30], "與此類似", "bubble"),
        raw([0.12, 0.12, 0.37, 0.37], "別的對話", "bubble"),
      ],
    });
    expect(regions).toHaveLength(2);
  });

  it("treats a whitespace-only (newline-wrap) difference as identical text", () => {
    // The same line OCR'd once with a wrapping newline, once with a space →
    // normalized equal, so the overlapping bubble pair collapses to the larger.
    const { regions } = pipeline({
      source_lang: "zh",
      regions: [
        raw([0.10, 0.10, 0.30, 0.30], "與此\n類似", "bubble"),
        raw([0.12, 0.12, 0.37, 0.37], "與此 類似", "bubble"),
      ],
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.bbox.w).toBeCloseTo(0.25, 6); // the larger box kept
  });

  it("end-to-end Call-11 fixture: drops the degenerate r12 box, collapses each cluster by one", () => {
    // 24 raw regions modelled on HAR Call 11: 19 distinct fillers + the degenerate
    // 讓其結合… box (dropped by the §2 parse guard) + its valid twin + three 與此類似
    // copies (two overlapping → collapse to larger, one disjoint → survives).
    const { regions } = pipeline(goldenJson("call11_duplicates.json"));
    const count = (t: string) => regions.filter((r) => r.original === t).length;
    expect(regions).toHaveLength(22); // 24 − r12 (degenerate) − one 與此類似 copy
    // The panel-covering degenerate 讓其結合… box is gone; only its valid twin remains.
    expect(count("讓其結合並提高密度的話")).toBe(1);
    // The tripled 與此類似 is down to one merged copy + the disjoint stray.
    expect(count("與此類似")).toBe(2);
    const similar = regions.filter((r) => r.original === "與此類似");
    expect(similar.some((r) => Math.abs(r.bbox.w - 0.25) < 1e-6)).toBe(true); // larger kept
    expect(similar.some((r) => Math.abs(r.bbox.w - 0.2) < 1e-6)).toBe(false); // smaller gone
  });
});

describe("providers/ProviderBase — parseBbox (Phase 7.4 corners-first)", () => {
  /** Assert a parsed bbox equals the expected components (float-tolerant). */
  function expectBbox(
    got: ReturnType<typeof parseBbox>,
    exp: { x: number; y: number; w: number; h: number },
  ): void {
    expect(got).not.toBeNull();
    expect(got!.x).toBeCloseTo(exp.x, 6);
    expect(got!.y).toBeCloseTo(exp.y, 6);
    expect(got!.w).toBeCloseTo(exp.w, 6);
    expect(got!.h).toBeCloseTo(exp.h, 6);
  }

  it("reads the canonical array as corners [x_min,y_min,x_max,y_max] (HAR literal)", () => {
    // The exact row from the 2026-07-11 HAR that renders wrong as w/h.
    expectBbox(parseBbox([0.55, 0.32, 0.95, 0.42]), {
      x: 0.55,
      y: 0.32,
      w: 0.4,
      h: 0.1,
    });
  });

  it("falls back to legacy w/h when the corners reading is degenerate (y_max < y_min)", () => {
    // [0.35, 0.18, 0.25, 0.08]: x_max<x_min AND y_max<y_min → not corners.
    expectBbox(parseBbox([0.35, 0.18, 0.25, 0.08]), {
      x: 0.35,
      y: 0.18,
      w: 0.25,
      h: 0.08,
    });
  });

  it("trusts the corners reading when it is valid, even if w/h would also parse", () => {
    expectBbox(parseBbox([0.1, 0.1, 0.3, 0.4]), { x: 0.1, y: 0.1, w: 0.2, h: 0.3 });
  });

  it("jointly clamps so a box can't extend past the image edge (Finding 2)", () => {
    // Corners overflowing the right edge: x_max 1.5 → clamped so x + w === 1.
    expectBbox(parseBbox([0.85, 0.1, 1.5, 0.5]), {
      x: 0.85,
      y: 0.1,
      w: 0.15,
      h: 0.4,
    });
    // Same guarantee via the object w/h form (h fits, only w is capped).
    expectBbox(parseBbox({ x: 0.85, y: 0.1, w: 0.5, h: 0.5 }), {
      x: 0.85,
      y: 0.1,
      w: 0.15,
      h: 0.5,
    });
  });

  it("still accepts the {x,y,w,h} object form unchanged", () => {
    expectBbox(parseBbox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), {
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    });
  });

  it("drops a box that is degenerate after clamping (w or h ≤ 0)", () => {
    // x clamps to 1 → no width left → dropped.
    expect(parseBbox({ x: 1, y: 0.5, w: 0.2, h: 0.2 })).toBeNull();
    // Legacy-fallback row whose top-left clamps to the bottom edge.
    expect(parseBbox([-1, 2, 0.5, 0.5])).toBeNull();
  });

  it("returns null for non-finite or malformed input", () => {
    expect(parseBbox([0.1, 0.2, NaN, 0.4])).toBeNull();
    expect(parseBbox([0.1, 0.2])).toBeNull();
    expect(parseBbox("nope")).toBeNull();
  });

  it("drops a noisy corner box whose legacy w/h reading overflows the frame (§2 guard)", () => {
    // The Call-11 r12 vector: corners degenerate (y_max 0.620 < y_min 0.650), so it
    // falls to legacy w/h = {w:0.65, h:0.62} from x=0.48 → x+w = 1.13 > 1, which no
    // real w/h box does. The plausibility guard drops it instead of clamping a
    // quarter-page rectangle onto the panel.
    expect(parseBbox([0.48, 0.65, 0.65, 0.62])).toBeNull();
  });

  it("preserves a genuine legacy w/h box that fits the frame (§2 back-compat pin)", () => {
    // Corners degenerate (y_max 0.15 < y_min 0.2) → legacy w/h; x+w = 0.4 and
    // y+h = 0.35 both fit, so the half-of-Haiku-emits-w/h case still parses as w/h.
    expectBbox(parseBbox([0.1, 0.2, 0.3, 0.15]), { x: 0.1, y: 0.2, w: 0.3, h: 0.15 });
  });

  it("keeps a valid corner box (the guard only gates the legacy w/h fallback)", () => {
    expectBbox(parseBbox([0.2, 0.2, 0.5, 0.6]), { x: 0.2, y: 0.2, w: 0.3, h: 0.4 });
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
