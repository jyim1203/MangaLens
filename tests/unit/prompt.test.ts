import { describe, expect, it } from "vitest";
import {
  REGION_SUFFIX,
  buildBatchUserText,
  buildPromptContext,
  buildSystemPrompt,
  buildUserText,
  languageName,
  toAnthropicBatchSchema,
  toAnthropicToolSchema,
  toGeminiBatchSchema,
  toGeminiSchema,
  toOpenAiBatchSchema,
  toOpenAiStrictSchema,
} from "../../src/background/providers/prompt";
import type { ProviderSettings } from "../../src/shared/types";

function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    provider: "gemini",
    apiKey: "k",
    model: "m",
    targetLang: "en",
    readingDirection: "rtl",
    preserveHonorifics: true,
    translateSfx: false,
    temperature: 0.25,
    ...overrides,
  };
}

describe("prompt — languageName", () => {
  it("resolves common codes to English names", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("ja")).toBe("Japanese");
  });

  it("appends the region tag for disambiguation", () => {
    expect(languageName("zh-TW")).toBe("Traditional Chinese (zh-TW)");
  });

  it("falls back to the raw code when even Intl can't resolve it", () => {
    // A structurally invalid tag makes Intl.DisplayNames.of throw → code returned.
    expect(languageName("123")).toBe("123");
  });
});

describe("prompt — buildSystemPrompt", () => {
  it("fills every slot (no {{...}} left) with target language + rules", () => {
    const sys = buildSystemPrompt(buildPromptContext(settings()));
    expect(sys).not.toMatch(/\{\{|\}\}/);
    expect(sys).toContain("English (en)");
    expect(sys).toContain("Preserve Japanese/Korean honorifics"); // keep
    expect(sys).toContain("right-to-left, top-to-bottom (Japanese manga order)."); // rtl
  });

  it("switches honorifics + reading-order text with settings", () => {
    const sys = buildSystemPrompt(
      buildPromptContext(settings({ preserveHonorifics: false, readingDirection: "ltr" })),
    );
    expect(sys).toContain("Convert honorifics"); // localize
    expect(sys).toContain("left-to-right, top-to-bottom.");
  });

  it("uses the Phase 9.5 whole-balloon per-kind bbox rule (corner format kept)", () => {
    const sys = buildSystemPrompt(buildPromptContext(settings()));
    expect(sys).toContain("[x_min, y_min, x_max, y_max]");
    expect(sys).toContain("x_max must be greater than x_min");
    // §1: bubbles/thoughts box the ENTIRE balloon; on-art text stays tight; one
    // box per balloon lobe.
    expect(sys).toContain("enclose the ENTIRE balloon");
    expect(sys).toContain("box the TEXT tightly");
    expect(sys).toContain("One box per balloon.");
    // The old tight-text-only rule is gone.
    expect(sys).not.toContain("tightly enclose the TEXT itself, not the entire bubble outline");
    // The old w/h wording is gone.
    expect(sys).not.toContain("[x, y, width, height]");
  });
});

describe("prompt — buildUserText", () => {
  it("omits the source hint when auto-detecting", () => {
    const text = buildUserText(buildPromptContext(settings()));
    expect(text).toBe("Translate this page to English.");
  });

  it("includes a source hint when the language is pinned", () => {
    const text = buildUserText(buildPromptContext(settings({ sourceLangHint: "ja" })));
    expect(text).toContain("The source language is Japanese.");
  });

  it("appends the repair nudge on the retry pass", () => {
    const text = buildUserText(buildPromptContext(settings()), { repair: true });
    expect(text).toContain("not valid JSON");
  });

  it("appends the §4.3 region suffix for a drag-select crop (F10)", () => {
    const text = buildUserText(buildPromptContext(settings()), { region: true });
    expect(text).toContain(REGION_SUFFIX);
    expect(text.startsWith("Translate this page to English.")).toBe(true);
  });

  it("region:false is byte-identical to no options (PROMPT_VERSION stability)", () => {
    const ctx = buildPromptContext(settings({ sourceLangHint: "ja" }));
    // The whole point: the Phase-7 addition must not change the cached-page
    // prompt at all, so the version stays 1 and cached translations stay valid.
    expect(buildUserText(ctx, { region: false })).toBe(buildUserText(ctx));
    expect(buildUserText(ctx, {})).toBe(buildUserText(ctx));
  });
});

