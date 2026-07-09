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
 * WHY reconstructed: the exact members were decided in an earlier design pass
 * that isn't in-repo. Reconstructed from the prompt spec (PROMPTS.md / §6),
 * which asks the model to detect "every speech bubble, caption, and text
 * region" and to flag onomatopoeia. `other` is the catch-all so the union can
 * grow without breaking the cache or overlay. Optional on
 * {@link TranslatedRegion} so providers that don't classify still validate.
 */
export type RegionKind = "bubble" | "caption" | "sfx" | "other";

/** All region kinds — runtime-usable for validation. */
export const REGION_KINDS: readonly RegionKind[] = [
  "bubble",
  "caption",
  "sfx",
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
  /** Keep Japanese honorifics (-san, -kun, …) in the translation. */
  preserveHonorifics: boolean;
  /** Translate SFX/onomatopoeia instead of skipping them (F19). */
  translateSfx: boolean;
  /** Sampling temperature; low (~0.25) for stable bboxes (PROMPTS.md §1). */
  temperature: number;
}

/** Taxonomy of provider failures (fully implemented in Phase 3). Surfaced here
 *  so message/error types can reference it now. */
export type ProviderErrorKind =
  | "auth"
  | "rate-limit"
  | "malformed"
  | "network"
  | "aborted"
  | "unknown";
