import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// popupLogic → shared/settings → webextension-polyfill.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Settings,
} from "../../src/shared/settings";
import {
  TRANSLATE_ALL_CONFIRM_THRESHOLD,
  costSummary,
  hostnameFromUrl,
  needsApiKey,
  pauseButtonLabel,
  planTranslateAll,
  queueControls,
  regionSelectEnabled,
  siteChoice,
  siteChoicePatch,
  statusLine,
  totalImages,
} from "../../src/popup/popupLogic";
import type { CostStats } from "../../src/background/costTracker";

function settings(patch: object = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

describe("popupLogic — site choice (F15 tri-state)", () => {
  it("maps override true/false/absent to on/off/default", () => {
    expect(siteChoice(settings({ perSiteOverrides: { "a.com": true } }), "a.com")).toBe("on");
    expect(siteChoice(settings({ perSiteOverrides: { "a.com": false } }), "a.com")).toBe("off");
    expect(siteChoice(settings(), "a.com")).toBe("default");
  });

  it("patch round-trips: on/off store a boolean, default deletes via null", () => {
    expect(siteChoicePatch("a.com", "on")).toEqual({
      perSiteOverrides: { "a.com": true },
    });
    expect(siteChoicePatch("a.com", "off")).toEqual({
      perSiteOverrides: { "a.com": false },
    });
    expect(siteChoicePatch("a.com", "default")).toEqual({
      perSiteOverrides: { "a.com": null },
    });
    // Applying the default patch really removes the override.
    const before = settings({ perSiteOverrides: { "a.com": true } });
    const after = mergeSettings(before, siteChoicePatch("a.com", "default"));
    expect("a.com" in after.perSiteOverrides).toBe(false);
  });
});

describe("popupLogic — hostnameFromUrl", () => {
  it("accepts http/https and returns the hostname", () => {
    expect(hostnameFromUrl("https://reader.example.com/ch/1")).toBe("reader.example.com");
    expect(hostnameFromUrl("http://localhost:8080/x")).toBe("localhost");
  });

  it("rejects non-web pages (about:, moz-extension:, undefined, garbage)", () => {
    expect(hostnameFromUrl("about:debugging")).toBeUndefined();
    expect(hostnameFromUrl("moz-extension://abc/options.html")).toBeUndefined();
    expect(hostnameFromUrl(undefined)).toBeUndefined();
    expect(hostnameFromUrl("not a url")).toBeUndefined();
  });
});

describe("popupLogic — statusLine (Phase 7.2 active-vs-auto split)", () => {
  it("explains non-web pages and the disabled state", () => {
    expect(statusLine(settings(), undefined)).toMatch(/not available/i);
    expect(statusLine(settings(), "a.com")).toMatch(/off/i);
    expect(
      statusLine(settings({ perSiteOverrides: { "a.com": false }, enabled: true }), "a.com"),
    ).toMatch(/site rule/i);
  });

  it("distinguishes auto-translating (per-site opt-in) from active-but-not-auto", () => {
    // Per-site opt-in → auto-translating.
    expect(
      statusLine(settings({ perSiteOverrides: { "a.com": true } }), "a.com"),
    ).toMatch(/auto-translat/i);
    // Global on, no override → active but auto is off; the line must say so and
    // point at the manual actions (the finding-2 messaging).
    const activeNotAuto = statusLine(settings({ enabled: true }), "a.com");
    expect(activeNotAuto).toMatch(/translate all|select region/i);
    expect(activeNotAuto).toMatch(/auto-translate is off/i);
  });
});

describe("popupLogic — regionSelectEnabled (Phase 7)", () => {
  it("is enabled only when MangaLens is effectively active on the page", () => {
    expect(regionSelectEnabled(settings({ enabled: true }), "a.com")).toBe(true);
    expect(regionSelectEnabled(settings({ enabled: false }), "a.com")).toBe(false);
    // A per-site override wins over the global flag (same gate as translate-all).
    expect(
      regionSelectEnabled(settings({ enabled: false, perSiteOverrides: { "a.com": true } }), "a.com"),
    ).toBe(true);
  });

  it("is disabled on non-web pages (no hostname)", () => {
    expect(regionSelectEnabled(settings({ enabled: true }), undefined)).toBe(false);
  });
});

describe("popupLogic — needsApiKey", () => {
  it("is true when the ACTIVE provider has no key, even if another does", () => {
    expect(needsApiKey(settings())).toBe(true);
    expect(needsApiKey(settings({ apiKeys: { anthropic: "k" } }))).toBe(true); // active is gemini
    expect(needsApiKey(settings({ apiKeys: { gemini: "k" } }))).toBe(false);
    expect(needsApiKey(settings({ apiKeys: { gemini: "   " } }))).toBe(true); // whitespace ≠ key
  });
});

describe("popupLogic — cost summary (F17)", () => {
  const stats: CostStats = {
    byProvider: {
      gemini: { calls: 3, images: 7, tokensIn: 100, tokensOut: 50, estCostUsd: 0.004 },
      openai: { calls: 1, images: 2, tokensIn: 10, tokensOut: 5, estCostUsd: 0.001 },
    },
    totalEstCostUsd: 0.005,
    updatedAt: 1,
  };

  it("sums images across providers", () => {
    expect(totalImages(stats)).toBe(9);
    expect(totalImages({ byProvider: {}, totalEstCostUsd: 0, updatedAt: 0 })).toBe(0);
  });

  it("formats the one-line summary", () => {
    expect(costSummary(stats)).toBe("≈ $0.0050 · 9 images");
  });
});

describe("popupLogic — queueControls (Phase 7.4 pause)", () => {
  it("labels the pause toggle by state", () => {
    expect(pauseButtonLabel(false)).toBe("Pause queue");
    expect(pauseButtonLabel(true)).toBe("Resume queue");
  });

  it("hides the pause toggle on an inactive page and enables translate-all", () => {
    const c = queueControls(false, false);
    expect(c.pauseHidden).toBe(true);
    expect(c.translateAllDisabled).toBe(true); // inactive → disabled regardless
  });

  it("shows the toggle when active and disables translate-all while paused", () => {
    const running = queueControls(true, false);
    expect(running.pauseHidden).toBe(false);
    expect(running.translateAllDisabled).toBe(false);
    expect(running.pauseLabel).toBe("Pause queue");

    const paused = queueControls(true, true);
    expect(paused.pauseHidden).toBe(false);
    expect(paused.translateAllDisabled).toBe(true);
    expect(paused.pauseLabel).toBe("Resume queue");
  });
});

describe("popupLogic — planTranslateAll (confirm > 30 pages)", () => {
  it("none for zero, run at or below the threshold, confirm above it", () => {
    expect(planTranslateAll(0)).toBe("none");
    expect(planTranslateAll(-2)).toBe("none");
    expect(planTranslateAll(1)).toBe("run");
    expect(planTranslateAll(TRANSLATE_ALL_CONFIRM_THRESHOLD)).toBe("run");
    expect(planTranslateAll(TRANSLATE_ALL_CONFIRM_THRESHOLD + 1)).toBe("confirm");
  });
});
