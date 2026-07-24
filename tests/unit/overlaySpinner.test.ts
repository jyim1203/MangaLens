// @vitest-environment jsdom
/**
 * Phase 9.8 §2: OverlayManager-level assertions that the pending state grows the wolf
 * spinner alongside the skeleton, and that the render/error transitions (which rebuild
 * the container) drop both. Kept minimal — the SVG parsing itself lives in
 * spinnerWolf.test.ts; here we only verify the setPending wiring + removal lifecycle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// OverlayManager transitively imports the webextension-polyfill (via shared modules),
// which throws outside a browser extension — swap it for the fake, like the other
// content-side suites.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import { OverlayManager } from "../../src/content/overlay/OverlayManager";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { OVERLAY_HOST_ATTR } from "../../src/shared/constants";
import type { Candidate } from "../../src/content/scanner";
import type { PageTranslation } from "../../src/shared/types";

const EMPTY_PAGE = { imageHash: "h", regions: [] } as unknown as PageTranslation;

function makeManager(): OverlayManager {
  return new OverlayManager({ settings: DEFAULT_SETTINGS, hostname: "example.com" });
}

function makeCandidate(id: string): Candidate {
  const el = document.createElement("img");
  el.width = 800;
  el.height = 1200;
  document.body.appendChild(el); // ensure() bails on a disconnected element
  return { id, el, url: `https://x/${id}.jpg` };
}

function containerOf(id: string): HTMLElement | null {
  const host = document.querySelector(`[${OVERLAY_HOST_ATTR}="${id}"]`);
  return (host?.shadowRoot?.querySelector(".mangalens-container") as HTMLElement) ?? null;
}

describe("OverlayManager — pending spinner (§2)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("setPending appends BOTH the skeleton and the wolf spinner badge", () => {
    const mgr = makeManager();
    const cand = makeCandidate("a");
    mgr.setPending(cand);

    const container = containerOf("a");
    expect(container).not.toBeNull();
    expect(container!.querySelector(".mangalens-skeleton")).not.toBeNull();
    const spinner = container!.querySelector(".mangalens-spinner");
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute("aria-hidden")).toBe("true");
    expect(spinner!.querySelector("svg")).not.toBeNull(); // jsdom has DOMParser
    mgr.stop();
  });

  it("render() removes the skeleton + spinner (container rebuilt)", () => {
    const mgr = makeManager();
    const cand = makeCandidate("a");
    mgr.setPending(cand);
    expect(containerOf("a")!.querySelector(".mangalens-spinner")).not.toBeNull();

    mgr.render(cand, EMPTY_PAGE);
    const container = containerOf("a");
    expect(container!.querySelector(".mangalens-skeleton")).toBeNull();
    expect(container!.querySelector(".mangalens-spinner")).toBeNull();
    mgr.stop();
  });

  it("setError() removes the skeleton + spinner and shows the error badge", () => {
    const mgr = makeManager();
    const cand = makeCandidate("a");
    mgr.setPending(cand);
    expect(containerOf("a")!.querySelector(".mangalens-spinner")).not.toBeNull();

    mgr.setError(cand, "auth");
    const container = containerOf("a");
    expect(container!.querySelector(".mangalens-spinner")).toBeNull();
    expect(container!.querySelector(".mangalens-badge")).not.toBeNull();
    mgr.stop();
  });
});
