/**
 * Shared data contracts — the single source of truth for every interface that
 * crosses a module or context boundary (content ⇄ background ⇄ providers).
 *
 * Handoff rule 4: do NOT change these interfaces without flagging it explicitly.
 * Handoff rule 5: all bbox coordinates are normalized 0–1 relative to the
 * ORIGINAL full image; convert to pixels only at render time.
 *
 * Keep this file free of runtime/browser imports so it can be pulled into any
 * context (including tests) with zero side effects.
 */

/** Identifiers for every supported LLM provider. `custom` is any
 *  OpenAI-compatible endpoint the user points us at (F2). */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openrouter"
  | "custom";

/** All provider ids, in display order. Runtime-usable (e.g. options dropdown,
 *  settings validation). Keep in sync with the {@link ProviderId} union. */
export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "custom",
] as const;

/**
 * What kind of text region the model detected (gap resolution #2).
 *
 * The five spec members mirror the canonical prompt schema enum in
 * PROMPTS.md §2 exactly — `sign` is load-bearing (the watermark post-filter
 * in PROMPTS.md §9 keys on it). `other` is NOT in the prompt schema: it is
 * the code-side catch-all the response sanitizer maps unknown/unlisted kinds
 * to, so a provider inventing a value can't poison the cache or overlay.
 * Optional on {@link TranslatedRegion} so providers that don't classify
 * still validate.
 */
export type RegionKind =
  | "bubble"
  | "caption"
  | "sfx"
  | "sign"
  | "thought"
  | "other";

/** All region kinds — runtime-usable for validation. */
export const REGION_KINDS: readonly RegionKind[] = [
  "bubble",
  "caption",
  "sfx",
  "sign",
  "thought",
  "other",
] as const;

/**
 * A normalized bounding box: every value is a fraction (0–1) of the ORIGINAL
 * image's width/height. Because it's normalized, an overlay positioned from a
 * BBox survives responsive resizing of the host image for free (§7.2).
 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One translated text region on a page: a speech bubble, caption, or SFX.
 * `bbox` is normalized (see {@link BBox}).
 */
export interface TranslatedRegion {
  bbox: BBox;
  /** Text as it appears in the source image (for the "peek original" feature, F14). */
  original: string;
  /** Text rendered into the overlay, in the user's target language. */
  translated: string;
  /** True for sound effects / onomatopoeia (F19). */
  isSfx: boolean;
  /** Region classification if the provider reports it (gap resolution #2). */
  kind?: RegionKind;
  /** Provider-reported confidence 0–1, if available; used for overlap dedupe (§7.4). */
  confidence?: number;
  /**
   * The speech bubble's traced outline (Phase 9, the ONE sanctioned contract
   * change): a closed polygon of normalized [x, y] points (fractions of the
   * ORIGINAL full image, like {@link bbox}), captured from the bubbleSnap flood
   * fill's accepted blob. NOT provider output — a deterministic local
   * refinement, cached like snapped boxes (7.5 precedent). Optional and
   * additive: absent (pre-Phase-9 cache entries, failed traces, non-snapped
   * kinds) renders exactly the pre-Phase-9 rounded rectangle.
   */
  shape?: Array<[number, number]>;
  /**
   * Sampled mean color of the bubble's interior pixels as a `#rrggbb` hex
   * (Phase 9 §7). When present the overlay fill uses it instead of the user's
   * `bubbleFillColor`, and a dark fill flips the text to light-on-dark.
   * Optional and additive, same compatibility story as {@link shape}.
   */
  fillColor?: string;
}

/**
 * The result of translating one image (or one webtoon tile). This is the exact
 * shape stored in the IndexedDB cache (F13), so any change here is a cache
 * schema change — see {@link CACHE_VERSION} considerations in Phase 4.
 */
export interface PageTranslation {
  /** SHA-256 of the sent image bytes; the primary cache key (§7.3). */
  imageHash: string;
  /** ISO 639-1 code the model detected, e.g. "ja"; "und" if no text (§6). */
  sourceLang: string;
  /** Target language the text was translated into. */
  targetLang: string;
  regions: TranslatedRegion[];
  /** Provider model id used, part of the cache key. */
  model: string;
  provider: ProviderId;
  tokensIn?: number;
  tokensOut?: number;
  /** Epoch ms when this translation was produced. */
  createdAt: number;
}

