/**
 * Phase 9 §1/§2 — the reading-window budget and the tier-0 confirmation pass.
 * Pure planners first (window gate, derived cursor, visibility confirmation),
 * then the shell scenarios on the fake-observer harness: suppressed candidates
 * re-planning when the window slides, translate-all bypassing the window,
 * prefetchAhead=0 strict mode, cursor fallback on unregister, and the
 * confirmation timer lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));
vi.mock("../../src/shared/messages", () => ({ sendToBackground: vi.fn() }));

import {
  CONFIRM_MIN_OVERLAP_PX,
  anchoredWindowAllows,
  classifyConfirm,
  confirmVisibility,
  createViewportQueue,
  planEnqueues,
  type OverlaySink,
  type RectLike,
} from "../../src/content/viewportQueue";
import { sendToBackground } from "../../src/shared/messages";
import type { Candidate } from "../../src/content/scanner";

const mockSend = vi.mocked(sendToBackground);

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Pure: anchored-window gate in planEnqueues (§8) ------------------------

/** confirmed[i] flags for a 10-candidate plan with the given anchor indices. */
const anchors = (...idx: number[]): boolean[] =>
  Array.from({ length: 10 }, (_, i) => idx.includes(i));

const base = {
  count: 10,
  sentPriority: new Map<number, number>(),
  prefetchAhead: 3,
  confirmed: anchors(0), // one anchor at index 0 → window [0, 3]
};

describe("planEnqueues — §8 anchored reading-window gate", () => {
  it("suppresses a beyond-window fresh send at tier 0 (and its prefetch tail)", () => {
    // anchor 0, prefetchAhead 3 → window [0, 3]; index 5 and its prefetch
    // neighbours are all beyond — every one is marked (so a later anchor slide
    // re-plans them), none sends.
    expect(planEnqueues({ ...base, changedIndex: 5, changedTier: 0 })).toEqual([
      { index: 5, priority: 0, suppressed: true },
      { index: 6, priority: 2, suppressed: true },
      { index: 7, priority: 2, suppressed: true },
      { index: 8, priority: 2, suppressed: true },
    ]);
  });

  it("suppresses a beyond-window fresh send at tier 1", () => {
    expect(planEnqueues({ ...base, changedIndex: 4, changedTier: 1 })).toEqual([
      { index: 4, priority: 1, suppressed: true },
    ]);
  });

  it("nothing confirmed suppresses every fresh send", () => {
    // The shell sets a candidate's flag INCLUDING the just-confirmed one before
    // planning for it, so only a confirmed tier-0 candidate ever escapes this.
    expect(
      planEnqueues({ ...base, confirmed: anchors(), changedIndex: 0, changedTier: 0 }),
    ).toEqual([
      { index: 0, priority: 0, suppressed: true },
      { index: 1, priority: 2, suppressed: true },
      { index: 2, priority: 2, suppressed: true },
      { index: 3, priority: 2, suppressed: true },
    ]);
  });

  it("a just-confirmed candidate (its own anchor) sends, with prefetch inside the window", () => {
    expect(
      planEnqueues({ ...base, confirmed: anchors(2), changedIndex: 2, changedTier: 0 }),
    ).toEqual([
      { index: 2, priority: 0 },
      { index: 3, priority: 2 },
      { index: 4, priority: 2 },
      { index: 5, priority: 2 },
    ]);
  });

  it("clamps prefetch to the window edge (window first, then count)", () => {
    // anchor 0, window [0, 3]; a tier-0 on index 2 (inside window) prefetches 3 but
    // suppresses 4 and 5 — the anchor's edge caps before the prefetch count.
    expect(planEnqueues({ ...base, changedIndex: 2, changedTier: 0 })).toEqual([
      { index: 2, priority: 0 },
      { index: 3, priority: 2 },
      { index: 4, priority: 2, suppressed: true },
      { index: 5, priority: 2, suppressed: true },
    ]);
  });

  it("a page BEHIND the only anchor is suppressed (§8: backward never buys)", () => {
    // Anchor at 5, window [5, 8]; a fresh tier-0 on index 3 (behind it) is
    // suppressed — the reverse-skim burst §8 exists to kill.
    expect(
      planEnqueues({ ...base, confirmed: anchors(5), changedIndex: 3, changedTier: 0 }),
    ).toEqual([
      { index: 3, priority: 0, suppressed: true },
      { index: 4, priority: 2, suppressed: true },
      { index: 5, priority: 2 }, // 5 is the anchor itself → allowed
      { index: 6, priority: 2 }, // 6 ∈ [5, 8]
    ]);
  });

  it("unions multiple anchors' forward windows", () => {
    // Anchors 0 and 6, prefetchAhead 1 → allowed {0,1,6,7}; a tier-0 on 6 sends 6
    // and prefetches 7, both inside the anchor-6 window.
    expect(
      planEnqueues({
        ...base,
        confirmed: anchors(0, 6),
        prefetchAhead: 1,
        changedIndex: 6,
        changedTier: 0,
      }),
    ).toEqual([
      { index: 6, priority: 0 },
      { index: 7, priority: 2 },
    ]);
  });

  it("never suppresses an UPGRADE, even far beyond the window", () => {
    expect(
      planEnqueues({
        ...base,
        changedIndex: 8,
        changedTier: 0,
        prefetchAhead: 0,
        sentPriority: new Map([[8, 2]]),
      }),
    ).toEqual([{ index: 8, priority: 0, upgrade: true }]);
  });

  it("is byte-identical to the pre-Phase-9 plan under a contiguous forward anchor", () => {
    expect(
      planEnqueues({ ...base, changedIndex: 0, changedTier: 0 }),
    ).toEqual([
      { index: 0, priority: 0 },
      { index: 1, priority: 2 },
      { index: 2, priority: 2 },
      { index: 3, priority: 2 },
    ]);
  });

  it("errs toward suppressing on a non-finite prefetchAhead (rule 6)", () => {
    expect(
      planEnqueues({ ...base, prefetchAhead: NaN, changedIndex: 1, changedTier: 1 }),
    ).toEqual([{ index: 1, priority: 1, suppressed: true }]);
  });
});

