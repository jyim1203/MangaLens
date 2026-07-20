import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// --- Mock the browser-only + storage deps so the batch WIRING is drivable in
//     node (real queue/coalesce/sharedAbort/batch collector, fake I/O). ---------

const cacheStorePage = vi.fn(async (..._a: unknown[]) => {});
const cacheStoreNegative = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../src/background/cache", () => ({
  buildCacheKey: (o: { imageHash: string }) => `key-${o.imageHash}`,
  cacheLookup: async () => ({ status: "miss" as const }),
  cacheStorePage: (...a: unknown[]) => cacheStorePage(...a),
  cacheStoreNegative: (...a: unknown[]) => cacheStoreNegative(...a),
  classifyResnap: () => false, // §3: only the (never-taken here) hit path uses it
  countCacheForOrigin: async () => 0,
  shouldNegativeCache: (kind: string) => kind === "malformed" || kind === "refusal",
}));

let hashCounter = 0;
vi.mock("../../src/background/hash", () => ({
  sha256Hex: async () => `pagehash-${hashCounter++}`,
}));

vi.mock("../../src/background/imageFetcher", async (orig) => {
  const actual = await orig<typeof import("../../src/background/imageFetcher")>();
  return {
    ...actual,
    fetchImageBytes: async () => ({ blob: new Blob(["x"], { type: "image/jpeg" }) }),
  };
});

vi.mock("../../src/background/imagePrep", async (orig) => {
  const actual = await orig<typeof import("../../src/background/imagePrep")>();
  return {
    ...actual,
    // A single-tile page — the batchable shape (no tileOffset, tiled:false).
    prepareImage: async (blob: Blob) => ({
      tiles: [{ index: 0, blob, offset: { x: 0, y: 0, w: 1, h: 1 }, widthPx: 100, heightPx: 100 }],
      naturalWidthPx: 100,
      naturalHeightPx: 100,
      scaledWidthPx: 100,
      scaledHeightPx: 100,
      tiled: false,
    }),
  };
});

vi.mock("../../src/background/bubbleSnap", () => ({
  snapPageRegions: async (_blob: Blob, page: unknown) => page,
  SNAP_VERSION: 1, // §3: threaded into cacheStorePage on the miss path
}));

const recordUsage = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../src/background/costTracker", async (orig) => {
  const actual = await orig<typeof import("../../src/background/costTracker")>();
  return { ...actual, recordUsage: (...a: unknown[]) => recordUsage(...a) };
});

const translateBatch =
  vi.fn<(jobs: { imageHash: string }[], ...rest: unknown[]) => Promise<PageTranslation[]>>();
const translatePage =
  vi.fn<(job: { imageHash: string }, ...rest: unknown[]) => Promise<PageTranslation>>();
vi.mock("../../src/background/providers/factory", async (orig) => {
  const actual = await orig<typeof import("../../src/background/providers/factory")>();
  return { ...actual, createProvider: () => ({ translateBatch, translatePage }) };
});

import {
  createTranslateHandlers,
  translateImage,
  resetInflightForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
  resetRateGateForTest,
  resetBatchCollectorForTest,
  resetReprioritizeForTest,
  pendingReprioritizeSizeForTest,
  MAX_PENDING_REPRIORITIZE,
} from "../../src/background/translateHandlers";
import { PriorityQueue } from "../../src/background/queue";
import { ProviderError } from "../../src/background/providers/ProviderBase";
import type browser from "webextension-polyfill";
import {
  DEFAULT_SETTINGS,
  deriveProviderSettings,
  mergeSettings,
  type Settings,
} from "../../src/shared/settings";
import type { PageTranslation } from "../../src/shared/types";

