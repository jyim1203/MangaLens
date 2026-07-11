/**
 * Background handler for the `translateRegion` message: the drag-select crop
 * path (F10, Phase 7). A user draws a rectangle over any on-page image; the
 * content script sends the crop (plus either the image URL or, for
 * `blob:`/`<canvas>` sources it read itself, the raw bytes), and this crops →
 * translates → returns crop-local regions already remapped to full-image space.
 *
 * Reuses the Phase 2–5 plumbing wholesale, with three deliberate differences
 * from {@link import("./translateHandlers").translateImage}:
 *  1. NO caching / coalescing — a hand-drawn rect is never pixel-identical to
 *     another, so a cache entry would never be hit again; `cacheLookup`/store are
 *     not even imported (kept out of the module graph).
 *  2. The crop is treated as a TILE — `tileOffset: crop` makes ProviderBase's
 *     existing `remapBboxFromTile` lift the provider's crop-local bboxes back to
 *     full-image space with zero new remap code.
 *  3. `isRegion: true` on the job appends the PROMPTS.md §4.3 prompt suffix.
 *
 * Everything else is shared: the same {@link getTranslationQueue} concurrency
 * cap (at priority 0 — a user gesture is the most urgent work we have), the same
 * `requestControllers` registry so the existing `cancelTranslation` message
 * covers regions too, usage recording (F17), and the same fail-soft
 * {@link errorToTranslateResult} mapping.
 *
 * Split like the rest of the background: {@link prepareRegionCrop}/
 * {@link planRegionCrop} carry the geometry (tested); this driver is a thin,
 * browser-only shell (OffscreenCanvas in prepareRegionCrop).
 */
import type browser from "webextension-polyfill";
import { createLogger } from "../shared/log";
import type { MessageHandlers, TranslateRegionRequest } from "../shared/messages";
import { deriveProviderSettings, loadSettings, type Settings } from "../shared/settings";
import type { PageTranslation, ProviderSettings, TranslateJob } from "../shared/types";
import { fetchImageBytes } from "./imageFetcher";
import { sha256Hex } from "./hash";
import { prepareRegionCrop } from "./imagePrep";
import { recordUsage, usageFromPage } from "./costTracker";
import { ProviderError } from "./providers/ProviderBase";
import { createProvider } from "./providers/factory";
import {
  errorToTranslateResult,
  getTranslationQueue,
  registerRequestController,
  unregisterRequestController,
} from "./translateHandlers";
import type { BBox } from "../shared/types";

const log = createLogger("region");

/**
 * Resolve the source bytes for a region request. Exactly one of `imageUrl`
 * (background fetches, reusing the HTTP cache) or `imageBytes` (content-acquired
 * blob/canvas bytes) must be present — both or neither is a malformed request,
 * surfaced as a `network`-kind failure (handoff item 3).
 */
async function resolveRegionBytes(
  req: TranslateRegionRequest,
  signal: AbortSignal,
): Promise<Blob> {
  const hasUrl = typeof req.imageUrl === "string" && req.imageUrl.length > 0;
  const hasBytes = req.imageBytes instanceof ArrayBuffer && req.imageBytes.byteLength > 0;
  if (hasUrl === hasBytes) {
    throw new ProviderError(
      "network",
      "translateRegion needs exactly one of imageUrl / imageBytes",
    );
  }
  if (hasUrl) {
    const fetched = await fetchImageBytes(req.imageUrl as string, signal);
    return fetched.blob;
  }
  return new Blob([req.imageBytes as ArrayBuffer], {
    type: req.imageMime || "image/jpeg",
  });
}

/**
 * Crop → translate one region (no cache, no coalesce). The crop is a single tile
 * by construction, so there is nothing to merge; ProviderBase already remapped
 * the bboxes into full-image space via `tileOffset`.
 */
async function translateRegionImage(
  blob: Blob,
  crop: BBox,
  settings: Settings,
  providerSettings: ProviderSettings,
  signal: AbortSignal,
): Promise<PageTranslation> {
  const prepared = await prepareRegionCrop(blob, crop, {
    maxEdgePx: settings.maxImageEdgePx,
    jpegQuality: settings.jpegQuality,
  });
  if (!prepared) {
    // Too small after clamping — malformed-style failure (handoff item 3).
    throw new ProviderError("malformed", "Selection too small to translate");
  }

  const imageHash = await sha256Hex(prepared.blob);
  const job: TranslateJob = {
    imageHash,
    imageBlob: prepared.blob,
    // The crop IS the tile: its actual (pixel-clamped) position in the full image.
    tileOffset: prepared.offset,
    isRegion: true,
    targetLang: providerSettings.targetLang,
    sourceLangHint: providerSettings.sourceLangHint,
    priority: 0,
  };

  const provider = createProvider(providerSettings);
  const queue = getTranslationQueue(settings.concurrency);
  // Priority 0: a user gesture is the most urgent thing we have (handoff item 3).
  const page = await queue.add(
    (qSignal) => provider.translatePage(job, providerSettings, qSignal),
    0,
    signal,
  );

  // F17 must count region calls (one provider image request per crop).
  void recordUsage(usageFromPage(page, 1));
  return page;
}

/** The region-translate slice of the background message router (Phase 7). */
export function createRegionHandlers(): MessageHandlers {
  return {
    translateRegion: async (req, _sender: browser.Runtime.MessageSender) => {
      // Share the cancellation registry with page translations so the existing
      // cancelTranslation message aborts regions too (handoff item 3).
      const controller = new AbortController();
      if (req.requestId) registerRequestController(req.requestId, controller);
      try {
        const settings = await loadSettings();
        const providerSettings = deriveProviderSettings(settings);
        if (req.targetLang) providerSettings.targetLang = req.targetLang;

        const blob = await resolveRegionBytes(req, controller.signal);
        const page = await translateRegionImage(
          blob,
          req.crop,
          settings,
          providerSettings,
          controller.signal,
        );
        return { ok: true, page };
      } catch (err) {
        log.warn("translateRegion failed", err);
        return errorToTranslateResult(err);
      } finally {
        if (req.requestId) unregisterRequestController(req.requestId);
      }
    },
  };
}
