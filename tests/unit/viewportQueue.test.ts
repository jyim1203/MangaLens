import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// viewportQueue.ts → messages.ts → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));
// Swap the message bus for a controllable spy so the shell tests can drive the
// translate result without a real background (item 6 retry path).
vi.mock("../../src/shared/messages", () => ({ sendToBackground: vi.fn() }));

import {
  TRANSLATE_ALL_BATCH,
  TRANSLATE_ALL_MAX_TIMEOUT_MS,
  TRANSLATE_ALL_PRIORITY,
  classifyRegisterIntent,
  createViewportQueue,
  maxConfirmedIndex,
  planEnqueues,
  planTranslateAllWindow,
  requestAllTimeoutMs,
  sameChapterHref,
  sameChapterSearch,
  type OverlaySink,
} from "../../src/content/viewportQueue";
import { sendToBackground } from "../../src/shared/messages";
import type { Candidate } from "../../src/content/scanner";
import type { PageTranslation, ProviderErrorKind } from "../../src/shared/types";

const mockSend = vi.mocked(sendToBackground);

// Phase 9.1 §8: ALL pages confirmed keeps the pre-Phase-9 plans byte-identical
// (every index sits in some anchor's forward window) — the anchored-window cases
// themselves live in viewportWindow.test.ts.
const base = {
  count: 5,
  sentPriority: new Map<number, number>(),
  prefetchAhead: 3,
  confirmed: [true, true, true, true, true],
};

/** Phase 9 §2 shell seams shared by every suite: a 0 ms confirm delay and a
 *  fixed viewport, so a visible fire + one `tick()` completes the confirmation
 *  and the send. Elements carry an always-visible client rect. */
const CONFIRM_SEAMS = {
  confirmDelayMs: 0,
  getViewport: () => ({ w: 1366, h: 768 }),
};
const VISIBLE_RECT = { top: 0, bottom: 600, left: 0, right: 800, height: 600 };

describe("viewportQueue — planEnqueues (§7.5 priority planner + §2 upgrades)", () => {
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

  it("skips a requested index whose tier is equal/worse (never worsen), still sends unrequested prefetch", () => {
    expect(
      planEnqueues({
        ...base,
        changedIndex: 0,
        changedTier: 0,
        // 0 already sent at 0 (equal → skip), 2 already sent at 2 (2<2 false → skip).
        sentPriority: new Map([
          [0, 0],
          [2, 2],
        ]),
      }),
    ).toEqual([
      { index: 1, priority: 2 },
      { index: 3, priority: 2 },
    ]);
  });

  it("emits an UPGRADE when a requested candidate's tier strictly improves (§2)", () => {
    // Page 2 was sent at prefetch (2); it just became visible (0) → upgrade to 0.
    expect(
      planEnqueues({
        ...base,
        count: 3,
        changedIndex: 2,
        changedTier: 0,
        prefetchAhead: 0,
        sentPriority: new Map([[2, 2]]),
      }),
    ).toEqual([{ index: 2, priority: 0, upgrade: true }]);
  });

  it("upgrades a prefetched page to near (2 → 1) but never to a worse tier", () => {
    // Near transition on a page sent at 2 → upgrade to 1.
    expect(
      planEnqueues({ ...base, changedIndex: 1, changedTier: 1, sentPriority: new Map([[1, 2]]) }),
    ).toEqual([{ index: 1, priority: 1, upgrade: true }]);
    // Near transition on a page already sent at 0 (visible) → 1<0 false → no-op.
    expect(
      planEnqueues({ ...base, changedIndex: 1, changedTier: 1, sentPriority: new Map([[1, 0]]) }),
    ).toEqual([]);
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

  it("does not enqueue a below-range change", () => {
    expect(
      planEnqueues({
        ...base,
        changedIndex: 4,
        changedTier: 1,
        sentPriority: new Map([[4, 1]]),
      }),
    ).toEqual([]);
  });
});

describe("viewportQueue — §1 maxConfirmedIndex (pure)", () => {
  it("returns -1 for an empty array and an all-false array", () => {
    expect(maxConfirmedIndex([])).toBe(-1);
    expect(maxConfirmedIndex([false, false, false])).toBe(-1);
  });

  it("returns the HIGHEST true index (not the first)", () => {
    expect(maxConfirmedIndex([true, false, true, false])).toBe(2);
    expect(maxConfirmedIndex([false, false, false, true])).toBe(3);
    expect(maxConfirmedIndex([true])).toBe(0);
  });
});

describe("viewportQueue — §1 planTranslateAllWindow (pure)", () => {
  const requested = (count: number, ...set: number[]): boolean[] =>
    Array.from({ length: count }, (_, i) => set.includes(i));

  it("no anchor (-1) ⇒ the first batch, indices 0..batch (one page beyond batch — pinned)", () => {
    // limit = max(0,-1) + 12 = 12 ⇒ 13 indices (0..12) when nothing is confirmed.
    const plan = planTranslateAllWindow({
      count: 30,
      anchor: -1,
      batch: TRANSLATE_ALL_BATCH,
      requested: requested(30),
    });
    expect(plan).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(plan).toHaveLength(TRANSLATE_ALL_BATCH + 1);
  });

  it("an advancing anchor slides the window forward (max(0,anchor)+batch)", () => {
    // anchor 10, batch 12 ⇒ limit 22 ⇒ indices 0..22 minus the requested 0..12.
    const plan = planTranslateAllWindow({
      count: 30,
      anchor: 10,
      batch: 12,
      requested: requested(30, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
    });
    expect(plan).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });

  it("re-plans a behind-anchor hole (a reset send) — the sweeper property", () => {
    // Anchor is 20, but page 3 (behind it) was reset to unrequested; it must re-plan.
    const req = requested(30, ...Array.from({ length: 30 }, (_, i) => i)); // all requested
    req[3] = false; // page 3's send reset
    const plan = planTranslateAllWindow({ count: 30, anchor: 20, batch: 12, requested: req });
    expect(plan).toEqual([3]);
  });

  it("skips already-requested indices", () => {
    const plan = planTranslateAllWindow({
      count: 6,
      anchor: -1,
      batch: 12,
      requested: requested(6, 0, 2, 4),
    });
    expect(plan).toEqual([1, 3, 5]);
  });

  it("clamps to the candidate count (never dispatches past the end)", () => {
    const plan = planTranslateAllWindow({
      count: 4,
      anchor: 0,
      batch: 12,
      requested: requested(4),
    });
    expect(plan).toEqual([0, 1, 2, 3]);
  });

  it("batch 0 ⇒ only the window up to the anchor (fail-cheap); with anchor -1 that is index 0", () => {
    expect(
      planTranslateAllWindow({ count: 30, anchor: -1, batch: 0, requested: requested(30) }),
    ).toEqual([0]);
    // anchor 5, batch 0 ⇒ limit 5 ⇒ everything behind/at the anchor (0..5).
    expect(
      planTranslateAllWindow({ count: 30, anchor: 5, batch: 0, requested: requested(30) }),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a non-finite/negative batch clamps to 0 (never a burst, rule 5)", () => {
    for (const bad of [NaN, Infinity, -5]) {
      expect(
        planTranslateAllWindow({ count: 30, anchor: -1, batch: bad, requested: requested(30) }),
      ).toEqual([0]); // same as batch 0 with anchor -1
    }
  });

  it("count 0 ⇒ empty", () => {
    expect(
      planTranslateAllWindow({ count: 0, anchor: -1, batch: 12, requested: [] }),
    ).toEqual([]);
  });

  it("pins the 2×batch per-wave budget arithmetic (flagged budget rule)", () => {
    // The shell arms with requestAllTimeoutMs(2*batch, concurrency, base); 2×12=24
    // pages at concurrency 6 = 4 waves ⇒ base + 4×30 s (independent of chapter size).
    expect(requestAllTimeoutMs(2 * TRANSLATE_ALL_BATCH, 6, 120_000)).toBe(120_000 + 4 * 30_000);
  });
});

/** Minimal fake IntersectionObserver recording observe/unobserve + firing on demand. */
class FakeIO {
  static instances: FakeIO[] = [];
  observeLog: Element[] = [];
  unobserveLog: Element[] = [];
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observeLog.push(el);
  }
  unobserve(el: Element): void {
    this.unobserveLog.push(el);
  }
  disconnect(): void {}
  fire(el: Element, isIntersecting: boolean): void {
    this.cb(
      [{ target: el, isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/** A no-op overlay sink whose calls are spied on. */
function fakeOverlay(): OverlaySink {
  return {
    setPending: vi.fn(),
    render: vi.fn(),
    setError: vi.fn(),
    clear: vi.fn(),
  };
}

const CAND: Candidate = {
  id: "c1",
  el: { getBoundingClientRect: () => VISIBLE_RECT } as unknown as Element,
  url: "https://x/page.jpg",
};

const tick = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("viewportQueue — requestAll (F8 translate-all)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    // insertInDocOrder touches Node.DOCUMENT_POSITION_FOLLOWING once a second
    // candidate registers; the node test env has no Node global.
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fake element whose compareDocumentPosition keeps registration order. */
  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;

  const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
  const candB: Candidate = { id: "b", el: fakeEl(), url: "https://x/b.jpg" };

  function makeQueue(overlay: OverlaySink) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("dry run counts unrequested candidates without sending anything", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    queue.register(candA);
    queue.register(candB);

    // A becomes visible → confirmed (§2) → requested; B untouched.
    FakeIO.instances[0]!.fire(candA.el, true);
    await tick();
    expect(mockSend).toHaveBeenCalledTimes(1);

    expect(queue.requestAll(true)).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1); // dry run sent nothing

    queue.stop();
  });

  it("real run sends the remaining candidates at the prefetch/all priority", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(candA);
    queue.register(candB);
    FakeIO.instances[0]!.fire(candA.el, true); // A requested at priority 0
    await tick(); // §2: confirmation completes the send

    expect(queue.requestAll()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const [, payload] = mockSend.mock.calls[1]!;
    expect(payload).toMatchObject({
      imageUrl: candB.url,
      priority: TRANSLATE_ALL_PRIORITY,
    });
    expect(overlay.setPending).toHaveBeenCalledTimes(2);

    // Everything is requested now — a second run is an idempotent no-op.
    expect(queue.requestAll()).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(2);

    queue.stop();
  });
});

describe("viewportQueue — onProviderError toast hook (Phase 7 item 6)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
  });

  function makeQueue(overlay: OverlaySink, onProviderError: (k: ProviderErrorKind) => void) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      onProviderError,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("fires on a badge-rendered error (auth) alongside setError", async () => {
    mockSend.mockResolvedValue({ ok: false, errorKind: "auth", message: "bad key" });
    const overlay = fakeOverlay();
    const onErr = vi.fn();
    const queue = makeQueue(overlay, onErr);

    queue.register(CAND);
    FakeIO.instances[0]!.fire(CAND.el, true);
    await tick();

    expect(overlay.setError).toHaveBeenCalledWith(CAND, "auth");
    expect(onErr).toHaveBeenCalledWith("auth");
    queue.stop();
  });

  it("does NOT fire for an aborted result (silent, no toast)", async () => {
    mockSend.mockResolvedValue({ ok: false, errorKind: "aborted" });
    const overlay = fakeOverlay();
    const onErr = vi.fn();
    const queue = makeQueue(overlay, onErr);

    queue.register(CAND);
    FakeIO.instances[0]!.fire(CAND.el, true);
    await tick();

    expect(onErr).not.toHaveBeenCalled();
    queue.stop();
  });
});

describe("viewportQueue — retry path re-observes a static image (item 6)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeQueue(overlay: OverlaySink, requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      requestTimeoutMs,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("on timeout: resets requested, re-observes, and a later visibility re-sends", async () => {
    // Request never settles → the injected short timeout fires.
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, 10);

    queue.register(CAND);
    const [visible, near] = FakeIO.instances;

    visible!.fire(CAND.el, true); // enters the viewport → confirmed → priority 0
    await tick();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0]).toBe("translatePage");

    await tick(30); // the 10 ms request timeout fires → catch path

    // Item 6: re-observed on BOTH observers so a still-visible image can retry.
    expect(visible!.unobserveLog).toContain(CAND.el);
    expect(near!.unobserveLog).toContain(CAND.el);
    expect(visible!.observeLog.filter((e) => e === CAND.el)).toHaveLength(2);

    // A fresh intersection callback now re-sends (requested was reset).
    visible!.fire(CAND.el, true);
    expect(mockSend).toHaveBeenCalledTimes(2);

    queue.stop();
  });

  it("aborted-while-registered resets requested so the next visibility re-sends", async () => {
    mockSend
      .mockResolvedValueOnce({ ok: false, errorKind: "aborted" })
      .mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);

    queue.register(CAND);
    const [visible] = FakeIO.instances;

    visible!.fire(CAND.el, true);
    await tick(); // §2 confirmation + the aborted result are both handled here
    expect(mockSend).toHaveBeenCalledTimes(1);

    expect(overlay.clear).toHaveBeenCalled();
    expect(visible!.unobserveLog).toContain(CAND.el); // re-observed

    visible!.fire(CAND.el, true); // requested was reset → re-sends
    expect(mockSend).toHaveBeenCalledTimes(2);

    queue.stop();
  });
});

