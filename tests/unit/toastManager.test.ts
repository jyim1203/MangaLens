// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastManager } from "../../src/content/toast";
import { OVERLAY_HOST_ATTR } from "../../src/shared/constants";

// Pins the reset mechanism the pure toastPolicy test only IMPLIES (Phase 7.1
// item 5): the dedupe set is empty because activate() builds a FRESH ToastManager
// per activation — nothing else proved the set is actually fresh on re-activate.
// toast.ts is polyfill-free (i18n reads globalThis.browser?.i18n), so no mock is
// needed; in node/jsdom t() falls back to the English strings.

/** Count all mounted toast cards across every toast host in the document. */
function countToastCards(): number {
  let n = 0;
  for (const host of document.querySelectorAll(`[${OVERLAY_HOST_ATTR}="toast"]`)) {
    n += (host as HTMLElement).shadowRoot?.querySelectorAll(".mangalens-toast").length ?? 0;
  }
  return n;
}

beforeEach(() => {
  vi.useFakeTimers(); // freeze the 8 s auto-dismiss so the card counts are stable
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ToastManager — per-activation dedupe reset (Phase 7.1 item 5)", () => {
  it("shows one auth toast per instance, then dedupes further auth failures", () => {
    const toast = new ToastManager({ onOpenSettings: () => {} });
    toast.showError("auth");
    toast.showError("auth"); // a chapter full of auth failures ⇒ still ONE toast
    expect(countToastCards()).toBe(1);
  });

  it("a FRESH instance shows auth again — the dedupe set is fresh per activation", () => {
    const first = new ToastManager({ onOpenSettings: () => {} });
    first.showError("auth");
    expect(countToastCards()).toBe(1);

    // A gate re-activation builds a brand-new ToastManager (see content activate()).
    const second = new ToastManager({ onOpenSettings: () => {} });
    second.showError("auth");
    // first's card lingers; second added its own → 2 total, proving it re-showed.
    expect(countToastCards()).toBe(2);
  });

  it("stop() removes the host and clears dedupe so a later show works again", () => {
    const toast = new ToastManager();
    toast.showError("rate-limit");
    expect(countToastCards()).toBe(1);
    toast.stop();
    expect(countToastCards()).toBe(0); // host removed
    toast.showError("rate-limit"); // set cleared → shows again on the same instance
    expect(countToastCards()).toBe(1);
  });
});
