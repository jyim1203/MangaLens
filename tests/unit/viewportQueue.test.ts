import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// viewportQueue.ts → messages.ts → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));
// Swap the message bus for a controllable spy so the shell tests can drive the
// translate result without a real background (item 6 retry path).
vi.mock("../../src/shared/messages", () => ({ sendToBackground: vi.fn() }));

import {
  TRANSLATE_ALL_MAX_TIMEOUT_MS,
  TRANSLATE_ALL_PRIORITY,
  createViewportQueue,
  planEnqueues,
  requestAllTimeoutMs,
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
    expect(mockSend).toHaveBeenCalledWith("cancelTranslation", { requestId: "rq" });
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

    await tick(30); // the 10 ms timeout fires → catch path calls reobserve

    // autoEnqueue=false → reobserve returns early, touching neither observer.
    for (const io of FakeIO.instances) {
      expect(io.observeLog).toEqual([]);
      expect(io.unobserveLog).toEqual([]);
    }
    queue.stop();
  });
});
