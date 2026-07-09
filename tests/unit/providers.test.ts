import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../../src/background/providers/gemini";
import {
  AnthropicProvider,
  resetSamplingMemo,
} from "../../src/background/providers/anthropic";
import {
  OPENAI_BASE_URL,
  createOpenAiProvider,
  resetEndpointModes,
} from "../../src/background/providers/openai";
import {
  OPENROUTER_BASE_URL,
  createOpenRouterProvider,
} from "../../src/background/providers/openrouter";
import { createProvider } from "../../src/background/providers/factory";
import { ProviderError } from "../../src/background/providers/ProviderBase";
import type {
  ProviderSettings,
  TranslateJob,
  Translator,
} from "../../src/shared/types";

function makeSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    provider: "gemini",
    apiKey: "key-123",
    model: "some-model",
    targetLang: "en",
    readingDirection: "auto",
    preserveHonorifics: true,
    translateSfx: false,
    temperature: 0.25,
    ...overrides,
  };
}

function makeJob(): TranslateJob {
  return {
    imageHash: "h",
    imageBlob: new Blob([new Uint8Array([9, 8, 7])], { type: "image/jpeg" }),
    targetLang: "en",
    priority: 0,
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

/** The parsed body of the Nth fetch call. */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[n] as [string, RequestInit];
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

/** The headers of the Nth fetch call. */
function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, string> {
  const call = fetchMock.mock.calls[n] as [string, RequestInit];
  return call[1].headers as Record<string, string>;
}

const VALID_PAGE = {
  source_lang: "ja",
  regions: [{ bbox: [0.1, 0.1, 0.2, 0.15], original: "やあ", translated: "Hey", is_sfx: false }],
};

async function run(provider: Translator, settings = makeSettings()) {
  return provider.translatePage(makeJob(), settings, new AbortController().signal);
}

// The adapters memoize per-endpoint/per-model quirks at module level (event-page
// lifetime); clear between tests so cases stay independent.
beforeEach(() => {
  resetEndpointModes();
  resetSamplingMemo();
});

describe("GeminiProvider", () => {
  it("posts to generateContent with the schema (additionalProperties stripped) and parses candidates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAGE) }] } }] }),
    );
    const provider = new GeminiProvider("gemini", { fetchFn: fetchMock });
    const page = await run(provider);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("models/some-model:generateContent");
    expect(requestHeaders(fetchMock)["x-goog-api-key"]).toBe("key-123");

    const body = requestBody(fetchMock);
    expect(body.systemInstruction).toBeDefined();
    const genConfig = body.generationConfig as Record<string, unknown>;
    expect(genConfig.responseMimeType).toBe("application/json");
    // Gemini dialect: additionalProperties must be gone everywhere.
    expect(JSON.stringify(genConfig.responseSchema)).not.toContain("additionalProperties");

    expect(page.regions[0]?.translated).toBe("Hey");
  });

  it("maps a SAFETY finishReason to a refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ finishReason: "SAFETY" }] }));
    const provider = new GeminiProvider("gemini", { fetchFn: fetchMock });
    await expect(run(provider)).rejects.toMatchObject({ kind: "refusal" });
  });

  it("extracts token usage from usageMetadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAGE) }] } }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 },
      }),
    );
    const provider = new GeminiProvider("gemini", { fetchFn: fetchMock });
    const page = await run(provider);
    expect(page.tokensIn).toBe(900);
    expect(page.tokensOut).toBe(120);
  });
});

