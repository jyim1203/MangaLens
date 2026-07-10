import { describe, expect, it } from "vitest";

// cache.ts imports only log/constants/types/idb — no webextension-polyfill — so
// the pure core is testable without a browser mock. The IndexedDB shell
// (cacheLookup/cacheStorePage/…) is the untested driver: IndexedDB doesn't exist
// in the Node test runtime, same reason prepareImage is untested.
import {
  buildCacheKey,
  classifyCacheLookup,
  estimatePageBytes,
  planLruEviction,
  totalAfterPut,
  shouldNegativeCache,
  NEGATIVE_TTL_MS,
  type CacheKeyParts,
  type CacheRecord,
  type EvictionCandidate,
} from "../../src/background/cache";
import type { PageTranslation, ProviderErrorKind } from "../../src/shared/types";

/** A complete {@link CacheKeyParts} for buildCacheKey tests, overridable per case. */
function keyParts(overrides: Partial<CacheKeyParts> = {}): CacheKeyParts {
  return {
    provider: "gemini",
    imageHash: "abc",
    targetLang: "en",
    model: "gemini-2.0-flash",
    preserveHonorifics: true,
    readingDirection: "auto",
    sourceLangHint: undefined,
    promptVersion: 1,
    ...overrides,
  };
}

function page(overrides: Partial<PageTranslation> = {}): PageTranslation {
  return {
    imageHash: "h",
    sourceLang: "ja",
    targetLang: "en",
    regions: [],
    model: "m",
    provider: "gemini",
    createdAt: 1,
    ...overrides,
  };
}

describe("cache — buildCacheKey", () => {
  it("produces the documented composite format and is deterministic", () => {
    const parts = keyParts({ readingDirection: "rtl", sourceLangHint: "ja" });
    expect(buildCacheKey(parts)).toBe("gemini|abc|en|gemini-2.0-flash|h1|drtl|sja|p1");
    // Stable across calls with the same inputs.
    expect(buildCacheKey(parts)).toBe(buildCacheKey(parts));
  });

  it("encodes honorifics-off as h0 and an absent source-lang hint as s-", () => {
    const key = buildCacheKey(keyParts({ preserveHonorifics: false, sourceLangHint: undefined }));
    expect(key).toContain("|h0|");
    expect(key).toContain("|s-|");
  });

  it("changes when ANY output-shaping field changes (no cross-contamination)", () => {
    const base = keyParts();
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, provider: "openai" })).not.toBe(key);
    expect(buildCacheKey({ ...base, imageHash: "xyz" })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: "fr" })).not.toBe(key);
    expect(buildCacheKey({ ...base, model: "other" })).not.toBe(key);
    expect(buildCacheKey({ ...base, preserveHonorifics: false })).not.toBe(key);
    expect(buildCacheKey({ ...base, readingDirection: "ltr" })).not.toBe(key);
    expect(buildCacheKey({ ...base, sourceLangHint: "ja" })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptVersion: 2 })).not.toBe(key);
  });

  it("has no temperature input — the key is always exactly 8 segments", () => {
    // temperature is a continuous knob, deliberately excluded (item 4); parts
    // have no field for it, so it can never fragment the cache.
    expect(buildCacheKey(keyParts()).split("|")).toHaveLength(8);
  });

  it("delimiter-proofs free-text so a '|' in a model can't collide with a neighbor", () => {
    const sneaky = buildCacheKey(keyParts({ model: "a|b" }));
    const neighbor = buildCacheKey(keyParts({ model: "a", targetLang: "b" }));
    expect(sneaky).not.toBe(neighbor);
    // The literal delimiter never leaks out of the encoded segment.
    expect(sneaky.split("|")).toHaveLength(8);
  });
});

describe("cache — estimatePageBytes", () => {
  it("a negative (null) entry is tiny; a bigger page estimates larger", () => {
    const empty = estimatePageBytes(null);
    const small = estimatePageBytes(page({ regions: [] }));
    const big = estimatePageBytes(
      page({
        regions: Array.from({ length: 20 }, (_, i) => ({
          bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
          original: `テキスト${i}`,
          translated: `text ${i}`,
          isSfx: false,
        })),
      }),
    );
    expect(empty).toBeLessThan(small);
    expect(small).toBeLessThan(big);
  });

  it("counts multi-byte (CJK) characters as more than one byte", () => {
    const ascii = estimatePageBytes(
      page({ regions: [{ bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, original: "aaa", translated: "x", isSfx: false }] }),
    );
    const cjk = estimatePageBytes(
      page({ regions: [{ bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, original: "日本語", translated: "x", isSfx: false }] }),
    );
    // Same character count, but CJK is 3 bytes/char in UTF-8 → larger estimate.
    expect(cjk).toBeGreaterThan(ascii);
  });
});

