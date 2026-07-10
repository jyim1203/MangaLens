import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// gate.ts → settings.ts → webextension-polyfill, which throws outside a browser.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  activeAfter,
  computeGateAction,
  type GateAction,
} from "../../src/content/gate";
import { DEFAULT_SETTINGS, type Settings } from "../../src/shared/settings";

const HOST = "reader.example.com";

function s(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    font: { ...DEFAULT_SETTINGS.font },
    ...overrides,
  };
}

describe("gate — computeGateAction (enable-gate reducer)", () => {
  it("off → on activates", () => {
    expect(computeGateAction({ active: false }, s({ enabled: true }), HOST)).toBe(
      "activate",
    );
  });

  it("stays inert when disabled (off → off)", () => {
    expect(computeGateAction({ active: false }, s({ enabled: false }), HOST)).toBe(
      "no-op",
    );
  });

  it("on → on with identical settings is idempotent (no-op)", () => {
    const settings = s({ enabled: true });
    expect(
      computeGateAction({ active: true, settings }, settings, HOST),
    ).toBe("no-op");
  });

  it("on → off deactivates", () => {
    const prev = s({ enabled: true });
    expect(
      computeGateAction({ active: true, settings: prev }, s({ enabled: false }), HOST),
    ).toBe("deactivate");
  });

  it("per-site override beats the global flag (forces ON when global is off)", () => {
    const settings = s({ enabled: false, perSiteOverrides: { [HOST]: true } });
    expect(computeGateAction({ active: false }, settings, HOST)).toBe("activate");
  });

  it("per-site override beats the global flag (forces OFF when global is on)", () => {
    const prev = s({ enabled: true });
    const next = s({ enabled: true, perSiteOverrides: { [HOST]: false } });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("deactivate");
  });

  it("classifies a font-only change as restyle", () => {
    const prev = s({ enabled: true });
    const next = s({
      enabled: true,
      font: { ...DEFAULT_SETTINGS.font, color: "#ff0000" },
    });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("restyle");
  });

  it("classifies a translateSfx change as restyle (render-time filter)", () => {
    const prev = s({ enabled: true, translateSfx: false });
    const next = s({ enabled: true, translateSfx: true });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("restyle");
  });

  it("classifies a targetLang change as re-request", () => {
    const prev = s({ enabled: true, targetLang: "en" });
    const next = s({ enabled: true, targetLang: "fr" });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("re-request");
  });

  it("classifies an active-provider model change as re-request", () => {
    const prev = s({ enabled: true, provider: "gemini", models: { gemini: "a" } });
    const next = s({ enabled: true, provider: "gemini", models: { gemini: "b" } });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("re-request");
  });

  it("re-request wins when both a translation field AND the font change", () => {
    const prev = s({ enabled: true, targetLang: "en" });
    const next = s({
      enabled: true,
      targetLang: "fr",
      font: { ...DEFAULT_SETTINGS.font, color: "#00ff00" },
    });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("re-request");
  });

  it("treats an irrelevant change (logLevel) as a no-op", () => {
    const prev = s({ enabled: true });
    const next = s({ enabled: true, logLevel: "debug" });
    expect(
      computeGateAction({ active: true, settings: prev }, next, HOST),
    ).toBe("no-op");
  });
});

describe("gate — activeAfter", () => {
  const cases: Array<[GateAction, boolean, boolean]> = [
    ["activate", false, true],
    ["re-request", false, true],
    ["deactivate", true, false],
    ["restyle", true, true],
    ["restyle", false, false],
    ["no-op", true, true],
    ["no-op", false, false],
  ];
  it("maps each action to the implied active flag", () => {
    for (const [action, prev, expected] of cases) {
      expect(activeAfter(action, prev)).toBe(expected);
    }
  });
});
