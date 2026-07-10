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