function settings(patch: object = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

function fakePage(imageHash: string, tokensIn = 40, tokensOut = 4): PageTranslation {
  return {
    imageHash,
    sourceLang: "ja",
    targetLang: "en",
    regions: [],
    model: "m",
    provider: "gemini",
    tokensIn,
    tokensOut,
    createdAt: 1,
  };
}

/** Two eligible priority-2 misses → one batch group of 2 (pagesPerRequest: 2). */
async function runTwoBatched(priority = 2) {
  const s = settings({ pagesPerRequest: 2 });
  const ps = deriveProviderSettings(s);
  const pA = translateImage("https://x/a.jpg", s, ps, new AbortController().signal, priority, "x");
  const pB = translateImage("https://x/b.jpg", s, ps, new AbortController().signal, priority, "x");
  return Promise.allSettled([pA, pB]);
}

describe("translateHandlers — batch collector wiring (F12)", () => {
  beforeEach(() => {
    hashCounter = 0;
    translateBatch.mockReset();
    translatePage.mockReset();
    cacheStorePage.mockClear();
    cacheStoreNegative.mockClear();
    recordUsage.mockClear();
    resetInflightForTest();
    resetSharedAbortsForTest();
    resetTranslationQueueForTest();
    resetRateGateForTest();
    resetBatchCollectorForTest();
    resetReprioritizeForTest();
  });
  afterEach(() => {
    fakeBrowser.reset();
  });

  it("groups two priority-2 misses into ONE translateBatch call; each resolves + caches under its own key; usage recorded ONCE", async () => {
    translateBatch.mockImplementation(async (jobs: { imageHash: string }[]) =>
      jobs.map((j) => fakePage(j.imageHash)),
    );

    const results = await runTwoBatched();

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]![0]).toHaveLength(2); // two images in one request
    expect(translatePage).not.toHaveBeenCalled();

    // Each member resolved with its own page.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const hashes = results.map((r) => (r as PromiseFulfilledResult<PageTranslation>).value.imageHash);
    expect(new Set(hashes)).toEqual(new Set(["pagehash-0", "pagehash-1"]));

    // Cached per member (its own composite key), and usage recorded ONCE for the
    // batch (images = 2, tokens summed exactly).
    expect(cacheStorePage).toHaveBeenCalledTimes(2);
    const storedKeys = cacheStorePage.mock.calls.map((c) => c[0]);
    expect(new Set(storedKeys)).toEqual(new Set(["key-pagehash-0", "key-pagehash-1"]));
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ images: 2, tokensIn: 80, tokensOut: 8 });
  });

  it("split-retries each member SOLO on a malformed batch (never re-batches)", async () => {
    translateBatch.mockRejectedValue(new ProviderError("malformed", "bad batch"));
    translatePage.mockImplementation(async (job: { imageHash: string }) => fakePage(job.imageHash, 10, 1));

    const results = await runTwoBatched();

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translatePage).toHaveBeenCalledTimes(2); // each member retried solo
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(cacheStorePage).toHaveBeenCalledTimes(2);
    // Solo path records usage per member (not the one-batch event).
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it("fails EVERY member with the same error on auth (no split, no solo retry)", async () => {
    translateBatch.mockRejectedValue(new ProviderError("auth", "bad key"));

    const results = await runTwoBatched();

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translatePage).not.toHaveBeenCalled();
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: "auth" });
    }
    expect(cacheStorePage).not.toHaveBeenCalled();
  });

  it("keeps priority-0/1 (visible/near) jobs SOLO even with batching on", async () => {
    translatePage.mockImplementation(async (job: { imageHash: string }) => fakePage(job.imageHash));
    await runTwoBatched(0); // priority 0 → not eligible → solo path
    expect(translateBatch).not.toHaveBeenCalled();
    expect(translatePage).toHaveBeenCalledTimes(2);
  });

  it("does not batch when pagesPerRequest is 1 (batching off, the default)", async () => {
    translatePage.mockImplementation(async (job: { imageHash: string }) => fakePage(job.imageHash));
    const s = settings({ pagesPerRequest: 1 });
    const ps = deriveProviderSettings(s);
    await Promise.allSettled([
      translateImage("https://x/a.jpg", s, ps, new AbortController().signal, 2, "x"),
      translateImage("https://x/b.jpg", s, ps, new AbortController().signal, 2, "x"),
    ]);
    expect(translateBatch).not.toHaveBeenCalled();
    expect(translatePage).toHaveBeenCalledTimes(2);
  });

  // --- §4: a lone linger-flushed member must NOT go out as a batch-of-1 ---------

  it("routes a lone linger-flushed member SOLO — never a batch-of-1 (§4)", async () => {
    // ONE eligible member at pagesPerRequest 3: no size-flush, so it linger-flushes
    // as a group of 1. It must take the single-page path (translatePage), not
    // translateBatch — a batch of one amortizes nothing and trips the split ladder.
    translatePage.mockImplementation(async (job: { imageHash: string }) => fakePage(job.imageHash, 10, 1));
    const s = settings({ pagesPerRequest: 3 });
    const ps = deriveProviderSettings(s);

    const page = await translateImage("https://x/a.jpg", s, ps, new AbortController().signal, 2, "x");

    expect(translateBatch).not.toHaveBeenCalled();
    expect(translatePage).toHaveBeenCalledTimes(1);
    expect(page.imageHash).toBe("pagehash-0");
    expect(cacheStorePage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1); // solo records its own usage once
  });

  it("10 pages @ batch 3 → three translateBatch(3) + one solo = 4 provider calls (3+3+3+1)", async () => {
    translateBatch.mockImplementation(async (jobs: { imageHash: string }[]) =>
      jobs.map((j) => fakePage(j.imageHash)),
    );
    translatePage.mockImplementation(async (job: { imageHash: string }) => fakePage(job.imageHash));
    const s = settings({ pagesPerRequest: 3 });
    const ps = deriveProviderSettings(s);

    const pending = [];
    for (let i = 0; i < 10; i++) {
      pending.push(
        translateImage(`https://x/${i}.jpg`, s, ps, new AbortController().signal, 2, "x"),
      );
    }
    const results = await Promise.allSettled(pending);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // 3 size-flushed groups of 3 + the 10th linger-flushed solo = 4 provider calls.
    expect(translateBatch).toHaveBeenCalledTimes(3);
    for (const call of translateBatch.mock.calls) expect(call[0]).toHaveLength(3);
    expect(translatePage).toHaveBeenCalledTimes(1);
    expect(cacheStorePage).toHaveBeenCalledTimes(10); // every member cached under its own key
  });
});

