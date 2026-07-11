import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  createMessageRouter,
  sendToBackground,
  type Envelope,
} from "../../src/shared/messages";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type Settings,
} from "../../src/shared/settings";
import {
  broadcastSettingsChanged,
  createOptionsPageHandlers,
  createSettingsHandlers,
  sendCommandToActiveTab,
  toggleEnabled,
} from "../../src/background/settingsHandlers";

describe("background/settingsHandlers", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.runtime.onMessage.addListener(
      createMessageRouter(createSettingsHandlers()),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getSettings returns full, migrated settings over the message bus (happy path)", async () => {
    const settings = await sendToBackground("getSettings");
    expect(settings.schemaVersion).toBe(DEFAULT_SETTINGS.schemaVersion);
    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it("setSettings persists a patch and responds with the full new settings (happy path)", async () => {
    const updated = await sendToBackground("setSettings", {
      enabled: true,
      perSiteOverrides: { "reader.io": true },
    });
    expect(updated.enabled).toBe(true);
    expect(updated.perSiteOverrides).toEqual({ "reader.io": true });
    // Persisted, not just echoed.
    const stored = (await fakeBrowser.storage.local.get(SETTINGS_KEY))[
      SETTINGS_KEY
    ] as Settings;
    expect(stored.enabled).toBe(true);
  });

  it("toggleEnabled flips the flag each call, incl. via keyboard-command path (edge: repeated toggles)", async () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    const on = await sendToBackground("toggleEnabled");
    expect(on.enabled).toBe(true);
    // Direct call — the same function the commands.onCommand listener uses.
    const off = await toggleEnabled();
    expect(off.enabled).toBe(false);
  });

  it("sendCommandToActiveTab messages the active tab and swallows a rejecting tab (Phase 7 commands)", async () => {
    // fake-browser's tabs.query doesn't filter by {active}; return a known tab.
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 42 } as never,
    ]);
    const spy = vi
      .spyOn(fakeBrowser.tabs, "sendMessage")
      .mockResolvedValue(undefined);

    await sendCommandToActiveTab("startRegionSelect");
    const [tabId, env] = spy.mock.calls.at(-1) as [number, Envelope<"startRegionSelect">];
    expect(tabId).toBe(42);
    expect(env.type).toBe("startRegionSelect");

    // A tab with no content script rejects — must not throw (fail-soft).
    spy.mockRejectedValueOnce(new Error("no receiver"));
    await expect(sendCommandToActiveTab("togglePeekOriginal")).resolves.toBeUndefined();
  });

  it("openOptionsPage handler calls the browser API (Phase 7 toast action)", async () => {
    const spy = vi
      .spyOn(fakeBrowser.runtime, "openOptionsPage")
      .mockResolvedValue(undefined);
    const handlers = createOptionsPageHandlers();
    await handlers.openOptionsPage!(undefined, {} as never);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("broadcastSettingsChanged fans out to every tab and survives tabs without a listener (edge: dead tabs)", async () => {
    const tabA = await fakeBrowser.tabs.create({ url: "https://reader.io/ch1" });
    const tabB = await fakeBrowser.tabs.create({ url: "https://no-listener.example" });

    // fake-browser's tabs.sendMessage is an unimplemented stub, so mock it:
    // tabA has a "content script" and accepts; tabB rejects like a real tab
    // with no listener does.
    const sent: Array<{ tabId: number; env: Envelope<"settingsChanged"> }> = [];
    const sendMessageSpy = vi
      .spyOn(fakeBrowser.tabs, "sendMessage")
      .mockImplementation(async (tabId, message) => {
        if (tabId === tabB.id) {
          throw new Error("Could not establish connection");
        }
        sent.push({ tabId, env: message as Envelope<"settingsChanged"> });
        return undefined;
      });

    const settings: Settings = { ...DEFAULT_SETTINGS, enabled: true };
    // The invariant: one dead tab must never reject the broadcast.
    await expect(broadcastSettingsChanged(settings)).resolves.toBeUndefined();
    // Every open tab was attempted (fake-browser seeds one default tab, so
    // assert membership, not exact counts).
    const attemptedTabIds = sendMessageSpy.mock.calls.map(([tabId]) => tabId);
    expect(attemptedTabIds).toContain(tabA.id);
    expect(attemptedTabIds).toContain(tabB.id);
    // The rejecting tab delivered nothing; the healthy tab got a well-formed envelope.
    expect(sent.map((s) => s.tabId)).toContain(tabA.id);
    expect(sent.map((s) => s.tabId)).not.toContain(tabB.id);
    const toTabA = sent.find((s) => s.tabId === tabA.id);
    expect(toTabA?.env.type).toBe("settingsChanged");
    expect(toTabA?.env.payload.settings.enabled).toBe(true);
  });
});
