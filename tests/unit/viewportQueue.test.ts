import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// viewportQueue.ts → messages.ts → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));
// Swap the message bus for a controllable spy so the shell tests can drive the
// translate result without a real background (item 6 retry path).
vi.mock("../../src/shared/messages", () => ({ sendToBackground: vi.fn() }));

import {
  TRANSLATE_ALL_PRIORITY,
  createViewportQueue,
  planEnqueues,
  type OverlaySink,
} from "../../src/content/viewportQueue";
import { sendToBackground } from "../../src/shared/messages";
import type { Candidate } from "../../src/content/scanner";
import type { ProviderErrorKind } from "../../src/shared/types";

const mockSend = vi.mocked(sendToBackground);

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
  el: {} as unknown as Element,
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
    ({ compareDocumentPosition: () => 2 }) as unknown as Element;

  const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
  const candB: Candidate = { id: "b", el: fakeEl(), url: "https://x/b.jpg" };

  function makeQueue(overlay: OverlaySink) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 0,
      autoEnqueue: true,
      makeRequestId: () => "rq",
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  it("dry run counts unrequested candidates without sending anything", () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const queue = makeQueue(fakeOverlay());
    queue.register(candA);
    queue.register(candB);

    // A becomes visible → requested; B untouched.
    FakeIO.instances[0]!.fire(candA.el, true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    expect(queue.requestAll(true)).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1); // dry run sent nothing

    queue.stop();
  });

  it("real run sends the remaining candidates at the prefetch/all priority", () => {
    mockSend.mockReturnValue(new Promise<never>(() => {}));
    const overlay = fakeOverlay();
    const queue = makeQueue(overlay);
    queue.register(candA);
    queue.register(candB);
    FakeIO.instances[0]!.fire(candA.el, true); // A requested at priority 0

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
      makeRequestId: () => "rq",
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
      makeRequestId: () => "rq",
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

    visible!.fire(CAND.el, true); // enters the viewport → sends at priority 0
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
    expect(mockSend).toHaveBeenCalledTimes(1);

    await tick(); // let the aborted result be handled

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
    el: {} as unknown as Element,
    url: "blob:https://reader.example.com/9f8c",
  };
  const HTTP: Candidate = {
    id: "h1",
    el: {} as unknown as Element,
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
      makeRequestId: () => "rq",
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

    expect(acquireBytes).toHaveBeenCalledWith(BLOB.url);
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
    ({ compareDocumentPosition: () => 2 }) as unknown as Element;
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
      makeRequestId: () => "rq",
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

describe("viewportQueue — autoEnqueue=false (per-site opt-in, item 3)", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fakeEl = (): Element =>
    ({ compareDocumentPosition: () => 2 }) as unknown as Element;
  const candA: Candidate = { id: "a", el: fakeEl(), url: "https://x/a.jpg" };
  const candB: Candidate = { id: "b", el: fakeEl(), url: "https://x/b.jpg" };

  function makeQueue(overlay: OverlaySink, requestTimeoutMs?: number) {
    return createViewportQueue({
      overlay,
      prefetchAhead: 3,
      autoEnqueue: false,
      makeRequestId: () => "rq",
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
