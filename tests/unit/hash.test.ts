import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/background/hash";

// Known-answer vectors (FIPS 180-4 / RFC): these never change, so they double
// as a stability guard — a regression in encoding would break them.
const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("background/hash — sha256Hex", () => {
  it("matches the known SHA-256 of 'abc' (happy path)", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256Hex(bytes)).toBe(SHA256_ABC);
  });

  it("hashes empty input to the canonical empty digest (edge: zero bytes)", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(SHA256_EMPTY);
  });

  it("is stable: identical bytes hash identically across calls and representations", async () => {
    const text = new TextEncoder().encode("manga page bytes");
    const buffer = text.buffer.slice(0) as ArrayBuffer;
    const blob = new Blob([text]);

    const a = await sha256Hex(text);
    const b = await sha256Hex(text);
    const fromBuffer = await sha256Hex(buffer);
    const fromBlob = await sha256Hex(blob);

    expect(a).toBe(b);
    expect(fromBuffer).toBe(a);
    expect(fromBlob).toBe(a);
  });

  it("produces different digests for different bytes (edge: sensitivity)", async () => {
    const one = await sha256Hex(new TextEncoder().encode("page-1"));
    const two = await sha256Hex(new TextEncoder().encode("page-2"));
    expect(one).not.toBe(two);
  });

  it("hashes only a typed-array view's own window, not its backing buffer", async () => {
    // A view offset into a larger buffer must hash the same as a standalone copy
    // of just those bytes — proves toArrayBuffer respects byteOffset/byteLength.
    const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
    const view = backing.subarray(2, 5); // [1,2,3]
    const standalone = new Uint8Array([1, 2, 3]);
    expect(await sha256Hex(view)).toBe(await sha256Hex(standalone));
  });

  it("returns a 64-char lowercase hex string", async () => {
    const digest = await sha256Hex(new TextEncoder().encode("x"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