describe("viewportQueue — blob bytes dispatch (item 1)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
  });

  const BLOB: Candidate = {
    id: "b1",
    el: { getBoundingClientRect: () => VISIBLE_RECT } as unknown as Element,
    url: "blob:https://reader.example.com/9f8c",
  };
  const HTTP: Candidate = {
    id: "h1",
    el: { getBoundingClientRect: () => VISIBLE_RECT } as unknown as Element,
    url: "https://reader.example.com/page.jpg",
  };

  function makeQueue(
    overlay: OverlaySink,
    acquireBytes?: (url: string) => Promise<{ imageBytes: ArrayBuffer; imageMime: string }>,
  ) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      acquireBytes,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("a blob candidate acquires bytes content-side and ships them in the payload", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const bytes = new Uint8Array([7, 7, 7]).buffer;
    const acquireBytes = vi.fn(async () => ({ imageBytes: bytes, imageMime: "image/webp" }));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, acquireBytes);

    queue.register(BLOB);
    FakeIO.instances[0]!.fire(BLOB.el, true);
    await tick();

    expect(acquireBytes).toHaveBeenCalledWith(BLOB.url, BLOB.el);
    const [type, payload] = mockSend.mock.calls[0]!;
    expect(type).toBe("translatePage");
    expect(payload).toMatchObject({
      imageUrl: BLOB.url,
      imageBytes: bytes,
      imageMime: "image/webp",
    });
    queue.stop();
  });

  it("an http candidate never acquires bytes and sends no bytes in the payload", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const acquireBytes = vi.fn();
    const queue = makeQueue(fakeOverlay(), acquireBytes);

    queue.register(HTTP);
    FakeIO.instances[0]!.fire(HTTP.el, true);
    await tick();

    expect(acquireBytes).not.toHaveBeenCalled();
    const [, payload] = mockSend.mock.calls[0]!;
    expect(payload).not.toHaveProperty("imageBytes");
    queue.stop();
  });

  it("acquisition failure shows a network error, sends nothing, and doesn't reset requested", async () => {
    const acquireBytes = vi.fn(async () => {
      throw new Error("blob revoked");
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, acquireBytes);

    queue.register(BLOB);
    FakeIO.instances[0]!.fire(BLOB.el, true);
    await tick();

    expect(overlay.setError).toHaveBeenCalledWith(BLOB, "network");
    expect(mockSend).not.toHaveBeenCalled(); // no translatePage sent

    // requested stayed true → a repeat visibility event does NOT re-acquire the
    // dead URL (the fresh candidate from a src swap is the real retry path).
    FakeIO.instances[0]!.fire(BLOB.el, true);
    await tick();
    expect(acquireBytes).toHaveBeenCalledTimes(1);
    queue.stop();
  });
});

