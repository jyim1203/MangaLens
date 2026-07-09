import { describe, expect, it, vi } from "vitest";
import {
  ProviderBase,
  type BuildContext,
  type ProviderBaseOptions,
  type ProviderOutput,
  type ProviderRequest,
} from "../../src/background/providers/ProviderBase";
import type { ProviderSettings, TranslateJob } from "../../src/shared/types";

/**
 * A concrete provider for testing the shared engine. Its `extractOutput` simply
 * returns whatever ProviderOutput the (mocked) response body carries, so a test
 * controls the pipeline input directly. It records the userText of every built
 * request so the repair retry can be asserted.
 */
class TestProvider extends ProviderBase {
  protected readonly defaultModel = "test-model";
  readonly userTexts: string[] = [];
  readonly modes: string[] = [];
  readonly temperatures: (number | undefined)[] = [];

  protected buildRequest(ctx: BuildContext): ProviderRequest {
    this.userTexts.push(ctx.userText);
    this.modes.push(ctx.mode);
    this.temperatures.push(ctx.temperature);
    return {
      url: "https://test.example/api",
      headers: { Authorization: `Bearer ${ctx.settings.apiKey}` },
      body: { model: ctx.model },
    };
  }

  protected extractOutput(responseJson: unknown): ProviderOutput {
    return responseJson as ProviderOutput;
  }
}

function makeSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "test-model",
    targetLang: "en",
    readingDirection: "auto",
    preserveHonorifics: true,
    translateSfx: false,
    temperature: 0.25,
    ...overrides,
  };
}

function makeJob(overrides: Partial<TranslateJob> = {}): TranslateJob {
  return {
    imageHash: "hash123",
    imageBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }),
    targetLang: "en",
    priority: 0,
    ...overrides,
  };
}

/** A JSON Response as global fetch would resolve. */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

/** A ProviderOutput carrying a valid single-region page. */
const VALID_OUTPUT: ProviderOutput = {
  kind: "json",
  value: {
    source_lang: "ja",
    regions: [
      { bbox: [0.1, 0.1, 0.2, 0.15], original: "やあ", translated: "Hey", is_sfx: false },
    ],
  },
};

/** Build a provider with an injected fetch (and instant sleep). */
function makeProvider(
  fetchFn: typeof fetch,
  extra: ProviderBaseOptions = {},
): { provider: TestProvider; sleeps: number[] } {
  const sleeps: number[] = [];
  const provider = new TestProvider("openai", {
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { provider, sleeps };
}

describe("ProviderBase — translatePage happy path", () => {
  it("returns a PageTranslation from a valid response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_OUTPUT));
    const { provider } = makeProvider(fetchMock);

    const page = await provider.translatePage(
      makeJob(),
      makeSettings(),
      new AbortController().signal,
    );

    expect(page.regions).toHaveLength(1);
    expect(page.regions[0]?.translated).toBe("Hey");
    expect(page.sourceLang).toBe("ja");
    expect(page.provider).toBe("openai");
    expect(page.model).toBe("test-model");
    expect(page.imageHash).toBe("hash123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes provider-reported token usage through to the PageTranslation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...VALID_OUTPUT,
        usage: { tokensIn: 1234, tokensOut: 56 },
      }),
    );
    const { provider } = makeProvider(fetchMock);

    const page = await provider.translatePage(
      makeJob(),
      makeSettings(),
      new AbortController().signal,
    );

    expect(page.tokensIn).toBe(1234);
    expect(page.tokensOut).toBe(56);
  });

  it("sends the settings temperature on the primary request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_OUTPUT));
    const { provider } = makeProvider(fetchMock);

    await provider.translatePage(
      makeJob(),
      makeSettings({ temperature: 0.3 }),
      new AbortController().signal,
    );

    expect(provider.temperatures).toEqual([0.3]);
  });

  it("remaps tile-local bboxes into full-image space when tileOffset is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "json",
        value: {
          source_lang: "ja",
          regions: [{ bbox: [0, 0, 0.2, 0.2], original: "x", translated: "X", is_sfx: false }],
        },
      }),
    );
    const { provider } = makeProvider(fetchMock);

    const page = await provider.translatePage(
      makeJob({ tileOffset: { x: 0, y: 0.5, w: 1, h: 0.5 } }),
      makeSettings(),
      new AbortController().signal,
    );

    // y lifted by the tile's y-offset (0.5), h scaled by the tile height (0.5).
    expect(page.regions[0]?.bbox).toEqual({ x: 0, y: 0.5, w: 0.2, h: 0.1 });
  });
});

