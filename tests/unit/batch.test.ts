import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// batch.ts → factory → openai → endpointModes (§4) → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  BATCH_MIN_PRIORITY,
  MAX_BATCH_SIZE,
  batchEligible,
  batchSignature,
  classifyBatchFailure,
  clampBatchSize,
  createBatchCollector,
  planFlush,
  type BatchCollectorTimers,
  type BatchJob,
} from "../../src/background/batch";
import {
  BatchLengthError,
  ProviderError,
} from "../../src/background/providers/ProviderBase";
import type { ProviderSettings } from "../../src/shared/types";

function ps(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    provider: "gemini",
    apiKey: "k",
    model: "gemini-2.0-flash",
    targetLang: "en",
    readingDirection: "rtl",
    preserveHonorifics: true,
    translateSfx: false,
    temperature: 0.25,
    ...overrides,
  };
}

const prep = { maxEdgePx: 1200, jpegQuality: 0.7 };

describe("batch — clampBatchSize", () => {
  it("clamps to [1, MAX_BATCH_SIZE] and floors", () => {
    expect(clampBatchSize(1)).toBe(1);
    expect(clampBatchSize(3)).toBe(3);
    expect(clampBatchSize(4)).toBe(MAX_BATCH_SIZE);
    expect(clampBatchSize(9)).toBe(MAX_BATCH_SIZE);
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(2.9)).toBe(2);
    expect(clampBatchSize(NaN)).toBe(1);
  });
});

describe("batch — batchEligible (priority × pagesPerRequest)", () => {
  it("batches only prefetch/all-tier jobs when batching is enabled", () => {
    // Visible (0) / near (1) never batch, regardless of pagesPerRequest.
    expect(batchEligible(0, 3)).toBe(false);
    expect(batchEligible(1, 3)).toBe(false);
    // Priority 2 batches iff pagesPerRequest >= 2.
    expect(batchEligible(BATCH_MIN_PRIORITY, 1)).toBe(false); // batching off
    expect(batchEligible(BATCH_MIN_PRIORITY, 2)).toBe(true);
    expect(batchEligible(BATCH_MIN_PRIORITY, 4)).toBe(true);
  });
});

describe("batch — batchSignature (mix guard)", () => {
  it("is equal for identical request-shaping settings", () => {
    expect(batchSignature(ps(), prep)).toBe(batchSignature(ps(), prep));
  });

  it("differs when ANY prompt/model/endpoint/prep field differs", () => {
    const base = batchSignature(ps(), prep);
    expect(batchSignature(ps({ provider: "openai" }), prep)).not.toBe(base);
    expect(batchSignature(ps({ model: "other" }), prep)).not.toBe(base);
    expect(batchSignature(ps({ targetLang: "es" }), prep)).not.toBe(base);
    expect(batchSignature(ps({ sourceLangHint: "ja" }), prep)).not.toBe(base);
    expect(batchSignature(ps({ preserveHonorifics: false }), prep)).not.toBe(base);
    expect(batchSignature(ps({ readingDirection: "ltr" }), prep)).not.toBe(base);
    expect(batchSignature(ps({ customEndpoint: "https://x" }), prep)).not.toBe(base);
    expect(batchSignature(ps(), { ...prep, maxEdgePx: 800 })).not.toBe(base);
    expect(batchSignature(ps(), { ...prep, jpegQuality: 0.9 })).not.toBe(base);
  });

  it("ignores temperature (a continuous sampling knob, not in the prompt)", () => {
    expect(batchSignature(ps({ temperature: 0.9 }), prep)).toBe(batchSignature(ps(), prep));
  });

  it("resolves the effective model so a default and an explicit-default key the same", () => {
    // Empty model resolves to the gemini default (= the explicit value here).
    expect(batchSignature(ps({ model: "" }), prep)).toBe(
      batchSignature(ps({ model: "gemini-2.0-flash" }), prep),
    );
  });
});

describe("batch — planFlush", () => {
  it("flushes at size", () => {
    expect(planFlush(3, 3, 0, 300)).toEqual({ flush: true, reason: "size" });
    expect(planFlush(4, 3, 0, 300)).toEqual({ flush: true, reason: "size" });
  });

  it("flushes on linger with at least one member", () => {
    expect(planFlush(1, 3, 300, 300)).toEqual({ flush: true, reason: "linger" });
    expect(planFlush(2, 3, 999, 300)).toEqual({ flush: true, reason: "linger" });
  });

  it("does not flush a partial group before the linger elapses, nor an empty one", () => {
    expect(planFlush(2, 3, 100, 300)).toEqual({ flush: false });
    expect(planFlush(0, 3, 999, 300)).toEqual({ flush: false });
  });
});

