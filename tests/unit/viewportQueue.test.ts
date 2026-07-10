import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// viewportQueue.ts → messages.ts → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import { planEnqueues } from "../../src/content/viewportQueue";

const base = { count: 5, requested: new Set<number>(), prefetchAhead: 3 };

describe("viewportQueue — planEnqueues (§7.5 priority planner)", () => {
  it("visible tier enqueues the page at priority 0 plus N+1..N+3 prefetch at priority 2", () => {
    expect(planEnqueues({ ...base, changedIndex: 0, changedTier: 0 })).toEqual([
      { index: 0, priority: 0 },
      { index: 1, priority: 2 },
      { index: 2, priority: 2 },
      { index: 3, priority: 2 },
    ]);
  });

  it("near tier enqueues only the page at priority 1 (no prefetch)", () => {
    expect(planEnqueues({ ...base, changedIndex: 2, changedTier: 1 })).toEqual([
      { index: 2, priority: 1 },
    ]);
  });

  it("skips already-requested indices (no re-send, no priority upgrade)", () => {
    expect(
      planEnqueues({
        ...base,
        changedIndex: 0,
        changedTier: 0,
        requested: new Set([0, 2]),
      }),
    ).toEqual([
      { index: 1, priority: 2 },
      { index: 3, priority: 2 },
    ]);
  });

  it("respects prefetchAhead depth and document order", () => {
    expect(
      planEnqueues({ ...base, changedIndex: 0, changedTier: 0, prefetchAhead: 1 }),
    ).toEqual([
      { index: 0, priority: 0 },
      { index: 1, priority: 2 },
    ]);
  });

  it("never prefetches past the end of the candidate list", () => {
    expect(
      planEnqueues({ ...base, count: 3, changedIndex: 2, changedTier: 0 }),
    ).toEqual([{ index: 2, priority: 0 }]);
  });

  it("does not enqueue a below-range or fully-requested change", () => {
    expect(
      planEnqueues({
        ...base,
        changedIndex: 4,
        changedTier: 1,
        requested: new Set([4]),
      }),
    ).toEqual([]);
  });
});
