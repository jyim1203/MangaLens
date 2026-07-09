/**
 * Provider foundation: the typed error taxonomy, the pure response pipeline
 * (parse → validate → sanitize, PROMPTS.md §6), and the abstract
 * {@link ProviderBase} class that turns a {@link TranslateJob} into a
 * {@link PageTranslation} — handling HTTP, rate-limit backoff, and a one-shot
 * malformed-JSON repair retry. Concrete providers (gemini/openai/anthropic/…)
 * supply only the request shape and how to pull the model output out of their
 * envelope; everything else is shared here.
 *
 * The pipeline functions are exported and browser-free so the golden tests can
 * exercise them directly against stored provider responses (no network).
 *
 * Handoff rule 6 (fail soft) is enforced one level up: every failure surfaces
 * as a typed {@link ProviderError} the caller maps to "no overlay" + a warning.
 */
import { isAbortError, isPlainObject } from "../../shared/guards";
import { createLogger } from "../../shared/log";
import type {
  BBox,
  PageTranslation,
  ProviderErrorKind,
  ProviderId,
  ProviderSettings,
  RegionKind,
  TranslateJob,
  TranslatedRegion,
  Translator,
} from "../../shared/types";
import { iou, remapBboxFromTile } from "../imagePrep";
import {
  buildPromptContext,
  buildSystemPrompt,
  buildUserText,
} from "./prompt";

const log = createLogger("provider");

// --- Error taxonomy (PROMPTS.md §6) ----------------------------------------

/**
 * A typed provider failure. `kind` drives UI messaging and retry policy:
 * `auth` → "check your API key", `rate-limit` → backoff, `refusal` → "provider
 * declined this image" (never retried), `malformed` → one repair attempt.
 * Mirrors the {@link ProviderErrorKind} taxonomy in shared/types.ts.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status when the failure came from a response. */
  readonly status?: number;
  /** For `rate-limit`: how long to wait before retrying, from `retry-after`. */
  readonly retryAfterMs?: number;
  readonly provider?: ProviderId;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      provider?: ProviderId;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.provider = options.provider;
  }
}

/**
 * Parse a `retry-after` header (RFC 7231: delta-seconds OR an HTTP date) into
 * milliseconds. Returns undefined when absent/unparseable so the caller falls
 * back to its fixed backoff ladder.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** Map an HTTP error response to a {@link ProviderError} of the right kind. */
export function mapHttpError(
  status: number,
  headers: Headers,
  bodyText: string,
  provider: ProviderId,
): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("auth", `HTTP ${status}: authentication failed`, {
      status,
      provider,
    });
  }
  // WHY 529 joins the rate-limit branch: it's the "overloaded, retry with
  // backoff" status (Anthropic documents it as retryable) — semantically the
  // same client response as a 429, unlike a plain 5xx fault.
  if (status === 429 || status === 529) {
    return new ProviderError(
      "rate-limit",
      status === 429 ? `HTTP ${status}: rate limited` : `HTTP ${status}: provider overloaded`,
      {
        status,
        provider,
        retryAfterMs: parseRetryAfter(headers.get("retry-after")),
      },
    );
  }
  if (status >= 500) {
    return new ProviderError("network", `HTTP ${status}: server error`, {
      status,
      provider,
    });
  }
  // Other 4xx (bad request, etc.): surface a trimmed body for diagnostics.
  const detail = bodyText.slice(0, 300);
  return new ProviderError("unknown", `HTTP ${status}: ${detail}`, {
    status,
    provider,
  });
}

// --- Pure response pipeline (PROMPTS.md §6) ---------------------------------

/**
 * Extract the outermost JSON object from a model's text output (PROMPTS.md
 * §6.1): strip ```json fences and any pre/post commentary by trimming to the
 * first `{` … last `}`. Returns the substring; parsing is the caller's job.
 *
 * @throws {ProviderError} `malformed` if no brace pair is found at all.
 */
export function extractJsonObject(raw: string): string {
  // Trimming to the outermost braces drops ```json fences and surrounding
  // "I hope this helps!" prose in one move; clean JSON passes through intact.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new ProviderError("malformed", "No JSON object found in response");
  }
  return raw.slice(first, last + 1);
}

/**
 * Parse a model's text output into an object: {@link extractJsonObject} then
 * `JSON.parse`.
 *
 * @throws {ProviderError} `malformed` on any parse failure.
 */
