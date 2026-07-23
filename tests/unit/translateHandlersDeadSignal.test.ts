import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// A CONTROLLABLE prepareImage (unlike translateHandlersPause's always-hang mock):
// the test swaps `prepareImageImpl` per case so it can hold a job INSIDE prep and
// cancel it there — exercising the Phase 9.6 §3 post-prep tiles guard. The rest of
// imagePrep (pure helpers) stays real.
let prepareImageImpl: (blob: Blob) => Promise<import("../../src/background/imagePrep").PreparedImage>;
vi.mock("../../src/background/imagePrep", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/background/imagePrep")>();
  return {
    ...actual,
    prepareImage: (blob: Blob) => prepareImageImpl(blob),
  };
});

import {
  createTranslateHandlers,
  resetInflightForTest,
  resetRequestControllersForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
  startedRequestsHasForTest,
} from "../../src/background/translateHandlers";
import type { PreparedImage } from "../../src/background/imagePrep";
import type browser from "webextension-polyfill";

const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;

/** A valid-looking image Response so the pipeline reaches the queue + prep. */
function imageResponse(): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

/** A minimal single-tile prepared image (the shape translateTiles consumes). */
function preparedSingle(): PreparedImage {
  return {
    tiles: [
      {
        index: 0,
        blob: new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }),
        offset: { x: 0, y: 0, w: 1, h: 1 },
        widthPx: 10,
        heightPx: 10,
      },
    ],
    naturalWidthPx: 10,
    naturalHeightPx: 10,
    scaledWidthPx: 10,
    scaledHeightPx: 10,
    tiled: false,
  };
}

describe("translateHandlers — §3 dead-signal guard after prep (no provider request)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetRequestControllersForTest();
    resetSharedAbortsForTest();
    resetInflightForTest();
    resetTranslationQueueForTest();
    prepareImageImpl = async () => preparedSingle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a cancel landing DURING prep fires no provider fetch (post-prep tiles guard)", async () => {
    const handlers = createTranslateHandlers();

    // Hold the job inside prep so the cancel lands in the longest in-slot window.
    let reachedPrep!: () => void;
    const atPrep = new Promise<void>((r) => (reachedPrep = r));
    let releasePrep!: () => void;
    const prepGate = new Promise<void>((r) => (releasePrep = r));
    prepareImageImpl = async () => {
      reachedPrep();
      await prepGate;
      return preparedSingle();
    };

    // fetch call #1 = the image fetch; a provider request would be call #2.
    const fetchMock = vi.fn(() => Promise.resolve(imageResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "t1" },
      SENDER,
    );
    await atPrep; // onStarted fired, now sitting inside prepareImage
    expect(startedRequestsHasForTest("t1")).toBe(true);

    // Abort mid-prep, then let prep finish → translateTiles sees the dead signal.
    handlers.cancelTranslation!({ requestId: "t1", mode: "hard" }, SENDER);
    releasePrep();

    await expect(pending).resolves.toMatchObject({ ok: false, errorKind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // image fetch only — NO provider call
  });
});