describe("viewportQueue — pause/resume (Phase 7.4 item 4)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
  const BLOB: Candidate = { id: "b", el: fakeEl(), url: "blob:https://x/9f8c" };

  function makeQueue(
    overlay: OverlaySink,
    acquireBytes?: (url: string) => Promise<{ imageBytes: ArrayBuffer; imageMime: string }>,
  ) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      acquireBytes,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("blocks a visibility send while paused (no send, no skeleton)", async () => {
    mockSend.mockResolvedValue({ cancelled: 0 });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    expect(await queue.setPaused(true)).toBe(0); // nothing queued yet
    expect(queue.isPaused()).toBe(true);

    queue.register(candA);
    FakeIO.instances[0]!.fire(candA.el, true);
    await tick(); // §2 confirmation runs; the plan then hits the pause gate

    expect(mockSend).not.toHaveBeenCalled();
    expect(overlay.setPending).not.toHaveBeenCalled();
    queue.stop();
  });

  it("makes requestAll a no-op returning 0 while paused (both dry-run and real)", async () => {
    mockSend.mockResolvedValue({ cancelled: 0 });
    const queue = makeQueue(fakeOverlay());
    queue.register(candA);
    await queue.setPaused(true);

    expect(queue.requestAll(true)).toBe(0);
    expect(queue.requestAll()).toBe(0);
    expect(mockSend).not.toHaveBeenCalledWith("translatePage", expect.anything());
    queue.stop();
  });

  it("still renders an in-flight request that resolves during pause", async () => {
    let resolveTranslate: (v: unknown) => void = () => {};
    mockSend.mockImplementation((type: string) => {
      if (type === "translatePage") {
        return new Promise((r) => {
          resolveTranslate = r as (v: unknown) => void;
        });
      }
      return Promise.resolve({ cancelled: 0 }); // background: already started
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(candA);
    FakeIO.instances[0]!.fire(candA.el, true); // sends translatePage (in-flight)
    await tick();

    expect(await queue.setPaused(true)).toBe(0); // sent cancelQueued, none cancelled
    const page = { imageHash: "h", regions: [] } as unknown;
    resolveTranslate({ ok: true, page });
    await tick();

    expect(overlay.render).toHaveBeenCalledWith(candA, page);
    queue.stop();
  });

  it("resets + clears + reobserves a request aborted by pause", async () => {
    let resolveTranslate: (v: unknown) => void = () => {};
    mockSend.mockImplementation((type: string) => {
      if (type === "translatePage") {
        return new Promise((r) => {
          resolveTranslate = r as (v: unknown) => void;
        });
      }
      return Promise.resolve({ cancelled: 1 });
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(candA);
    const [visible] = FakeIO.instances;
    visible!.fire(candA.el, true);
    await tick();

    expect(await queue.setPaused(true)).toBe(1); // background aborted the queued job
    // The aborted translatePage result flows through the existing aborted branch.
    resolveTranslate({ ok: false, errorKind: "aborted" });
    await tick();

    expect(overlay.clear).toHaveBeenCalledWith(candA);
    expect(visible!.unobserveLog.includes(candA.el)).toBe(true); // reobserved for retry
    queue.stop();
  });

  it("reobserves still-visible unrequested candidates on resume", async () => {
    mockSend.mockResolvedValue({ cancelled: 0 });
    const queue = makeQueue(fakeOverlay());
    queue.register(candA); // observed once (autoEnqueue)
    const [visible, near] = FakeIO.instances;

    await queue.setPaused(true);
    await queue.setPaused(false);

    // Resume re-observes the unrequested candidate on both observers.
    expect(visible!.unobserveLog.includes(candA.el)).toBe(true);
    expect(near!.unobserveLog.includes(candA.el)).toBe(true);
    expect(visible!.observeLog.filter((e) => e === candA.el)).toHaveLength(2);
    queue.stop();
  });

  it("re-checks the pause flag after the acquireBytes gap (no send)", async () => {
    let releaseAcquire: () => void = () => {};
    const bytes = new Uint8Array([1]).buffer;
    const acquireBytes = vi.fn(
      () =>
        new Promise<{ imageBytes: ArrayBuffer; imageMime: string }>((r) => {
          releaseAcquire = () => r({ imageBytes: bytes, imageMime: "image/webp" });
        }),
    );
    mockSend.mockResolvedValue({ cancelled: 0 });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, acquireBytes);
    queue.register(BLOB);
    FakeIO.instances[0]!.fire(BLOB.el, true); // sets requested, setPending, awaits acquire
    await tick();
    expect(acquireBytes).toHaveBeenCalled();

    await queue.setPaused(true); // pause DURING the acquireBytes gap
    releaseAcquire();
    await tick();

    // The post-gap re-check abandons the send and clears the skeleton.
    expect(mockSend).not.toHaveBeenCalledWith("translatePage", expect.anything());
    expect(overlay.clear).toHaveBeenCalledWith(BLOB);
    queue.stop();
  });
});

describe("viewportQueue — cache-only hydrate (Phase 7.6)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const httpCand = (id: string): Candidate => ({ id, el: fakeEl(), url: `https://x/${id}.jpg` });
  const BLOB: Candidate = { id: "b", el: fakeEl(), url: "blob:https://x/9f8c" };
  const PAGE = { imageHash: "h", regions: [] } as unknown as PageTranslation;

  function makeQueue(
    overlay: OverlaySink,
    hydrate = true,
    acquireBytes?: (url: string) => Promise<{ imageBytes: ArrayBuffer; imageMime: string }>,
    requestTimeoutMs?: number,
  ) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: false, // hydrate is the non-auto complement
      hydrate,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      acquireBytes,
      requestTimeoutMs,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  /** Count translatePage sends by whether they were cacheOnly probes. */
  const probeCalls = () =>
    mockSend.mock.calls.filter(
      (c) => c[0] === "translatePage" && (c[1] as { cacheOnly?: boolean }).cacheOnly,
    );
  const realCalls = () =>
    mockSend.mock.calls.filter(
      (c) => c[0] === "translatePage" && !(c[1] as { cacheOnly?: boolean }).cacheOnly,
    );

  it("gate: an origin with zero cache entries sends no probes", async () => {
    mockSend.mockImplementation((type: string) =>
      type === "countCachedForSite" ? Promise.resolve({ count: 0 }) : Promise.resolve(undefined),
    );
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(httpCand("a"));
    await tick();
    expect(probeCalls()).toHaveLength(0);
    expect(overlay.setPending).not.toHaveBeenCalled();
    queue.stop();
  });

  it("a cache hit renders, flips requested, and shows NO skeleton", async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return Promise.resolve({ ok: true, page: PAGE });
      return Promise.resolve(undefined);
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    const cand = httpCand("a");
    queue.register(cand);
    await tick();

    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0]![1]).toMatchObject({ cacheOnly: true });
    expect(overlay.render).toHaveBeenCalledWith(cand, PAGE);
    expect(overlay.setPending).not.toHaveBeenCalled(); // no skeleton flash
    // A later Translate all skips it — it's already requested.
    expect(queue.requestAll()).toBe(0);
    queue.stop();
  });

  it("a not-cached probe leaves the candidate unrequested and badge-free; requestAll then sends a real request", async () => {
    mockSend.mockImplementation((type: string, payload?: unknown) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") {
        return (payload as { cacheOnly?: boolean }).cacheOnly
          ? Promise.resolve({ ok: false, errorKind: "not-cached" })
          : new Promise<never>(() => {}); // real send hangs (just proving it fired)
      }
      return Promise.resolve(undefined);
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    const cand = httpCand("a");
    queue.register(cand);
    await tick();

    expect(probeCalls()).toHaveLength(1);
    expect(overlay.render).not.toHaveBeenCalled();
    expect(overlay.setError).not.toHaveBeenCalled();
    expect(overlay.setPending).not.toHaveBeenCalled();

    // The record stayed unrequested → a real translate-all still sends it.
    expect(queue.requestAll()).toBe(1);
    expect(realCalls()).toHaveLength(1);
    queue.stop();
  });

  it("a probe timeout renders nothing and leaves the candidate retryable", async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return new Promise<never>(() => {}); // never settles
      return Promise.resolve(undefined);
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, true, undefined, 10);
    queue.register(httpCand("a"));
    await tick(30); // the 10 ms probe timeout fires

    expect(overlay.render).not.toHaveBeenCalled();
    expect(overlay.setError).not.toHaveBeenCalled();
    // Still unrequested → a real send is available.
    expect(queue.requestAll()).toBe(1);
    queue.stop();
  });

  it("bounds probe concurrency to HYDRATE_CONCURRENCY (3)", async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return new Promise<never>(() => {}); // hang → stays in-flight
      return Promise.resolve(undefined);
    });
    const queue = makeQueue(fakeOverlay());
    for (const id of ["a", "b", "c", "d", "e"]) queue.register(httpCand(id));
    await tick();
    expect(probeCalls().length).toBeLessThanOrEqual(3);
    queue.stop();
  });

  it("a blob candidate's probe ships its bytes", async () => {
    const bytes = new Uint8Array([9, 9]).buffer;
    const acquireBytes = vi.fn(async () => ({ imageBytes: bytes, imageMime: "image/webp" }));
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return new Promise<never>(() => {});
      return Promise.resolve(undefined);
    });
    const queue = makeQueue(fakeOverlay(), true, acquireBytes);
    queue.register(BLOB);
    await tick();

    expect(acquireBytes).toHaveBeenCalledWith(BLOB.url, BLOB.el);
    expect(probeCalls()[0]![1]).toMatchObject({
      cacheOnly: true,
      imageBytes: bytes,
      imageMime: "image/webp",
    });
    queue.stop();
  });

  it("unregister cancels an in-flight probe", async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return new Promise<never>(() => {}); // in-flight
      return Promise.resolve(undefined);
    });
    const cand = httpCand("a");
    const queue = makeQueue(fakeOverlay());
    queue.register(cand);
    await tick();
    expect(probeCalls()).toHaveLength(1);

    queue.unregister(cand);
    // §1: the DOM-reconcile unregister path sends the soft "queued-only" mode.
    expect(mockSend).toHaveBeenCalledWith("cancelTranslation", {
      requestId: "rq",
      mode: "queued-only",
    });
    queue.stop();
  });

  it("hydrate=false (auto site) sends no probes and never counts the cache", async () => {
    mockSend.mockResolvedValue({ count: 5 });
    const queue = makeQueue(fakeOverlay(), false);
    queue.register(httpCand("a"));
    await tick();
    expect(mockSend).not.toHaveBeenCalledWith("countCachedForSite");
    expect(probeCalls()).toHaveLength(0);
    queue.stop();
  });

  it("probes ignore pause (they spend no provider budget)", async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === "countCachedForSite") return Promise.resolve({ count: 5 });
      if (type === "translatePage") return Promise.resolve({ ok: true, page: PAGE });
      if (type === "cancelQueuedTranslations") return Promise.resolve({ cancelled: 0 });
      return Promise.resolve(undefined);
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    await queue.setPaused(true);
    const cand = httpCand("a");
    queue.register(cand);
    await tick();

    expect(probeCalls()).toHaveLength(1);
    expect(overlay.render).toHaveBeenCalledWith(cand, PAGE); // hit still rendered while paused
    queue.stop();
  });
});

