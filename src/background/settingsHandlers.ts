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
