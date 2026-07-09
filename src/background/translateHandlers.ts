/**
 * Background translate orchestration + message handler: the fetch → prep → hash
 * → provider → merge path deferred out of Phase 2 (which lacked the provider
 * layer). Wires the `translatePage` message to a real translation of one on-page
 * image.
 *
 * Split like `imagePrep.ts`:
 *  - {@link mergeTilePages} is PURE (concat + dedupe overlapping tiles, §7.4) and
 *    unit-tested.
 *  - {@link translateImage} is the thin, browser-only driver (calls
 *    `prepareImage`, which needs OffscreenCanvas) — kept minimal, untested for
 *    the same env reason `prepareImage` is.
 *
 * DEFERRED to Phase 4: the IndexedDB cache (cache-first lookup + negative cache
 * on failure) and the priority/concurrency queue. This handler currently runs
 * each request immediately and ignores `priority`; Phase 4 wraps it. Abort is
 * plumbed through but nothing cancels yet (the queue will).
 */
import { createLogger } from "../shared/log";
import type { MessageHandlers, TranslatePageResult } from "../shared/messages";
import {
  deriveProviderSettings,
  loadSettings,
  type Settings,
} from "../shared/settings";
import type {
  PageTranslation,
  ProviderSettings,
  TranslateJob,
} from "../shared/types";
import { ImageFetchError, fetchImageBytes } from "./imageFetcher";
import { sha256Hex } from "./hash";
import { dedupeRegions, prepareImage } from "./imagePrep";
import { ProviderError } from "./providers/ProviderBase";
import { createProvider } from "./providers/factory";

const log = createLogger("translate");

/**
 * Merge the per-tile {@link PageTranslation}s of one image into a single page
 * (§7.4). Regions arrive already remapped to full-image space by the provider,
 * so this concatenates them and dedupes the duplicates that appear in adjacent
 * tiles' overlap zones (IoU-based, keep higher confidence).
 *
 * @param pages tile results in top-to-bottom order (never empty).
 * @param imageHash the page-level cache key to stamp on the merged result.
 * @returns one PageTranslation for the whole image.
 */
export function mergeTilePages(
  pages: readonly PageTranslation[],
  imageHash: string,
): PageTranslation {
  const first = pages[0];
  if (!first) {
    throw new Error("mergeTilePages requires at least one page");
  }
  if (pages.length === 1) {
    return { ...first, imageHash };
  }

  const regions = dedupeRegions(pages.flatMap((p) => p.regions));
  // First tile that actually detected a language wins; "und" means "no text".
  const sourceLang =
    pages.find((p) => p.sourceLang && p.sourceLang !== "und")?.sourceLang ??
    first.sourceLang;
  const tokensIn = sumDefined(pages.map((p) => p.tokensIn));
  const tokensOut = sumDefined(pages.map((p) => p.tokensOut));

  return {
    imageHash,
    sourceLang,
    targetLang: first.targetLang,
    regions,
    model: first.model,
    provider: first.provider,
    tokensIn,
    tokensOut,
    createdAt: Date.now(),
  };
}

/** Sum an array of maybe-undefined counts; undefined when none were reported. */
function sumDefined(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Translate one on-page image end to end: fetch its bytes (§7.3), downscale/tile
 * (§7.4/§7.5), translate every tile via the active provider, and merge.
 *
 * Browser-only (via `prepareImage`). Errors propagate as typed
 * {@link import("./providers/ProviderBase").ProviderError} /
 * {@link import("./imageFetcher").ImageFetchError} for the caller to fail soft.
 *
 * @param imageUrl absolute URL of the on-page image.
 * @param settings full settings (for prep dimensions).
 * @param providerSettings the provider slice (already target-lang-overridden if needed).
 * @param signal abort signal from the caller.
 * @param priority scheduling priority from the request (§7.5); recorded on the
 *   jobs so the Phase 4 queue can order them.
 */
export async function translateImage(
  imageUrl: string,
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
  priority = 0,
): Promise<PageTranslation> {
  const fetched = await fetchImageBytes(imageUrl, signal);
  const prepared = await prepareImage(fetched.blob, {
    maxEdgePx: settings.maxImageEdgePx,
    jpegQuality: settings.jpegQuality,
  });

  const provider = createProvider(providerSettings);
  // WHY parallel: tiles of one strip are independent requests, and §7.5's
  // latency target dies on a 10-tile strip translated serially. Rate limits
  // self-correct via the provider's 429/529 backoff; the global concurrency
  // cap (settings.concurrency) arrives with the Phase 4 queue.
  const tilePages: PageTranslation[] = await Promise.all(
    prepared.tiles.map(async (tile): Promise<PageTranslation> => {
      const imageHash = await sha256Hex(tile.blob);
      const job: TranslateJob = {
        imageHash,
        imageBlob: tile.blob,
        tileOffset: prepared.tiled ? tile.offset : undefined,
        targetLang: providerSettings.targetLang,
        sourceLangHint: providerSettings.sourceLangHint,
        priority,
      };
      return provider.translatePage(job, providerSettings, signal);
    }),
  );

  // The page identity is the hash of the ORIGINAL downloaded bytes — stable
  // regardless of how many tiles it was split into. (Phase 4 composes this with
  // targetLang/model/PROMPT_VERSION for the real cache key.)
  const pageHash = await sha256Hex(fetched.blob);
  const merged = mergeTilePages(tilePages, pageHash);
  log.debug(
    `translated ${imageUrl}: ${merged.regions.length} regions from ${prepared.tiles.length} tile(s)`,
  );
  return merged;
}

/**
 * Map any translate-path failure to the wire-safe failure arm of
 * {@link TranslatePageResult}. WHY: typed errors don't survive
 * `runtime.sendMessage` serialization (only the message string does), so the
 * §6 error-kind taxonomy must cross the boundary as data. Pure — unit-tested
 * directly.
 */
export function errorToTranslateResult(err: unknown): TranslatePageResult {
  if (err instanceof ProviderError) {
    return { ok: false, errorKind: err.kind, message: err.message };
  }
  if (err instanceof ImageFetchError) {
    // The fetch taxonomy is finer-grained than the provider one; aborted maps
    // 1:1 and everything else is a fetch-stage failure the UI treats alike.
    return {
      ok: false,
      errorKind: err.reason === "aborted" ? "aborted" : "network",
      message: `Image fetch failed (${err.reason}): ${err.message}`,
    };
  }
  return {
    ok: false,
    errorKind: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** The translate slice of the background message router. */
export function createTranslateHandlers(): MessageHandlers {
  return {
    translatePage: async (req) => {
      try {
        const settings = await loadSettings();
        const providerSettings = deriveProviderSettings(settings);
        // A request-level target language (e.g. drag-select) overrides settings.
        if (req.targetLang) providerSettings.targetLang = req.targetLang;

        // No queue yet (Phase 4); run immediately. A fresh controller gives the
        // provider an AbortSignal even though nothing cancels it here.
        const controller = new AbortController();
        const page = await translateImage(
          req.imageUrl,
          settings,
          providerSettings,
          controller.signal,
          req.priority,
        );
        return { ok: true, page };
      } catch (err) {
        log.warn(`translatePage failed for ${req.imageUrl}`, err);
        return errorToTranslateResult(err);
      }
    },
  };
}
