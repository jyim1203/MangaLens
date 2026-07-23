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
  buildBatchUserText,
  buildPromptContext,
  buildSystemPrompt,
  buildUserText,
} from "./prompt";

const log = createLogger("provider");

// Re-exported from shared/constants.ts (moved there in Phase 6 so the
// popup/options model placeholders can read it without importing this whole
// provider engine); adapters and the factory keep importing it from here.
export { DEFAULT_MODELS } from "../../shared/constants";

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
 * Thrown by the batch pipeline ({@link ProviderBase.translateBatch}) when the
 * provider returned a `pages` array whose length ≠ the number of images sent
 * (PROMPTS §4.2 guardrail). A DISTINCT type (not a {@link ProviderError}) so the
 * batch failure classifier routes it straight to split-retry WITHOUT spending the
 * one whole-batch repair nudge — a length mismatch is a batching failure, not a
 * JSON-formatting one the repair pass fixes.
 */
export class BatchLengthError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Batch returned ${received} pages, expected ${expected}`);
    this.name = "BatchLengthError";
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

/**
 * Shape-validate a batch response (PROMPTS §4.2): the top-level object must carry
 * a `pages` array. Returns the raw pages (each still needs
 * {@link validatePageShape}/{@link sanitizePage}); the LENGTH check is the
 * caller's ({@link BatchLengthError}) so it can distinguish wrong-length (split,
 * no repair) from malformed (one repair, then split).
 *
 * @throws {ProviderError} `malformed` if the object has no `pages` array.
 */
export function validateBatchShape(parsed: unknown): unknown[] {
  if (!isPlainObject(parsed)) {
    throw new ProviderError("malformed", "Batch response was not a JSON object");
  }
  if (!Array.isArray(parsed.pages)) {
    throw new ProviderError("malformed", "Batch response has no pages array");
  }
  return parsed.pages;
}

/**
 * Split an aggregate token count evenly across `n` batch members for per-member
 * attribution (F17), with the remainder on the FIRST member so the parts sum
 * EXACTLY back to `total` — the recorded cost must equal what the provider billed
 * (no double count, no loss). Returns all-`undefined` when the provider reported
 * no usage. // WHY a ballpark per-member split: the provider bills the batch as
 * one call and doesn't break tokens down per image; F17 is an estimate surface.
 */
export function splitTokens(
  total: number | undefined,
  n: number,
): (number | undefined)[] {
  if (n <= 0) return [];
  if (total === undefined) return new Array<undefined>(n).fill(undefined);
  const base = Math.floor(total / n);
  const out = new Array<number>(n).fill(base);
  out[0] = total - base * (n - 1); // remainder on the first → exact sum
  return out;
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

/** A finite number, or null (caller drops the region). No clamping here — the
 *  joint clamp in {@link parseBbox} needs the raw values to resolve corners. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Clamp a number into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Phase 9.5 §2: slack allowed on the legacy-`w/h` plausibility check (a real box
 * may round a hair past the edge, e.g. `x + w = 1.01`). Past this the row can't
 * be a genuine w/h box and is treated as corners-with-noise (dropped).
 */
const PLAUSIBLE_WH_EPS = 0.02;

/**
 * Parse a bbox into the internal `{x, y, w, h}` shape (PROMPTS.md §2/§6.3),
 * format-defensive so a model that ignores the schema still degrades to a
 * dropped region rather than garbage:
 *
 *  - **Array `[a, b, c, d]`** — the canonical schema path — is read as CORNERS
 *    `[x_min, y_min, x_max, y_max]`: `x=a, y=b, w=c−a, h=d−b`. // WHY corners-first
 *    (Phase 7.4): the schema now ASKS for corners, and the live HAR showed Haiku
 *    already emits corners about half the time even when asked for w/h — so
 *    corners is the compliant reading and the ambiguous case must trust the
 *    schema. If the corners reading is degenerate (`w ≤ 0` or `h ≤ 0`) the row
 *    can't be corners, so fall back to the legacy `[x, y, width, height]` reading
 *    (`w=c, h=d`) for any third-party endpoint still emitting w/h — but only when
 *    that reading plausibly fits the image (Phase 9.5 §2 guard, `PLAUSIBLE_WH_EPS`);
 *    a legacy reading that overflows the frame was a noisy corner box and is dropped.
 *  - **Object `{x, y, w, h}`** — unchanged back-compat for models emitting the
 *    object form.
 *
 * Then a JOINT edge clamp (the Phase 7.4 Finding-2 fix): `x,y` into [0,1], then
 * `w = min(w, 1−x)`, `h = min(h, 1−y)`. Clamping each component independently
 * (the old behavior) let `x + w` reach 2.0 — a box could render past the drawn
 * bitmap's right/bottom edge. With the joint clamp a box physically cannot
 * escape the image. Returns null if any component is missing/non-finite, or if
 * the box is degenerate after clamping (`w ≤ 0` or `h ≤ 0`), so the region is
 * dropped.
 */
export function parseBbox(raw: unknown): BBox | null {
  let x: number | null;
  let y: number | null;
  let w: number | null;
  let h: number | null;
  if (Array.isArray(raw) && raw.length >= 4) {
    const a = finite(raw[0]);
    const b = finite(raw[1]);
    const c = finite(raw[2]);
    const d = finite(raw[3]);
    if (a === null || b === null || c === null || d === null) return null;
    x = a;
    y = b;
    // Corners first: w = x_max − x_min, h = y_max − y_min. If EITHER extent is
    // non-positive the row can't be corners, so fall back to reading the whole
    // row as legacy [x, y, width, height].
    const cw = c - a;
    const ch = d - b;
    if (cw > 0 && ch > 0) {
      w = cw;
      h = ch;
    } else {
      // Phase 9.5 §2 plausibility guard: the corners reading is degenerate, so
      // read the row as a legacy [x, y, width, height] box — but ACCEPT that
      // reading only if it plausibly IS one, i.e. the box fits the image
      // (x + w ≤ 1, y + h ≤ 1, within ε). WHY: a real third-party w/h box fits
      // the frame; a noisy CORNER box (the Call-11 r12 `[0.480,0.650,0.650,0.620]`,
      // reinterpreted as w = 0.65 from x = 0.48 → x + w = 1.13) does NOT, and that
      // heavy overflow is the tell it was corners-with-noise, not w/h. Dropping it
      // beats clamping a quarter-page rectangle onto the panel, while the fitting
      // case preserves w/h back-compat (half of Haiku still emits w/h).
      if (!(c > 0 && d > 0 && x + c <= 1 + PLAUSIBLE_WH_EPS && y + d <= 1 + PLAUSIBLE_WH_EPS)) {
        return null;
      }
      w = c;
      h = d;
    }
  } else if (isPlainObject(raw)) {
    x = finite(raw.x);
    y = finite(raw.y);
    w = finite(raw.w);
    h = finite(raw.h);
  } else {
    return null;
  }
  if (x === null || y === null || w === null || h === null) return null;

  // Joint clamp: pin the top-left into the image, then cap the extent so the
  // box's right/bottom edge can never cross the image boundary.
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w <= 0 || h <= 0) return null;
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
/**
 * Phase 9.5 §2: the LOWER overlap threshold at which two identical-`original`
 * BALLOON detections (bubble/thought/caption) are collapsed. WHY 0.3 (far below
 * {@link IDENTICAL_DEDUPE_IOU}): the Call-11 evidence showed the model emitting the
 * same bubble two/three times at IoU ≈ 0.32 — well under the strict 0.85 gate — yet
 * still clearly the same detection. Kept conservative + kind-scoped (see
 * {@link dedupeIdentical}) so genuinely repeated dialogue in SEPARATE, non-overlapping
 * balloons (IoU ≈ 0) is never merged.
 */
const IDENTICAL_OVERLAP_IOU = 0.3;
/**
 * Phase 9.5 §2: kinds eligible for the lower-threshold identical-text collapse —
 * balloon-ish text that a model realistically double-detects in the SAME spot.
 * `sfx`/`sign`/`other` are excluded: `sfx` legitimately repeats verbatim (パチ/ドズ)
 * at DIFFERENT, disjoint spots, and those must survive, so they stay on the strict
 * IoU>0.85 path only.
 */
const OVERLAP_DEDUPE_KINDS: ReadonlySet<RegionKind> = new Set<RegionKind>([
  "bubble",
  "thought",
  "caption",
]);
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
 *  - dedupe duplicate detections ({@link dedupeIdentical}): IoU > 0.85 + identical
 *    `original` for every kind, plus a lower-threshold (IoU > 0.3) collapse of
 *    overlapping balloon kinds with the same text, keeping the larger (Phase 9.5 §2);
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

/** Trim + collapse internal whitespace so newline-wrapped OCR of the same line
 *  compares equal (Phase 9.5 §2). `original` is already trimmed by sanitizePage. */
function normalizeOriginal(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Is this kind eligible for the lower-threshold identical-text collapse (§2)? */
function isOverlapDedupeKind(kind: RegionKind | undefined): boolean {
  return kind !== undefined && OVERLAP_DEDUPE_KINDS.has(kind);
}

/** Bbox area (normalized units). */
function bboxArea(bbox: BBox): number {
  return bbox.w * bbox.h;
}

/**
 * Collapse duplicate detections of the SAME text, keeping one region per cluster
 * (PROMPTS.md §6.3, extended Phase 9.5 §2). Two complementary rules, evaluated per
 * already-kept region in reading order:
 *
 *  - **General (all kinds):** exact-`original` + IoU > {@link IDENTICAL_DEDUPE_IOU}
 *    (0.85) → the later region is the same detection; drop it, keep the first. The
 *    pre-9.5 behaviour, unchanged for `sfx`/`sign`/`other`/untyped regions.
 *  - **Overlap-gated balloon collapse (§2, `bubble`/`thought`/`caption` only):**
 *    NORMALIZED-identical `original` (so newline-wrapped OCR matches) + IoU >
 *    {@link IDENTICAL_OVERLAP_IOU} (0.3) → the same balloon detected twice; keep the
 *    LARGER-area region (the bigger box is likelier the real balloon; the smaller is
 *    the spurious echo), dropping the other.
 *
 * WHY overlap-gated + kind-scoped (the user's explicit steer): repeated dialogue
 * across a real conversation lives in SEPARATE, non-overlapping balloons (IoU ≈ 0)
 * — never collapse those; two detections of the SAME balloon overlap. A disjoint
 * third copy (Call-11 r18) intentionally SURVIVES — one stray copy is far less harm
 * than risking a genuinely repeated line. Pure and order-deterministic.
 */
function dedupeIdentical(regions: TranslatedRegion[]): TranslatedRegion[] {
  const out: TranslatedRegion[] = [];
  for (const region of regions) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const existing = out[i] as TranslatedRegion;
      if (
        isOverlapDedupeKind(existing.kind) &&
        isOverlapDedupeKind(region.kind) &&
        normalizeOriginal(existing.original) === normalizeOriginal(region.original) &&
        iou(existing.bbox, region.bbox) > IDENTICAL_OVERLAP_IOU
      ) {
        // Same balloon detected twice → keep the larger; replace the kept region
        // when the incoming one is bigger. Either way the incoming isn't appended.
        if (bboxArea(region.bbox) > bboxArea(existing.bbox)) out[i] = region;
        merged = true;
        break;
      }
      // General strict path (every kind): exact text + high overlap → keep first.
      if (
        existing.original === region.original &&
        iou(existing.bbox, region.bbox) > IDENTICAL_DEDUPE_IOU
      ) {
        merged = true;
        break;
      }
    }
    if (!merged) out.push(region);
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

/**
 * The request fields shared by the single-page and batch build contexts — the
 * prompt text, model, settings, and the two delivery knobs the {@link downgrade}
 * hook mutates. Kept generic so {@link ProviderBase.downgrade} and the HTTP
 * machinery ({@link ProviderBase} `callWithRetry`/`callOnce`) work for both a
 * one-image {@link BuildContext} and a multi-image {@link BatchBuildContext}
 * without duplication.
 */
export interface BuildContextBase {
  systemPrompt: string;
  userText: string;
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

/** Everything a provider needs to build one single-image request. */
export interface BuildContext extends BuildContextBase {
  /** Base64 (no data-URI prefix) of the tile bytes. */
  imageBase64: string;
  /** MIME of the encoded tile, e.g. "image/jpeg". */
  mime: string;
}

/** One image block for a multi-image batch request (F12, PROMPTS §4.2). */
export interface BatchImage {
  /** Base64 (no data-URI prefix) of the page bytes. */
  imageBase64: string;
  /** MIME of the encoded page, e.g. "image/jpeg". */
  mime: string;
}

/** Everything a provider needs to build one MULTI-image batch request (F12). */
export interface BatchBuildContext extends BuildContextBase {
  /** The N page images, in order; `pages[i]` of the response corresponds to `images[i]`. */
  images: BatchImage[];
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

  /**
   * Build the concrete MULTI-image batch request (F12, PROMPTS §4.2): the same
   * envelope as {@link buildRequest} but with N image blocks in order + the batch
   * user text + the batch schema dialect. Every adapter supports multi-image
   * messages, so this is abstract (OpenRouter/custom inherit OpenAI's).
   */
  protected abstract buildBatchRequest(ctx: BatchBuildContext): ProviderRequest;

  /** Pull the model output (or a refusal) out of this provider's response JSON. */
  protected abstract extractOutput(responseJson: unknown): ProviderOutput;

  /**
   * Provider-specific one-shot recovery from a 400: inspect the error body and
   * return a modified context to retry once, or null to give up. Used by the
   * OpenAI family for the `json_schema` → `json_object` ladder (PROMPTS.md
   * §5.2) and by Anthropic to drop `temperature` for models that reject
   * sampling params. Default: no recovery. Generic over the context type so it
   * applies to both single-page and batch requests unchanged.
   */
  protected downgrade<C extends BuildContextBase>(_ctx: C, _bodyText: string): C | null {
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

    // Primary attempt. `region` appends the PROMPTS.md §4.3 suffix for
    // drag-select crops (F10) and is a no-op (byte-identical output) otherwise.
    const region = job.isRegion === true;
    const output = await this.callAndExtract(
      {
        ...baseCtx,
        userText: buildUserText(promptCtx, { region }),
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
            userText: buildUserText(promptCtx, { repair: true, region }),
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
    const responseJson = await this.callWithRetry(
      ctx,
      (c) => this.buildRequest(c),
      signal,
    );
    return this.extractOutput(responseJson);
  }

  /** Batch sibling of {@link callAndExtract}: same HTTP machinery, batch request builder. */
  private async callAndExtractBatch(
    ctx: BatchBuildContext,
    signal: AbortSignal,
  ): Promise<ProviderOutput> {
    const responseJson = await this.callWithRetry(
      ctx,
      (c) => this.buildBatchRequest(c),
      signal,
    );
    return this.extractOutput(responseJson);
  }

  /**
   * Call the endpoint, retrying on rate-limit with the backoff ladder. Generic
   * over the context type + its request builder so single-page and batch share
   * one backoff/downgrade path (the ONLY difference between them is which builder
   * turns the context into an HTTP request).
   */
  private async callWithRetry<C extends BuildContextBase>(
    ctx: C,
    buildReq: (c: C) => ProviderRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(ctx, buildReq, signal, true);
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
  private async callOnce<C extends BuildContextBase>(
    ctx: C,
    buildReq: (c: C) => ProviderRequest,
    signal: AbortSignal,
    allowDowngrade: boolean,
  ): Promise<unknown> {
    const req = buildReq(ctx);
    let response: Response;
    // Phase 9.6 §3 (dead-signal guard): the hard guarantee — an aborted signal must
    // mean `fetchFn` is NEVER invoked, so a cancel that lands anywhere in the
    // dequeue→fetch window can no longer create a status-0 ghost request. Covers the
    // repair-retry and 400-downgrade re-entries for free (both re-enter here).
    this.throwIfAborted(signal);
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
          return this.callOnce(downgraded, buildReq, signal, false);
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

  /**
   * Translate up to N single-tile page images in ONE provider request (F12,
   * PROMPTS §4.2), amortizing the ~600-token system prompt. Background-local —
   * deliberately NOT on the shared {@link Translator} interface (handoff rule 4);
   * the background batch collector calls it, everything else uses
   * {@link translatePage}.
   *
   * Mirrors {@link translatePage}'s structure: primary call → {@link finishBatch};
   * a malformed result gets ONE whole-batch repair retry (§4.2 "never retry the
   * whole batch more than once"). The failure ladder is split across this method
   * and the caller's classifier:
   *  - wrong `pages.length` → {@link BatchLengthError} (no repair — straight to split);
   *  - malformed JSON → one repair retry here; still malformed → throw `malformed`
   *    (caller splits);
   *  - refusal → throw `refusal` (caller splits — one bad image must not damn its
   *    batch-mates);
   *  - auth/rate-limit/network/abort → propagate (caller fails all members — a
   *    split would just repeat it N times).
   *
   * @param jobs single-tile member jobs (`imageBlob` = the prepped page bytes),
   *   in order; `result[i]` corresponds to `jobs[i]`. Each result is stamped with
   *   its job's `imageHash` and carries an even split of the batch's token usage
   *   ({@link splitTokens}).
   */
  async translateBatch(
    jobs: readonly TranslateJob[],
    settings: ProviderSettings,
    signal: AbortSignal,
  ): Promise<PageTranslation[]> {
    this.throwIfAborted(signal);
    if (!settings.apiKey) {
      throw new ProviderError("auth", "No API key configured", {
        provider: this.providerId,
      });
    }
    if (jobs.length === 0) return [];

    const images: BatchImage[] = await Promise.all(
      jobs.map(async (job) => ({
        imageBase64: await blobToBase64(job.imageBlob),
        mime: job.imageBlob.type || "image/jpeg",
      })),
    );
    const model = settings.model || this.defaultModel;
    const promptCtx = buildPromptContext(settings);
    const systemPrompt = buildSystemPrompt(promptCtx);
    const baseCtx: Omit<BatchBuildContext, "userText" | "temperature"> = {
      systemPrompt,
      images,
      model,
      settings,
      mode: "json_schema",
    };

    const output = await this.callAndExtractBatch(
      {
        ...baseCtx,
        userText: buildBatchUserText(promptCtx, jobs.length),
        temperature: settings.temperature,
      },
      signal,
    );

    try {
      return this.finishBatch(output, jobs, settings, model);
    } catch (err) {
      // ONE whole-batch repair retry, but ONLY for a malformed-JSON failure — a
      // BatchLengthError or refusal is not a formatting problem the nudge fixes.
      if (err instanceof ProviderError && err.kind === "malformed") {
        log.debug("batch response malformed — running one repair retry");
        const repaired = await this.callAndExtractBatch(
          {
            ...baseCtx,
            userText: buildBatchUserText(promptCtx, jobs.length, { repair: true }),
            temperature: 0,
          },
          signal,
        );
        return this.finishBatch(repaired, jobs, settings, model);
      }
      throw err;
    }
  }

  /** Run one extracted batch output through the pipeline into per-member pages. */
  private finishBatch(
    output: ProviderOutput,
    jobs: readonly TranslateJob[],
    settings: ProviderSettings,
    model: string,
  ): PageTranslation[] {
    if (output.kind === "refusal") {
      throw new ProviderError("refusal", output.message, {
        provider: this.providerId,
      });
    }
    const parsed =
      output.kind === "text" ? parseModelJson(output.value) : output.value;
    const rawPages = validateBatchShape(parsed);
    if (rawPages.length !== jobs.length) {
      throw new BatchLengthError(jobs.length, rawPages.length);
    }

    const tokensIn = splitTokens(output.usage?.tokensIn, jobs.length);
    const tokensOut = splitTokens(output.usage?.tokensOut, jobs.length);
    const createdAt = Date.now();

    return rawPages.map((rawPage, i) => {
      const page = validatePageShape(rawPage);
      const { sourceLang, regions } = sanitizePage(page);
      const job = jobs[i] as TranslateJob;
      // Batch members are single-tile by construction (the collector diverts any
      // that prep multi-tile), so bboxes are already full-image space — no remap.
      return {
        imageHash: job.imageHash,
        sourceLang,
        targetLang: settings.targetLang,
        regions,
        model,
        provider: this.providerId,
        tokensIn: tokensIn[i],
        tokensOut: tokensOut[i],
        createdAt,
      };
    });
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
