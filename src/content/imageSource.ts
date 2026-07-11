/**
 * Content-side image source classification + byte acquisition (§7.3).
 *
 * Factored out of `regionSelect.ts` in Phase 7.2 so BOTH the drag-select
 * fallback (F10) and the auto-translate viewport queue can share it: MangaDex
 * and other readers serve their pages as `blob:` object URLs, which the
 * background event page cannot fetch (a blob URL is scoped to the document that
 * created it), so the content script — the only context whose origin can read
 * them — acquires the bytes and ships them over the structured-clone message
 * boundary.
 *
 * Split per the pure-core / thin-shell rule:
 *  - PURE, unit-tested: {@link sourceKindForUrl} (scheme → {@link SourceKind})
 *    and {@link acquisitionPlan} (kind → how to get its bytes).
 *  - THIN shell: {@link acquireBlobBytes} / {@link acquireCanvasBytes} — the
 *    actual `fetch`/`toBlob` reads, kept minimal and browser-only (a tainted
 *    canvas throws `SecurityError`, a revoked blob URL throws on fetch — callers
 *    fail soft, rule 6).
 */

/** How an image's bytes reach the background. */
export type SourceKind = "img-http" | "img-data" | "img-blob" | "canvas" | "unsupported";

/**
 * Classify an `<img>` source URL into a {@link SourceKind} (canvas is decided by
 * element type in the shell, not here). Pure.
 */
export function sourceKindForUrl(url: string | null | undefined): SourceKind {
  if (!url) return "unsupported";
  if (url.startsWith("http://") || url.startsWith("https://")) return "img-http";
  if (url.startsWith("data:")) return "img-data";
  if (url.startsWith("blob:")) return "img-blob";
  return "unsupported";
}

/** What the shell must do to get a source's bytes to the background. */
export type AcquisitionPlan =
  /** Send the URL; the background fetches (reuses the HTTP cache, §7.3). */
  | { send: "url" }
  /** Read the bytes content-side and ship them (the background can't fetch these). */
  | { send: "bytes" }
  /** Not translatable. */
  | { send: "unsupported" };

/**
 * Decide how to acquire a source's bytes from its {@link SourceKind}. `http(s)`/
 * `data:` go by URL (background fetch); `blob:`/`<canvas>` are read content-side
 * because only the page's own origin can. Pure.
 */
export function acquisitionPlan(kind: SourceKind): AcquisitionPlan {
  switch (kind) {
    case "img-http":
    case "img-data":
      return { send: "url" };
    case "img-blob":
    case "canvas":
      return { send: "bytes" };
    case "unsupported":
      return { send: "unsupported" };
  }
}

/**
 * Raw image bytes read content-side, ready to ship over `runtime.sendMessage`.
 * WHY safe: Firefox structured-clones an ArrayBuffer intact; a future Chrome
 * port (JSON message passing) would need base64 here.
 */
export interface AcquiredBytes {
  imageBytes: ArrayBuffer;
  imageMime: string;
}

/**
 * Read a `blob:` object URL's bytes (the content script's own origin CAN fetch a
 * page-created blob URL, unlike the background). Throws on a revoked/unreadable
 * URL — the caller fails soft.
 */
export async function acquireBlobBytes(url: string): Promise<AcquiredBytes> {
  const response = await fetch(url);
  const blob = await response.blob();
  return { imageBytes: await blob.arrayBuffer(), imageMime: blob.type || "image/jpeg" };
}

/**
 * Read a `<canvas>`'s bytes as PNG. A cross-origin-tainted canvas throws
 * `SecurityError` (sync or via the null callback) — the caller fails soft.
 */
export async function acquireCanvasBytes(canvas: HTMLCanvasElement): Promise<AcquiredBytes> {
  const blob = await canvasToBlob(canvas);
  return { imageBytes: await blob.arrayBuffer(), imageMime: blob.type || "image/png" };
}

/** Promise-wrap `canvas.toBlob`; a cross-origin-tainted canvas throws SecurityError. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
        "image/png",
      );
    } catch (err) {
      // Some engines throw synchronously for a tainted canvas.
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
