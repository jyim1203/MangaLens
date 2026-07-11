import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// regionSelect.ts → shared/messages → webextension-polyfill (throws in node).
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  MIN_DRAG_PX,
  acquisitionPlan,
  isClickNotDrag,
  normalizeDragRect,
  pickTargetImage,
  selectionToImageBbox,
  sourceKindForUrl,
  type Rect,
} from "../../src/content/regionSelect";

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  width,
  height,
});

describe("regionSelect — normalizeDragRect", () => {
  it("normalizes a down-right drag", () => {
    expect(normalizeDragRect({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual(
      rect(10, 20, 100, 200),
    );
  });

  it("normalizes an up-left drag to the same rect (inverted drag works)", () => {
    expect(normalizeDragRect({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual(
      rect(10, 20, 100, 200),
    );
  });

  it("keeps a PAGE-space anchor fixed across a mid-drag scroll (§8 scrolled case)", () => {
    // Press at pageY=100 (client 100, scroll 0). User scrolls 200 without moving
    // the mouse: client stays 100 but pageY becomes 300. The page anchor is fixed,
    // so the rect grows downward instead of shifting.
    const anchorPage = { x: 0, y: 100 };
    const endPageAfterScroll = { x: 50, y: 100 + 200 }; // clientY 100 + scrollY 200
    expect(normalizeDragRect(anchorPage, endPageAfterScroll)).toEqual(
      rect(0, 100, 50, 200),
    );
  });
});

describe("regionSelect — isClickNotDrag", () => {
  it("treats a sub-threshold drag as a click (cancel)", () => {
    expect(isClickNotDrag(rect(0, 0, MIN_DRAG_PX - 1, 100))).toBe(true);
    expect(isClickNotDrag(rect(0, 0, 100, MIN_DRAG_PX - 1))).toBe(true);
  });

  it("treats a real drag as a selection", () => {
    expect(isClickNotDrag(rect(0, 0, 40, 40))).toBe(false);
  });
});

describe("regionSelect — selectionToImageBbox", () => {
  it("computes a normalized crop for a selection fully inside the image", () => {
    // Image at (100,100) 400×400; selection covers its center quarter.
    const bbox = selectionToImageBbox(rect(200, 200, 200, 200), rect(100, 100, 400, 400));
    expect(bbox).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it("clips a selection that spills past the image edges", () => {
    // Selection starts left/above the image and ends inside it.
    const bbox = selectionToImageBbox(rect(0, 0, 300, 300), rect(100, 100, 400, 400));
    expect(bbox).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it("is invariant to browser zoom (both rects scale together)", () => {
    const unzoomed = selectionToImageBbox(rect(200, 200, 200, 200), rect(100, 100, 400, 400));
    // Zoom ×1.5 scales every CSS px equally → same normalized crop.
    const zoomed = selectionToImageBbox(rect(300, 300, 300, 300), rect(150, 150, 600, 600));
    expect(zoomed).toEqual(unzoomed);
  });

  it("returns null when the selection misses the image", () => {
    expect(selectionToImageBbox(rect(0, 0, 50, 50), rect(100, 100, 400, 400))).toBeNull();
  });

  it("returns null for a degenerate image", () => {
    expect(selectionToImageBbox(rect(0, 0, 50, 50), rect(0, 0, 0, 0))).toBeNull();
  });
});

describe("regionSelect — pickTargetImage", () => {
  const a = rect(0, 0, 100, 100);
  const b = rect(120, 0, 100, 100);

  it("picks the image with the largest intersection", () => {
    // Selection overlaps mostly image b.
    expect(pickTargetImage(rect(90, 0, 100, 50), [a, b])).toBe(1);
  });

  it("returns null when the selection intersects nothing", () => {
    expect(pickTargetImage(rect(400, 400, 20, 20), [a, b])).toBeNull();
  });

  it("breaks an equal-overlap tie toward the larger image", () => {
    // Selection sits equally on two stacked images sharing the overlap column,
    // but the second is larger overall → wins the tie.
    const small = rect(0, 0, 100, 100);
    const large = rect(0, 0, 300, 300);
    // A selection fully inside both has intersection = min area with each; make the
    // intersection identical by selecting a 50×50 region inside both.
    expect(pickTargetImage(rect(10, 10, 50, 50), [small, large])).toBe(1);
  });
});

describe("regionSelect — sourceKindForUrl + acquisitionPlan (item 2)", () => {
  it("classifies image URLs by scheme", () => {
    expect(sourceKindForUrl("https://x/a.jpg")).toBe("img-http");
    expect(sourceKindForUrl("http://x/a.jpg")).toBe("img-http");
    expect(sourceKindForUrl("data:image/png;base64,AAAA")).toBe("img-data");
    expect(sourceKindForUrl("blob:https://x/uuid")).toBe("img-blob");
    expect(sourceKindForUrl("")).toBe("unsupported");
    expect(sourceKindForUrl(null)).toBe("unsupported");
    expect(sourceKindForUrl("about:blank")).toBe("unsupported");
  });

  it("routes http/data by URL, blob/canvas by bytes, unsupported as unsupported", () => {
    expect(acquisitionPlan("img-http")).toEqual({ send: "url" });
    expect(acquisitionPlan("img-data")).toEqual({ send: "url" });
    expect(acquisitionPlan("img-blob")).toEqual({ send: "bytes" });
    expect(acquisitionPlan("canvas")).toEqual({ send: "bytes" });
    expect(acquisitionPlan("unsupported")).toEqual({ send: "unsupported" });
  });
});
