/**
 * Background-side settings message handling: the single write path for
 * settings. Content scripts, popup, and options never write storage
 * themselves — they send `setSettings`/`toggleEnabled` here, which also
 * serializes writes through one context (avoids popup/options clobbering
 * each other's load-then-save) and broadcasts the result to open tabs.
 *
 * Kept separate from the entry point (index.ts) so the logic is unit-testable
 * without `browser.commands` (which @webext-core/fake-browser doesn't stub).
 */
import browser from "webextension-polyfill";
import { createLogger } from "../shared/log";
import { sendToTab, type MessageHandlers } from "../shared/messages";
import {
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsPatch,
} from "../shared/settings";

const log = createLogger("settings-handlers");

/**
 * Push the new settings to every open tab's content script.
 *
 * WHY fire-and-forget per tab: most tabs have no MangaLens listener (content
 * script is inert until Phase 5), so `tabs.sendMessage` rejects for them —
 * that's expected, not an error. `allSettled` swallows those rejections so
 * one dead tab can never fail a settings save.
 */
export async function broadcastSettingsChanged(
  settings: Settings,
): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab): tab is typeof tab & { id: number } => tab.id !== undefined)
      .map((tab) => sendToTab(tab.id, "settingsChanged", { settings })),
  );
}

/** Persist a patch, broadcast the result, and return the full new settings. */
export async function applySettingsPatch(
  patch: SettingsPatch,
): Promise<Settings> {
  const next = await saveSettings(patch);
  // WHY not awaited: the sender gets its response as soon as the save lands;
  // the broadcast is best-effort fan-out.
  void broadcastSettingsChanged(next).catch((err) =>
    log.warn("settingsChanged broadcast failed", err),
  );
  return next;
}

/**
 * Fire a void command message at the active tab's content script (Phase 7
 * keyboard commands `select-region` / `peek-original`).
 *
 * WHY no `tabs`/`activeTab` permission needed: querying tabs and messaging BY
 * tabId are permission-free; only reading `tab.url` needs a permission, and we
 * don't. WHY fail-soft: a tab with no content script (about:, AMO pages) rejects
 * the send — that's expected, swallowed here (handoff rule 6). Kept in
 * settingsHandlers.ts (not index.ts) so it's unit-testable without
 * `browser.commands`, which @webext-core/fake-browser doesn't stub.
 */
export async function sendCommandToActiveTab(
  type: "startRegionSelect" | "togglePeekOriginal",
): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  try {
    await sendToTab(tab.id, type);
  } catch (err) {
    log.debug(`command "${type}" not delivered to tab ${tab.id}`, err);
  }
}

/** Flip the global enabled flag (F1) — used by both the `toggleEnabled`
 *  message and the keyboard command. */
export async function toggleEnabled(): Promise<Settings> {
  const current = await loadSettings();
  const next = await applySettingsPatch({ enabled: !current.enabled });
  log.info(`MangaLens ${next.enabled ? "enabled" : "disabled"}`);
  return next;
}

/** The settings-related slice of the background message router. */
export function createSettingsHandlers(): MessageHandlers {
  return {
    getSettings: () => loadSettings(),
    setSettings: (patch) => applySettingsPatch(patch),
    toggleEnabled: () => toggleEnabled(),
  };
}

/**
 * The `openOptionsPage` handler (Phase 7): content scripts can't open the
 * options page themselves, so the F14/error-toast "Open settings" action sends
 * this. Extracted here (not inlined in index.ts) so it's unit-testable without
 * `browser.commands`, which @webext-core/fake-browser doesn't stub.
 */
export function createOptionsPageHandlers(): MessageHandlers {
  return {
    openOptionsPage: async () => {
      await browser.runtime.openOptionsPage();
    },
  };
}
