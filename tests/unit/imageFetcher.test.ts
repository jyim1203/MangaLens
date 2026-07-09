import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchImageBytes,
  ImageFetchError,
  MAX_IMAGE_BYTES,
  type ImageFetchReason,
} from "../../src/background/imageFetcher";

/** Build a Response with the given body/headers, as global fetch would return. */
function imageResponse(
  body: BlobPart[],
  init: {
    status?: number;
    contentType?: string | null;
    url?: string;
    contentLength?: string;
  } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "image/jpeg");
  }
  if (init.contentLength !== undefined) {
    headers.set("content-length", init.contentLength);
  }
  const res = new Response(new Blob(body), {
    status: init.status ?? 200,
    headers,
  });
  // Response.url is read-only and empty for constructed responses; stub it so
  // the finalUrl assertion has something to check.
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

/** Assert the promise rejects with an ImageFetchError of the given reason. */
async function expectReason(
  promise: Promise<unknown>,
  reason: ImageFetchReason,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ImageFetchError);
  await promise.catch((err: unknown) => {
    expect((err as ImageFetchError).reason).toBe(reason);
  });
}

describe("background/imageFetcher — fetchImageBytes", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the blob + metadata on a 200 image response (happy path)", async () => {
    fetchMock.mockResolvedValue(
      imageResponse([new Uint8Array([1, 2, 3, 4])], {
        contentType: "image/png",
        url: "https://cdn.example/final.png",
      }),
    );

    const result = await fetchImageBytes("https://cdn.example/p1.png");

    expect(result.byteLength).toBe(4);
    expect(result.contentType).toBe("image/png");
    expect(result.finalUrl).toBe("https://cdn.example/final.png");
    expect(result.blob.size).toBe(4);
    // Request was made with credentials + cache reuse (see WHY in source).
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("force-cache");
  });

  it("rejects a non-absolute URL without fetching (edge: bad-url)", async () => {
    await expectReason(fetchImageBytes("/relative/path.png"), "bad-url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a disallowed scheme without fetching (edge: unsupported-scheme)", async () => {
    await expectReason(fetchImageBytes("ftp://host/x.png"), "unsupported-scheme");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to http-error carrying the status", async () => {
    fetchMock.mockResolvedValue(imageResponse([""], { status: 404 }));
    const promise = fetchImageBytes("https://cdn.example/missing.png");
    await expectReason(promise, "http-error");
    await promise.catch((err: unknown) => {
      expect((err as ImageFetchError).status).toBe(404);
    });
  });

  it("rejects an HTML body (auth wall / soft-404) as not-image", async () => {
    fetchMock.mockResolvedValue(
      imageResponse(["<html>login</html>"], { contentType: "text/html" }),
    );
    await expectReason(
      fetchImageBytes("https://reader.example/p1"),
      "not-image",
    );
  });

  it("rejects a 200 with an empty body as empty", async () => {
    fetchMock.mockResolvedValue(
      imageResponse([], { contentType: "image/jpeg" }),
    );
    await expectReason(fetchImageBytes("https://cdn.example/blank.jpg"), "empty");
  });

  it("rejects a body over the size cap as too-large", async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    fetchMock.mockResolvedValue(
      imageResponse([huge], { contentType: "image/jpeg" }),
    );
    await expectReason(fetchImageBytes("https://cdn.example/huge.jpg"), "too-large");
  });

  it("rejects an oversized content-length BEFORE reading the body", async () => {
    // Empty body on purpose: if the header pre-check were missing, the body
    // read would surface "empty" instead of "too-large".
    fetchMock.mockResolvedValue(
      imageResponse([], {
        contentType: "image/jpeg",
        contentLength: String(MAX_IMAGE_BYTES + 1),
      }),
    );
    await expectReason(
      fetchImageBytes("https://cdn.example/huge.jpg"),
      "too-large",
    );
  });

  it("maps an AbortError from fetch to the aborted reason", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expectReason(fetchImageBytes("https://cdn.example/p1.png"), "aborted");
  });

  it("maps a generic fetch throw to the network reason", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expectReason(fetchImageBytes("https://cdn.example/p1.png"), "network");
  });

  it("falls back to the sniffed Blob type when no content-type header is present", async () => {
    // No header at all; the Blob still reports image/webp → accepted.
    const res = imageResponse([new Uint8Array([1, 2, 3])], { contentType: null });
    Object.defineProperty(res, "blob", {
      value: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    });
    fetchMock.mockResolvedValue(res);

    const result = await fetchImageBytes("https://cdn.example/p1");
    expect(result.contentType).toBe("image/webp");
  });
});
