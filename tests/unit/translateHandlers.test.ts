import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// translateHandlers.ts transitively imports settings.ts → webextension-polyfill,
// which throws outside a browser; swap it for the fake even though mergeTilePages
// itself is pure.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  createTranslateHandlers,
  errorToTranslateResult,
  mergeTilePages,
  resetInflightForTest,
  resetRequestControllersForTest,
  resetSharedAbortsForTest,
  resetTranslationQueueForTest,
} from "../../src/background/translateHandlers";
import { ImageFetchError } from "../../src/background/imageFetcher";
import { ProviderError } from "../../src/background/providers/ProviderBase";
import type { PageTranslation, TranslatedRegion } from "../../src/shared/types";
import type browser from "webextension-polyfill";

/** A minimal message sender stub for handler calls. */
const SENDER = { url: "https://reader.example.com/ch/1" } as browser.Runtime.MessageSender;

function region(
  bbox: TranslatedRegion["bbox"],
  original: string,
  confidence?: number,
): TranslatedRegion {
  return { bbox, original, translated: original.toUpperCase(), isSfx: false, confidence };
}

function page(overrides: Partial<PageTranslation>): PageTranslation {
  return {
    imageHash: "tile",
    sourceLang: "ja",
    targetLang: "en",
    regions: [],
    model: "m",
    provider: "gemini",
    createdAt: 1,
    ...overrides,
  };
}

describe("translateHandlers — mergeTilePages", () => {
  it("returns a single tile as-is but stamps the page-level hash", () => {
    const only = page({ regions: [region({ x: 0, y: 0, w: 0.2, h: 0.1 }, "a")] });
    const merged = mergeTilePages([only], "page-hash");
    expect(merged.imageHash).toBe("page-hash");
    expect(merged.regions).toHaveLength(1);
  });

  it("concatenates tiles and dedupes overlap-zone duplicates (§7.4)", () => {
    const t1 = page({
      regions: [
        region({ x: 0, y: 0.1, w: 0.3, h: 0.2 }, "top"),
        region({ x: 0.5, y: 0.8, w: 0.3, h: 0.15 }, "seam", 0.6), // in overlap zone
      ],
    });
    const t2 = page({
      regions: [
        region({ x: 0.5, y: 0.8, w: 0.3, h: 0.15 }, "seam", 0.9), // same bubble, higher conf
        region({ x: 0.1, y: 0.9, w: 0.3, h: 0.08 }, "bottom"),
      ],
    });
    const merged = mergeTilePages([t1, t2], "page-hash");

    // top + bottom + one deduped seam = 3
    expect(merged.regions).toHaveLength(3);
    const seam = merged.regions.find((r) => r.original === "seam");
    expect(seam?.confidence).toBe(0.9); // higher-confidence copy survives
  });

  it("picks the first non-und source language and sums token counts", () => {
    const merged = mergeTilePages(
      [
        page({ sourceLang: "und", tokensIn: 10, tokensOut: 5 }),
        page({ sourceLang: "ja", tokensIn: 20, tokensOut: 8 }),
      ],
      "h",
    );
    expect(merged.sourceLang).toBe("ja");
    expect(merged.tokensIn).toBe(30);
    expect(merged.tokensOut).toBe(13);
  });

  it("throws on an empty tile list", () => {
    expect(() => mergeTilePages([], "h")).toThrow();
  });
});

describe("translateHandlers — errorToTranslateResult", () => {
  it("carries a ProviderError's kind across as data (survives sendMessage)", () => {
    const result = errorToTranslateResult(
      new ProviderError("auth", "HTTP 401: authentication failed"),
    );
    expect(result).toEqual({
      ok: false,
      errorKind: "auth",
      message: "HTTP 401: authentication failed",
    });
  });

  it("maps ImageFetchError reasons: aborted stays aborted, the rest become network", () => {
    const aborted = errorToTranslateResult(
      new ImageFetchError("aborted", "Image fetch aborted"),
    );
    expect(aborted).toMatchObject({ ok: false, errorKind: "aborted" });

    const notImage = errorToTranslateResult(
      new ImageFetchError("not-image", "got text/html"),
    );
    expect(notImage).toMatchObject({ ok: false, errorKind: "network" });
    if (!notImage.ok) expect(notImage.message).toContain("not-image");
  });

  it("maps anything unrecognized to unknown (edge: non-Error throw)", () => {
    expect(errorToTranslateResult(new Error("boom"))).toMatchObject({
      ok: false,
      errorKind: "unknown",
      message: "boom",
    });
    expect(errorToTranslateResult("string throw")).toMatchObject({
      ok: false,
      errorKind: "unknown",
      message: "string throw",
    });
  });

  it("maps a raw AbortError to aborted (queue-level pre-run cancel path)", () => {
    expect(
      errorToTranslateResult(new DOMException("Aborted", "AbortError")),
    ).toMatchObject({ ok: false, errorKind: "aborted" });
  });
});

describe("translateHandlers — cancellation wiring (item 4)", () => {
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

  /** Stub global fetch to hang until its signal aborts, resolving `onReached`. */
  function hangingFetch(onReached: () => void): void {
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      onReached();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
  }

  it("cancelTranslation aborts the in-flight request → an aborted result", async () => {
    const handlers = createTranslateHandlers();
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    hangingFetch(reached);

    const pending = handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "req-1" },
      SENDER,
    );
    await atFetch; // now blocked inside the image fetch, controller registered

    void handlers.cancelTranslation!({ requestId: "req-1" }, SENDER);

    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorKind: "aborted" });
  });

  it("cancelTranslation for an unknown id is a silent no-op", () => {
    const handlers = createTranslateHandlers();
    expect(() =>
      handlers.cancelTranslation!({ requestId: "does-not-exist" }, SENDER),
    ).not.toThrow();
  });

  it("removes the request from the registry once it settles (later cancel no-ops)", async () => {
    const handlers = createTranslateHandlers();
    // Fetch rejects immediately → the request settles fast (as a network fail).
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("NetworkError when attempting to fetch")),
    );

    const result = await handlers.translatePage!(
      { imageUrl: "https://x/y.jpg", priority: 0, requestId: "req-2" },
      SENDER,
    );
    expect(result.ok).toBe(false);

    // Entry was removed in the handler's finally; cancelling now is a no-op.
    expect(() =>
      handlers.cancelTranslation!({ requestId: "req-2" }, SENDER),
    ).not.toThrow();
  });
});
