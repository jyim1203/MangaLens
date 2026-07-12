import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// Mock the cache module so we can drive cacheLookup / countCacheForOrigin
// deterministically; every OTHER export (buildCacheKey, stores, …) stays real.
vi.mock("../../src/background/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/background/cache")>();
  return {
    ...actual,
    cacheLookup: vi.fn(),
    countCacheForOrigin: vi.fn(),
  };
});

import {
  createTranslateHandlers,
  resetInflightForTest,
  resetRequestControllersForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
  sharedAbortsSizeForTest,
} from "../../src/background/translateHandlers";
import { cacheLookup, countCacheForOrigin } from "../../src/background/cache";
import type { PageTranslation } from "../../src/shared/types";
import type browser from "webextension-polyfill";

const mockLookup = vi.mocked(cacheLookup);
const mockCount = vi.mocked(countCacheForOrigin);

const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;

const PAGE: PageTranslation = {
  imageHash: "abc",
  sourceLang: "ja",
  targetLang: "en",
  regions: [],
  model: "m",
  provider: "anthropic",
  createdAt: 1,
};

/** Stub fetch so the fetch→hash→key block reaches cacheLookup (a valid image). */
function stubImageFetch(): void {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    ),
  );
}

describe("translateHandlers — cacheOnly probe (Phase 7.6 hydrate)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetRequestControllersForTest();
    resetSharedAbortsForTest();
    resetInflightForTest();
    resetTranslationQueueForTest();
    mockLookup.mockReset();
    mockCount.mockReset();
    stubImageFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("miss → the not-cached arm, and it never coalesces or enqueues", async () => {
    mockLookup.mockResolvedValue({ status: "miss" });
    const handlers = createTranslateHandlers();

    const result = await handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "p1", cacheOnly: true },
      SENDER,
    );

    expect(result).toEqual({ ok: false, errorKind: "not-cached" });
    // The coalesce block was skipped entirely — a leader always creates a
    // SharedAbort, so an empty registry proves nothing was queued/coalesced.
    expect(sharedAbortsSizeForTest()).toBe(0);
  });

  it("hit → returns the cached page (no provider call)", async () => {
    mockLookup.mockResolvedValue({ status: "hit", page: PAGE });
    const handlers = createTranslateHandlers();

    const result = await handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "p2", cacheOnly: true },
      SENDER,
    );

    expect(result).toEqual({ ok: true, page: PAGE });
  });

  it("live negative → the mapped provider error (a cached negative IS a result)", async () => {
    mockLookup.mockResolvedValue({
      status: "negative",
      errorKind: "refusal",
      message: "provider declined",
    });
    const handlers = createTranslateHandlers();

    const result = await handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "p3", cacheOnly: true },
      SENDER,
    );

    expect(result).toEqual({
      ok: false,
      errorKind: "refusal",
      message: "provider declined",
    });
    expect(sharedAbortsSizeForTest()).toBe(0);
  });
});

describe("translateHandlers — countCachedForSite (Phase 7.6 hydrate gate)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    mockCount.mockReset();
  });

  it("returns the origin's cache count from the cache helper", async () => {
    mockCount.mockResolvedValue(7);
    const handlers = createTranslateHandlers();
    const result = await handlers.countCachedForSite!(undefined, SENDER);
    expect(result).toEqual({ count: 7 });
    expect(mockCount).toHaveBeenCalledWith("reader.example.com");
  });

  it("returns 0 without touching the cache when the sender has no origin", async () => {
    const handlers = createTranslateHandlers();
    const result = await handlers.countCachedForSite!(
      undefined,
      {} as browser.Runtime.MessageSender,
    );
    expect(result).toEqual({ count: 0 });
    expect(mockCount).not.toHaveBeenCalled();
  });
});
