import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// openai.ts → endpointModes.ts (Phase 8 §4 persistence) → webextension-polyfill,
// which throws at import outside a browser; swap it for the fake.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import { GeminiProvider } from "../../src/background/providers/gemini";
import {
  AnthropicProvider,
  resetSamplingMemo,
} from "../../src/background/providers/anthropic";
import {
  SAMPLING_REJECT_KEY,
  loadSamplingMemo,
} from "../../src/background/endpointModes";
import {
  OPENAI_BASE_URL,
  createOpenAiProvider,
  resetEndpointModes,
} from "../../src/background/providers/openai";
import {
  OPENROUTER_BASE_URL,
  createOpenRouterProvider,
} from "../../src/background/providers/openrouter";
import {
  createProvider,
  resolveEffectiveModel,
} from "../../src/background/providers/factory";
import {
  DEFAULT_MODELS,
  ProviderError,
} from "../../src/background/providers/ProviderBase";
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

// The adapters memoize per-endpoint/per-model quirks in the persisted memos;
// clear memo + backing storage between tests so cases stay independent.
beforeEach(async () => {
  resetEndpointModes();
  resetSamplingMemo();
  await fakeBrowser.storage.local.clear();
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

  it("drops temperature after a 400 that names it, then memoizes per model (gpt-5.x/o-series)", async () => {
    const okBody = () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] });
    // Reasoning models 400 with: temperature does not support 0.25 ... only the default (1).
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message:
                "Unsupported value: 'temperature' does not support 0.25 with this model. Only the default (1) value is supported.",
              code: "unsupported_value",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(okBody());
    const page = await run(
      createOpenAiProvider({ fetchFn: firstFetch }),
      makeSettings({ provider: "openai" }),
    );
    expect(page.regions).toHaveLength(1);
    expect(firstFetch).toHaveBeenCalledTimes(2);
    expect(requestBody(firstFetch, 0)).toHaveProperty("temperature", 0.25);
    expect(requestBody(firstFetch, 1)).not.toHaveProperty("temperature");

    // Memoized per model: a FRESH instance omits temperature up front, no re-paid 400.
    const secondFetch = vi.fn().mockResolvedValue(okBody());
    await run(createOpenAiProvider({ fetchFn: secondFetch }), makeSettings({ provider: "openai" }));
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(requestBody(secondFetch)).not.toHaveProperty("temperature");
  });

  it("recovers EVERY concurrent request from a temperature-400, not just the learn-race winner", async () => {
    // The concurrency-N first wave all build with temperature before any sibling
    // has learned the model rejects it, so all 400 together. The shared memo is
    // set synchronously by the first to recover; the retry must NOT be gated on
    // it or the other siblings skip their retry and blank permanently (the live
    // HAR: 5 of 6 first-wave pages 400'd and never retried). Body-keyed mock: any
    // request carrying `temperature` 400s; the retry (temperature dropped) succeeds.
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      if ("temperature" in body) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                message:
                  "Unsupported value: 'temperature' does not support 0.25 with this model. Only the default (1) value is supported.",
                code: "unsupported_value",
              },
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PAGE) } }] }),
      );
    });
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    const results = await Promise.all([
      run(provider, makeSettings({ provider: "openai" })),
      run(provider, makeSettings({ provider: "openai" })),
    ]);
    // BOTH pages translated (before the fix the second rejected with the raw 400).
    expect(results[0].regions).toHaveLength(1);
    expect(results[1].regions).toHaveLength(1);
    // Each page: one rejected initial send + one temperature-dropped retry.
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it("recovers EVERY concurrent request from a sampling-param 400 (shared memo race)", async () => {
    // Same race as the OpenAI path: concurrent requests all send temperature and
    // 400 together; the first to recover flips the shared memo, so the retry must
    // key off what THIS request sent, not the memo, or the siblings blank.
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      if ("temperature" in body) {
        return Promise.resolve(
          jsonResponse(
            { error: { message: "temperature is not supported on this model" } },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({
          content: [{ type: "tool_use", name: "emit_translation", input: VALID_PAGE }],
        }),
      );
    });
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    const results = await Promise.all([
      run(provider, makeSettings({ provider: "anthropic" })),
      run(provider, makeSettings({ provider: "anthropic" })),
    ]);
    expect(results[0].regions).toHaveLength(1);
    expect(results[1].regions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honors a sampling rejection persisted by a PREVIOUS event-page lifetime", async () => {
    // The memo is keyed by the resolved model (makeSettings → "some-model").
    await fakeBrowser.storage.local.set({
      [SAMPLING_REJECT_KEY]: { "some-model": true },
    });
    resetSamplingMemo(); // fresh event-page lifetime — memo empty, un-hydrated
    await loadSamplingMemo(); // the background/index.ts startup hydrate

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", name: "emit_translation", input: VALID_PAGE }],
      }),
    );
    await run(
      new AnthropicProvider("anthropic", { fetchFn: fetchMock }),
      makeSettings({ provider: "anthropic" }),
    );
    // No re-paid 400: ONE request, temperature omitted up front.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock)).not.toHaveProperty("temperature");
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