describe("viewportQueue — requestAllTimeoutMs (§3 budget)", () => {
  const BASE = 120_000;
  it("floors at baseMs (count 0) and is monotonic in count", () => {
    expect(requestAllTimeoutMs(0, 6, BASE)).toBe(BASE);
    const t10 = requestAllTimeoutMs(10, 6, BASE);
    const t50 = requestAllTimeoutMs(50, 6, BASE);
    const t200 = requestAllTimeoutMs(200, 6, BASE);
    expect(t10).toBeGreaterThanOrEqual(BASE);
    expect(t50).toBeGreaterThan(t10);
    expect(t200).toBeGreaterThan(t50);
  });

  it("adds ~30 s per wave of `concurrency` requests", () => {
    // 12 pages at concurrency 6 → 2 waves → base + 60 s.
    expect(requestAllTimeoutMs(12, 6, BASE)).toBe(BASE + 2 * 30_000);
    // A smaller concurrency = more waves = bigger budget.
    expect(requestAllTimeoutMs(12, 3, BASE)).toBe(BASE + 4 * 30_000);
  });

  it("holds the 15-minute cap for a huge backlog", () => {
    expect(requestAllTimeoutMs(100_000, 1, BASE)).toBe(TRANSLATE_ALL_MAX_TIMEOUT_MS);
  });

  it("clamps a degenerate concurrency to at least 1 lane", () => {
    expect(requestAllTimeoutMs(6, 0, BASE)).toBe(BASE + 6 * 30_000);
  });
});

describe("viewportQueue — §3 shell (budget + setPrefetchAhead)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const cand = (id: string): Candidate => ({ id, el: fakeEl(), url: `https://x/${id}.jpg` });

  function makeQueue(overlay: OverlaySink, prefetchAhead: number, requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead,
      concurrency: 6,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      requestTimeoutMs,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("requestAll uses the backlog-scaled budget, not the flat visibility timeout", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {})); // never settles
    const queue = makeQueue(fakeOverlay(), 0, 10); // flat timeout would be 10 ms
    queue.register(cand("a"));
    queue.requestAll(); // budget ≈ 30 s → won't reset within the test window
    await tick(40);
    // Still requested (no 10 ms timeout reset) → a second requestAll is a no-op.
    expect(queue.requestAll()).toBe(0);
    queue.stop();
  });

  it("setPrefetchAhead changes how many neighbours the next tier change prefetches", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const queue = makeQueue(fakeOverlay(), 0); // start with no prefetch
    queue.register(a);
    queue.register(b);
    queue.register(c);

    // With prefetchAhead 0, "a" visible sends only "a".
    FakeIO.instances[0]!.fire(a.el, true);
    await tick();
    expect(mockSend.mock.calls.filter((cl) => cl[0] === "translatePage")).toHaveLength(1);

    // Live-raise the depth, then a fresh tier change on "b" prefetches its neighbour.
    queue.setPrefetchAhead(1);
    FakeIO.instances[0]!.fire(b.el, true); // sends "b" (0) + prefetch "c" (2)
    await tick();
    expect(mockSend.mock.calls.filter((cl) => cl[0] === "translatePage")).toHaveLength(3);
    queue.stop();
  });
});

describe("viewportQueue — priority upgrade shell (§2)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;

  function makeQueue(overlay: OverlaySink) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 1,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("tier improvements on a requested candidate send reprioritizeTranslation (not a re-send)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {})); // translatePage hangs (stays in-flight)
    const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
    const candB: Candidate = { id: "b", el: fakeEl(), url: "https://x/b.jpg" };
    const queue = makeQueue(fakeOverlay());
    queue.register(candA);
    queue.register(candB);
    const [visible, near] = FakeIO.instances;

    // A confirms visible → A sent at 0 and B prefetched at 2 (inside the window).
    visible!.fire(candA.el, true);
    await tick();
    const sent = mockSend.mock.calls.filter((c) => c[0] === "translatePage");
    expect(sent).toHaveLength(2);
    expect((sent[1]![1] as { priority: number }).priority).toBe(2);

    // B enters the near tier → an UPGRADE (2 → 1), not a second translatePage.
    near!.fire(candB.el, true);
    await tick();
    let repro = mockSend.mock.calls.filter((c) => c[0] === "reprioritizeTranslation");
    expect(repro).toHaveLength(1);
    expect(repro[0]![1]).toEqual({ requestId: "rq", priority: 1 });

    // B becomes visible → a further upgrade to 0, still no re-send.
    visible!.fire(candB.el, true);
    await tick();
    repro = mockSend.mock.calls.filter((c) => c[0] === "reprioritizeTranslation");
    expect(repro[repro.length - 1]![1]).toEqual({ requestId: "rq", priority: 0 });
    expect(mockSend.mock.calls.filter((c) => c[0] === "translatePage")).toHaveLength(2);
    queue.stop();
  });
});

