import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

// WHY mock the polyfill with fake-browser: settings.ts imports the default
// `browser` export; fake-browser is a full in-memory implementation of the
// storage APIs we touch, reset between tests.
vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_SCHEMA_VERSION,
  deriveProviderSettings,
  getEffectiveEnabled,
  loadSettings,
  mergeSettings,
  migrateSettings,
  saveSettings,
  type Settings,
} from "../../src/shared/settings";

describe("shared/settings — mergeSettings", () => {
  it("returns a complete settings object from an empty stored blob (happy path)", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {});
    expect(merged).toEqual(DEFAULT_SETTINGS);
    // Nested font object must be a copy, not the same reference (no aliasing).
    expect(merged.font).not.toBe(DEFAULT_SETTINGS.font);
  });

  it("deep-merges a partial nested font, keeping untouched font fields (edge: partial nested)", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { font: { color: "#ff0000" } });
    expect(merged.font.color).toBe("#ff0000");
    // Every other font field survives the shallow-spread trap.
    expect(merged.font.family).toBe(DEFAULT_SETTINGS.font.family);
    expect(merged.font.bubbleFillOpacity).toBe(DEFAULT_SETTINGS.font.bubbleFillOpacity);
  });

  it("ignores unknown keys and non-object input (edge: hostile/corrupt data)", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      enabled: true,
      bogusKey: "ignored",
    });
    expect(merged.enabled).toBe(true);
    expect((merged as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
    // A non-object collapses to defaults rather than throwing.
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, "nope")).toEqual(DEFAULT_SETTINGS);
  });

  it("deletes open-record entries on null and heals null in fixed-shape objects (edge: null semantics)", () => {
    const base: Settings = {
      ...DEFAULT_SETTINGS,
      perSiteOverrides: { "reader.io": true, "other.io": false },
      apiKeys: { gemini: "key-g", openai: "key-o" },
    };
    const merged = mergeSettings(base, {
      perSiteOverrides: { "reader.io": null },
      apiKeys: { openai: null },
      // Corrupt data: null inside the fixed-shape font object heals, not deletes.
      font: { color: null },
      // Top-level null is ignored entirely.
      enabled: null,
    });
    expect(merged.perSiteOverrides).toEqual({ "other.io": false });
    expect(merged.apiKeys).toEqual({ gemini: "key-g" });
    expect(merged.font.color).toBe(base.font.color);
    expect(merged.enabled).toBe(base.enabled);
  });
});

describe("shared/settings — migrateSettings", () => {
  it("produces versioned defaults from nothing stored (happy path)", () => {
    const { settings, changed } = migrateSettings(undefined);
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(changed).toBe(true);
  });

  it("stamps the version onto an unversioned (v0) blob and fills new fields (edge: legacy upgrade)", () => {
    const legacy = { enabled: true, provider: "openai" };
    const { settings, changed } = migrateSettings(legacy);
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.enabled).toBe(true);
    expect(settings.provider).toBe("openai");
    // A field absent in v0 comes from defaults.
    expect(settings.cacheCapMb).toBe(DEFAULT_SETTINGS.cacheCapMb);
    expect(changed).toBe(true);
  });

  it("reports no change when already at the current version (edge: idempotent)", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, enabled: true };
    const { settings, changed } = migrateSettings(current);
    expect(changed).toBe(false);
    expect(settings.enabled).toBe(true);
  });
});

describe("shared/settings — getEffectiveEnabled", () => {
  const base: Settings = { ...DEFAULT_SETTINGS, enabled: false };

  it("follows the global flag when no per-site override exists (happy path)", () => {
    expect(getEffectiveEnabled({ ...base, enabled: true }, "a.com")).toBe(true);
    expect(getEffectiveEnabled({ ...base, enabled: false }, "a.com")).toBe(false);
  });

  it("lets a per-site override win over the global flag (edge: both directions)", () => {
    const on = { ...base, enabled: false, perSiteOverrides: { "reader.io": true } };
    expect(getEffectiveEnabled(on, "reader.io")).toBe(true);
    const off = { ...base, enabled: true, perSiteOverrides: { "reader.io": false } };
    expect(getEffectiveEnabled(off, "reader.io")).toBe(false);
    // A different host still follows the global flag.
    expect(getEffectiveEnabled(off, "other.io")).toBe(true);
  });
});

describe("shared/settings — deriveProviderSettings", () => {
  it("picks the active provider's key and model (happy path)", () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      provider: "anthropic",
      apiKeys: { anthropic: "sk-ant", openai: "sk-oai" },
      models: { anthropic: "claude-haiku", openai: "gpt-4o-mini" },
    };
    const ps = deriveProviderSettings(s);
    expect(ps.provider).toBe("anthropic");
    expect(ps.apiKey).toBe("sk-ant");
    expect(ps.model).toBe("claude-haiku");
  });

  it("maps sourceLang 'auto' to undefined hint and empty custom endpoint to undefined (edge: sentinels)", () => {
    const ps = deriveProviderSettings({ ...DEFAULT_SETTINGS, sourceLang: "auto" });
    expect(ps.sourceLangHint).toBeUndefined();
    expect(ps.customEndpoint).toBeUndefined();
    const pinned = deriveProviderSettings({ ...DEFAULT_SETTINGS, sourceLang: "ja" });
    expect(pinned.sourceLangHint).toBe("ja");
  });

  it("defaults missing key/model to empty strings (edge: unconfigured provider)", () => {
    const ps = deriveProviderSettings(DEFAULT_SETTINGS);
    expect(ps.apiKey).toBe("");
    expect(ps.model).toBe("");
  });
});

describe("shared/settings — load/save round-trip", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds and persists defaults on first run (happy path)", async () => {
    const loaded = await loadSettings();
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    // First run persisted the blob so the next load is stable.
    const stored = (await fakeBrowser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    expect(stored).toBeDefined();
  });

  it("saveSettings merges a partial patch and reloads it (edge: partial update persistence)", async () => {
    await loadSettings();
    const saved = await saveSettings({ enabled: true, font: { color: "#0000ff" } });
    expect(saved.enabled).toBe(true);
    expect(saved.font.color).toBe("#0000ff");
    // Untouched nested field survived the patch.
    expect(saved.font.family).toBe(DEFAULT_SETTINGS.font.family);

    const reloaded = await loadSettings();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.font.color).toBe("#0000ff");
  });

  it("saveSettings removes a per-site override via a null patch entry (edge: user-data deletion)", async () => {
    await saveSettings({ perSiteOverrides: { "reader.io": true }, apiKeys: { gemini: "sk" } });
    const cleared = await saveSettings({
      perSiteOverrides: { "reader.io": null },
      apiKeys: { gemini: null },
    });
    expect(cleared.perSiteOverrides).toEqual({});
    expect(cleared.apiKeys).toEqual({});
    // The deletion persisted — nulls are never stored.
    const reloaded = await loadSettings();
    expect(reloaded.perSiteOverrides).toEqual({});
    expect(reloaded.apiKeys).toEqual({});
  });

  it("heals a corrupt stored blob on load (edge: bad data in storage)", async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: "corrupt-not-an-object" });
    const loaded = await loadSettings();
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, targetLang: loaded.targetLang });
  });
});
