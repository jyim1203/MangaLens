/**
 * Background entry point.
 *
 * WHY: This is a Firefox MV3 EVENT PAGE, not a Chrome service worker. It has
 * a DOM (so OffscreenCanvas/Image are available for imagePrep later) but it is
 * NOT persistent — Firefox may unload it when idle. Nothing here may rely on
 * long-lived in-memory state surviving between messages; anything that must
 * survive goes to browser.storage.local or IndexedDB. (Per gap resolution #8,
 * in-flight translate jobs deliberately do NOT persist — they are re-requested
 * by content scripts.)
 */
import browser from "webextension-polyfill";
import { createLogger } from "../shared/log";
import { CMD_TOGGLE } from "../shared/constants";
import { createMessageRouter } from "../shared/messages";
import {
  createSettingsHandlers,
  toggleEnabled,
} from "./settingsHandlers";
import { createTranslateHandlers } from "./translateHandlers";

const log = createLogger("background");

// Typed message router (shared/messages.ts). Settings + translatePage are live;
// testApiKey lands with the options UI (Phase 6). Cache/queue wrap the translate
// handler in Phase 4.
const router = createMessageRouter({
  ping: () => {
    log.debug("ping received");
    return { ok: true };
  },
  ...createSettingsHandlers(),
  ...createTranslateHandlers(),
});
browser.runtime.onMessage.addListener(router);

browser.commands.onCommand.addListener((command) => {
  if (command === CMD_TOGGLE) {
    // Fail soft: a storage error must never leave an unhandled rejection.
    void toggleEnabled().catch((err) => log.warn("toggle command failed", err));
  }
});

log.info("background event page loaded");