describe("viewportQueue — hydrateAll (Phase 8 §0 Show cached button)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const httpCand = (id: string): Candidate => ({ id, el: fakeEl(), url: `https://x/${id}.jpg` });
  const PAGE = { imageHash: "h", regions: [] } as unknown as PageTranslation;

  /** hydrate:false + autoEnqueue reflects an AUTO site: the auto-hydrate path sent
   *  zero probes, but the button must still work there. */
  function makeQueue(overlay: OverlaySink, autoEnqueue: boolean, requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue,
      hydrate: false, // the button ignores this flag
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      requestTimeoutMs,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  const probeCalls = () =>
    mockSend.mock.calls.filter(
      (c) => c[0] === "translatePage" && (c[1] as { cacheOnly?: boolean }).cacheOnly,
    );

  it("schedules a cacheOnly probe per unrequested candidate and returns the count (auto site, hydrate:false)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {})); // probes hang → stay in-flight
    const queue = makeQueue(fakeOverlay(), true);
    queue.register(httpCand("a"));
    queue.register(httpCand("b"));

    // No auto-hydrate probes fired (hydrate:false) and countCachedForSite is never
    // consulted — the button bypasses the origin gate.
    await tick();
    expect(probeCalls()).toHaveLength(0);

    expect(queue.hydrateAll()).toBe(2);
    await tick();
    expect(probeCalls()).toHaveLength(2);
    expect(mockSend).not.toHaveBeenCalledWith("countCachedForSite");
    expect(probeCalls()[0]![1]).toMatchObject({ cacheOnly: true });
    queue.stop();
  });

  it("skips already-requested candidates", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay(), true);
    const a = httpCand("a");
    queue.register(a);
    queue.register(httpCand("b"));
    // Mark a as requested via a real (non-probe) translate-all send.
    expect(queue.requestAll()).toBe(2); // both sent → both requested now

    expect(queue.hydrateAll()).toBe(0); // nothing left unrequested
    queue.stop();
  });

  it("a hit renders and flips requested (a later Translate all skips it)", async () => {
    mockSend.mockImplementation((type: string) =>
      type === "translatePage" ? Promise.resolve({ ok: true, page: PAGE }) : Promise.resolve(undefined),
    );
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, true);
    const cand = httpCand("a");
    queue.register(cand);

    expect(queue.hydrateAll()).toBe(1);
    await tick();
    expect(overlay.render).toHaveBeenCalledWith(cand, PAGE);
    expect(overlay.setPending).not.toHaveBeenCalled(); // no skeleton flash
    expect(queue.requestAll()).toBe(0); // already requested
    queue.stop();
  });

  it("a not-cached probe leaves the candidate untouched and still translatable", async () => {
    mockSend.mockImplementation((type: string, payload?: unknown) => {
      if (type === "translatePage" && (payload as { cacheOnly?: boolean }).cacheOnly) {
        return Promise.resolve({ ok: false, errorKind: "not-cached" });
      }
      return new Promise<never>(() => {});
    });
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, true);
    queue.register(httpCand("a"));

    expect(queue.hydrateAll()).toBe(1);
    await tick();
    expect(overlay.render).not.toHaveBeenCalled();
    expect(overlay.setError).not.toHaveBeenCalled();
    expect(queue.requestAll()).toBe(1); // still unrequested → real send available
    queue.stop();
  });

  it("obeys HYDRATE_CONCURRENCY (≤ 3 probes in flight)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {})); // hang → stay in-flight
    const queue = makeQueue(fakeOverlay(), true);
    for (const id of ["a", "b", "c", "d", "e"]) queue.register(httpCand(id));

    expect(queue.hydrateAll()).toBe(5);
    await tick();
    expect(probeCalls().length).toBeLessThanOrEqual(3);
    queue.stop();
  });
});

describe("viewportQueue — autoEnqueue=false (per-site opt-in, item 3)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
  const candB: Candidate = { id: "b", el: fakeEl(), url: "https://x/b.jpg" };

  function makeQueue(overlay: OverlaySink, requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 3,
      autoEnqueue: false,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      requestTimeoutMs,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("registers candidates but never observes them (no auto sends)", () => {
    const queue = makeQueue(fakeOverlay());
    queue.register(candA);
    queue.register(candB);

    // Both observers exist but watch nothing — no tier event can ever fire.
    for (const io of FakeIO.instances) expect(io.observeLog).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
    queue.stop();
  });

  it("requestAll still sends every registered candidate (translate-all works)", () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(candA);
    queue.register(candB);

    expect(queue.requestAll()).toBe(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(overlay.setPending).toHaveBeenCalledTimes(2);
    queue.stop();
  });

  it("reobserve is a no-op: a timed-out translate-all send does not re-observe", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {})); // never settles → timeout
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, 10);
    queue.register(candA);

    queue.requestAll(); // sends candA at the translate-all priority
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [visible, near] = FakeIO.instances;
    // Phase 9.8 §1: arming a non-auto translate-all attaches the VISIBLE observer
    // (so confirmed anchors can advance the staged horizon) but never the NEAR one.
    expect(visible!.observeLog).toEqual([candA.el]);
    expect(near!.observeLog).toEqual([]);

    await tick(30); // the 10 ms timeout fires → catch path calls reobserve

    // reobserve still early-returns on a non-auto site: NO extra observe (the log
    // stays length 1, not 2) and NO unobserve — the pump is the retry path here.
    expect(visible!.observeLog).toEqual([candA.el]);
    expect(visible!.unobserveLog).toEqual([]);
    expect(near!.observeLog).toEqual([]);
    expect(near!.unobserveLog).toEqual([]);
    queue.stop();
  });
});