describe("batch — classifyBatchFailure", () => {
  it("splits on wrong-length, malformed, and refusal", () => {
    expect(classifyBatchFailure(new BatchLengthError(3, 2))).toBe("split");
    expect(classifyBatchFailure(new ProviderError("malformed", "x"))).toBe("split");
    expect(classifyBatchFailure(new ProviderError("refusal", "x"))).toBe("split");
  });

  it("fails all on auth / rate-limit / network / aborted / unknown", () => {
    for (const kind of ["auth", "rate-limit", "network", "aborted", "unknown"] as const) {
      expect(classifyBatchFailure(new ProviderError(kind, "x"))).toBe("fail-all");
    }
    expect(classifyBatchFailure(new Error("weird"))).toBe("fail-all");
  });
});

describe("batch — createBatchCollector (grouping + linger)", () => {
  /** Controllable timers for deterministic linger tests. */
  function fakeTimers() {
    let handle = 0;
    let clock = 0;
    const pending = new Map<number, () => void>();
    const timers: BatchCollectorTimers = {
      schedule: (fn) => {
        const id = ++handle;
        pending.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (h) => {
        pending.delete(h as unknown as number);
      },
      now: () => clock,
    };
    return {
      timers,
      advance: () => {
        for (const fn of [...pending.values()]) fn();
        pending.clear();
      },
      setClock: (t: number) => {
        clock = t;
      },
    };
  }

  it("flushes a full group immediately (size trigger), no timer needed", () => {
    const t = fakeTimers();
    const groups: BatchJob<number, number>[][] = [];
    const collector = createBatchCollector<number, number>({
      lingerMs: 300,
      runGroup: (jobs) => groups.push(jobs),
      timers: t.timers,
    });
    void collector.submit("sig", 3, 1);
    void collector.submit("sig", 3, 2);
    expect(groups).toHaveLength(0); // not full yet
    void collector.submit("sig", 3, 3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((j) => j.payload)).toEqual([1, 2, 3]);
    expect(collector.pendingCount()).toBe(0);
  });

  it("flushes a partial group when the linger timer fires", () => {
    const t = fakeTimers();
    const groups: BatchJob<number, number>[][] = [];
    const collector = createBatchCollector<number, number>({
      lingerMs: 300,
      runGroup: (jobs) => groups.push(jobs),
      timers: t.timers,
    });
    void collector.submit("sig", 3, 1);
    void collector.submit("sig", 3, 2);
    expect(groups).toHaveLength(0);
    t.advance(); // linger fires
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((j) => j.payload)).toEqual([1, 2]);
  });

  it("never mixes different signatures into one group", () => {
    const t = fakeTimers();
    const groups: number[][] = [];
    const collector = createBatchCollector<number, number>({
      lingerMs: 300,
      runGroup: (jobs) => groups.push(jobs.map((j) => j.payload)),
      timers: t.timers,
    });
    void collector.submit("A", 2, 1);
    void collector.submit("B", 2, 2);
    void collector.submit("A", 2, 3); // completes group A
    expect(groups).toEqual([[1, 3]]);
    t.advance(); // group B flushes on linger
    expect(groups).toEqual([[1, 3], [2]]);
  });

  it("submit's promise resolves when the group executor settles that member", () => {
    const t = fakeTimers();
    const collector = createBatchCollector<number, number>({
      lingerMs: 300,
      runGroup: (jobs) => jobs.forEach((j) => j.resolve(j.payload * 10)),
      timers: t.timers,
    });
    const p = collector.submit("sig", 1, 5); // batchSize 1 → flush immediately
    return expect(p).resolves.toBe(50);
  });

  it("flushAll flushes every open group", () => {
    const t = fakeTimers();
    const runGroup = vi.fn();
    const collector = createBatchCollector<number, number>({
      lingerMs: 300,
      runGroup,
      timers: t.timers,
    });
    void collector.submit("A", 3, 1);
    void collector.submit("B", 3, 2);
    expect(runGroup).not.toHaveBeenCalled();
    collector.flushAll();
    expect(runGroup).toHaveBeenCalledTimes(2);
  });
});