describe("OpenAiProvider", () => {
  it("posts json_schema strict mode with kind required + 'none' enum, and parses choices", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] }),
    );
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    const page = await run(provider, makeSettings({ provider: "openai" }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_BASE_URL}/chat/completions`);
    expect(requestHeaders(fetchMock).Authorization).toBe("Bearer key-123");

    const body = requestBody(fetchMock);
    const rf = body.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    const schemaStr = JSON.stringify(rf.json_schema.schema);
    expect(schemaStr).toContain('"none"'); // kind enum extended for strict mode
    expect(schemaStr).not.toContain("minimum"); // numeric keywords stripped

    expect(page.regions[0]?.translated).toBe("Hey");
  });

  it("downgrades to json_object once on a 400 that mentions response_format", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "unsupported response_format" }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] }),
      );
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    const page = await run(provider, makeSettings({ provider: "openai" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = requestBody(fetchMock, 1);
    expect((retryBody.response_format as { type: string }).type).toBe("json_object");
    // The schema is pasted into the system prompt on downgrade.
    const messages = retryBody.messages as { role: string; content: unknown }[];
    expect(String(messages[0]?.content)).toContain("schema");
    expect(page.regions).toHaveLength(1);
  });

  it("maps an OpenAI structured refusal to a refusal error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { refusal: "I can't help with that." } }] }),
    );
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    await expect(run(provider, makeSettings({ provider: "openai" }))).rejects.toMatchObject({
      kind: "refusal",
    });
  });

  it("remembers the downgraded mode per endpoint (PROMPTS §5.2)", async () => {
    const okBody = () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }],
      });
    // First provider instance: 400 → downgrade → success.
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "unsupported response_format" }, { status: 400 }),
      )
      .mockResolvedValueOnce(okBody());
    await run(createOpenAiProvider({ fetchFn: firstFetch }), makeSettings({ provider: "openai" }));

    // A FRESH instance for the same endpoint starts in json_object directly.
    const secondFetch = vi.fn().mockResolvedValue(okBody());
    await run(createOpenAiProvider({ fetchFn: secondFetch }), makeSettings({ provider: "openai" }));

    expect(secondFetch).toHaveBeenCalledTimes(1);
    const body = requestBody(secondFetch);
    expect((body.response_format as { type: string }).type).toBe("json_object");
  });

  it("extracts token usage from the usage block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }],
        usage: { prompt_tokens: 800, completion_tokens: 90 },
      }),
    );
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    const page = await run(provider, makeSettings({ provider: "openai" }));
    expect(page.tokensIn).toBe(800);
    expect(page.tokensOut).toBe(90);
  });
});

describe("AnthropicProvider", () => {
  it("forces the emit_translation tool and reads tool_use.input directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "emit_translation", input: VALID_PAGE }],
      }),
    );
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    const page = await run(provider, makeSettings({ provider: "anthropic" }));

    const headers = requestHeaders(fetchMock);
    expect(headers["x-api-key"]).toBe("key-123");
    expect(headers["anthropic-version"]).toBeDefined();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");

    const body = requestBody(fetchMock);
    expect((body.tool_choice as { name: string }).name).toBe("emit_translation");

    expect(page.regions[0]?.translated).toBe("Hey");
  });

  it("maps a refusal stop_reason to a refusal error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stop_reason: "refusal", content: [] }));
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    await expect(run(provider, makeSettings({ provider: "anthropic" }))).rejects.toMatchObject({
      kind: "refusal",
    });
  });

  it("sends temperature normally but drops it after a sampling-param 400 (Claude 4.6+)", async () => {
    const okBody = () =>
      jsonResponse({
        content: [{ type: "tool_use", name: "emit_translation", input: VALID_PAGE }],
      });
    // Newer models reject sampling params with a 400 naming the parameter.
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "temperature is not supported on this model" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(okBody());
    const provider = new AnthropicProvider("anthropic", { fetchFn: firstFetch });
    const page = await run(provider, makeSettings({ provider: "anthropic" }));
    expect(page.regions).toHaveLength(1);

    expect(firstFetch).toHaveBeenCalledTimes(2);
    expect(requestBody(firstFetch, 0)).toHaveProperty("temperature", 0.25);
    expect(requestBody(firstFetch, 1)).not.toHaveProperty("temperature");

    // The rejection is memoized per model: a FRESH instance omits it up front.
    const secondFetch = vi.fn().mockResolvedValue(okBody());
    await run(
      new AnthropicProvider("anthropic", { fetchFn: secondFetch }),
      makeSettings({ provider: "anthropic" }),
    );
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(requestBody(secondFetch)).not.toHaveProperty("temperature");
  });

  it("extracts token usage from the usage block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", name: "emit_translation", input: VALID_PAGE }],
        usage: { input_tokens: 1500, output_tokens: 200 },
      }),
    );
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    const page = await run(provider, makeSettings({ provider: "anthropic" }));
    expect(page.tokensIn).toBe(1500);
    expect(page.tokensOut).toBe(200);
  });
});

describe("OpenRouterProvider", () => {
  it("targets the OpenRouter base URL with attribution headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] }),
    );
    const provider = createOpenRouterProvider({ fetchFn: fetchMock });
    await run(provider, makeSettings({ provider: "openrouter" }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    const headers = requestHeaders(fetchMock);
    expect(headers["HTTP-Referer"]).toBeDefined();
    expect(headers["X-Title"]).toBe("MangaLens");
  });
});

describe("createProvider factory", () => {
  it("builds the right class per provider id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] }),
    );
    // Custom endpoint routes through the OpenAI wire format.
    const provider = createProvider(
      makeSettings({ provider: "custom", customEndpoint: "https://my.host/v1" }),
      { fetchFn: fetchMock },
    );
    await run(provider, makeSettings({ provider: "custom", customEndpoint: "https://my.host/v1" }));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my.host/v1/chat/completions");
  });

  it("throws when custom is selected with no endpoint", () => {
    expect(() =>
      createProvider(makeSettings({ provider: "custom", customEndpoint: "" })),
    ).toThrowError(ProviderError);
  });

  it("returns a Translator for every real provider id", () => {
    for (const id of ["gemini", "anthropic", "openai", "openrouter"] as const) {
      const provider = createProvider(makeSettings({ provider: id }));
      expect(typeof provider.translatePage).toBe("function");
    }
  });
});