describe("viewportQueue — sameChapterHref (§1 chapter-identity comparison)", () => {
  const base = "https://mangadex.org/chapter/abc-uuid/4";

  it("identical strings → true (fast path)", () => {
    expect(sameChapterHref(base, base)).toBe(true);
  });

  it("two empty strings → true (the location-less test runtime, new URL('') would throw)", () => {
    expect(sameChapterHref("", "")).toBe(true);
  });

  it("hash-only drift → true (a fragment can never change the chapter)", () => {
    expect(sameChapterHref(base, base + "#page-9")).toBe(true);
  });

  it("numeric last-segment drift → true (page 4 → page 9)", () => {
    expect(sameChapterHref(base, "https://mangadex.org/chapter/abc-uuid/9")).toBe(true);
  });

  it("appended trailing numeric segment → true (both directions)", () => {
    const bare = "https://mangadex.org/chapter/abc-uuid";
    expect(sameChapterHref(bare, bare + "/1")).toBe(true); // reader adds /<page> on scroll
    expect(sameChapterHref(bare + "/1", bare)).toBe(true); // and the reverse
  });

  it("non-numeric last-segment change → false", () => {
    expect(sameChapterHref(base, "https://mangadex.org/chapter/abc-uuid/foo")).toBe(false);
  });

  it("appended NON-numeric trailing segment → false", () => {
    const bare = "https://mangadex.org/chapter/abc-uuid";
    expect(sameChapterHref(bare, bare + "/foo")).toBe(false);
  });

  it("uuid/slug (non-last) segment change → false (a real chapter change)", () => {
    expect(sameChapterHref(base, "https://mangadex.org/chapter/xyz-uuid/4")).toBe(false);
  });

  it("origin change → false", () => {
    expect(sameChapterHref(base, "https://evil.org/chapter/abc-uuid/4")).toBe(false);
  });

  it("§2 (Phase 10): a numeric query drift is now TOLERATED; a non-numeric search change still disarms", () => {
    // Pre-10 this asserted `false` (query page-drift NOT tolerated); Phase 10 §2 lifts
    // that limitation via sameChapterSearch — a numeric `?page=` counter drift is same
    // chapter. The full search truth table lives in the sameChapterSearch suite below.
    expect(
      sameChapterHref(
        "https://mangadex.org/chapter/abc-uuid?page=4",
        "https://mangadex.org/chapter/abc-uuid?page=9",
      ),
    ).toBe(true);
    // A non-numeric query value change is still a real chapter change → disarm.
    expect(
      sameChapterHref(
        "https://mangadex.org/chapter/abc-uuid?vol=a",
        "https://mangadex.org/chapter/abc-uuid?vol=b",
      ),
    ).toBe(false);
  });

  it("path length differing by ≥ 2 → false", () => {
    expect(sameChapterHref("https://mangadex.org/chapter/abc-uuid", "https://mangadex.org/chapter/abc-uuid/1/2")).toBe(
      false,
    );
  });

  it("unparseable input → false unless the strings are exactly equal", () => {
    expect(sameChapterHref("not a url", "also not a url")).toBe(false);
    expect(sameChapterHref("not a url", "not a url")).toBe(true); // exact-equality fast path
  });

  it("the e2e-fixture drift shape → true (the MangaDex reader path rewrite)", () => {
    // What Scenario E's rewriting fixture produces: armed on /chapter-long.html/1,
    // then the page segment climbs as the reader scrolls.
    const origin = "http://127.0.0.1:8785";
    expect(sameChapterHref(origin + "/chapter-long.html/1", origin + "/chapter-long.html/7")).toBe(true);
    expect(sameChapterHref(origin + "/chapter-long.html", origin + "/chapter-long.html/1")).toBe(true);
  });
});

describe("viewportQueue — sameChapterSearch (§2 query-string page drift)", () => {
  it("identical searches → true, including two empty strings", () => {
    expect(sameChapterSearch("?page=4", "?page=4")).toBe(true);
    expect(sameChapterSearch("", "")).toBe(true);
  });

  it("same-key digit drift ?page=4 → ?page=9 → true", () => {
    expect(sameChapterSearch("?page=4", "?page=9")).toBe(true);
  });

  it("a single digit-valued param added and removed → true (both directions, incl. from empty)", () => {
    expect(sameChapterSearch("", "?page=2")).toBe(true); // reader adds the tracker on first scroll
    expect(sameChapterSearch("?page=2", "")).toBe(true); // and the reverse
    expect(sameChapterSearch("?a=1", "?a=1&page=2")).toBe(true); // added alongside an unchanged param
  });

  it("a non-digit value change → false", () => {
    expect(sameChapterSearch("?chapter=abc", "?chapter=xyz")).toBe(false);
  });

  it("a key rename (?page= → ?p=) → false", () => {
    expect(sameChapterSearch("?page=4", "?p=4")).toBe(false);
  });

  it("two drifted keys → false", () => {
    expect(sameChapterSearch("?page=1&x=2", "?page=3&x=4")).toBe(false);
  });

  it("an extra NON-digit param → false", () => {
    expect(sameChapterSearch("?page=4", "?page=4&mode=strip")).toBe(false);
  });

  it("order-insensitive (params reserialized in a different order) → true", () => {
    expect(sameChapterSearch("?a=1&b=2", "?b=2&a=1")).toBe(true);
  });

  it("a repeated-key multiset mismatch (?a=1&a=2) → false", () => {
    expect(sameChapterSearch("?a=1&a=2", "?a=1&a=3")).toBe(false);
  });

  it("digit drift combined with tolerated numeric PATH drift → true (compose independently)", () => {
    // sameChapterHref threads the search through sameChapterSearch: a numeric path
    // segment AND a numeric query value may BOTH drift and still name one chapter.
    expect(
      sameChapterHref(
        "https://mangadex.org/chapter/abc-uuid/4?page=1",
        "https://mangadex.org/chapter/abc-uuid/9?page=2",
      ),
    ).toBe(true);
  });

  it("digit query drift on a DIFFERENT origin → false (the origin gate still dominates)", () => {
    expect(
      sameChapterHref(
        "https://mangadex.org/chapter/abc-uuid?page=1",
        "https://evil.org/chapter/abc-uuid?page=2",
      ),
    ).toBe(false);
  });
});

describe("viewportQueue — classifyRegisterIntent (§2 persistence predicate)", () => {
  const intent = { href: "https://mangadex.org/ch/1", budgetMs: 90_000 };

  it("no intent armed → ignore", () => {
    expect(classifyRegisterIntent(undefined, "https://mangadex.org/ch/1", false)).toBe(
      "ignore",
    );
  });

  it("armed + same href + not paused → send", () => {
    expect(classifyRegisterIntent(intent, "https://mangadex.org/ch/1", false)).toBe("send");
  });

  it("armed + same href + paused → ignore (a paused queue never auto-sends)", () => {
    expect(classifyRegisterIntent(intent, "https://mangadex.org/ch/1", true)).toBe("ignore");
  });

  it("armed + a DIFFERENT chapter → disarm (SPA chapter change), regardless of pause", () => {
    // Phase 9.9 §1: a genuine chapter change is a non-numeric (slug/uuid) segment
    // drift — here the leading path segment changes, page number held constant, so it
    // is unambiguously a new chapter and NOT tolerated page drift.
    expect(classifyRegisterIntent(intent, "https://mangadex.org/other/1", false)).toBe("disarm");
    expect(classifyRegisterIntent(intent, "https://mangadex.org/other/1", true)).toBe("disarm");
  });

  it("§1: armed + same chapter, numeric page-segment drift → send (not disarm)", () => {
    // The 9.9 fix: /ch/1 → /ch/2 is the reader's page rewrite, NOT a chapter change,
    // so a later registration still auto-sends instead of permanently disarming.
    expect(classifyRegisterIntent(intent, "https://mangadex.org/ch/2", false)).toBe("send");
    expect(classifyRegisterIntent(intent, "https://mangadex.org/ch/9", true)).toBe("ignore"); // paused, but NOT disarmed
  });

  it("§1: within the horizon (index ≤ limit) → send", () => {
    expect(
      classifyRegisterIntent(intent, "https://mangadex.org/ch/1", false, { index: 5, limit: 12 }),
    ).toBe("send");
    expect(
      classifyRegisterIntent(intent, "https://mangadex.org/ch/1", false, { index: 12, limit: 12 }),
    ).toBe("send");
  });

  it("§1: beyond the horizon (index > limit) → ignore (stay armed, defer to the pump)", () => {
    expect(
      classifyRegisterIntent(intent, "https://mangadex.org/ch/1", false, { index: 13, limit: 12 }),
    ).toBe("ignore");
  });

  it("§1: a NaN index/limit defers (fail-cheap), and href/pause still take precedence", () => {
    expect(
      classifyRegisterIntent(intent, "https://mangadex.org/ch/1", false, { index: NaN, limit: 12 }),
    ).toBe("ignore");
    // A chapter change beats the horizon; a within-horizon registration on a NEW
    // chapter (non-numeric segment drift, §1) still disarms rather than sending.
    expect(
      classifyRegisterIntent(intent, "https://mangadex.org/other/2", false, { index: 3, limit: 12 }),
    ).toBe("disarm");
  });
});

