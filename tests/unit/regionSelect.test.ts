import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// regionSelect.ts → shared/messages → webextension-polyfill (throws in node).
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  MIN_DRAG_PX,
  isClickNotDrag,
  normalizeDragRect,
  pickTargetImage,
  selectionToImageBbox,
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

describe("regionSelect — letterboxed crop normalizes against the DRAWN bitmap (Phase 7.3 item 4)", () => {
  // A portrait bitmap (400×900) drawn with object-fit: contain in a WIDE 800×450
  // element box letterboxes to a centered 200×450 rect at x∈[300,500]. Phase 7.3
  // makes defaultCollectTargets feed THIS drawn-bitmap rect (not the element box)
  // as the target.rect, so the pure crop/pick math below sees the bitmap.
  const bitmap = rect(300, 0, 200, 450);

  it("returns null for a selection over the letterbox bar only (no request fires)", () => {
    const overLeftBar = rect(50, 50, 100, 100); // x∈[50,150], left of the bitmap
    expect(pickTargetImage(overLeftBar, [bitmap])).toBeNull();
    expect(selectionToImageBbox(overLeftBar, bitmap)).toBeNull();
  });

  it("normalizes a selection over the bitmap to the BITMAP rect, not the element box", () => {
    // Center quarter of the bitmap. Normalized against the 200×450 bitmap this is
    // the clean center quarter; against the wider 800×450 element box it would be a
    // DIFFERENT (wrong) region — the silent wrong-crop bug this phase fixes.
    const overBitmap = rect(350, 112.5, 100, 225);
    expect(pickTargetImage(overBitmap, [bitmap])).toBe(0);
    expect(selectionToImageBbox(overBitmap, bitmap)).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.5,
    });
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

// Source classification + acquisition plan moved to imageSource.test.ts in
// Phase 7.2 (the pure helpers now live in the shared imageSource module).