describe("ProviderBase — auth / abort guards (before any fetch)", () => {
  it("throws auth without calling fetch when no API key is set", async () => {
    const fetchMock = vi.fn();
    const { provider } = makeProvider(fetchMock);
    await expect(
      provider.translatePage(
        makeJob(),
        makeSettings({ apiKey: "" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws aborted without calling fetch when the signal already fired", async () => {
    const fetchMock = vi.fn();
    const { provider } = makeProvider(fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.translatePage(makeJob(), makeSettings(), controller.signal),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ProviderBase — HTTP error mapping", () => {
  it("maps 401 to auth and does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 }));
    const { provider } = makeProvider(fetchMock);
    await expect(
      provider.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 5xx to network", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 }));
    const { provider } = makeProvider(fetchMock);
    await expect(
      provider.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "network", status: 503 });
  });

  it("maps a fetch throw to network and an AbortError to aborted", async () => {
    const netMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { provider: p1 } = makeProvider(netMock);
    await expect(
      p1.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "network" });

    const abortMock = vi.fn().mockRejectedValue(new DOMException("x", "AbortError"));
    const { provider: p2 } = makeProvider(abortMock);
    await expect(
      p2.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("surfaces a provider refusal without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "refusal", message: "declined" }));
    const { provider } = makeProvider(fetchMock);
    await expect(
      provider.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "refusal" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderBase — rate-limit backoff", () => {
  it("retries 429s on the backoff ladder then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(VALID_OUTPUT));
    const { provider, sleeps } = makeProvider(fetchMock, {
      backoffMs: [2000, 8000, 30000],
    });

    const page = await provider.translatePage(
      makeJob(),
      makeSettings(),
      new AbortController().signal,
    );

    expect(page.regions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 8000]);
  });

  it("honors a retry-after header over the fixed ladder", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { "retry-after": "5" } }),
      )
      .mockResolvedValueOnce(jsonResponse(VALID_OUTPUT));
    const { provider, sleeps } = makeProvider(fetchMock);

    await provider.translatePage(makeJob(), makeSettings(), new AbortController().signal);
    expect(sleeps).toEqual([5000]);
  });

  it("caps an absurd retry-after at MAX_RETRY_AFTER_MS (edge: hour-long header)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { "retry-after": "3600" } }),
      )
      .mockResolvedValueOnce(jsonResponse(VALID_OUTPUT));
    const { provider, sleeps } = makeProvider(fetchMock);

    await provider.translatePage(makeJob(), makeSettings(), new AbortController().signal);
    expect(sleeps).toEqual([60_000]);
  });

  it("treats a 529 overloaded response like a rate limit and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 529 }))
      .mockResolvedValueOnce(jsonResponse(VALID_OUTPUT));
    const { provider, sleeps } = makeProvider(fetchMock);

    const page = await provider.translatePage(
      makeJob(),
      makeSettings(),
      new AbortController().signal,
    );

    expect(page.regions).toHaveLength(1);
    expect(sleeps).toEqual([2000]); // first ladder step
  });

  it("gives up after exhausting the ladder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 }));
    const { provider, sleeps } = makeProvider(fetchMock, { backoffMs: [10, 20] });
    await expect(
      provider.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "rate-limit" });
    // 2 backoff waits, then a 3rd failing attempt with no wait left.
    expect(sleeps).toEqual([10, 20]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("ProviderBase — malformed repair retry", () => {
  it("retries once with a repair nudge when the first response is malformed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ kind: "text", value: "not json at all" }))
      .mockResolvedValueOnce(jsonResponse(VALID_OUTPUT));
    const { provider } = makeProvider(fetchMock);

    const page = await provider.translatePage(
      makeJob(),
      makeSettings(),
      new AbortController().signal,
    );

    expect(page.regions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second request carried the repair instruction at temperature 0
    // (PROMPTS.md §6.4: deterministic repair pass).
    expect(provider.userTexts).toHaveLength(2);
    expect(provider.userTexts[1]).toContain("not valid JSON");
    expect(provider.temperatures).toEqual([0.25, 0]);
  });

  it("propagates malformed when the repair attempt also fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "text", value: "still garbage" }));
    const { provider } = makeProvider(fetchMock);

    await expect(
      provider.translatePage(makeJob(), makeSettings(), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one primary + one repair
  });
});
