import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  ENDPOINT_MODES_KEY,
  SAMPLING_REJECT_KEY,
  getEndpointMode,
  isSamplingRejected,
  learnEndpointMode,
  learnSamplingRejected,
  loadEndpointModes,
  loadSamplingMemo,
  resetEndpointModes,
  resetSamplingMemo,
} from "../../src/background/endpointModes";

/** Let the fire-and-forget learn→persist chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("endpointModes (§4 persistence)", () => {
  beforeEach(async () => {
    resetEndpointModes();
    await fakeBrowser.storage.local.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => fakeBrowser.reset());

  it("learn is immediately effective in-memory and persists the whole memo", async () => {
    expect(getEndpointMode("https://a/v1")).toBeUndefined();
    learnEndpointMode("https://a/v1", "json_object");
    // Synchronously effective (the provider reads it mid-request).
    expect(getEndpointMode("https://a/v1")).toBe("json_object");

    await settle();
    const stored = (await fakeBrowser.storage.local.get(ENDPOINT_MODES_KEY))[ENDPOINT_MODES_KEY];
    expect(stored).toEqual({ "https://a/v1": "json_object" });
  });

  it("rehydrates the memo from storage on a fresh lifetime", async () => {
    await fakeBrowser.storage.local.set({
      [ENDPOINT_MODES_KEY]: { "https://b/v1": "json_object" },
    });
    resetEndpointModes(); // fresh event-page lifetime — memo empty, un-hydrated
    expect(getEndpointMode("https://b/v1")).toBeUndefined();

    await loadEndpointModes();
    expect(getEndpointMode("https://b/v1")).toBe("json_object");
  });

  it("does not persist-clobber other endpoints learned in a previous lifetime", async () => {
    await fakeBrowser.storage.local.set({
      [ENDPOINT_MODES_KEY]: { "https://old/v1": "json_object" },
    });
    resetEndpointModes(); // fresh lifetime, memo empty
    // Learn a NEW endpoint before any explicit hydrate — the write must MERGE.
    learnEndpointMode("https://new/v1", "json_object");
    await settle();

    const stored = (await fakeBrowser.storage.local.get(ENDPOINT_MODES_KEY))[ENDPOINT_MODES_KEY];
    expect(stored).toEqual({
      "https://old/v1": "json_object",
      "https://new/v1": "json_object",
    });
  });

  it("does not clobber a previous lifetime when a learn races the startup hydrate (§7 latch)", async () => {
    await fakeBrowser.storage.local.set({
      [ENDPOINT_MODES_KEY]: { "https://old/v1": "json_object" },
    });
    resetEndpointModes(); // fresh lifetime — memo empty, un-hydrated

    // Gate the hydrate's storage read so a learn can race it while it is in flight.
    let releaseGet!: () => void;
    const gate = new Promise<void>((r) => (releaseGet = r));
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
    const getSpy = vi
      .spyOn(fakeBrowser.storage.local, "get")
      .mockImplementation(async (key?: unknown) => {
        await gate;
        return realGet(key as string);
      });

    // Startup hydrate begins (read gated); a learn races it BEFORE it resolves.
    const hydratePromise = loadEndpointModes();
    learnEndpointMode("https://new/v1", "json_object");
    releaseGet(); // let the gated read resolve → hydrate merges the old entry
    await hydratePromise;
    await settle();

    getSpy.mockRestore();
    const stored = (await realGet(ENDPOINT_MODES_KEY))[ENDPOINT_MODES_KEY];
    // The write-through waited for the hydrate (latched on the PROMISE), so it wrote
    // the UNION — not just the freshly-learned key clobbering the old one.
    expect(stored).toEqual({
      "https://old/v1": "json_object",
      "https://new/v1": "json_object",
    });
  });

  it("heals a corrupt stored value to an empty memo", async () => {
    await fakeBrowser.storage.local.set({ [ENDPOINT_MODES_KEY]: "not an object" });
    resetEndpointModes();
    await loadEndpointModes();
    expect(getEndpointMode("https://anything")).toBeUndefined();
  });

  it("ignores non-mode values inside a stored object", async () => {
    await fakeBrowser.storage.local.set({
      [ENDPOINT_MODES_KEY]: { "https://c/v1": "garbage", "https://d/v1": "json_schema" },
    });
    resetEndpointModes();
    await loadEndpointModes();
    expect(getEndpointMode("https://c/v1")).toBeUndefined();
    expect(getEndpointMode("https://d/v1")).toBe("json_schema");
  });

  it("a storage rejection doesn't break loading (runs un-memoized)", async () => {
    vi.spyOn(fakeBrowser.storage.local, "get").mockRejectedValueOnce(new Error("storage down"));
    resetEndpointModes();
    await expect(loadEndpointModes()).resolves.toBeUndefined();
    expect(getEndpointMode("https://e/v1")).toBeUndefined();
  });

  it("hydrates once — a second load is a no-op (does not re-read storage)", async () => {
    const spy = vi.spyOn(fakeBrowser.storage.local, "get");
    resetEndpointModes();
    await loadEndpointModes();
    await loadEndpointModes();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("sampling-reject memo (Anthropic temperature 400s, persisted)", () => {
  beforeEach(async () => {
    resetSamplingMemo();
    await fakeBrowser.storage.local.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => fakeBrowser.reset());

  it("learn is immediately effective in-memory and persists under its OWN key", async () => {
    expect(isSamplingRejected("claude-sonnet-5")).toBe(false);
    learnSamplingRejected("claude-sonnet-5");
    // Synchronously effective (buildRequest/downgrade read it mid-request).
    expect(isSamplingRejected("claude-sonnet-5")).toBe(true);
    await settle();
    const stored = (await fakeBrowser.storage.local.get(SAMPLING_REJECT_KEY))[
      SAMPLING_REJECT_KEY
    ];
    expect(stored).toEqual({ "claude-sonnet-5": true });
    // The two memos never cross keys.
    expect(
      (await fakeBrowser.storage.local.get(ENDPOINT_MODES_KEY))[ENDPOINT_MODES_KEY],
    ).toBeUndefined();
  });

  it("rehydrates on a fresh lifetime — an event-page restart no longer re-pays the 400", async () => {
    await fakeBrowser.storage.local.set({
      [SAMPLING_REJECT_KEY]: { "claude-sonnet-5": true },
    });
    resetSamplingMemo(); // fresh event-page lifetime — memo empty, un-hydrated
    expect(isSamplingRejected("claude-sonnet-5")).toBe(false);
    await loadSamplingMemo();
    expect(isSamplingRejected("claude-sonnet-5")).toBe(true);
  });

  it("ignores non-true values inside a stored object", async () => {
    await fakeBrowser.storage.local.set({
      [SAMPLING_REJECT_KEY]: { "model-a": "yes", "model-b": true },
    });
    resetSamplingMemo();
    await loadSamplingMemo();
    expect(isSamplingRejected("model-a")).toBe(false);
    expect(isSamplingRejected("model-b")).toBe(true);
  });
});