describe("cache — classifyCacheLookup", () => {
  const now = 1_000_000;

  function record(overrides: Partial<CacheRecord>): CacheRecord {
    return {
      key: "k",
      imageHash: "h",
      page: null,
      bytes: 10,
      createdAt: now,
      lastAccess: now,
      ...overrides,
    };
  }

  it("undefined → miss", () => {
    expect(classifyCacheLookup(undefined, now)).toEqual({ status: "miss" });
  });

  it("a positive record → hit carrying the page", () => {
    const p = page();
    const result = classifyCacheLookup(record({ page: p }), now);
    expect(result).toEqual({ status: "hit", page: p });
  });

  it("a live negative record → negative with kind + message", () => {
    const result = classifyCacheLookup(
      record({ page: null, errorKind: "refusal", message: "declined", expiresAt: now + 1000 }),
      now,
    );
    expect(result).toEqual({ status: "negative", errorKind: "refusal", message: "declined" });
  });

  it("an expired negative record → expired (re-translatable)", () => {
    const result = classifyCacheLookup(
      record({ page: null, errorKind: "malformed", message: "bad", expiresAt: now - 1 }),
      now,
    );
    expect(result).toEqual({ status: "expired" });
  });

  it("expiry takes precedence even if a page were present (defensive)", () => {
    const result = classifyCacheLookup(record({ page: page(), expiresAt: now - 1 }), now);
    expect(result).toEqual({ status: "expired" });
  });
});

describe("cache — shouldNegativeCache", () => {
  it("caches only deterministic failures (malformed, refusal)", () => {
    expect(shouldNegativeCache("malformed")).toBe(true);
    expect(shouldNegativeCache("refusal")).toBe(true);
  });

  it("never caches transient failures", () => {
    const transient: ProviderErrorKind[] = ["auth", "rate-limit", "network", "aborted", "unknown"];
    for (const kind of transient) expect(shouldNegativeCache(kind)).toBe(false);
  });

  it("NEGATIVE_TTL_MS is the documented 10 minutes", () => {
    expect(NEGATIVE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe("cache — totalAfterPut", () => {
  it("adds new bytes for a fresh key (nothing overwritten)", () => {
    expect(totalAfterPut(1000, 0, 250)).toBe(1250);
  });

  it("nets out the overwritten record's bytes", () => {
    expect(totalAfterPut(1000, 200, 250)).toBe(1050);
  });

  it("never goes negative when accounting drifts", () => {
    expect(totalAfterPut(100, 500, 0)).toBe(0);
  });
});

describe("cache — planLruEviction", () => {
  function e(key: string, bytes: number): EvictionCandidate {
    return { key, bytes };
  }

  it("under cap → evict nothing, total unchanged", () => {
    expect(planLruEviction([e("a", 100), e("b", 100)], 200, 500)).toEqual({
      keys: [],
      remaining: 200,
    });
  });

  it("over cap → drops oldest-first (input order) until it fits", () => {
    // ordered oldest→newest; total 300, cap 250 → drop just the oldest.
    const plan = planLruEviction([e("oldest", 100), e("mid", 100), e("newest", 100)], 300, 250);
    expect(plan.keys).toEqual(["oldest"]);
    expect(plan.remaining).toBe(200);
  });

  it("drops multiple when far over cap", () => {
    const plan = planLruEviction(
      [e("a", 100), e("b", 100), e("c", 100), e("d", 100)],
      400,
      150,
    );
    expect(plan.keys).toEqual(["a", "b", "c"]);
    expect(plan.remaining).toBe(100);
  });

  it("cap ≤ 0 evicts everything and floors remaining at 0", () => {
    const plan = planLruEviction([e("a", 100), e("b", 50)], 150, 0);
    expect(plan.keys).toEqual(["a", "b"]);
    expect(plan.remaining).toBe(0);
  });
});
