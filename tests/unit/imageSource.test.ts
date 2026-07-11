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

  it("fetches the blob URL and returns bytes + mime", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob)));

    const { imageBytes, imageMime } = await acquireBlobBytes("blob:https://x/uuid");
    expect(imageMime).toBe("image/png");
    expect(new Uint8Array(imageBytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("defaults the mime to image/jpeg when the blob has none", async () => {
    const blob = new Blob([new Uint8Array([9])]); // no type
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob)));
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
});
