import { describe, expect, it } from "vitest";
import {
  REGION_SUFFIX,
  buildPromptContext,
  buildSystemPrompt,
  buildUserText,
  languageName,
  toAnthropicToolSchema,
  toGeminiSchema,
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
});
