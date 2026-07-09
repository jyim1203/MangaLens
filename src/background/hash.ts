/**
 * SHA-256 hashing of image bytes — the primary translation-cache key (§7.3, F13).
 *
 * The hash is taken over the EXACT bytes that get sent to the provider (i.e. the
 * downscaled/tiled JPEG produced by {@link import("./imagePrep")}, not the
 * original download), so a cache hit guarantees the provider would have seen an
 * identical image. That value is {@link import("../shared/types").TranslateJob.imageHash}.
 *
 * The full cache key composes this digest with target language, model, and
 * {@link import("../shared/constants").PROMPT_VERSION}; that composition lives in
 * `cache.ts` (Phase 4), not here — this module does one thing: bytes → hex.
 *
 * Uses WebCrypto {@link SubtleCrypto}, available both in the Firefox event page
 * and in the Node test runtime (`globalThis.crypto`), so no browser mock is
 * needed to test it.
 */

/** Anything hashable: a Blob, a raw ArrayBuffer, or any typed-array view. */
export type HashInput = Blob | ArrayBuffer | ArrayBufferView;

/** Resolve the platform SubtleCrypto (event page or Node), or fail loudly. */
function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    // WHY throw rather than fail soft: hashing underpins the cache key; a missing
    // WebCrypto is an environment bug, not a per-image error to swallow.
    throw new Error("WebCrypto SubtleCrypto is unavailable in this context");
  }
  return c.subtle;
}

/** Normalize any {@link HashInput} to a contiguous ArrayBuffer for digesting. */
async function toArrayBuffer(input: HashInput): Promise<ArrayBuffer> {
  if (input instanceof Blob) return input.arrayBuffer();
  if (input instanceof ArrayBuffer) return input;
  // ArrayBufferView (Uint8Array, DataView, …): copy out its exact window, since
  // the view may cover only part of a larger backing buffer.
  const view = input;
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

/** Lowercase hex encoding of a digest buffer. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Compute the SHA-256 of `input` and return it as a 64-char lowercase hex
 * string. Stable across calls and across input representations: the same bytes
 * as a Blob, an ArrayBuffer, or a Uint8Array all produce the same digest.
 *
 * @param input image bytes (Blob / ArrayBuffer / typed-array view).
 * @returns the hex-encoded SHA-256 digest.
 */
export async function sha256Hex(input: HashInput): Promise<string> {
  const data = await toArrayBuffer(input);
  const digest = await getSubtle().digest("SHA-256", data);
  return toHex(digest);
}
