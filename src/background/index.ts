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
import {
  CMD_PEEK_ORIGINAL,
  CMD_SELECT_REGION,
  CMD_TOGGLE,
} from "../shared/constants";
import { createMessageRouter } from "../shared/messages";
import {
  createOptionsPageHandlers,
  createSettingsHandlers,
  sendCommandToActiveTab,
  toggleEnabled,
} from "./settingsHandlers";
import { createTranslateHandlers } from "./translateHandlers";
import { createRegionHandlers } from "./regionHandlers";
import { createKeyTestHandlers } from "./providers/keyTest";
import { resetCostStats } from "./costTracker";
import { loadEndpointModes, loadSamplingMemo } from "./endpointModes";

const log = createLogger("background");

// Hydrate the persisted request-shape memos once per lifetime (§4), so an
// OpenAI-compatible endpoint that already learned it needs `json_object` — or
// an Anthropic model that already learned it rejects `temperature` — doesn't
// re-pay the 400 after the event page restarts. Fail-soft.
void loadEndpointModes();
void loadSamplingMemo();

// Typed message router (shared/messages.ts). Settings, translatePage, and (as
// of Phase 6) testApiKey + resetCostStats are live. translateAll is handled by
// the CONTENT script (popup → tab), not here.
const router = createMessageRouter({
  ping: () => {
    log.debug("ping received");
    return { ok: true };
  },
  ...createSettingsHandlers(),
  ...createOptionsPageHandlers(),
  ...createTranslateHandlers(),
  ...createRegionHandlers(),
  ...createKeyTestHandlers(),
  // WHY here and not a direct import in the options page: cost writes are
  // serialized through costTracker's per-context chain — a second context
  // writing would race it (see the resetCostStats MessageMap note).
  resetCostStats: async () => {
    await resetCostStats();
  },
});
browser.runtime.onMessage.addListener(router);

browser.commands.onCommand.addListener((command) => {
  // Fail soft: a storage/messaging error must never leave an unhandled rejection.
  if (command === CMD_TOGGLE) {
    void toggleEnabled().catch((err) => log.warn("toggle command failed", err));
  } else if (command === CMD_SELECT_REGION) {
    void sendCommandToActiveTab("startRegionSelect").catch((err) =>
      log.warn("select-region command failed", err),
    );
  } else if (command === CMD_PEEK_ORIGINAL) {
    void sendCommandToActiveTab("togglePeekOriginal").catch((err) =>
      log.warn("peek-original command failed", err),
    );
  }
});

log.info("background event page loaded");
