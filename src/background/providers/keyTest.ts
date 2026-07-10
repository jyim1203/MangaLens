/**
 * API-key validation for the options page "Test key" button (§7.6, F2).
 *
 * Strategy: hit each provider's cheapest *authenticated* endpoint with a GET —
 * a model-list (or OpenRouter's key-info) request costs zero tokens, needs no
 * image, and fails with the same auth semantics as a real translation call.
 * This is even cheaper than the architecture's "1-token ping".
 *
 * Split per the repo rule:
 *  - PURE, unit-tested: {@link buildKeyTestRequest} (which URL/headers per
 *    provider) and {@link classifyKeyTestResponse} (status/body →
 *    {@link TestKeyResult}, including Gemini's 400-for-bad-key quirk);
 *  - THIN shell: {@link runKeyTest} (the fetch + timeout), which NEVER rejects —
 *    a failure is data ({@link TestKeyResult}), because a rejected message
 *    would be serialized down to a bare string at the runtime.sendMessage
 *    boundary and lose its kind (same reason as TranslatePageResult).
 */
import type { MessageHandlers, TestKeyResult } from "../../shared/messages";
import type { ProviderId } from "../../shared/types";
import { createLogger } from "../../shared/log";
import { GEMINI_BASE_URL } from "./gemini";
import { OPENAI_BASE_URL } from "./openai";
import { OPENROUTER_BASE_URL } from "./openrouter";

const log = createLogger("key-test");

/** Anthropic's model-list endpoint (its ANTHROPIC_URL export is /messages). */
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

/** Abort a hung key test after this long — the options page must not spin forever. */
export const KEY_TEST_TIMEOUT_MS = 15_000;

/** A fully-built key-test request (always a GET, so no body). */
export interface KeyTestRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the cheap authenticated GET that validates a key for `provider`.
 *
 * WHY per provider:
 *  - gemini/openai/custom: `GET {base}/models` — authenticated, token-free.
 *  - openrouter: `GET /key` — its `/models` list is PUBLIC (no auth), so it
 *    would accept any garbage key; `/key` returns the key's own metadata.
 *  - anthropic: `GET /v1/models` with the same headers a real call uses,
 *    including `anthropic-dangerous-direct-browser-access` (browser-origin
 *    calls are rejected without it, §7.6).
 *
 * @param provider the provider whose key is being tested.
 * @param apiKey the key to test (caller has already trimmed/validated non-empty).
 * @param customEndpoint OpenAI-compatible base URL; required for `custom`.
 * @throws {Error} for `custom` with no endpoint — callers surface the message.
 */
export function buildKeyTestRequest(
  provider: ProviderId,
  apiKey: string,
  customEndpoint?: string,
): KeyTestRequest {
  switch (provider) {
    case "gemini":
      return {
        url: `${GEMINI_BASE_URL}/models`,
        headers: { "x-goog-api-key": apiKey },
      };
    case "anthropic":
      return {
        url: ANTHROPIC_MODELS_URL,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      };
    case "openai":
      return {
        url: `${OPENAI_BASE_URL}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "openrouter":
      return {
        url: `${OPENROUTER_BASE_URL}/key`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "custom": {
      const base = customEndpoint?.trim().replace(/\/+$/, "");
      if (!base) {
        throw new Error("Set the custom endpoint URL before testing the key.");
      }
      return {
        url: `${base}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    }
  }
}

/** Trim a response body to a short diagnostic snippet for the options UI. */
function snippet(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Map a key-test HTTP response to a {@link TestKeyResult} (pure).
 *
 * Notable quirk: Gemini reports an invalid key as **HTTP 400** with an
 * `API_KEY_INVALID` reason, not 401 — a plain status map would call that
 * "unknown" and leave the user staring at a useless error.
 *
 * A 429/529 means auth *succeeded* but the account is throttled or out of
 * quota — the key itself may be fine, so the message says so instead of
 * pretending the key is bad.
 */
export function classifyKeyTestResponse(
  provider: ProviderId,
  status: number,
  bodyText: string,
): TestKeyResult {
  if (status >= 200 && status < 300) return { ok: true };

  if (status === 401 || status === 403) {
    return {
      ok: false,
      errorKind: "auth",
      message: `The provider rejected this key (HTTP ${status}).`,
    };
  }

  if (
    provider === "gemini" &&
    status === 400 &&
    /api[\s_]?key/i.test(bodyText)
  ) {
    return {
      ok: false,
      errorKind: "auth",
      message: "Google rejected this API key (API_KEY_INVALID).",
    };
  }

  if (status === 429 || status === 529) {
    return {
      ok: false,
      errorKind: "rate-limit",
      message:
        "The key authenticated but the account is rate-limited or out of quota — check your plan/billing.",
    };
  }

  if (status >= 500) {
    return {
      ok: false,
      errorKind: "network",
      message: `Provider server error (HTTP ${status}) — try again in a moment.`,
    };
  }

  return {
    ok: false,
    errorKind: "unknown",
    message: `HTTP ${status}: ${snippet(bodyText) || "unexpected response"}`,
  };
}

/**
 * Run one key test end to end. Never rejects — every failure comes back as a
 * `{ ok: false }` {@link TestKeyResult} so the options page can render it and
 * the message channel never has to carry an exception.
 *
 * @param req provider + key (+ endpoint for `custom`) from the options page.
 * @param fetchFn injectable fetch (tests); defaults to global fetch.
 */
export async function runKeyTest(
  req: { provider: ProviderId; apiKey: string; customEndpoint?: string },
  fetchFn: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<TestKeyResult> {
  const apiKey = req.apiKey.trim();
  if (!apiKey) {
    return { ok: false, errorKind: "auth", message: "Enter an API key first." };
  }

  let built: KeyTestRequest;
  try {
    built = buildKeyTestRequest(req.provider, apiKey, req.customEndpoint);
    new URL(built.url); // reject a malformed custom endpoint before fetching
  } catch (err) {
    return {
      ok: false,
      errorKind: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let response: Response;
  try {
    response = await fetchFn(built.url, {
      method: "GET",
      headers: built.headers,
      signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.debug("key test fetch failed", err);
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      errorKind: "network",
      message: timedOut
        ? "The key test timed out — check your connection and try again."
        : "Could not reach the provider — check your connection (or the endpoint URL).",
    };
  }

  // Only failures need the body (for the diagnostic snippet).
  const bodyText = response.ok ? "" : await safeText(response);
  return classifyKeyTestResponse(req.provider, response.status, bodyText);
}

/** Read a response body as text, swallowing errors (diagnostics only). */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** The key-test slice of the background message router (Phase 6). */
export function createKeyTestHandlers(fetchFn?: typeof fetch): MessageHandlers {
  return {
    testApiKey: (req) => runKeyTest(req, fetchFn),
  };
}
