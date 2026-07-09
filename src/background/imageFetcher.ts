/**
 * Fetch image bytes in the BACKGROUND event page (§7.3, the critical CORS
 * gotcha).
 *
 * WHY this exists: a content script usually cannot read the pixel data of a
 * cross-origin image — drawing it to a canvas taints the canvas and
 * `getImageData`/`toBlob` throw. So the content script only ever sends us the
 * image URL; the background, holding the `<all_urls>` optional host permission,
 * fetches the raw bytes here (no CORS restriction on a permitted extension
 * fetch) and hands the Blob to `imagePrep.ts` for decoding/downscaling.
 *
 * Failures are surfaced as a typed {@link ImageFetchError} so callers can map a
 * reason to UI (and know an abort from a dead link). Per handoff rule 6, callers
 * fail soft: no overlay + a warning, never a broken host page.
 */
import { isAbortError } from "../shared/guards";
import { createLogger } from "../shared/log";

const log = createLogger("imageFetcher");

/** Why an image fetch failed — drives caller UX and retry decisions. */
export type ImageFetchReason =
  | "bad-url" // not a parseable absolute URL
  | "unsupported-scheme" // e.g. ftp:, chrome://
  | "http-error" // non-2xx response
  | "empty" // 2xx but zero-length body
  | "too-large" // body exceeds the sanity cap
  | "not-image" // server returned HTML/JSON (auth wall, error page)
  | "network" // connection reset, DNS, offline
  | "aborted"; // caller's AbortSignal fired

/** A typed image-fetch failure. `status` is set for `http-error`. */
export class ImageFetchError extends Error {
  readonly reason: ImageFetchReason;
  readonly status?: number;

  constructor(
    reason: ImageFetchReason,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ImageFetchError";
    this.reason = reason;
    this.status = options?.status;
  }
}

/** The raw image, ready to hand to `imagePrep.ts`. */
export interface FetchedImage {
  /** The downloaded bytes (still full-resolution — prep downscales). */
  blob: Blob;
  /** Best-known MIME type (`image/...`), from the header or the sniffed Blob. */
  contentType: string;
  /** URL after redirects (may differ from the requested URL). */
  finalUrl: string;
  /** `blob.size`, surfaced for logging/telemetry. */
  byteLength: number;
}

/** Schemes we will attempt to fetch. Everything else is rejected up front. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "data:",
  // WHY blob: stays allowed even though a page-created blob: URL usually can't
  // be fetched from the extension context (the blob URL store is origin-scoped):
  // it fails as a plain "network" error callers already fail-soft on, and blob
  // URLs minted in our own context do work. §7.3 screenshot fallback is the
  // real answer for blob-gated readers.
  "blob:",
]);

/**
 * Sanity cap on a single image download (40 MB). Guards against a mislinked
 * huge asset exhausting event-page memory; real manga pages are well under this
 * even before downscaling.
 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * Content types that are definitely NOT an image — almost always an auth wall,
 * a soft-404 HTML page, or a JSON error body served with a 200 (§7.3 fallback
 * territory). Anything not matching this (including `application/octet-stream`
 * or a missing header) is given the benefit of the doubt and left for the
 * decoder in `imagePrep.ts` to accept or reject.
 */
const NON_IMAGE_TYPE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript))/i;

/** First MIME token, lowercased and trimmed (`image/jpeg; charset=x` → `image/jpeg`). */
function normalizeContentType(raw: string | null): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Fetch the bytes of an on-page image by URL.
 *
 * WHY `cache: "force-cache"`: the host page already downloaded this image, so
 * its bytes are usually in the HTTP cache — reusing them avoids a second network
 * round trip and matches the exact bytes the user is looking at.
 * WHY `credentials: "include"`: reader sites often gate images behind cookies;
 * sending them mirrors how the page itself loaded the image. With host
 * permission this is not subject to CORS.
 *
 * @param url absolute image URL (content scripts always resolve to absolute).
 * @param signal optional abort signal from the job queue (§7.5 cancellation).
 * @returns the image blob plus metadata.
 * @throws {ImageFetchError} for every failure mode (see {@link ImageFetchReason}).
 */
export async function fetchImageBytes(
  url: string,
  signal?: AbortSignal,
): Promise<FetchedImage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageFetchError("bad-url", `Not an absolute URL: ${url}`);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new ImageFetchError(
      "unsupported-scheme",
      `Refusing to fetch scheme "${parsed.protocol}"`,
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new ImageFetchError("aborted", "Image fetch aborted", { cause: err });
    }
    throw new ImageFetchError("network", `Network error fetching ${url}`, {
      cause: err,
    });
  }

  if (!response.ok) {
    throw new ImageFetchError(
      "http-error",
      `HTTP ${response.status} fetching ${url}`,
      { status: response.status },
    );
  }

  const headerType = normalizeContentType(response.headers.get("content-type"));
  // Reject an obvious non-image early, before reading a potentially large body.
  if (headerType && NON_IMAGE_TYPE.test(headerType)) {
    throw new ImageFetchError(
      "not-image",
      `Expected an image but got "${headerType}" from ${url}`,
    );
  }

  // Cheap pre-check: trust a declared content-length to reject an oversized
  // body BEFORE buffering it into memory (the authoritative check on the real
  // blob.size still runs below).
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_IMAGE_BYTES) {
      throw new ImageFetchError(
        "too-large",
        `Image declares ${bytes} bytes (content-length), over the ${MAX_IMAGE_BYTES}-byte cap`,
      );
    }
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (err) {
    if (isAbortError(err)) {
      throw new ImageFetchError("aborted", "Image fetch aborted", { cause: err });
    }
    throw new ImageFetchError("network", `Failed reading image body from ${url}`, {
      cause: err,
    });
  }

  if (blob.size === 0) {
    throw new ImageFetchError("empty", `Empty image body from ${url}`);
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new ImageFetchError(
      "too-large",
      `Image is ${blob.size} bytes, over the ${MAX_IMAGE_BYTES}-byte cap`,
    );
  }

  // Fall back to the Blob's own sniffed type when the header was absent/ambiguous.
  const contentType = headerType || blob.type.toLowerCase();
  if (contentType && NON_IMAGE_TYPE.test(contentType)) {
    throw new ImageFetchError(
      "not-image",
      `Expected an image but got "${contentType}" from ${url}`,
    );
  }

  log.debug(`fetched ${blob.size}B (${contentType || "unknown type"}) from ${url}`);
  return {
    blob,
    contentType,
    finalUrl: response.url || url,
    byteLength: blob.size,
  };
}
