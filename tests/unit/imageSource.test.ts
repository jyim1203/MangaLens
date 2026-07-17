// @vitest-environment jsdom
// jsdom: the revoked-blob fallback tests need document.createElement("img") and
// a real HTMLImageElement for the instanceof guard; DOM APIs the fallback uses
// (createImageBitmap, OffscreenCanvas) are stubbed per test.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBlobBytes,
  acquisitionPlan,
  sourceKindForUrl,
} from "../../src/content/imageSource";

describe("imageSource — sourceKindForUrl (pure classification)", () => {
  it("classifies image URLs by scheme", () => {
    expect(sourceKindForUrl("https://x/a.jpg")).toBe("img-http");
    expect(sourceKindForUrl("http://x/a.jpg")).toBe("img-http");
    expect(sourceKindForUrl("data:image/png;base64,AAAA")).toBe("img-data");
    expect(sourceKindForUrl("blob:https://x/uuid")).toBe("img-blob");
    expect(sourceKindForUrl("")).toBe("unsupported");
    expect(sourceKindForUrl(null)).toBe("unsupported");
    expect(sourceKindForUrl(undefined)).toBe("unsupported");
    expect(sourceKindForUrl("about:blank")).toBe("unsupported");
  });
});

describe("imageSource — acquisitionPlan (pure)", () => {
  it("routes http/data by URL, blob/canvas by bytes, unsupported as unsupported", () => {
    expect(acquisitionPlan("img-http")).toEqual({ send: "url" });
    expect(acquisitionPlan("img-data")).toEqual({ send: "url" });
    expect(acquisitionPlan("img-blob")).toEqual({ send: "bytes" });
    expect(acquisitionPlan("canvas")).toEqual({ send: "bytes" });
    expect(acquisitionPlan("unsupported")).toEqual({ send: "unsupported" });
  });
});

describe("imageSource — acquireBlobBytes (thin shell)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // WHY not `new Response(blob)`: under jsdom, undici's Response re-wraps a
  // jsdom Blob and loses its MIME type; the code under test only calls
  // `response.blob()`, so a minimal object is the honest stub.
  const fetchResolving = (blob: Blob) =>
    vi.fn(async () => ({ blob: async () => blob }) as unknown as Response);

  it("fetches the blob URL and returns bytes + mime", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    vi.stubGlobal("fetch", fetchResolving(blob));

    const { imageBytes, imageMime } = await acquireBlobBytes("blob:https://x/uuid");
    expect(imageMime).toBe("image/png");
    expect(new Uint8Array(imageBytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("defaults the mime to image/jpeg when the blob has none", async () => {
    const blob = new Blob([new Uint8Array([9])]); // no type
    vi.stubGlobal("fetch", fetchResolving(blob));
    const { imageMime } = await acquireBlobBytes("blob:https://x/uuid");
    expect(imageMime).toBe("image/jpeg");
  });

  it("propagates a fetch throw (revoked object URL) for the caller to fail soft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(acquireBlobBytes("blob:https://x/dead")).rejects.toThrow();
  });

  it("falls back to the element's decoded bitmap when the URL is revoked (MangaDex)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch"); // revoked object URL
      }),
    );
    const close = vi.fn();
    const createImageBitmap = vi.fn(async () => ({ width: 2, height: 3, close }));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const drawImage = vi.fn();
    const png = new Blob([new Uint8Array([5, 6])], { type: "image/png" });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { drawImage };
        }
        convertToBlob() {
          return Promise.resolve(png);
        }
      },
    );

    const img = document.createElement("img");
    const { imageBytes, imageMime } = await acquireBlobBytes("blob:https://x/dead", img);
    expect(imageMime).toBe("image/png");
    expect(new Uint8Array(imageBytes)).toEqual(new Uint8Array([5, 6]));
    expect(createImageBitmap).toHaveBeenCalledWith(img);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled(); // bitmap released even on success
  });

  it("rethrows the ORIGINAL fetch error when the element is not an <img>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const div = document.createElement("div"); // e.g. a background-image host
    await expect(acquireBlobBytes("blob:https://x/dead", div)).rejects.toThrow(
      "Failed to fetch",
    );
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("does not touch the element when the fetch succeeds", async () => {
    const blob = new Blob([new Uint8Array([7])], { type: "image/webp" });
    vi.stubGlobal("fetch", fetchResolving(blob));
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const img = document.createElement("img");
    const { imageMime } = await acquireBlobBytes("blob:https://x/alive", img);
    expect(imageMime).toBe("image/webp");
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
