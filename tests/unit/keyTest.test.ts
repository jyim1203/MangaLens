import { describe, expect, it, vi } from "vitest";
import {
  buildKeyTestRequest,
  classifyKeyTestResponse,
  createKeyTestHandlers,
  runKeyTest,
} from "../../src/background/providers/keyTest";

function response(status: number, body = ""): Response {
  return new Response(body || null, { status });
}

describe("keyTest — buildKeyTestRequest (per-provider ping shape)", () => {
  it("gemini pings the models list with the x-goog-api-key header", () => {
    const req = buildKeyTestRequest("gemini", "g-key");
    expect(req.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    expect(req.headers["x-goog-api-key"]).toBe("g-key");
  });

  it("anthropic pings /v1/models with version + browser-access headers", () => {
    const req = buildKeyTestRequest("anthropic", "a-key");
    expect(req.url).toBe("https://api.anthropic.com/v1/models");
    expect(req.headers["x-api-key"]).toBe("a-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe(
      "true",
    );
  });

  it("openai pings /models with a Bearer token", () => {
    const req = buildKeyTestRequest("openai", "sk-1");
    expect(req.url).toBe("https://api.openai.com/v1/models");
    expect(req.headers.Authorization).toBe("Bearer sk-1");
  });

  it("openrouter pings /key (its /models list is public and would accept any key)", () => {
    const req = buildKeyTestRequest("openrouter", "or-1");
    expect(req.url).toBe("https://openrouter.ai/api/v1/key");
    expect(req.headers.Authorization).toBe("Bearer or-1");
  });

  it("custom pings {endpoint}/models, trimming trailing slashes", () => {
    const req = buildKeyTestRequest("custom", "k", "https://llm.local/v1///");
    expect(req.url).toBe("https://llm.local/v1/models");
    expect(req.headers.Authorization).toBe("Bearer k");
  });

  it("custom without an endpoint throws a user-facing message", () => {
    expect(() => buildKeyTestRequest("custom", "k")).toThrow(/endpoint/i);
    expect(() => buildKeyTestRequest("custom", "k", "   ")).toThrow(/endpoint/i);
  });
});

describe("keyTest — classifyKeyTestResponse", () => {
  it("2xx is ok", () => {
    expect(classifyKeyTestResponse("openai", 200, "")).toEqual({ ok: true });
  });

  it("401/403 map to auth", () => {
    for (const status of [401, 403]) {
      const res = classifyKeyTestResponse("anthropic", status, "");
      expect(res.ok).toBe(false);
      expect(res.errorKind).toBe("auth");
    }
  });

  it("gemini's 400 API_KEY_INVALID quirk maps to auth, other 400s stay unknown", () => {
    const invalid = classifyKeyTestResponse(
      "gemini",
      400,
      '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid."}}',
    );
    expect(invalid.errorKind).toBe("auth");

    const other = classifyKeyTestResponse("gemini", 400, "bad request");
    expect(other.errorKind).toBe("unknown");

    // The quirk is gemini-specific: a 400 mentioning "api key" elsewhere is not auth.
    const openai = classifyKeyTestResponse("openai", 400, "api key stuff");
    expect(openai.errorKind).toBe("unknown");
  });

  it("429 reports rate-limit and says the key itself may be valid", () => {
    const res = classifyKeyTestResponse("openai", 429, "");
    expect(res.errorKind).toBe("rate-limit");
    expect(res.message).toMatch(/quota|rate/i);
  });

  it("5xx maps to network; other statuses carry a body snippet", () => {
    expect(classifyKeyTestResponse("gemini", 503, "").errorKind).toBe(
      "network",
    );
    const odd = classifyKeyTestResponse("gemini", 418, "  I'm a\n teapot  ");
    expect(odd.errorKind).toBe("unknown");
    expect(odd.message).toContain("I'm a teapot");
  });
});

describe("keyTest — runKeyTest (thin shell, never rejects)", () => {
  it("happy path: 200 → ok, GET with the built headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200));
    const res = await runKeyTest(
      { provider: "openai", apiKey: " sk-x " },
      fetchFn,
    );
    expect(res).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer sk-x"); // trimmed
  });

  it("empty key short-circuits to auth without any network call", async () => {
    const fetchFn = vi.fn();
    const res = await runKeyTest({ provider: "gemini", apiKey: "  " }, fetchFn);
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("auth");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("custom with a malformed endpoint fails as data, not a rejection", async () => {
    const fetchFn = vi.fn();
    const res = await runKeyTest(
      { provider: "custom", apiKey: "k", customEndpoint: "not a url" },
      fetchFn,
    );
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("unknown");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a network throw maps to the network kind", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline"));
    const res = await runKeyTest({ provider: "gemini", apiKey: "k" }, fetchFn);
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("network");
  });

  it("failure statuses read the body for the diagnostic snippet", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(response(400, "API key not valid"));
    const res = await runKeyTest({ provider: "gemini", apiKey: "bad" }, fetchFn);
    expect(res.errorKind).toBe("auth");
  });
});

describe("keyTest — createKeyTestHandlers", () => {
  it("routes the testApiKey message through runKeyTest", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(401));
    const handlers = createKeyTestHandlers(fetchFn);
    const res = await handlers.testApiKey!(
      { provider: "anthropic", apiKey: "nope" },
      {} as never,
    );
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("auth");
  });
});
