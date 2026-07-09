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

const log = createLogger("background");

// Typed message router (shared/messages.ts). Phase 1 wires only the messages
// whose handlers already exist; translatePage/testApiKey land with the provider
// and pipeline layers (Phases 2–3).
const router = createMessageRouter({
  ping: () => {
    log.debug("ping received");
    return { ok: true };
  },
});
browser.runtime.onMessage.addListener(router);

browser.commands.onCommand.addListener((command) => {
  if (command === CMD_TOGGLE) {
    // Real toggle behavior lands with settings in Phase 1.
    log.info("toggle command received (not yet implemented)");
  }
});

log.info("background event page loaded");
