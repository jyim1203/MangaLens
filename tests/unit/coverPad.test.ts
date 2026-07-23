import { describe, expect, it } from "vitest";
import {
  FALLBACK_COVER_PAD,
  computeFallbackCoverRects,
} from "../../src/content/overlay/coverPad";
import type { PxRect } from "../../src/content/overlay/geometry";
import type { RegionKind, TranslatedRegion } from "../../src/shared/types";

/** A minimal region carrying only the fields the cover-pad reads (kind/fillColor). */
function region(kind?: RegionKind, fillColor?: string): TranslatedRegion {
  return {
    bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
    original: "x",
    translated: "X",
    isSfx: false,
    ...(kind ? { kind } : {}),
    ...(fillColor ? { fillColor } : {}),
  };
}

const BOUNDS = { width: 1000, height: 1000 };
/** A snap-FAILURE bubble = a bubble kind with no snapped fillColor. */
const FALLBACK = region("bubble");

describe("overlay/coverPad — computeFallbackCoverRects (Phase 9.5 §3)", () => {
  it("expands an isolated snap-failure bubble by the pad on all four sides", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 };
    const [out] = computeFallbackCoverRects([FALLBACK], [rect], BOUNDS);
    // padX = padY = 0.12 · 100 = 12, so it grows 12 px each side (right/bottom too).
    expect(out).toEqual({ left: 388, top: 388, width: 124, height: 124 });
    // Concrete default pad pinned.
    expect(FALLBACK_COVER_PAD).toBe(0.12);
  });

  it("stops the right edge at a neighbour abutting on the right, full pad elsewhere", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 }; // right = 500
    const neighbour: PxRect = { left: 500, top: 400, width: 100, height: 100 }; // abuts R's right
    const [out] = computeFallbackCoverRects(
      [FALLBACK, region("bubble", "#ffffff")], // the neighbour is irrelevant kind-wise
      [rect, neighbour],
      BOUNDS,
    );
    // Right edge cannot cross into the neighbour → stays at 500 (no growth). Left,
    // top, bottom still get the full 12 px pad.
    expect(out!.left).toBe(388);
    expect(out!.top).toBe(388);
    expect(out!.left + out!.width).toBe(500); // right edge unmoved
    expect(out!.top + out!.height).toBe(512); // bottom grew
  });

  it("does not clamp against a neighbour that only touches a DIFFERENT edge span", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 };
    // A box far below-left that shares neither R's vertical nor horizontal span in
    // the relevant direction — must not constrain the right growth.
    const neighbour: PxRect = { left: 500, top: 900, width: 50, height: 50 };
    const [out] = computeFallbackCoverRects([FALLBACK, region()], [rect, neighbour], BOUNDS);
    expect(out).toEqual({ left: 388, top: 388, width: 124, height: 124 });
  });

  it("leaves a SNAPPED bubble (fillColor set) unchanged", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 };
    const [out] = computeFallbackCoverRects([region("bubble", "#ffffff")], [rect], BOUNDS);
    expect(out).toEqual(rect);
  });

  it("leaves non-bubble kinds (and untyped regions) unchanged", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 };
    for (const r of [region("sfx"), region("caption"), region("sign"), region()]) {
      const [out] = computeFallbackCoverRects([r], [rect], BOUNDS);
      expect(out).toEqual(rect);
    }
  });

  it("clamps the expansion to the image bounds (both edges)", () => {
    const topLeft: PxRect = { left: 0, top: 0, width: 100, height: 100 };
    const [tl] = computeFallbackCoverRects([FALLBACK], [topLeft], BOUNDS);
    expect(tl!.left).toBe(0); // can't grow past the left edge
    expect(tl!.top).toBe(0);
    expect(tl!.width).toBe(112); // right still grows 12
    expect(tl!.height).toBe(112);

    const botRight: PxRect = { left: 900, top: 900, width: 100, height: 100 };
    const [br] = computeFallbackCoverRects([FALLBACK], [botRight], BOUNDS);
    expect(br!.left).toBe(888); // left grows 12
    expect(br!.left + br!.width).toBe(1000); // right pinned at the bound
    expect(br!.top + br!.height).toBe(1000);
  });

  it("honours a pad override", () => {
    const rect: PxRect = { left: 400, top: 400, width: 100, height: 100 };
    const [out] = computeFallbackCoverRects([FALLBACK], [rect], { ...BOUNDS, pad: 0.2 });
    expect(out).toEqual({ left: 380, top: 380, width: 140, height: 140 }); // 20 px each side
  });

  it("returns a parallel array and is pure + deterministic", () => {
    const regions = [FALLBACK, region("bubble", "#fff"), region("sfx")];
    const rects: PxRect[] = [
      { left: 100, top: 100, width: 80, height: 80 },
      { left: 400, top: 400, width: 80, height: 80 },
      { left: 700, top: 700, width: 80, height: 80 },
    ];
    const snapshot = JSON.parse(JSON.stringify(rects));
    const first = computeFallbackCoverRects(regions, rects, BOUNDS);
    expect(first).toHaveLength(rects.length);
    expect(rects).toEqual(snapshot); // inputs untouched
    expect(computeFallbackCoverRects(regions, rects, BOUNDS)).toEqual(first);
  });
});
