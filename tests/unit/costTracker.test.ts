import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// costTracker persistence uses storage.local via the polyfill; swap in the fake.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  COST_KEY,
  PRICING,
  addUsage,
  emptyCostStats,
  estimateRequestCost,
  getCostStats,
  recordUsage,
  resetCostStats,
  usageFromPage,
  type CostStats,
  type UsageEntry,
} from "../../src/background/costTracker";
import type { PageTranslation } from "../../src/shared/types";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return { provider: "gemini", model: "flash", tokensIn: 0, tokensOut: 0, images: 1, ...overrides };
}

describe("costTracker — estimateRequestCost (pure)", () => {
  it("prices input + output tokens from the table", () => {
    const g = PRICING.gemini;
    const cost = estimateRequestCost(entry({ tokensIn: 1_000_000, tokensOut: 1_000_000 }));
    expect(cost).toBeCloseTo(g.inputPerMTokens + g.outputPerMTokens, 10);
  });

  it("scales linearly and treats negative counts as zero", () => {
    const half = estimateRequestCost(entry({ tokensIn: 500_000, tokensOut: 0 }));
    expect(half).toBeCloseTo(PRICING.gemini.inputPerMTokens / 2, 10);
    expect(estimateRequestCost(entry({ tokensIn: -100, tokensOut: -100 }))).toBe(0);
  });

  it("uses per-provider pricing", () => {
    const gemini = estimateRequestCost(entry({ provider: "gemini", tokensIn: 1_000_000 }));
    const anthropic = estimateRequestCost(entry({ provider: "anthropic", tokensIn: 1_000_000 }));
    expect(anthropic).toBeGreaterThan(gemini); // Haiku tier costs more than Flash tier
  });
});

describe("costTracker — addUsage (pure)", () => {
  it("accumulates per-provider totals and the grand total", () => {
    let stats = emptyCostStats();
    stats = addUsage(stats, entry({ tokensIn: 1_000_000, tokensOut: 0, images: 1 }), 100);
    stats = addUsage(stats, entry({ tokensIn: 1_000_000, tokensOut: 0, images: 2 }), 200);

    const gem = stats.byProvider.gemini;
    expect(gem?.calls).toBe(2);
    expect(gem?.images).toBe(3);
    expect(gem?.tokensIn).toBe(2_000_000);
    expect(stats.totalEstCostUsd).toBeCloseTo(PRICING.gemini.inputPerMTokens * 2, 10);
    expect(stats.updatedAt).toBe(200);
  });

  it("keeps providers separate", () => {
    let stats = emptyCostStats();
    stats = addUsage(stats, entry({ provider: "gemini", tokensIn: 1_000_000 }));
    stats = addUsage(stats, entry({ provider: "openai", tokensIn: 1_000_000 }));
    expect(stats.byProvider.gemini?.calls).toBe(1);
    expect(stats.byProvider.openai?.calls).toBe(1);
  });

  it("accumulates provider image requests from a multi-tile page (item 2)", () => {
    let stats = emptyCostStats();
    stats = addUsage(stats, entry({ images: 4 })); // a 4-tile webtoon page
    stats = addUsage(stats, entry({ images: 1 })); // a normal page
    // `calls` counts pages/events; `images` counts provider image requests.
    expect(stats.byProvider.gemini?.calls).toBe(2);
    expect(stats.byProvider.gemini?.images).toBe(5);
  });

  it("is pure — does not mutate the input stats", () => {
    const before = emptyCostStats();
    const snapshot = JSON.stringify(before);
    const after = addUsage(before, entry({ tokensIn: 1_000_000 }));
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after).not.toBe(before);
  });
});

describe("costTracker — usageFromPage (pure)", () => {
  function page(overrides: Partial<PageTranslation> = {}): PageTranslation {
    return {
      imageHash: "h",
      sourceLang: "ja",
      targetLang: "en",
      regions: [],
      model: "flash",
      provider: "gemini",
      createdAt: 1,
      ...overrides,
    };
  }

  it("reads provider/model/tokens off a page", () => {
    expect(usageFromPage(page({ tokensIn: 500, tokensOut: 120 }))).toEqual({
      provider: "gemini",
      model: "flash",
      tokensIn: 500,
      tokensOut: 120,
      images: 1,
    });
  });

  it("treats missing token counts as zero and carries the image count", () => {
    expect(usageFromPage(page(), 3)).toMatchObject({ tokensIn: 0, tokensOut: 0, images: 3 });
  });
});

describe("costTracker — persistence (fake-browser)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getCostStats returns a zeroed record when nothing is stored", async () => {
    const stats = await getCostStats();
    expect(stats).toEqual(emptyCostStats());
  });

  it("recordUsage persists and accumulates across calls", async () => {
    await recordUsage(entry({ tokensIn: 1_000_000, tokensOut: 0 }));
    const after = await recordUsage(entry({ tokensIn: 1_000_000, tokensOut: 0 }));

    expect(after.byProvider.gemini?.calls).toBe(2);
    // Persisted, not just returned.
    const stored = (await fakeBrowser.storage.local.get(COST_KEY))[COST_KEY] as CostStats;
    expect(stored.byProvider.gemini?.calls).toBe(2);
    expect(stored.totalEstCostUsd).toBeCloseTo(PRICING.gemini.inputPerMTokens * 2, 10);
  });

  it("resetCostStats zeroes the persisted totals", async () => {
    await recordUsage(entry({ tokensIn: 1_000_000 }));
    const zero = await resetCostStats();
    expect(zero).toEqual(emptyCostStats());
    expect(await getCostStats()).toEqual(emptyCostStats());
  });

  it("ignores a corrupt stored value and falls back to zero", async () => {
    await fakeBrowser.storage.local.set({ [COST_KEY]: "not an object" });
    expect(await getCostStats()).toEqual(emptyCostStats());
  });

  it("serializes concurrent recordUsage so no update is lost (item 1)", async () => {
    // Defer every get by a microtask so the read-modify-write windows overlap —
    // exactly the lost-update race the write chain must prevent.
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((keys) =>
      Promise.resolve().then(() => realGet(keys)),
    );

    // Fire both WITHOUT awaiting the first — the chain must still serialize them.
    await Promise.all([
      recordUsage(entry({ tokensIn: 1_000_000 })),
      recordUsage(entry({ tokensIn: 1_000_000 })),
    ]);

    const stored = await getCostStats();
    expect(stored.byProvider.gemini?.calls).toBe(2);
    expect(stored.byProvider.gemini?.tokensIn).toBe(2_000_000);
  });

  it("a failed write link does not poison the chain (item 1)", async () => {
    // The first write fails to persist; the chain must survive so the next one succeeds.
    vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValueOnce(new Error("disk full"));

    await recordUsage(entry({ tokensIn: 1_000_000 })); // fails to persist
    const after = await recordUsage(entry({ tokensIn: 1_000_000 })); // must persist

    expect(after.byProvider.gemini?.calls).toBe(1); // only the successful write counted
    const stored = await getCostStats();
    expect(stored.byProvider.gemini?.calls).toBe(1);
  });
});
