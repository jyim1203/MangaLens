import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import type { PageTranslation } from "../../src/shared/types";

// Shared spies, hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  fetchImageBytes: vi.fn(),
  prepareImage: vi.fn(),
  translatePage: vi.fn(),
}));

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

// Skip the real HTTP fetch: assert whether the bytes path bypassed it.
vi.mock("../../src/background/imageFetcher", async (orig) => ({
  ...(await orig<typeof import("../../src/background/imageFetcher")>()),
  fetchImageBytes: h.fetchImageBytes,
}));

// prepareImage needs OffscreenCanvas (browser-only) — stub it to a single tile.
vi.mock("../../src/background/imagePrep", async (orig) => ({
  ...(await orig<typeof import("../../src/background/imagePrep")>()),
  prepareImage: h.prepareImage,
}));

// Replace the real provider with a spy; keep resolveEffectiveModel (pure).
vi.mock("../../src/background/providers/factory", async (orig) => ({
  ...(await orig<typeof import("../../src/background/providers/factory")>()),
  createProvider: () => ({ translatePage: h.translatePage }),
}));

import {
  createTranslateHandlers,
  resetInflightForTest,
  resetRateGateForTest,
  resetRequestControllersForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
} from "../../src/background/translateHandlers";
import type browser from "webextension-polyfill";

const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;

function fakePage(): PageTranslation {
  return {
    imageHash: "unused-overwritten-by-merge",
    sourceLang: "ja",
    targetLang: "en",
    regions: [
      { bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, original: "こんにちは", translated: "Hi", isSfx: false },
    ],
    model: "gemini-x",
    provider: "gemini",
    createdAt: 1,
  };
}

describe("translateHandlers — provided-bytes (blob-sourced) path (Phase 7.2 item 1)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetInflightForTest();
    resetSharedAbortsForTest();
    resetTranslationQueueForTest();
    resetRateGateForTest();
    resetRequestControllersForTest();
    h.fetchImageBytes.mockReset();
    h.prepareImage.mockReset();
    h.translatePage.mockReset();

    // A single non-tiled tile carrying whatever blob it's given.
    h.prepareImage.mockImplementation(async (blob: Blob) => ({
      tiles: [{ blob, offset: { x: 0, y: 0, w: 1, h: 1 } }],
      tiled: false,
    }));
    h.translatePage.mockResolvedValue(fakePage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the shipped bytes and does NOT fetch the (blob) URL", async () => {
    const handlers = createTranslateHandlers();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;

    const result = await handlers.translatePage!(
      {
        imageUrl: "blob:https://reader.example.com/9f8c",
        imageBytes: bytes,
        imageMime: "image/png",
        priority: 0,
      },
      SENDER,
    );

    expect(result.ok).toBe(true);
    expect(h.fetchImageBytes).not.toHaveBeenCalled(); // the whole point (§7.3)
    expect(h.translatePage).toHaveBeenCalledTimes(1);
    // prepareImage received a Blob built from the shipped bytes with the mime.
    const preppedBlob = h.prepareImage.mock.calls[0]![0] as Blob;
    expect(preppedBlob.type).toBe("image/png");
    expect(preppedBlob.size).toBe(5);
  });

  it("falls back to fetching when no bytes are shipped (the http path is unchanged)", async () => {
    h.fetchImageBytes.mockResolvedValue({
      blob: new Blob([new Uint8Array([9, 9])], { type: "image/jpeg" }),
    });
    const handlers = createTranslateHandlers();

    const result = await handlers.translatePage!(
      { imageUrl: "https://reader.example.com/page.jpg", priority: 0 },
      SENDER,
    );

    expect(result.ok).toBe(true);
    expect(h.fetchImageBytes).toHaveBeenCalledTimes(1);
  });

  it("coalesces two tabs' identical bytes (different blob URLs) onto ONE provider run", async () => {
    // Page identity is the content hash, not the URL — so the same page under two
    // ephemeral blob URLs must share a single provider call (WHY the cache/coalesce
    // layers needed no change).
    const handlers = createTranslateHandlers();
    const bytes = () => new Uint8Array([5, 5, 5, 5]).buffer;

    const [a, b] = await Promise.all([
      handlers.translatePage!(
        { imageUrl: "blob:https://x/aaa", imageBytes: bytes(), imageMime: "image/png", priority: 0 },
        SENDER,
      ),
      handlers.translatePage!(
        { imageUrl: "blob:https://x/bbb", imageBytes: bytes(), imageMime: "image/png", priority: 0 },
        SENDER,
      ),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(h.translatePage).toHaveBeenCalledTimes(1); // one provider run, shared
  });
});