describe("resolveEffectiveModel", () => {
  it("returns the explicit model when the user picked one", () => {
    expect(resolveEffectiveModel(makeSettings({ provider: "gemini", model: "gemini-1.5-pro" }))).toBe(
      "gemini-1.5-pro",
    );
  });

  it("falls back to the per-provider default when model is empty", () => {
    for (const id of ["gemini", "anthropic", "openai", "openrouter"] as const) {
      expect(resolveEffectiveModel(makeSettings({ provider: id, model: "" }))).toBe(
        DEFAULT_MODELS[id],
      );
    }
  });

  it("keeps '' for a custom endpoint with no model set", () => {
    expect(resolveEffectiveModel(makeSettings({ provider: "custom", model: "" }))).toBe("");
  });

  it("resolves default-settings gemini to the same model as an explicit pick (item 3)", () => {
    // The cache key would therefore match — no needless re-translation when the
    // user explicitly selects the model that is already the default.
    const fromDefault = resolveEffectiveModel(makeSettings({ provider: "gemini", model: "" }));
    const fromExplicit = resolveEffectiveModel(
      makeSettings({ provider: "gemini", model: "gemini-2.0-flash" }),
    );
    expect(fromDefault).toBe(fromExplicit);
    expect(fromDefault).toBe(DEFAULT_MODELS.gemini);
  });
});

describe("per-adapter batch request shape (F12, §4.2)", () => {
  /** N single-tile jobs (distinct hashes). */
  function batchJobs(n: number): TranslateJob[] {
    return Array.from({ length: n }, (_, i) => ({
      imageHash: `h${i}`,
      imageBlob: new Blob([new Uint8Array([i])], { type: "image/jpeg" }),
      targetLang: "en",
      priority: 2,
    }));
  }

  /** A minimal valid batch body with `n` pages. */
  function batchPages(n: number) {
    return {
      pages: Array.from({ length: n }, () => ({
        source_lang: "ja",
        regions: [{ bbox: [0.1, 0.1, 0.2, 0.2], original: "x", translated: "X", is_sfx: false }],
      })),
    };
  }

  it("Gemini batch: N inline_data image parts + the batch schema (pages array)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(batchPages(3)) }] } }],
      }),
    );
    const provider = new GeminiProvider("gemini", { fetchFn: fetchMock });
    const pages = await provider.translateBatch(batchJobs(3), makeSettings(), new AbortController().signal);

    expect(pages).toHaveLength(3);
    const body = requestBody(fetchMock);
    const parts = (body.contents as { parts: { inline_data?: unknown }[] }[])[0]!.parts;
    expect(parts.filter((p) => p.inline_data).length).toBe(3); // 3 image parts
    const schema = JSON.stringify((body.generationConfig as Record<string, unknown>).responseSchema);
    expect(schema).toContain('"pages"');
  });

  it("OpenAI batch: N image_url blocks + a batch json_schema response_format", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify(batchPages(2)) } }] }),
    );
    const provider = createOpenAiProvider({ fetchFn: fetchMock });
    const pages = await provider.translateBatch(
      batchJobs(2),
      makeSettings({ provider: "openai" }),
      new AbortController().signal,
    );

    expect(pages).toHaveLength(2);
    const body = requestBody(fetchMock);
    const content = (body.messages as { role: string; content: { type: string }[] }[])[1]!.content;
    expect(content.filter((b) => b.type === "image_url").length).toBe(2);
    expect(JSON.stringify(body.response_format)).toContain('"pages"');
  });

  it("Anthropic batch: N image content blocks + the batch tool input_schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", name: "emit_translation", input: batchPages(2) }],
      }),
    );
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    const pages = await provider.translateBatch(
      batchJobs(2),
      makeSettings({ provider: "anthropic" }),
      new AbortController().signal,
    );

    expect(pages).toHaveLength(2);
    const body = requestBody(fetchMock);
    const content = (body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.filter((b) => b.type === "image").length).toBe(2);
    const tools = body.tools as { input_schema: unknown }[];
    expect(JSON.stringify(tools[0]!.input_schema)).toContain('"pages"');
    // The output cap scales with the page count (a batch's output is ~N pages'
    // worth of regions — the flat single-page cap truncated dense batches).
    expect(body).toHaveProperty("max_tokens", 8192 * 2);
  });

  it("Anthropic batch: scaled max_tokens is capped at 32000 (oldest active model limit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", name: "emit_translation", input: batchPages(4) }],
      }),
    );
    const provider = new AnthropicProvider("anthropic", { fetchFn: fetchMock });
    await provider.translateBatch(
      batchJobs(4),
      makeSettings({ provider: "anthropic" }),
      new AbortController().signal,
    );
    // 4 × 8192 = 32768 would fail max_tokens validation on legacy Opus 4.1.
    expect(requestBody(fetchMock)).toHaveProperty("max_tokens", 32000);
  });
});