describe("viewportQueue — translate-all persistence across recycling (§2 shell)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2,
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const cand = (id: string): Candidate => ({ id, el: fakeEl(), url: `https://x/${id}.jpg` });

  /** A NON-auto site (autoEnqueue false) — the exact hole: translate-all works,
   *  visibility never sends, so §2 is the only path that reaches a recycled page. */
  function makeQueue(overlay: OverlaySink, getHref: () => string) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      concurrency: 6,
      autoEnqueue: false,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      getHref,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  const translateCalls = () =>
    mockSend.mock.calls.filter((c) => c[0] === "translatePage");

  it("a real requestAll arms the intent → a later registration auto-sends at translate-all priority", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay, () => "https://mangadex.org/ch/1");
    queue.register(cand("a"));
    queue.register(cand("b"));
    expect(queue.requestAll()).toBe(2); // sends a + b, arms the intent
    expect(translateCalls()).toHaveLength(2);

    // A recycled <img>'s fresh candidate (or a late lazy-loaded page) registers
    // AFTER the burst → §2 auto-sends it instead of leaving it blank.
    const late = cand("c");
    queue.register(late);
    await tick();
    expect(translateCalls()).toHaveLength(3);
    expect(translateCalls()[2]![1]).toMatchObject({
      imageUrl: late.url,
      priority: TRANSLATE_ALL_PRIORITY,
    });
    expect(overlay.setPending).toHaveBeenCalledWith(late);
    queue.stop();
  });

  it("a dry-run requestAll does NOT arm the intent", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay(), () => "https://mangadex.org/ch/1");
    queue.register(cand("a"));
    expect(queue.requestAll(true)).toBe(1); // counts only — sends nothing, arms nothing
    expect(translateCalls()).toHaveLength(0);

    queue.register(cand("b"));
    await tick();
    expect(translateCalls()).toHaveLength(0); // unarmed → no auto-send
    queue.stop();
  });

  it("setPaused(true) disarms → a later registration is not auto-sent", async () => {
    mockSend.mockImplementation((type: string) =>
      type === "cancelQueuedTranslations"
        ? Promise.resolve({ cancelled: 0 })
        : new Promise<never>(() => {}),
    );
    const queue = makeQueue(fakeOverlay(), () => "https://mangadex.org/ch/1");
    queue.register(cand("a"));
    queue.requestAll(); // arm + send a
    expect(translateCalls()).toHaveLength(1);

    await queue.setPaused(true); // revoke the intent
    queue.register(cand("b"));
    await tick();
    expect(translateCalls()).toHaveLength(1); // disarmed → no auto-send
    queue.stop();
  });

  it("stop() disarms → a registration afterward is not auto-sent", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay(), () => "https://mangadex.org/ch/1");
    queue.register(cand("a"));
    queue.requestAll(); // arm + send a
    expect(translateCalls()).toHaveLength(1);

    queue.stop(); // teardown revokes the intent
    queue.register(cand("b"));
    await tick();
    expect(translateCalls()).toHaveLength(1);
  });

  it("a chapter change at register time disarms and does not send (SPA chapter change)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://mangadex.org/ch/1";
    const queue = makeQueue(fakeOverlay(), () => href);
    queue.register(cand("a"));
    queue.requestAll(); // arm on ch/1 + send a
    expect(translateCalls()).toHaveLength(1);

    // §1: a REAL chapter change (non-numeric segment drift) — a numeric /ch/2 drift
    // would be tolerated (covered below); this leading-segment change must disarm.
    href = "https://mangadex.org/other/1"; // SPA navigated to a new chapter
    queue.register(cand("b")); // a new chapter's image must NOT inherit the intent
    await tick();
    expect(translateCalls()).toHaveLength(1);

    // The intent is now permanently disarmed — returning to ch/1 does not re-arm it.
    href = "https://mangadex.org/ch/1";
    queue.register(cand("c"));
    await tick();
    expect(translateCalls()).toHaveLength(1);
    queue.stop();
  });

  it("§1: the reader's numeric page-segment drift keeps the intent armed → later pages still auto-send", async () => {
    // The 9.9 regression: a long-strip reader rewrites the page-number path segment as
    // the user scrolls. On the pre-9.9 exact-href scope the first rewrite permanently
    // disarmed the intent and every later-registering page stayed blank.
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://mangadex.org/chapter-long.html/1";
    const queue = makeQueue(fakeOverlay(), () => href);
    queue.register(cand("a"));
    queue.requestAll(); // arm on /chapter-long.html/1 + send a
    expect(translateCalls()).toHaveLength(1);

    href = "https://mangadex.org/chapter-long.html/7"; // reader scrolled — page segment drifted
    const late = cand("b");
    queue.register(late); // a page registering after the drift must STILL auto-send
    await tick();
    expect(translateCalls()).toHaveLength(2);
    expect(translateCalls()[1]![1]).toMatchObject({
      imageUrl: late.url,
      priority: TRANSLATE_ALL_PRIORITY,
    });
    queue.stop();
  });

  it("§2: the reader's numeric QUERY page drift keeps the intent armed → later pages still auto-send", async () => {
    // A reader that tracks the page in the query string (`?page=N`) rewrites it as the
    // user scrolls; Phase 10 §2 tolerates that drift so later pages still auto-send.
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://mangadex.org/reader?page=1";
    const queue = makeQueue(fakeOverlay(), () => href);
    queue.register(cand("a"));
    queue.requestAll(); // arm on ?page=1 + send a
    expect(translateCalls()).toHaveLength(1);

    href = "https://mangadex.org/reader?page=7"; // query counter drifted
    const late = cand("b");
    queue.register(late);
    await tick();
    expect(translateCalls()).toHaveLength(2);
    expect(translateCalls()[1]![1]).toMatchObject({
      imageUrl: late.url,
      priority: TRANSLATE_ALL_PRIORITY,
    });
    queue.stop();
  });

  it("§2: a non-numeric query change disarms (a real chapter change via the query string)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://mangadex.org/reader?chapter=abc";
    const queue = makeQueue(fakeOverlay(), () => href);
    queue.register(cand("a"));
    queue.requestAll(); // arm on ?chapter=abc + send a
    expect(translateCalls()).toHaveLength(1);

    href = "https://mangadex.org/reader?chapter=xyz"; // non-numeric query drift = new chapter
    queue.register(cand("b"));
    await tick();
    expect(translateCalls()).toHaveLength(1); // disarmed → no auto-send
    queue.stop();
  });
});