describe("translateHandlers — reprioritizeTranslation (§2)", () => {
  const SENDER = { url: "https://x/ch" } as browser.Runtime.MessageSender;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const setPriorityCalls: number[] = [];
  let addJobSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    hashCounter = 0;
    translateBatch.mockReset();
    translatePage.mockReset();
    cacheStorePage.mockClear();
    recordUsage.mockClear();
    setPriorityCalls.length = 0;
    resetInflightForTest();
    resetSharedAbortsForTest();
    resetTranslationQueueForTest();
    resetRateGateForTest();
    resetBatchCollectorForTest();
    resetReprioritizeForTest();
    // Wrap every queue handle's setPriority so path (b) is observable.
    const realAddJob = PriorityQueue.prototype.addJob;
    addJobSpy = vi.spyOn(PriorityQueue.prototype, "addJob").mockImplementation(function (
      this: PriorityQueue,
      task: (s: AbortSignal) => Promise<unknown>,
      priority?: number,
      sig?: AbortSignal,
    ) {
      const handle = realAddJob.call(this, task, priority, sig);
      return {
        promise: handle.promise,
        setPriority: (p: number) => {
          setPriorityCalls.push(p);
          return handle.setPriority(p);
        },
      };
    } as typeof PriorityQueue.prototype.addJob);
  });
  afterEach(() => {
    addJobSpy?.mockRestore();
    fakeBrowser.reset();
  });

  it("(a) pulls a buffered batch member out of the collector and runs it SOLO", async () => {
    const s = settings({ pagesPerRequest: 2 });
    const ps = deriveProviderSettings(s);
    translatePage.mockImplementation(async (job) => fakePage(job.imageHash));
    // ONE eligible member → buffered in the collector (batchSize 2 → lingering).
    const p = translateImage(
      "https://x/a.jpg", s, ps, new AbortController().signal, 2, "x", undefined, undefined, false, "req-1",
    );
    await flush();
    expect(translateBatch).not.toHaveBeenCalled();

    createTranslateHandlers().reprioritizeTranslation!({ requestId: "req-1", priority: 0 }, SENDER);

    const page = await p;
    expect(page.imageHash).toBe("pagehash-0");
    expect(translatePage).toHaveBeenCalledTimes(1); // ran solo
    expect(translateBatch).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1); // solo member records its own usage
  });

  it("(b) calls setPriority on a queued solo job", async () => {
    const s = settings({ pagesPerRequest: 1 }); // solo path
    const ps = deriveProviderSettings(s);
    translatePage.mockReturnValue(new Promise(() => {})); // hang → handle stays registered
    void translateImage(
      "https://x/a.jpg", s, ps, new AbortController().signal, 2, "x", undefined, undefined, false, "req-b",
    );
    await flush();

    createTranslateHandlers().reprioritizeTranslation!({ requestId: "req-b", priority: 0 }, SENDER);
    expect(setPriorityCalls).toContain(0);
  });

  it("is a silent no-op for an unknown/settled id", () => {
    expect(() =>
      createTranslateHandlers().reprioritizeTranslation!({ requestId: "nope", priority: 0 }, SENDER),
    ).not.toThrow();
    expect(translatePage).not.toHaveBeenCalled();
    expect(setPriorityCalls).not.toContain(0);
  });

  it("cleans up the requestId→cacheKey mapping after settle (later reprioritize is a no-op)", async () => {
    const s = settings({ pagesPerRequest: 1 });
    const ps = deriveProviderSettings(s);
    translatePage.mockImplementation(async (job) => fakePage(job.imageHash));
    await translateImage(
      "https://x/a.jpg", s, ps, new AbortController().signal, 2, "x", undefined, undefined, false, "req-c",
    );
    setPriorityCalls.length = 0;
    createTranslateHandlers().reprioritizeTranslation!({ requestId: "req-c", priority: 0 }, SENDER);
    expect(setPriorityCalls).not.toContain(0); // mapping gone → no handle found
  });

  // --- §5: an upgrade that arrives BEFORE the miss registers must not be lost ---

  it("buffers a reprioritize that arrives BEFORE registration, applying it once the miss registers (§5)", async () => {
    const s = settings({ pagesPerRequest: 1 }); // solo path
    const ps = deriveProviderSettings(s);
    translatePage.mockReturnValue(new Promise(() => {})); // hang → handle stays queued

    // The upgrade lands first — no requestId→cacheKey mapping yet → buffered, no apply.
    createTranslateHandlers().reprioritizeTranslation!({ requestId: "req-early", priority: 0 }, SENDER);
    expect(setPriorityCalls).not.toContain(0);
    expect(pendingReprioritizeSizeForTest()).toBe(1);

    // Now the miss runs, registers the mapping, and drains the buffer → setPriority(0).
    void translateImage(
      "https://x/a.jpg", s, ps, new AbortController().signal, 2, "x", undefined, undefined, false, "req-early",
    );
    await flush();
    expect(setPriorityCalls).toContain(0);
    expect(pendingReprioritizeSizeForTest()).toBe(0); // drained, not leaked
  });

  it("bounds the pending buffer — the oldest is evicted past the cap (§5)", () => {
    const handlers = createTranslateHandlers();
    for (let i = 0; i < MAX_PENDING_REPRIORITIZE + 25; i++) {
      handlers.reprioritizeTranslation!({ requestId: `r${i}`, priority: 0 }, SENDER);
    }
    expect(pendingReprioritizeSizeForTest()).toBe(MAX_PENDING_REPRIORITIZE);
  });
});