describe("prompt — schema dialects", () => {
  it("Gemini dialect strips additionalProperties everywhere", () => {
    expect(JSON.stringify(toGeminiSchema())).not.toContain("additionalProperties");
  });

  it("OpenAI strict dialect requires kind (+ 'none') and drops numeric keywords", () => {
    const schema = toOpenAiStrictSchema();
    const region = schema.properties?.regions?.items;
    expect(region?.required).toContain("kind");
    expect(region?.properties?.kind?.enum).toContain("none");
    const str = JSON.stringify(schema);
    expect(str).not.toContain("minimum");
    expect(str).not.toContain("minItems");
    // additionalProperties: false is retained (strict mode demands it).
    expect(str).toContain("additionalProperties");
  });

  it("Anthropic dialect keeps the canonical schema intact (kind optional)", () => {
    const schema = toAnthropicToolSchema();
    const region = schema.properties?.regions?.items;
    expect(region?.required).not.toContain("kind");
    expect(JSON.stringify(schema)).toContain("additionalProperties");
  });

  it("all three dialects carry the corner-format bbox description through (Phase 7.4)", () => {
    for (const schema of [toGeminiSchema(), toOpenAiStrictSchema(), toAnthropicToolSchema()]) {
      const desc = schema.properties?.regions?.items?.properties?.bbox?.description ?? "";
      expect(desc).toContain("[x_min, y_min, x_max, y_max]");
      expect(desc).not.toContain("width, height");
    }
  });
});

describe("prompt — buildBatchUserText (§4.2, F12)", () => {
  it("uses the verbatim §4.2 text with the page count + pages-array instruction", () => {
    const text = buildBatchUserText(buildPromptContext(settings()), 3);
    expect(text).toContain("Translate these 3 pages to English.");
    expect(text).toContain('top-level "pages" array of length 3');
    expect(text).toContain("pages[i] corresponds to image i (0-indexed)");
    expect(text).toContain("Bboxes are relative to that page's own dimensions.");
  });

  it("includes the source hint when pinned, omits it otherwise (no double space)", () => {
    const pinned = buildBatchUserText(buildPromptContext(settings({ sourceLangHint: "ja" })), 2);
    expect(pinned).toContain("The source language is Japanese.");
    const auto = buildBatchUserText(buildPromptContext(settings()), 2);
    expect(auto).toContain("Translate these 2 pages to English.\n");
    expect(auto).not.toContain("English. \n"); // trailing space trimmed
  });

  it("appends the repair nudge on the retry pass (the one whole-batch retry)", () => {
    const text = buildBatchUserText(buildPromptContext(settings()), 2, { repair: true });
    expect(text).toContain("not valid JSON");
  });
});

describe("prompt — batch schema dialects (§4.2)", () => {
  it("wraps each single-page dialect in a required top-level pages array", () => {
    for (const build of [toGeminiBatchSchema, toOpenAiBatchSchema, toAnthropicBatchSchema]) {
      const schema = build();
      expect(schema.required).toContain("pages");
      expect(schema.properties?.pages?.type).toBe("array");
      // The items ARE the single-page schema (has source_lang + regions).
      const item = schema.properties?.pages?.items;
      expect(item?.properties?.regions).toBeDefined();
      expect(item?.properties?.source_lang).toBeDefined();
    }
  });

  it("Gemini batch strips additionalProperties (wrapper + inner)", () => {
    expect(JSON.stringify(toGeminiBatchSchema())).not.toContain("additionalProperties");
  });

  it("OpenAI strict batch keeps additionalProperties:false and the strict inner rules", () => {
    const schema = toOpenAiBatchSchema();
    expect(schema.additionalProperties).toBe(false);
    const region = schema.properties?.pages?.items?.properties?.regions?.items;
    expect(region?.required).toContain("kind"); // strict inner dialect preserved
    expect(JSON.stringify(schema)).not.toContain("minItems");
  });

  it("carries the corner-format bbox description into the batch inner schema", () => {
    for (const build of [toGeminiBatchSchema, toOpenAiBatchSchema, toAnthropicBatchSchema]) {
      const desc =
        build().properties?.pages?.items?.properties?.regions?.items?.properties?.bbox
          ?.description ?? "";
      expect(desc).toContain("[x_min, y_min, x_max, y_max]");
    }
  });
});