/**
 * A unit of work handed to a {@link Translator}. The image is already fetched,
 * downscaled, and (for webtoons) tiled by the background pipeline (§7.3/§7.4);
 * the provider only sees ready-to-send bytes.
 */
export interface TranslateJob {
  /** SHA-256 of {@link imageBlob} — the cache key and job identity. */
  imageHash: string;
  /** Already downscaled / JPEG-encoded image bytes. */
  imageBlob: Blob;
  /**
   * Set when this job is one tile of a long strip: the tile's position within
   * the full image, in normalized coords. Region bboxes are remapped from
   * tile-space to full-image-space using this offset before caching (§7.4).
   */
  tileOffset?: BBox;
  targetLang: string;
  /** Optional pinned source language (F11); omit to let the model auto-detect. */
  sourceLangHint?: string;
  /** Scheduling priority: 0 = visible now, 1 = near viewport, 2 = prefetch/all (§7.5). */
  priority: number;
  /**
   * True when this job is a user-drawn drag-select crop (F10), not an
   * auto-detected page/tile. The prompt layer appends the PROMPTS.md §4.3
   * region suffix ("This is a cropped region…") when set. Added in Phase 7 (the
   * one pre-authorized handoff-rule-4 contract change). Does NOT bump
   * PROMPT_VERSION: the shared page-prompt strings are untouched, so cached page
   * translations stay valid; the suffix only exists on never-cached region jobs.
   */
  isRegion?: boolean;
}

/**
 * The provider abstraction (Architecture Decision §3, Option A). Everything
 * above the providers/ layer depends only on this interface, so the local
 * pipeline (F20, Option B) can slot in later without touching callers.
 */
export interface Translator {
  /**
   * Translate one image/tile. Must reject on {@link signal} abort and surface
   * a typed {@link ProviderError} for auth/rate-limit/malformed/network faults.
   */
  translatePage(
    job: TranslateJob,
    settings: ProviderSettings,
    signal: AbortSignal,
  ): Promise<PageTranslation>;
}

/**
 * The minimal, provider-facing slice of user settings. Derived from the full
 * {@link import("./settings").Settings} via `deriveProviderSettings` so the
 * providers/ layer never imports the whole settings module. Kept here (a data
 * contract) rather than in settings.ts because {@link Translator} depends on it.
 */
export interface ProviderSettings {
  provider: ProviderId;
  /** BYOK key for the active provider (F2). Never logged, never synced. */
  apiKey: string;
  /** Model id, e.g. "gemini-1.5-flash". */
  model: string;
  /** Base URL for `provider: "custom"` (OpenAI-compatible). Ignored otherwise. */
  customEndpoint?: string;
  targetLang: string;
  /** Pinned source language (F11); omit for auto-detect. */
  sourceLangHint?: string;
  /**
   * Manga reading direction, drives the prompt's `{{reading_order_rule}}`
   * (PROMPTS.md §3/§7). Mirrors {@link import("./settings").Settings.readingDirection};
   * added in Phase 3 (flagged handoff-rule-4 contract change) because the prompt
   * layer needs it and `deriveProviderSettings` is the only bridge to it.
   */
  readingDirection: "rtl" | "ltr" | "auto";
  /** Keep Japanese honorifics (-san, -kun, …) in the translation. */
  preserveHonorifics: boolean;
  /** Translate SFX/onomatopoeia instead of skipping them (F19). */
  translateSfx: boolean;
  /** Sampling temperature; low (~0.25) for stable bboxes (PROMPTS.md §1). */
  temperature: number;
}

/** Taxonomy of provider failures (fully implemented in Phase 3). Surfaced here
 *  so message/error types can reference it now. `refusal` is a provider
 *  safety refusal (PROMPTS.md §6 ContentRefusalError): UI shows "provider
 *  declined this image" and, unlike the others, it is never retried. */
export type ProviderErrorKind =
  | "auth"
  | "rate-limit"
  | "malformed"
  | "network"
  | "aborted"
  | "refusal"
  | "unknown";