// --- Pure: anchoredWindowAllows (§8) ----------------------------------------

describe("anchoredWindowAllows", () => {
  it("nothing confirmed → nothing allowed", () => {
    expect(anchoredWindowAllows([false, false, false], 0, 3)).toBe(false);
    expect(anchoredWindowAllows([], 5, 3)).toBe(false);
  });

  it("a lone mid-chapter anchor allows only its FORWARD range", () => {
    const c = anchors(); // 10 falses
    c[5] = true;
    expect(anchoredWindowAllows(c, 1, 3)).toBe(false); // far before the anchor
    expect(anchoredWindowAllows(c, 4, 3)).toBe(false); // one before the anchor (backward)
    expect(anchoredWindowAllows(c, 5, 3)).toBe(true); // the anchor itself
    expect(anchoredWindowAllows(c, 8, 3)).toBe(true); // edge (5 + 3)
    expect(anchoredWindowAllows(c, 9, 3)).toBe(false); // past the edge
  });

  it("contiguous forward anchors behave like the old cursor window", () => {
    const c = [true, true, true, false, false, false, false, false];
    // confirmed 0..2, prefetchAhead 3 → allowed 0..5
    for (let i = 0; i <= 5; i++) expect(anchoredWindowAllows(c, i, 3)).toBe(true);
    expect(anchoredWindowAllows(c, 6, 3)).toBe(false);
  });

  it("unions multiple anchors", () => {
    const c = [true, false, false, false, false, true, false, false];
    // anchors 0 and 5, prefetchAhead 1 → allowed {0,1,5,6}
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => anchoredWindowAllows(c, i, 1))).toEqual([
      true, true, false, false, false, true, true, false,
    ]);
  });

  it("NaN suppresses; a negative prefetch clamps to 0 (exact anchors only)", () => {
    expect(anchoredWindowAllows([true, true, true], 2, NaN)).toBe(false);
    expect(anchoredWindowAllows([true, true, true], 2, -5)).toBe(true); // confirmed[2] itself
    expect(anchoredWindowAllows([true, false, false], 1, -5)).toBe(false);
  });
});