export function parseModelJson(raw: string): unknown {
  const json = extractJsonObject(raw);
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new ProviderError("malformed", "Response was not valid JSON", {
      cause: err,
    });
  }
}

/** A validated (but not yet sanitized) page: shape-checked, values still raw. */
export interface RawPage {
  source_lang: string;
  regions: unknown[];
}

/**
 * Shape-validate a parsed response against the canonical schema (PROMPTS.md §6.2,
 * hand-rolled — we deliberately don't ship ajv). Only structural guarantees are
 * made here; value-level cleaning happens in {@link sanitizePage}.
 *
 * @throws {ProviderError} `malformed` if `regions` is not an array.
 */
export function validatePageShape(parsed: unknown): RawPage {
  if (!isPlainObject(parsed)) {
    throw new ProviderError("malformed", "Response was not a JSON object");
  }
  if (!Array.isArray(parsed.regions)) {
    throw new ProviderError("malformed", "Response has no regions array");
  }
  const sourceLang =
    typeof parsed.source_lang === "string" ? parsed.source_lang : "und";
  return { source_lang: sourceLang, regions: parsed.regions };
}

/** Common ISO 639-2/T (and a few 639-2/B) → 639-1 fixups for `source_lang`. */
const ISO_639_2_TO_1: Record<string, string> = {
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  eng: "en",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  ita: "it",
  por: "pt",
  rus: "ru",
  vie: "vi",
  tha: "th",
  ind: "id",
  ara: "ar",
};

/**
 * Normalize a model-reported source language to a lowercase 2-letter code
 * (PROMPTS.md §6.3): drops region tags (`ja-JP` → `ja`), maps 3-letter codes
 * (`jpn` → `ja`), and preserves the `und` "no text" sentinel.
 */
export function normalizeSourceLang(code: string): string {
  const primary = (code.toLowerCase().split("-")[0] ?? "").trim();
  if (!primary) return "und";
  if (primary === "und") return "und";
  if (primary.length === 3 && ISO_639_2_TO_1[primary]) {
    return ISO_639_2_TO_1[primary];
  }
  return primary;
}

/** The five prompt-schema kinds; anything else collapses to the code-side `other`. */
const SPEC_KINDS: ReadonlySet<string> = new Set([
  "bubble",
  "caption",
  "sfx",
  "sign",
  "thought",
]);

/**
 * Map a provider-reported `kind` to a {@link RegionKind}: the OpenAI strict-mode
 * `"none"` sentinel and absent values → undefined; the five canonical kinds pass
 * through; the existing `other` passes through; anything unknown collapses to
 * `other` so a provider inventing a value can't poison the overlay/cache.
 */
export function normalizeKind(kind: unknown): RegionKind | undefined {
  if (typeof kind !== "string") return undefined;
  const k = kind.toLowerCase();
  if (k === "none" || k === "") return undefined;
  // Everything outside the five spec kinds (including invented values)
  // collapses to the code-side catch-all `other`.
  return SPEC_KINDS.has(k) ? (k as RegionKind) : "other";
}

