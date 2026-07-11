import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import type { PageTranslation, TranslateJob } from "../../src/shared/types";

// Hoisted mocks: these are referenced inside vi.mock factories, which vitest
// hoists above the module body — so the values they close over must be hoisted too.
const { prepareRegionCropMock, cacheSpies, recordUsageMock } = vi.hoisted(() => ({
  prepareRegionCropMock: vi.fn(),
  cacheSpies: {
    cacheLookup: vi.fn(),
    cacheStorePage: vi.fn(),
    cacheStoreNegative: vi.fn(),
    buildCacheKey: vi.fn(() => "key"),
    shouldNegativeCache: vi.fn(() => false),
  },
  recordUsageMock: vi.fn(async (_entry: unknown) => undefined),
}));

// regionHandlers → translateHandlers → settings/cache → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// prepareRegionCrop needs OffscreenCanvas (absent in node) — stub it, keep the
// rest of imagePrep real (planRegionCrop etc. stay under test elsewhere).
vi.mock("../../src/background/imagePrep", async (orig) => {
  const actual = await orig<typeof import("../../src/background/imagePrep")>();
  return { ...actual, prepareRegionCrop: prepareRegionCropMock };
});

// The cache module: mocked so we can PROVE the region path never touches it
// (translateHandlers imports it, but translateRegion must not use it — item 3).
vi.mock("../../src/background/cache", () => cacheSpies);

// A controllable provider so we don't need a real HTTP round trip. `let` is only
// dereferenced at call time (runtime), so it needn't be hoisted.
let providerTranslate: (job: TranslateJob, s: unknown, signal: AbortSignal) => Promise<PageTranslation>;
vi.mock("../../src/background/providers/factory", () => ({
  createProvider: () => ({
    translatePage: (job: TranslateJob, s: unknown, signal: AbortSignal) =>
      providerTranslate(job, s, signal),
  }),
  resolveEffectiveModel: () => "m",
}));

// Spy recordUsage (F17), keep usageFromPage real.
vi.mock("../../src/background/costTracker", async (orig) => {
  const actual = await orig<typeof import("../../src/background/costTracker")>();
  return { ...actual, recordUsage: recordUsageMock };
});

import { createRegionHandlers } from "../../src/background/regionHandlers";
import {
  createTranslateHandlers,
  resetRequestControllersForTest,
  resetTranslationQueueForTest,
} from "../../src/background/translateHandlers";
import type browser from "webextension-polyfill";

const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;
const CROP = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

function page(overrides: Partial<PageTranslation> = {}): PageTranslation {
  return {
    imageHash: "crop-hash",
    sourceLang: "ja",
    targetLang: "en",
    regions: [
      { bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, original: "やあ", translated: "Hey", isSfx: false },
    ],
    model: "m",
    provider: "gemini",
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  resetRequestControllersForTest();
  resetTranslationQueueForTest();
  prepareRegionCropMock.mockReset();
  recordUsageMock.mockClear();
  for (const spy of Object.values(cacheSpies)) spy.mockClear();
  // Default: a successful crop prep and an immediate provider result.
  prepareRegionCropMock.mockResolvedValue({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    offset: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    widthPx: 500,
    heightPx: 500,
  });
  providerTranslate = async () => page();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("regionHandlers — translateRegion", () => {
  it("url path: fetches, crops, translates, and never touches the cache (item 3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
    let seenJob: TranslateJob | undefined;
    providerTranslate = async (job) => {
      seenJob = job;
      return page();
    };

    const region = createRegionHandlers();
    const result = await region.translateRegion!(
      { imageUrl: "https://x/y.jpg", crop: CROP, requestId: "r1" },
      SENDER,
    );

    expect(result.ok).toBe(true);
    // The crop is threaded as a tile + region job (§4.3 + remap).
    expect(seenJob?.isRegion).toBe(true);
    expect(seenJob?.tileOffset).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    // F17: exactly one image call recorded.
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock.mock.calls[0]![0]).toMatchObject({ images: 1 });
    // No caching for regions.
    expect(cacheSpies.cacheLookup).not.toHaveBeenCalled();
    expect(cacheSpies.cacheStorePage).not.toHaveBeenCalled();
    expect(cacheSpies.cacheStoreNegative).not.toHaveBeenCalled();
  });

  it("bytes path: uses the supplied ArrayBuffer, no network fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const region = createRegionHandlers();
    const result = await region.translateRegion!(
      {
        imageBytes: new Uint8Array([1, 2, 3, 4]).buffer,
        imageMime: "image/png",
        crop: CROP,
      },
      SENDER,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // bytes came over the message
    // The crop prep got a Blob built from the bytes.
    expect(prepareRegionCropMock).toHaveBeenCalledTimes(1);
  });

  it("neither source → a network-kind failure result", async () => {
    const region = createRegionHandlers();
    const result = await region.translateRegion!({ crop: CROP }, SENDER);
    expect(result).toMatchObject({ ok: false, errorKind: "network" });
  });

  it("both sources → a network-kind failure result", async () => {
    const region = createRegionHandlers();
    const result = await region.translateRegion!(
      { imageUrl: "https://x/y.jpg", imageBytes: new Uint8Array([1]).buffer, crop: CROP },
      SENDER,
    );
    expect(result).toMatchObject({ ok: false, errorKind: "network" });
  });

  it("too-small crop → a malformed-kind failure result", async () => {
    prepareRegionCropMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Blob([new Uint8Array([9])], { type: "image/jpeg" }), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
    const region = createRegionHandlers();
    const result = await region.translateRegion!(
      { imageUrl: "https://x/y.jpg", crop: CROP },
      SENDER,
    );
    expect(result).toMatchObject({ ok: false, errorKind: "malformed" });
  });

  it("cancelTranslation aborts an in-flight region request (shared registry)", async () => {
    let reached!: () => void;
    const atProvider = new Promise<void>((r) => (reached = r));
    providerTranslate = (_job, _s, signal) =>
      new Promise<PageTranslation>((_resolve, reject) => {
        reached();
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });

    const region = createRegionHandlers();
    const translate = createTranslateHandlers();
    const pending = region.translateRegion!(
      {
        imageBytes: new Uint8Array([1, 2, 3]).buffer,
        imageMime: "image/jpeg",
        crop: CROP,
        requestId: "rq",
      },
      SENDER,
    );
    await atProvider; // now hanging inside the provider, controller registered

    void translate.cancelTranslation!({ requestId: "rq" }, SENDER);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorKind: "aborted" });
  });
});