// --- Pure: confirmVisibility (§2) -------------------------------------------

const rect = (top: number, bottom: number, left = 0, right = 800): RectLike => ({
  top,
  bottom,
  left,
  right,
  height: bottom - top,
});

describe("confirmVisibility", () => {
  const VW = 1366;
  const VH = 768;

  it("confirms a page overlapping the viewport by more than the floor", () => {
    expect(confirmVisibility(rect(100, 1300), VW, VH)).toBe(true); // 668 px overlap
    expect(confirmVisibility(rect(-1100, 100), VW, VH)).toBe(true); // 100 px overlap
  });

  it(`rejects a sliver overlap below ${CONFIRM_MIN_OVERLAP_PX} px`, () => {
    expect(confirmVisibility(rect(VH - 10, VH + 1190), VW, VH)).toBe(false); // 10 px at the fold
    expect(confirmVisibility(rect(-1190, 20), VW, VH)).toBe(false); // 20 px at the top
  });

  it("uses 50% of a SHORT candidate's height when that is smaller than the floor", () => {
    // 60 px tall: needs min(48, 30) = 30 px of overlap.
    expect(confirmVisibility(rect(VH - 35, VH + 25), VW, VH)).toBe(true); // 35 ≥ 30
    expect(confirmVisibility(rect(VH - 20, VH + 40), VW, VH)).toBe(false); // 20 < 30
  });

  it("rejects when there is no horizontal overlap (offscreen column)", () => {
    expect(confirmVisibility(rect(100, 700, 2000, 2800), VW, VH)).toBe(false);
  });

  it("rejects fully-offscreen and degenerate inputs", () => {
    expect(confirmVisibility(rect(2000, 3200), VW, VH)).toBe(false);
    expect(confirmVisibility(rect(100, 100), VW, VH)).toBe(false); // zero height
    expect(confirmVisibility(rect(100, 700), 0, 0)).toBe(false); // no viewport
  });

  it("classifyConfirm: meaningful overlap → confirm; sliver → retry; gone → drop", () => {
    expect(classifyConfirm(rect(100, 1300), VW, VH)).toBe("confirm");
    // 10 px sliver at the fold: SOME overlap → retry (scrolling deeper never
    // fires another IO transition, so a one-shot drop would wedge the cursor).
    expect(classifyConfirm(rect(VH - 10, VH + 1190), VW, VH)).toBe("retry");
    // No overlap at all → drop (the next transition covers a return).
    expect(classifyConfirm(rect(2000, 3200), VW, VH)).toBe("drop");
    expect(classifyConfirm(rect(100, 700, 2000, 2800), VW, VH)).toBe("drop");
    expect(classifyConfirm(rect(100, 100), VW, VH)).toBe("drop"); // degenerate
  });

  it("§9: an unloaded candidate with a meaningful overlap → retry (never confirm)", () => {
    // A big overlap that WOULD confirm if loaded → retry while loaded:false.
    expect(classifyConfirm(rect(100, 1300), VW, VH, false)).toBe("retry");
    // No overlap → still drop even when unloaded (the next transition covers it).
    expect(classifyConfirm(rect(2000, 3200), VW, VH, false)).toBe("drop");
    // The `loaded` param defaults to true → every prior expectation is unchanged.
    expect(classifyConfirm(rect(100, 1300), VW, VH)).toBe("confirm");
    expect(classifyConfirm(rect(100, 1300), VW, VH, true)).toBe("confirm");
  });
});