/** Clamp a number into [0, 1]; NaN/±Inf → null (caller drops the region). */
function clamp01(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Parse and clamp a bbox from either the canonical `[x, y, w, h]` array or a
 * `{x, y, w, h}` object (some models emit the latter). Every component is
 * clamped to [0, 1] (PROMPTS.md §6.3). Returns null if any component is
 * missing/non-finite so the region is dropped.
 */
export function parseBbox(raw: unknown): BBox | null {
  let x: number | null;
  let y: number | null;
  let w: number | null;
  let h: number | null;
  if (Array.isArray(raw) && raw.length >= 4) {
    x = clamp01(raw[0]);
    y = clamp01(raw[1]);
    w = clamp01(raw[2]);
    h = clamp01(raw[3]);
  } else if (isPlainObject(raw)) {
    x = clamp01(raw.x);
    y = clamp01(raw.y);
    w = clamp01(raw.w);
    h = clamp01(raw.h);
  } else {
    return null;
  }
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

/** Read an optional confidence (0–1) if the provider supplied a sane number. */
function parseConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(1, Math.max(0, raw));
}

/** Below this area a bbox is degenerate; above it the model boxed the whole page. */
const MIN_REGION_AREA = 0.0001;
const MAX_REGION_AREA = 0.9;
/** Regions this similar with identical `original` are the same detection (PROMPTS.md §6.3). */
const IDENTICAL_DEDUPE_IOU = 0.85;
/** Fraction of empty-translation regions above which the whole response is malformed. */
const NEEDS_RETRY_FRACTION = 0.3;

/** The cleaned result of {@link sanitizePage}. */
export interface SanitizedPage {
  sourceLang: string;
  regions: TranslatedRegion[];
}

/**
 * Clean a validated response into render-ready regions (PROMPTS.md §6.3), always
 * — even when the response validated. Steps, in order:
 *  - parse+clamp each bbox to [0, 1]; drop degenerate (`w*h < 0.0001`) or
 *    whole-page (`w*h > 0.9`) boxes;
 *  - drop regions whose `original` is empty/whitespace;
 *  - count regions whose `translated` is empty (but `original` isn't) and drop
 *    them; if they exceed 30% of otherwise-valid regions, throw `malformed` so
 *    the caller runs the repair pass;
 *  - dedupe near-identical detections (IoU > 0.85 AND identical `original`),
 *    keeping the first;
 *  - normalize `source_lang`.
 *
 * SFX regions are KEPT (with `isSfx: true`) regardless of the user's skip-SFX
 * setting — the overlay filters them at render time (§9), so the cache holds the
 * full translation. The §9 watermark post-filter is deferred to the overlay
 * layer (Phase 5) where image-edge proximity is unambiguous.
 *
 * @throws {ProviderError} `malformed` when too many regions lack a translation.
 */
export function sanitizePage(page: RawPage): SanitizedPage {
  const kept: TranslatedRegion[] = [];
  let considered = 0;
  let needsRetry = 0;

  for (const raw of page.regions) {
    if (!isPlainObject(raw)) continue;
    const bbox = parseBbox(raw.bbox);
    if (!bbox) continue;
    const area = bbox.w * bbox.h;
    if (area < MIN_REGION_AREA || area > MAX_REGION_AREA) continue;

    const original = typeof raw.original === "string" ? raw.original.trim() : "";
    if (!original) continue;

    considered++;
    const translated =
      typeof raw.translated === "string" ? raw.translated.trim() : "";
    if (!translated) {
      // Has source text but no translation — a partial/failed generation.
      needsRetry++;
      continue;
    }

    kept.push({
      bbox,
      original,
      translated,
      isSfx: raw.is_sfx === true,
      kind: normalizeKind(raw.kind),
      confidence: parseConfidence(raw.confidence),
    });
  }

  if (considered > 0 && needsRetry / considered > NEEDS_RETRY_FRACTION) {
    throw new ProviderError(
      "malformed",
      `${needsRetry}/${considered} regions had no translation`,
    );
  }

  return {
    sourceLang: normalizeSourceLang(page.source_lang),
    regions: dedupeIdentical(kept),
  };
}

/** Drop later regions that overlap a kept one by IoU > 0.85 with identical text. */
function dedupeIdentical(regions: TranslatedRegion[]): TranslatedRegion[] {
  const out: TranslatedRegion[] = [];
  for (const region of regions) {
    const dup = out.some(
      (existing) =>
        existing.original === region.original &&
        iou(existing.bbox, region.bbox) > IDENTICAL_DEDUPE_IOU,
    );
    if (!dup) out.push(region);
  }
  return out;
}

// --- Abstract base class ----------------------------------------------------

/** Token counts reported by a provider's response envelope (feeds F17 cost tracking). */
export interface TokenUsage {
  tokensIn?: number;
  tokensOut?: number;
}

/** The model output pulled out of a provider's response envelope. */
export type ProviderOutput =
  /** Already-parsed object (Anthropic tool input; a provider that returns JSON directly). */
  | { kind: "json"; value: unknown; usage?: TokenUsage }
  /** A JSON string still needing {@link parseModelJson}. */
  | { kind: "text"; value: string; usage?: TokenUsage }
  /** A safety refusal (PROMPTS.md §6 ContentRefusalError) — never retried. */
  | { kind: "refusal"; message: string };

/** Read one numeric token count out of an untyped usage blob, if sane. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** A fully-built HTTP request for a provider endpoint. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Everything a provider needs to build one request. */
export interface BuildContext {
  systemPrompt: string;
  userText: string;
  /** Base64 (no data-URI prefix) of the tile bytes. */
  imageBase64: string;
  /** MIME of the encoded tile, e.g. "image/jpeg". */
  mime: string;
  model: string;
  settings: ProviderSettings;
  /**
   * Sampling temperature for this request; `undefined` means "omit the field"
   * (for models that reject sampling params). Distinct from
   * `settings.temperature` because the repair retry overrides it to 0
   * (PROMPTS.md §6.4).
   */
  temperature: number | undefined;
  /**
   * Structured-output delivery mode for the OpenAI family; ignored by providers
   * that have one enforcement path. `json_object` is the downgrade fallback
   * (PROMPTS.md §5.2).
   */
  mode: "json_schema" | "json_object";
}

/** Injectable seams so retry/backoff and HTTP are unit-testable without waiting or a network. */
export interface ProviderBaseOptions {
  fetchFn?: typeof fetch;
  /** Sleep that resolves after `ms` (tests pass an instant/instrumented stub). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Rate-limit backoff ladder in ms (PROMPTS.md §6: 2s / 8s / 30s). */
  backoffMs?: readonly number[];
}

/** Default rate-limit backoff ladder (PROMPTS.md §6). */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 8000, 30000];

