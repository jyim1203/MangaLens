import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// optionsLogic → shared/settings (types) → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Settings,
} from "../../src/shared/settings";
import {
  NUMERIC_FIELDS,
  apiKeyPatch,
  costRows,
  honorificsPatch,
  honorificsValue,
  maskApiKey,
  modelPatch,
  normalizeHostname,
  numericFieldPatch,
  numericFieldValue,
  parseNumericField,
  sanitizeFontBounds,
  siteRulePatch,
  siteRuleRows,
} from "../../src/options/optionsLogic";
import type { CostStats } from "../../src/background/costTracker";

function settings(patch: object = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

describe("optionsLogic — parseNumericField", () => {
  it("parses and passes through in-range values", () => {
    expect(parseNumericField("concurrency", "4")).toBe(4);
    expect(parseNumericField("jpegQuality", "0.8")).toBe(0.8);
  });

  it("clamps out-of-range values to the field bounds", () => {
    expect(parseNumericField("concurrency", "999")).toBe(NUMERIC_FIELDS.concurrency.max);
    expect(parseNumericField("concurrency", "0")).toBe(NUMERIC_FIELDS.concurrency.min);
    expect(parseNumericField("jpegQuality", "70")).toBe(NUMERIC_FIELDS.jpegQuality.max);
  });

  it("rounds integer fields and keeps floats at 2 decimals", () => {
    expect(parseNumericField("prefetchAhead", "2.7")).toBe(3);
    expect(parseNumericField("temperature", "0.256")).toBe(0.26);
  });

  it("returns undefined for garbage so the form can revert", () => {
    expect(parseNumericField("concurrency", "")).toBeUndefined();
    expect(parseNumericField("concurrency", "abc")).toBeUndefined();
    expect(parseNumericField("concurrency", "NaN")).toBeUndefined();
  });
});

describe("optionsLogic — numeric field value/patch mapping", () => {
  it("reads top-level and font-nested fields from the right place", () => {
    const s = settings({ concurrency: 3, font: { minSizePx: 12 } });
    expect(numericFieldValue(s, "concurrency")).toBe(3);
    expect(numericFieldValue(s, "minSizePx")).toBe(12);
  });

  it("builds top-level patches for top-level fields and font patches for font fields", () => {
    expect(numericFieldPatch("cacheCapMb", 100)).toEqual({ cacheCapMb: 100 });
    expect(numericFieldPatch("bubbleFillOpacity", 0.5)).toEqual({
      font: { bubbleFillOpacity: 0.5 },
    });
    // Round-trip: every field's patch applies to where its value is read from.
    for (const id of Object.keys(NUMERIC_FIELDS) as (keyof typeof NUMERIC_FIELDS)[]) {
      const spec = NUMERIC_FIELDS[id] as { min: number };
      const next = mergeSettings(settings(), numericFieldPatch(id, spec.min));
      expect(numericFieldValue(next, id)).toBe(spec.min);
    }
  });
});

describe("optionsLogic — sanitizeFontBounds", () => {
  it("keeps an already-ordered pair", () => {
    expect(sanitizeFontBounds(10, 28, "min")).toEqual({ minSizePx: 10, maxSizePx: 28 });
  });

  it("the edited bound wins and drags the other along", () => {
    expect(sanitizeFontBounds(30, 28, "min")).toEqual({ minSizePx: 30, maxSizePx: 30 });
    expect(sanitizeFontBounds(30, 28, "max")).toEqual({ minSizePx: 28, maxSizePx: 28 });
  });
});

describe("optionsLogic — API key helpers (§7.6)", () => {
  it("masks keys without leaking the middle; short keys are fully hidden", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("shortkey")).toBe("••••••••");
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
    expect(maskApiKey("sk-abcdefghijklmnop")).not.toContain("cdefghijkl");
  });

  it("apiKeyPatch stores trimmed keys and null-deletes empties", () => {
    expect(apiKeyPatch("gemini", "  k1  ")).toEqual({ apiKeys: { gemini: "k1" } });
    expect(apiKeyPatch("gemini", "   ")).toEqual({ apiKeys: { gemini: null } });
  });

  it("modelPatch mirrors the same shape for models", () => {
    expect(modelPatch("openai", " gpt-4o ")).toEqual({ models: { openai: "gpt-4o" } });
    expect(modelPatch("openai", "")).toEqual({ models: { openai: null } });
  });
});

describe("optionsLogic — normalizeHostname (F15)", () => {
  it("accepts bare hosts, URLs, and host+path; lowercases", () => {
    expect(normalizeHostname("Reader.Example.com")).toBe("reader.example.com");
    expect(normalizeHostname("https://Reader.example.com/ch/1?p=2")).toBe("reader.example.com");
    expect(normalizeHostname("example.com/some/path")).toBe("example.com");
    expect(normalizeHostname("localhost:8080")).toBe("localhost");
  });

  it("rejects empties, spaces, and non-web schemes", () => {
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("   ")).toBeNull();
    expect(normalizeHostname("not a host")).toBeNull();
    expect(normalizeHostname("ftp://example.com")).toBeNull();
  });
});

describe("optionsLogic — site rules", () => {
  it("siteRulePatch sets or null-deletes one rule", () => {
    expect(siteRulePatch("a.com", true)).toEqual({ perSiteOverrides: { "a.com": true } });
    expect(siteRulePatch("a.com", null)).toEqual({ perSiteOverrides: { "a.com": null } });
  });

  it("siteRuleRows sorts by hostname", () => {
    const s = settings({ perSiteOverrides: { "z.com": true, "a.com": false } });
    expect(siteRuleRows(s)).toEqual([
      { hostname: "a.com", enabled: false },
      { hostname: "z.com", enabled: true },
    ]);
  });
});

describe("optionsLogic — honorifics select mapping", () => {
  it("round-trips keep/localize onto the stored boolean", () => {
    expect(honorificsValue(settings({ preserveHonorifics: true }))).toBe("keep");
    expect(honorificsValue(settings({ preserveHonorifics: false }))).toBe("localize");
    expect(honorificsPatch("keep")).toEqual({ preserveHonorifics: true });
    expect(honorificsPatch("localize")).toEqual({ preserveHonorifics: false });
  });
});

describe("optionsLogic — costRows (F17)", () => {
  it("emits only providers with usage, in display order", () => {
    const stats: CostStats = {
      byProvider: {
        openai: { calls: 1, images: 1, tokensIn: 1, tokensOut: 1, estCostUsd: 0.1 },
        gemini: { calls: 2, images: 3, tokensIn: 4, tokensOut: 5, estCostUsd: 0.2 },
      },
      totalEstCostUsd: 0.3,
      updatedAt: 1,
    };
    const rows = costRows(stats);
    expect(rows.map((r) => r.provider)).toEqual(["openai", "gemini"]);
    expect(rows[1]).toMatchObject({ provider: "gemini", images: 3 });
    expect(costRows({ byProvider: {}, totalEstCostUsd: 0, updatedAt: 0 })).toEqual([]);
  });
});