// --- Shell scenarios (fake observers + injectable confirm delay) ------------

/** Minimal fake IntersectionObserver (same shape as viewportQueue.test.ts). */
class FakeIO {
  static instances: FakeIO[] = [];
  observeLog: Element[] = [];
  unobserveLog: Element[] = [];
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observeLog.push(el);
  }
  unobserve(el: Element): void {
    this.unobserveLog.push(el);
  }
  disconnect(): void {}
  fire(el: Element, isIntersecting: boolean): void {
    this.cb(
      [{ target: el, isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function fakeOverlay(): OverlaySink {
  return { setPending: vi.fn(), render: vi.fn(), setError: vi.fn(), clear: vi.fn() };
}

interface FakeElOpts {
  rect?: RectLike;
  checkVisibility?: () => boolean;
}

/** A fake element with a mutable client rect (the §2 re-read target). */
function fakeEl(opts: FakeElOpts = {}): Element & { setRect(r: RectLike): void } {
  let current: RectLike = opts.rect ?? rect(0, 600);
  const el = {
    compareDocumentPosition: () => 2,
    getBoundingClientRect: () => current,
    setRect(r: RectLike) {
      current = r;
    },
  } as unknown as Element & { setRect(r: RectLike): void };
  if (opts.checkVisibility) {
    (el as unknown as { checkVisibility: () => boolean }).checkVisibility =
      opts.checkVisibility;
  }
  return el;
}

const VIEWPORT = { w: 1366, h: 768 };

describe("viewportQueue shell — §1/§2 reading window + confirmation", () => {
  beforeEach(() => {
    FakeIO.instances = [];
    mockSend.mockReset();
    mockSend.mockReturnValue(new Promise<never>(() => {})); // sends hang (countable)
    // WHY a function-shaped stub: vitest's toContain runs `x instanceof Node`
    // internally, and instanceof needs a callable right-hand side.
    vi.stubGlobal(
      "Node",
      Object.assign(function Node() {}, { DOCUMENT_POSITION_FOLLOWING: 4 }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const cand = (id: string, el = fakeEl()): Candidate => ({
    id,
    el,
    url: `https://x/${id}.jpg`,
  });

  function makeQueue(
    overlay: OverlaySink,
    prefetchAhead: number,
    confirmDelayMs = 0,
  ) {
    return createViewportQueue({
      overlay,
      prefetchAhead,
      autoEnqueue: true,
      hydrate: false,
      makeRequestId: () => "rq",
      confirmDelayMs,
      getViewport: () => VIEWPORT,
      createObserver: (cb, options) =>
        new FakeIO(cb, options) as unknown as IntersectionObserver,
    });
  }

  const sends = () =>
    mockSend.mock.calls.filter((c) => c[0] === "translatePage");
  const sentUrls = () =>
    sends().map((c) => (c[1] as { imageUrl: string }).imageUrl);

  it("cold open: nothing sends before the first confirmation; confirming sends page + prefetch", async () => {
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const queue = makeQueue(fakeOverlay(), 1);
    queue.register(a);
    queue.register(b);
    queue.register(c);
    const [visible] = FakeIO.instances;

    visible!.fire(a.el, true);
    expect(sends()).toHaveLength(0); // §2: cursor advance waits for confirmation

    await tick(); // 0 ms confirm fires → cursor 0 → window edge 1
    expect(sentUrls()).toEqual(["https://x/a.jpg", "https://x/b.jpg"]); // a @0 + prefetch b
    queue.stop();
  });

  it("a BACKWARD near candidate stays suppressed after a LATER page anchors (§8: backward never buys)", async () => {
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const queue = makeQueue(fakeOverlay(), 1);
    queue.register(a);
    queue.register(b);
    queue.register(c);
    const [visible, near] = FakeIO.instances;

    // b (idx 1) fires NEAR while nothing is confirmed → suppressed, no send.
    near!.fire(b.el, true);
    expect(sends()).toHaveLength(0);

    // c (idx 2) confirms → anchor 2, window [2, 3]. b is BEHIND the anchor, so
    // §8 does NOT re-observe it (only [2, 3] slides in): a reverse skim buys nothing.
    visible!.fire(c.el, true);
    await tick();
    expect(near!.unobserveLog).not.toContain(b.el); // NOT reobserved (backward)
    expect(sentUrls()).toContain("https://x/c.jpg");
    expect(sentUrls()).not.toContain("https://x/b.jpg");

    // Even a fresh near transition on b keeps it suppressed — no anchor covers it.
    near!.fire(b.el, true);
    expect(sentUrls()).not.toContain("https://x/b.jpg");
    queue.stop();
  });

  it("a forward suppressed candidate is bought once a new anchor's window reaches it", async () => {
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const d = cand("d");
    const queue = makeQueue(fakeOverlay(), 1);
    for (const x of [a, b, c, d]) queue.register(x);
    const [visible, near] = FakeIO.instances;

    // d (idx 3) fires near while nothing is confirmed → suppressed, no send.
    near!.fire(d.el, true);
    expect(sends()).toHaveLength(0);

    // c (idx 2) confirms → anchor 2, window [2, 3]. d (idx 3) is FORWARD, inside
    // the new anchor's range → re-planned and bought; b/a (backward) stay unsent.
    visible!.fire(c.el, true);
    await tick();
    expect(sentUrls()).toContain("https://x/c.jpg");
    expect(sentUrls()).toContain("https://x/d.jpg"); // forward, in [2,3]
    expect(sentUrls()).not.toContain("https://x/a.jpg");
    expect(sentUrls()).not.toContain("https://x/b.jpg");
    queue.stop();
  });

  it("a suppressed candidate still OUTSIDE the window is not re-observed", async () => {
    const cands = ["a", "b", "c", "d", "e"].map((id) => cand(id));
    const queue = makeQueue(fakeOverlay(), 1);
    for (const c of cands) queue.register(c);
    const [visible, near] = FakeIO.instances;

    near!.fire(cands[4]!.el, true); // e (idx 4) → suppressed
    visible!.fire(cands[0]!.el, true); // a confirms → cursor 0, edge 1
    await tick();

    // e stays suppressed and untouched: observed exactly once (registration).
    expect(near!.observeLog.filter((el) => el === cands[4]!.el)).toHaveLength(1);
    expect(sentUrls()).not.toContain("https://x/e.jpg");
    queue.stop();
  });

  it("requestAll ignores the window entirely (sends everything, nothing confirmed)", () => {
    const cands = ["a", "b", "c"].map((id) => cand(id));
    const queue = makeQueue(fakeOverlay(), 0);
    for (const c of cands) queue.register(c);

    expect(queue.requestAll()).toBe(3); // cursor undefined — bypassed
    expect(sends()).toHaveLength(3);
    queue.stop();
  });

  it("prefetchAhead=0 → strictly on-view sends only (each page waits for its own confirm)", async () => {
    const a = cand("a");
    const b = cand("b");
    const queue = makeQueue(fakeOverlay(), 0);
    queue.register(a);
    queue.register(b);
    const [visible, near] = FakeIO.instances;

    visible!.fire(a.el, true);
    await tick();
    expect(sentUrls()).toEqual(["https://x/a.jpg"]); // no prefetch

    near!.fire(b.el, true); // near can never enter a zero-depth window ahead of the cursor
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);

    visible!.fire(b.el, true);
    await tick(); // b confirms → cursor 1 → b sends
    expect(sentUrls()).toEqual(["https://x/a.jpg", "https://x/b.jpg"]);
    queue.stop();
  });

  it("unregistering the cursor-holding element falls back to the previous confirmed index", async () => {
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const queue = makeQueue(fakeOverlay(), 0);
    queue.register(a);
    queue.register(b);
    queue.register(c);
    const [visible, near] = FakeIO.instances;

    visible!.fire(a.el, true);
    await tick();
    visible!.fire(b.el, true);
    await tick(); // cursor = 1 (b)
    queue.unregister(b); // the cursor holder leaves the DOM

    // c (now idx 1) fires near: cursor fell back to a (idx 0), edge 0 → suppressed.
    near!.fire(c.el, true);
    expect(sentUrls()).not.toContain("https://x/c.jpg"); // no crash, no burst
    queue.stop();
  });

  it("a sliver-entry page confirms via retry once it gains real overlap (no new transition needed)", async () => {
    // The page enters the viewport with a 20 px sliver — its ONE tier-0
    // transition — and only gains overlap as the user scrolls deeper, which
    // fires nothing. The retry backoff must confirm it on its own.
    const el = fakeEl({ rect: rect(748, 1948) }); // 20 px below the 768 fold
    const a = cand("a", el);
    const queue = makeQueue(fakeOverlay(), 0, 5);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    await tick(12); // first confirm at 5 ms → sliver → retry scheduled
    expect(sends()).toHaveLength(0);

    el.setRect(rect(200, 1400)); // the user scrolled deeper — no IO event fires
    await tick(60); // retries (10/20/40 ms backoff) re-check and confirm
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);
    queue.stop();
  });

  it("a hidden stack member (checkVisibility=false) confirms via retry when revealed", async () => {
    let revealed = false;
    const el = fakeEl({ checkVisibility: () => revealed });
    const a = cand("a", el);
    const queue = makeQueue(fakeOverlay(), 0, 5);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    await tick(12);
    expect(sends()).toHaveLength(0); // hidden → rejected, retrying

    revealed = true; // the reader flips the page visible — IO fires NOTHING
    await tick(60);
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);
    queue.stop();
  });

  it("a tier-0 streaker (leaves the viewport before the delay) never advances the cursor", async () => {
    const el = fakeEl({ rect: rect(100, 700) });
    const a = cand("a", el);
    const queue = makeQueue(fakeOverlay(), 3, 20);
    queue.register(a);
    const [visible] = FakeIO.instances;

    visible!.fire(a.el, true); // accordion parks it at the fold…
    el.setRect(rect(5000, 6200)); // …then layout shifts it far below
    await tick(40); // confirm re-reads → rejects

    expect(sends()).toHaveLength(0); // no cursor advance, no send
    queue.stop();
  });

  it("checkVisibility=false (opacity/visibility-hidden stack) rejects the confirmation", async () => {
    const el = fakeEl({ checkVisibility: () => false });
    const a = cand("a", el);
    const queue = makeQueue(fakeOverlay(), 3);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    await tick();
    expect(sends()).toHaveLength(0);
    queue.stop();
  });

  it("checkVisibility missing → fail-open: the confirmation passes on geometry alone", async () => {
    const a = cand("a"); // fakeEl has no checkVisibility
    const queue = makeQueue(fakeOverlay(), 0);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    await tick();
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);
    queue.stop();
  });

  it("§9: an unloaded image (placeholder) never confirms; it confirms after the image arrives", async () => {
    // A real HTMLImageElement whose `complete`/`naturalWidth` we control: parked in
    // the viewport as a not-yet-loaded MangaDex placeholder, it must NOT confirm.
    class FakeImg {
      complete = false;
      naturalWidth = 0;
      rectValue: RectLike = rect(0, 600); // fully in the viewport
      compareDocumentPosition(): number {
        return 2;
      }
      getBoundingClientRect(): RectLike {
        return this.rectValue;
      }
    }
    vi.stubGlobal("HTMLImageElement", FakeImg);
    const img = new FakeImg();
    const a: Candidate = { id: "a", el: img as unknown as Element, url: "https://x/a.jpg" };
    const queue = makeQueue(fakeOverlay(), 0, 5);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    await tick(12); // confirm at 5 ms → loaded:false → retry, no anchor, no send
    expect(sends()).toHaveLength(0);

    img.complete = true; // the image finishes loading — fires NO IntersectionObserver
    img.naturalWidth = 800;
    await tick(60); // the retry backoff re-checks and confirms
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);
    queue.stop();
  });

  it("unregister during the confirm delay cancels the timer (no dangling send)", async () => {
    const a = cand("a");
    const queue = makeQueue(fakeOverlay(), 3, 20);
    queue.register(a);
    FakeIO.instances[0]!.fire(a.el, true);
    queue.unregister(a); // before the 20 ms delay elapses
    await tick(40);
    expect(sends()).toHaveLength(0);
    queue.stop();
  });

  it("a within-window FORWARD tier-0 acts immediately (upgrade), without waiting for its own confirmation", async () => {
    const a = cand("a");
    const b = cand("b");
    const queue = makeQueue(fakeOverlay(), 1); // prefetchAhead 1, 0 ms confirm
    queue.register(a);
    queue.register(b);
    const [visible] = FakeIO.instances;

    visible!.fire(a.el, true);
    await tick(); // a confirms → anchor 0, window [0, 1] → a sent @0 + b prefetched @2
    expect(sentUrls()).toEqual(["https://x/a.jpg", "https://x/b.jpg"]);

    const reproCount = () =>
      mockSend.mock.calls.filter((c) => c[0] === "reprioritizeTranslation").length;
    expect(reproCount()).toBe(0);

    // b (idx 1, inside anchor 0's window) fires tier-0: it acts SYNCHRONOUSLY —
    // an UPGRADE of the already-paid prefetch to priority 0 — with NO wait for b's
    // own 300 ms confirmation (the within-window budget was already accepted).
    visible!.fire(b.el, true);
    expect(reproCount()).toBe(1);
    const repro = mockSend.mock.calls.filter((c) => c[0] === "reprioritizeTranslation");
    expect(repro[0]![1]).toEqual({ requestId: "rq", priority: 0 });
    queue.stop();
  });

  it("a fast reverse skim (element leaves before the confirm) buys nothing (§8)", async () => {
    // A backward page pokes into view (its ONE tier-0), then the skim carries it
    // out before the confirm fires → it never anchors and never buys.
    const el = fakeEl({ rect: rect(100, 700) });
    const a = cand("a", el);
    const queue = makeQueue(fakeOverlay(), 3, 20);
    queue.register(a);
    const [visible] = FakeIO.instances;

    visible!.fire(a.el, true); // pokes in at the top of a reverse skim…
    el.setRect(rect(-5000, -3800)); // …then the skim carries it far above
    await tick(40); // confirm re-reads → no overlap → drop
    expect(sends()).toHaveLength(0);
    queue.stop();
  });

  it("raising prefetchAhead live widens the window and re-plans suppressed candidates", async () => {
    const a = cand("a");
    const b = cand("b");
    const c = cand("c");
    const queue = makeQueue(fakeOverlay(), 0);
    queue.register(a);
    queue.register(b);
    queue.register(c);
    const [visible, near] = FakeIO.instances;

    visible!.fire(a.el, true);
    await tick(); // cursor 0, edge 0 → only a sent
    near!.fire(b.el, true); // b (idx 1) suppressed
    expect(sentUrls()).toEqual(["https://x/a.jpg"]);

    queue.setPrefetchAhead(2); // edge now 2 → b reobserved
    expect(near!.unobserveLog).toContain(b.el);
    near!.fire(b.el, true); // redelivery (real IO does this on observe())
    expect(sentUrls()).toContain("https://x/b.jpg");
    queue.stop();
  });
});