/**
 * Cap on how long a server-sent `retry-after` is honored. WHY: an unbounded
 * header (e.g. `retry-after: 3600`) would stall the translate job — and the
 * content script awaiting it — for an hour; past a minute the user is better
 * served by failing soft and retrying later.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** A sleep that rejects promptly on abort. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("aborted", "aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ProviderError("aborted", "aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Shared provider engine. A concrete provider implements {@link buildRequest}
 * and {@link extractOutput} (and optionally {@link downgrade}); this class owns
 * base64 encoding, the HTTP call, rate-limit backoff, the malformed-JSON repair
 * retry, and running the {@link sanitizePage} pipeline into a
 * {@link PageTranslation}.
 */
export abstract class ProviderBase implements Translator {
  protected readonly fetchFn: typeof fetch;
  protected readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  protected readonly backoffMs: readonly number[];

  /** Model id used when the user hasn't picked one (settings.model empty). */
  protected abstract readonly defaultModel: string;

  constructor(
    protected readonly providerId: ProviderId,
    options: ProviderBaseOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffMs = options.backoffMs ?? RATE_LIMIT_BACKOFF_MS;
  }

  /** Build the concrete HTTP request for this provider (endpoint, headers, body). */
  protected abstract buildRequest(ctx: BuildContext): ProviderRequest;

  /** Pull the model output (or a refusal) out of this provider's response JSON. */
  protected abstract extractOutput(responseJson: unknown): ProviderOutput;

  /**
   * Provider-specific one-shot recovery from a 400: inspect the error body and
   * return a modified context to retry once, or null to give up. Used by the
   * OpenAI family for the `json_schema` → `json_object` ladder (PROMPTS.md
   * §5.2) and by Anthropic to drop `temperature` for models that reject
   * sampling params. Default: no recovery.
   */
  protected downgrade(_ctx: BuildContext, _bodyText: string): BuildContext | null {
    return null;
  }

  async translatePage(
    job: TranslateJob,
    settings: ProviderSettings,
    signal: AbortSignal,
  ): Promise<PageTranslation> {
    this.throwIfAborted(signal);
    if (!settings.apiKey) {
      throw new ProviderError("auth", "No API key configured", {
        provider: this.providerId,
      });
    }

    const imageBase64 = await blobToBase64(job.imageBlob);
    const mime = job.imageBlob.type || "image/jpeg";
    const model = settings.model || this.defaultModel;
    const promptCtx = buildPromptContext(settings);
    const systemPrompt = buildSystemPrompt(promptCtx);

    const baseCtx: Omit<BuildContext, "userText" | "temperature"> = {
      systemPrompt,
      imageBase64,
      mime,
      model,
      settings,
      mode: "json_schema",
    };

    // Primary attempt.
    const output = await this.callAndExtract(
      {
        ...baseCtx,
        userText: buildUserText(promptCtx),
        temperature: settings.temperature,
      },
      signal,
    );

    try {
      return this.finish(output, job, settings, model);
    } catch (err) {
      // A malformed/parse failure gets ONE repair retry (PROMPTS.md §6.4):
      // re-run at temperature 0 (deterministic) with an explicit "return only
      // JSON" nudge. (A refusal or auth/rate-limit error is not retried here —
      // it isn't a formatting problem.)
      if (err instanceof ProviderError && err.kind === "malformed") {
        log.debug("primary response malformed — running one repair retry");
        const repaired = await this.callAndExtract(
          {
            ...baseCtx,
            userText: buildUserText(promptCtx, { repair: true }),
            temperature: 0,
          },
          signal,
        );
        return this.finish(repaired, job, settings, model);
      }
      throw err;
    }
  }

