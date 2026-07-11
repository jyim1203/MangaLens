import { describe, expect, it, vi } from "vitest";
import { buildContentRouterHandlers } from "../../src/content/contentRouter";
// Type-only import: erased at runtime, so no polyfill mock is needed here (the
// factory is browser-free — the whole point of extracting it, item 5).
import type browser from "webextension-polyfill";

const SENDER = {} as browser.Runtime.MessageSender;

describe("contentRouter — buildContentRouterHandlers (Phase 7.1 item 5)", () => {
  it("startRegionSelect replies {started:false} and leaves the selector untouched while inert", () => {
    const start = vi.fn();
    const handlers = buildContentRouterHandlers({
      getQueue: () => undefined,
      getRegionSelector: () => undefined, // inert on this tab
      getOverlay: () => undefined,
    });
    expect(handlers.startRegionSelect!(undefined, SENDER)).toEqual({ started: false });
    expect(start).not.toHaveBeenCalled();
  });

  it("startRegionSelect enters selection mode and replies {started:true} while active", () => {
    const start = vi.fn();
    const handlers = buildContentRouterHandlers({
      getQueue: () => undefined,
      getRegionSelector: () => ({ start }),
      getOverlay: () => undefined,
    });
    expect(handlers.startRegionSelect!(undefined, SENDER)).toEqual({ started: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("togglePeekOriginal is a silent no-op while inert and flips peek-all while active", () => {
    const togglePeekAll = vi.fn();
    const inert = buildContentRouterHandlers({
      getQueue: () => undefined,
      getRegionSelector: () => undefined,
      getOverlay: () => undefined, // inert
    });
    expect(() => inert.togglePeekOriginal!(undefined, SENDER)).not.toThrow();
    expect(togglePeekAll).not.toHaveBeenCalled();

    const active = buildContentRouterHandlers({
      getQueue: () => undefined,
      getRegionSelector: () => undefined,
      getOverlay: () => ({ togglePeekAll }),
    });
    active.togglePeekOriginal!(undefined, SENDER);
    expect(togglePeekAll).toHaveBeenCalledTimes(1);
  });

  it("translateAll returns {count:0} while inert and forwards the queue count while active", () => {
    const requestAll = vi.fn((dryRun?: boolean) => (dryRun ? 3 : 7));
    const inert = buildContentRouterHandlers({
      getQueue: () => undefined, // inert
      getRegionSelector: () => undefined,
      getOverlay: () => undefined,
    });
    expect(inert.translateAll!({ dryRun: true }, SENDER)).toEqual({ count: 0 });

    const active = buildContentRouterHandlers({
      getQueue: () => ({ requestAll }),
      getRegionSelector: () => undefined,
      getOverlay: () => undefined,
    });
    expect(active.translateAll!({ dryRun: true }, SENDER)).toEqual({ count: 3 });
    expect(active.translateAll!({}, SENDER)).toEqual({ count: 7 });
    expect(requestAll).toHaveBeenNthCalledWith(1, true);
    expect(requestAll).toHaveBeenNthCalledWith(2, false);
  });
});
