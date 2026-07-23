import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// Mock prepareImage to hang so a job can sit in the "started" state (its queue
// task ran → onStarted fired) while we probe cancelQueuedTranslations. The pure
// helpers (dedupeRegions/iou/remapBboxFromTile) stay real so the rest of the
// pipeline behaves normally.
vi.mock("../../src/background/imagePrep", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/background/imagePrep")>();
  return {
    ...actual,
    prepareImage: vi.fn(() => new Promise(() => {})), // never settles
  };
});

import {
  createTranslateHandlers,
  requestControllerHasForTest,
  resetInflightForTest,
  resetRequestControllersForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
  startedRequestsHasForTest,
} from "../../src/background/translateHandlers";
import type browser from "webextension-polyfill";

const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;

/** A valid-looking image Response so the pipeline reaches the queue. */
function imageResponse(): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("translateHandlers — cancelQueuedTranslations (Phase 7.4 pause)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetRequestControllersForTest();
    resetSharedAbortsForTest();
    resetInflightForTest();
    resetTranslationQueueForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts a registered-not-started id, skips an unknown id, and counts correctly", async () => {
    const handlers = createTranslateHandlers();
    // Fetch hangs → the request is registered (controller) but never reaches the
    // queue task, so it is NOT started — exactly the queued state pause cancels.
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      reached();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "queued-1" },
      SENDER,
    );
    await atFetch; // controller registered, still queued (fetch pending)

    const res = handlers.cancelQueuedTranslations!(
      { requestIds: ["queued-1", "unknown-id"] },
      SENDER,
    );
    expect(res).toEqual({ cancelled: 1 });

    // The aborted request surfaces as an aborted result.
    await expect(pending).resolves.toMatchObject({ ok: false, errorKind: "aborted" });
  });

  it("an aborted job logs no warn-level noise (Phase 7.5 item 2)", async () => {
    // A 15-page pause aborts every queued job; each abort used to log a
    // warn-level "translatePage failed … All waiters aborted" that reads as a
    // failure. The catch now gates aborts to debug — assert nothing warns here.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handlers = createTranslateHandlers();
      let reached!: () => void;
      const atFetch = new Promise<void>((r) => (reached = r));
      vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
        reached();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      });

      const pending = handlers.translatePage!(
        { imageUrl: "https://x/y.jpg", priority: 0, requestId: "queued-1" },
        SENDER,
      );
      await atFetch;
      handlers.cancelQueuedTranslations!({ requestIds: ["queued-1"] }, SENDER);
      await expect(pending).resolves.toMatchObject({ ok: false, errorKind: "aborted" });

      const warnedFailure = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("translatePage failed")),
      );
      expect(warnedFailure).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips an already-started id (its provider call keeps running)", async () => {
    const handlers = createTranslateHandlers();
    vi.stubGlobal("fetch", () => Promise.resolve(imageResponse()));

    // The mocked prepareImage hangs, so once the queue task runs (onStarted fires)
    // the job stays in-flight and STARTED.
    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "started-1" },
      SENDER,
    );
    void pending; // never settles (prepareImage hangs); we only probe the registry
    // Let fetch → hash → cache-miss → queue dequeue → onStarted run. Poll rather
    // than guess a fixed tick count (the async hops through storage/idb vary).
    for (let i = 0; i < 100 && !startedRequestsHasForTest("started-1"); i++) {
      await tick();
    }
    expect(startedRequestsHasForTest("started-1")).toBe(true);

    const res = handlers.cancelQueuedTranslations!(
      { requestIds: ["started-1"] },
      SENDER,
    );
    // Started → not cancellable by pause; that's the feature.
    expect(res).toEqual({ cancelled: 0 });
  });
});

describe("translateHandlers — cancelTranslation soft-cancel (Phase 9.6 §1)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetRequestControllersForTest();
    resetSharedAbortsForTest();
    resetInflightForTest();
    resetTranslationQueueForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fetch that hangs at the IMAGE fetch (rejecting on abort) → the request is
   *  registered (controller) but its provider call never starts (queued state). */
  function hangUnstarted(onReached: () => void): void {
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      onReached();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
  }

  /** Drive a request past the started boundary (mocked prepareImage hangs after
   *  onStarted fires) and return once `startedRequests` records it. */
  async function startAndWait(handlers: ReturnType<typeof createTranslateHandlers>, id: string) {
    vi.stubGlobal("fetch", () => Promise.resolve(imageResponse()));
    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: id },
      SENDER,
    );
    void pending; // never settles (prepareImage hangs) — we only probe the registries
    for (let i = 0; i < 100 && !startedRequestsHasForTest(id); i++) await tick();
    expect(startedRequestsHasForTest(id)).toBe(true);
  }

  it("queued-only aborts a not-yet-started job and deregisters it", async () => {
    const handlers = createTranslateHandlers();
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    hangUnstarted(reached);

    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "q1" },
      SENDER,
    );
    await atFetch; // controller registered, still queued (image fetch pending)
    expect(startedRequestsHasForTest("q1")).toBe(false);

    handlers.cancelTranslation!({ requestId: "q1", mode: "queued-only" }, SENDER);
    await expect(pending).resolves.toMatchObject({ ok: false, errorKind: "aborted" });
    expect(requestControllerHasForTest("q1")).toBe(false); // deregistered on abort
  });

  it("queued-only SPARES a started job — controller retained, not aborted", async () => {
    const handlers = createTranslateHandlers();
    await startAndWait(handlers, "s1");

    handlers.cancelTranslation!({ requestId: "s1", mode: "queued-only" }, SENDER);

    // Spared: the started run keeps going (its provider call already billed) so it
    // finishes + caches. Controller + started mark both retained until it settles.
    expect(requestControllerHasForTest("s1")).toBe(true);
    expect(startedRequestsHasForTest("s1")).toBe(true);
  });

  it("hard aborts a started job (teardown path), deregistering it", async () => {
    const handlers = createTranslateHandlers();
    await startAndWait(handlers, "s2");

    handlers.cancelTranslation!({ requestId: "s2", mode: "hard" }, SENDER);
    expect(requestControllerHasForTest("s2")).toBe(false); // aborted + removed
  });

  it("mode-absent defaults to hard (aborts a started job — byte-compatible caller)", async () => {
    const handlers = createTranslateHandlers();
    await startAndWait(handlers, "s3");

    handlers.cancelTranslation!({ requestId: "s3" }, SENDER); // no mode field
    expect(requestControllerHasForTest("s3")).toBe(false);
  });

  it("unknown id is a silent no-op in both modes", () => {
    const handlers = createTranslateHandlers();
    expect(() =>
      handlers.cancelTranslation!({ requestId: "nope", mode: "queued-only" }, SENDER),
    ).not.toThrow();
    expect(() =>
      handlers.cancelTranslation!({ requestId: "nope", mode: "hard" }, SENDER),
    ).not.toThrow();
  });
});