describe("viewportQueue — staged translate-all dispatch (§1 shell)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({
      compareDocumentPosition: () => 2, // never FOLLOWING → append-order = doc order
      getBoundingClientRect: () => VISIBLE_RECT,
    }) as unknown as Element;
  const cand = (id: string): Candidate => ({ id, el: fakeEl(), url: `https://x/${id}.jpg` });

  /** A NON-auto site (the §1-critical case): translate-all works, but visibility
   *  never sends, so the staged window + pump are the only dispatch path. */
  function makeQueue(overlay: OverlaySink, href = "https://x/ch/1", requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      concurrency: 6,
      autoEnqueue: false,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      requestTimeoutMs,
      getHref: () => href,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  const translateCalls = () => mockSend.mock.calls.filter((c) => c[0] === "translatePage");
  const sentUrls = () => translateCalls().map((c) => (c[1] as { imageUrl: string }).imageUrl);

  it("a real requestAll on a 30-candidate queue dispatches EXACTLY the initial wave", () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 30 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);

    // Return value is the TOTAL pending (30), not the initial wave.
    expect(queue.requestAll()).toBe(30);
    // seed 0 (top), nothing confirmed ⇒ anchor 0, limit 12 ⇒ indices 0..12 = 13 pages.
    expect(translateCalls()).toHaveLength(TRANSLATE_ALL_BATCH + 1);
    expect(sentUrls()).toEqual(cands.slice(0, 13).map((c) => c.url));
    queue.stop();
  });

  it("a small chapter (≤ batch) dispatches every page in the initial wave (A/B parity)", () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 5 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    expect(queue.requestAll()).toBe(5);
    expect(translateCalls()).toHaveLength(5); // all dispatched at once — like today
    queue.stop();
  });

  it("a confirm advances the staged horizon (the pump dispatches up to k + batch)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 30 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    queue.requestAll(); // initial wave: indices 0..12
    expect(translateCalls()).toHaveLength(13);

    // Confirm index 10 → maxConfirmed 10 → horizon 22 → pump fills 13..22.
    const [visible] = FakeIO.instances;
    visible!.fire(cands[10]!.el, true);
    await tick(); // confirm (0 ms delay) runs → pump
    expect(translateCalls()).toHaveLength(23);
    expect(sentUrls().slice(13)).toEqual(cands.slice(13, 23).map((c) => c.url));
    queue.stop();
  });

  it("re-sends a window-covered candidate whose earlier send reset — the SWEEPER", async () => {
    // c3's send resolves aborted → sendTranslate resets requested=false in place; the
    // other in-window pages hang (stay requested). A later confirm-driven pump must
    // re-dispatch c3 (it is behind the horizon and now unrequested).
    mockSend.mockImplementation((type: string, payload?: unknown) => {
      if (type === "cancelTranslation") return Promise.resolve(undefined);
      if (type === "translatePage" && (payload as { imageUrl?: string }).imageUrl?.includes("/c3.")) {
        return Promise.resolve({ ok: false, errorKind: "aborted" });
      }
      return new Promise<never>(() => {}); // everything else hangs
    });
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 30 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    queue.requestAll(); // dispatch 0..12; c3's send will reset
    await tick();
    const beforeSweep = translateCalls().length; // 13 initial sends (c3 among them)

    // Confirm index 0 (in window) → pump re-plans 0..12; only c3 is now unrequested.
    const [visible] = FakeIO.instances;
    visible!.fire(cands[0]!.el, true);
    await tick();
    expect(translateCalls()).toHaveLength(beforeSweep + 1); // exactly c3 re-sent
    expect(sentUrls()[sentUrls().length - 1]).toBe(cands[3]!.url);
    queue.stop();
  });

  it("a beyond-horizon late registration defers, then dispatches once a confirm reaches it", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 15 }, (_, i) => cand(`c${i}`));
    queue.register(cands[0]!);
    queue.requestAll(); // arms; only c0 exists so far → dispatches c0
    expect(translateCalls()).toHaveLength(1);

    // Register the rest AFTER arming (late lazy-loaded pages). Indices 1..12 are within
    // the horizon (12) → auto-send; 13,14 are beyond → deferred, not dropped.
    for (let i = 1; i < 15; i++) queue.register(cands[i]!);
    await tick();
    expect(translateCalls()).toHaveLength(13); // c0..c12, NOT c13/c14

    // A confirm at index 5 advances maxConfirmed → horizon 17 → the pump sweeps in the
    // two deferred tail pages.
    const [visible] = FakeIO.instances;
    visible!.fire(cands[5]!.el, true);
    await tick();
    expect(translateCalls()).toHaveLength(15);
    queue.stop();
  });

  it("non-auto arming attaches the visible observer to every candidate; disarm detaches", async () => {
    mockSend.mockImplementation((type: string) =>
      type === "cancelQueuedTranslations"
        ? Promise.resolve({ cancelled: 0 })
        : new Promise<never>(() => {}),
    );
    const queue = makeQueue(fakeOverlay());
    const a = cand("a");
    const b = cand("b");
    queue.register(a);
    queue.register(b);
    const [visible, near] = FakeIO.instances;
    expect(visible!.observeLog).toEqual([]); // nothing observed until a translate-all arms

    queue.requestAll();
    expect(visible!.observeLog).toEqual([a.el, b.el]);
    expect(near!.observeLog).toEqual([]); // near stays auto-only

    await queue.setPaused(true); // disarm → detach the visible observers
    expect(visible!.unobserveLog).toEqual(expect.arrayContaining([a.el, b.el]));
    queue.stop();
  });

  it("the pump disarms with NO dispatch when the CHAPTER changed under it (SPA nav)", async () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://x/ch/1";
    const queue = createViewportQueue({
      overlay: fakeOverlay(),
      prefetchAhead: 0,
      autoEnqueue: false,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      getHref: () => href,
      createObserver: (cb, options) => new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
    const cands = Array.from({ length: 20 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    queue.requestAll(); // dispatches 0..12 on ch/1
    const dispatched = translateCalls().length;
    expect(dispatched).toBe(13);

    href = "https://x/other/1"; // §1: a REAL chapter change (non-numeric segment drift)
    const [visible] = FakeIO.instances;
    visible!.fire(cands[15]!.el, true); // confirm → pump, but a chapter change disarms
    await tick();
    expect(translateCalls()).toHaveLength(dispatched); // no new dispatch

    // Disarmed permanently: a later registration does not auto-send even back on ch/1.
    href = "https://x/ch/1";
    queue.register(cand("late"));
    await tick();
    expect(translateCalls()).toHaveLength(dispatched);
    queue.stop();
  });

  it("§1: the pump TOLERATES numeric page drift and keeps refilling on a confirm (the 9.9 fix)", async () => {
    // The regression proper: the reader scrolls, the reader's page-number path segment
    // drifts, and the pump must NOT disarm — a confirm still advances the horizon and
    // the staged window keeps refilling past the URL rewrite (no frozen initial wave).
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    let href = "https://x/chapter-long.html/1";
    const queue = createViewportQueue({
      overlay: fakeOverlay(),
      prefetchAhead: 0,
      autoEnqueue: false,
      hydrate: false,
      makeRequestId: () => "rq",
      ...CONFIRM_SEAMS,
      getHref: () => href,
      createObserver: (cb, options) => new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
    const cands = Array.from({ length: 30 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    queue.requestAll(); // initial wave: indices 0..12 on /chapter-long.html/1
    expect(translateCalls()).toHaveLength(13);

    href = "https://x/chapter-long.html/11"; // reader scrolled — page segment drifted
    const [visible] = FakeIO.instances;
    visible!.fire(cands[10]!.el, true); // confirm index 10 → horizon 22 → pump fills 13..22
    await tick();
    expect(translateCalls()).toHaveLength(23);
    expect(sentUrls().slice(13)).toEqual(cands.slice(13, 23).map((c) => c.url));

    // And a page registering after the drift still auto-sends (register-path tolerance).
    href = "https://x/chapter-long.html/12";
    const late = cand("late");
    queue.register(late); // index 30, beyond horizon 22 → deferred, not disarmed
    await tick();
    expect(translateCalls()).toHaveLength(23); // deferred (beyond horizon), NOT dropped/disarmed
    visible!.fire(cands[25]!.el, true); // confirm 25 → horizon 37 → sweeps in 23..29 + late
    await tick();
    // `.includes(...)` not `toContain`: `Node` is stubbed to a non-constructor here and
    // vitest's `toContain` does an internal `instanceof Node` that would throw on it.
    expect(sentUrls().includes(late.url)).toBe(true);
    queue.stop();
  });

  it("makes the pump a no-op while paused (arming happens, dispatch does not)", async () => {
    mockSend.mockImplementation((type: string) =>
      type === "cancelQueuedTranslations"
        ? Promise.resolve({ cancelled: 0 })
        : new Promise<never>(() => {}),
    );
    const queue = makeQueue(fakeOverlay());
    const cands = Array.from({ length: 20 }, (_, i) => cand(`c${i}`));
    for (const c of cands) queue.register(c);
    await queue.setPaused(true);

    // requestAll is a no-op while paused (nothing armed, nothing dispatched).
    expect(queue.requestAll()).toBe(0);
    expect(translateCalls()).toHaveLength(0);
    queue.stop();
  });
});