  /** Run the request (with rate-limit backoff + 400 downgrade), then extract the output. */
  private async callAndExtract(
    ctx: BuildContext,
    signal: AbortSignal,
  ): Promise<ProviderOutput> {
    const responseJson = await this.callWithRetry(ctx, signal);
    return this.extractOutput(responseJson);
  }

  /** Call the endpoint, retrying on rate-limit with the backoff ladder. */
  private async callWithRetry(
    ctx: BuildContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(ctx, signal, true);
      } catch (err) {
        if (
          err instanceof ProviderError &&
          err.kind === "rate-limit" &&
          attempt < this.backoffMs.length
        ) {
          const waitMs = Math.min(
            err.retryAfterMs ?? this.backoffMs[attempt] ?? 0,
            MAX_RETRY_AFTER_MS,
          );
          log.debug(`rate limited — backing off ${waitMs}ms (attempt ${attempt + 1})`);
          await this.sleep(waitMs, signal);
          continue;
        }
        throw err;
      }
    }
  }

  /** A single HTTP round trip. `allowDowngrade` guards the one-shot 400 downgrade. */
  private async callOnce(
    ctx: BuildContext,
    signal: AbortSignal,
    allowDowngrade: boolean,
  ): Promise<unknown> {
    const req = this.buildRequest(ctx);
    let response: Response;
    try {
      response = await this.fetchFn(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new ProviderError("aborted", "Request aborted", {
          provider: this.providerId,
          cause: err,
        });
      }
      throw new ProviderError("network", "Network error calling provider", {
        provider: this.providerId,
        cause: err,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      if (allowDowngrade && response.status === 400) {
        const downgraded = this.downgrade(ctx, bodyText);
        if (downgraded) {
          log.debug("400 recovery: retrying once with downgraded request");
          return this.callOnce(downgraded, signal, false);
        }
      }
      throw mapHttpError(
        response.status,
        response.headers,
        bodyText,
        this.providerId,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (err) {
      throw new ProviderError("malformed", "Provider response was not JSON", {
        provider: this.providerId,
        cause: err,
      });
    }
  }

  /** Run the extracted output through the pipeline and build the PageTranslation. */
  private finish(
    output: ProviderOutput,
    job: TranslateJob,
    settings: ProviderSettings,
    model: string,
  ): PageTranslation {
    if (output.kind === "refusal") {
      throw new ProviderError("refusal", output.message, {
        provider: this.providerId,
      });
    }
    const parsed =
      output.kind === "text" ? parseModelJson(output.value) : output.value;
    const page = validatePageShape(parsed);
    const { sourceLang, regions } = sanitizePage(page);

    // Lift tile-local bboxes into full-image space (§7.4). For a non-tiled job
    // there's no offset and the bboxes are already page-relative.
    const finalRegions = job.tileOffset
      ? regions.map((r) => ({
          ...r,
          bbox: remapBboxFromTile(r.bbox, job.tileOffset as BBox),
        }))
      : regions;

    return {
      imageHash: job.imageHash,
      sourceLang,
      targetLang: settings.targetLang,
      regions: finalRegions,
      model,
      provider: this.providerId,
      tokensIn: output.usage?.tokensIn,
      tokensOut: output.usage?.tokensOut,
      createdAt: Date.now(),
    };
  }

  /** Throw a typed abort if the signal already fired (before any work). */
  protected throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ProviderError("aborted", "Request aborted", {
        provider: this.providerId,
      });
    }
  }
}

/** Read a response body as text, swallowing errors (diagnostics only). */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Encode a Blob as base64 (no data-URI prefix). Works in the event page and the
 * Node test runtime (both provide `Blob.arrayBuffer` and `btoa`). Chunked so a
 * large image doesn't blow the argument limit of `String.fromCharCode`.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
