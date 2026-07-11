/**
 * The content-script message router's handler map (Phase 7.1 item 5), extracted
 * from the composition root ({@link file://./index.ts}) so its inert-vs-active
 * behavior is unit-testable without booting the whole content script — importing
 * `index.ts` runs `bootstrap()` (and drags in the polyfill) as a side effect.
 *
 * Browser-free: it only calls methods on the live subsystems handed in through
 * getters, each of which returns `undefined` while the gate is inert (the content
 * root nulls them on deactivate). So "inert ⇒ `{ started: false }` and the selector
 * is untouched" and "togglePeekOriginal no-ops while inert" become tested
 * properties rather than composition we merely hope is wired right.
 */
import type { MessageHandlers } from "../shared/messages";
import type { ViewportQueue } from "./viewportQueue";
import type { RegionSelector } from "./regionSelect";
import type { OverlayManager } from "./overlay/OverlayManager";

/** Live-subsystem accessors; each returns `undefined` while the gate is inert. */
export interface ContentRouterDeps {
  /** The viewport queue (F8 translate-all), or undefined while inert. */
  getQueue: () => Pick<ViewportQueue, "requestAll"> | undefined;
  /** The drag-select controller (F10), or undefined while inert. */
  getRegionSelector: () => Pick<RegionSelector, "start"> | undefined;
  /** The overlay manager (F14 peek-all), or undefined while inert. */
  getOverlay: () => Pick<OverlayManager, "togglePeekAll"> | undefined;
}

/**
 * Build the content-script router's handler map from the live-subsystem getters.
 * These handlers are registered even while inert (a passive `onMessage` listener
 * touches nothing on the host page — same inert-safety as the Phase 6
 * `translateAll` wiring): the getters return `undefined` then, so translate-all
 * reports `{ count: 0 }`, region-select reports `{ started: false }` without
 * touching a selector, and peek-all is a silent no-op.
 *
 * @param deps accessors over the content root's module state.
 * @returns a partial {@link MessageHandlers} map for {@link createMessageRouter}.
 */
export function buildContentRouterHandlers(deps: ContentRouterDeps): MessageHandlers {
  return {
    translateAll: (req) => ({
      count: deps.getQueue()?.requestAll(req?.dryRun ?? false) ?? 0,
    }),
    // WHY the return value: the popup uses `{ started }` to decide whether to close
    // (drag over the page) or show the "enable first" hint (inert on this tab).
    startRegionSelect: () => {
      const selector = deps.getRegionSelector();
      if (!selector) return { started: false }; // inert on this tab
      selector.start();
      return { started: true };
    },
    togglePeekOriginal: () => {
      deps.getOverlay()?.togglePeekAll();
    },
  };
}
