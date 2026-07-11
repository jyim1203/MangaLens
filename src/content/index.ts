/**
 * Content script entry point — the composition root (handoff item 1/7).
 *
 * WHY inert-by-default: injected on <all_urls>, this must do nothing observable
 * until MangaLens is enabled (globally + for this site) — no DOM mutation, no
 * fetches, no observers, and (since 1.1) not even a message to the background,
 * which would wake the event page on every page the user visits.
 *
 * The gate is driven by a `storage.local` READ + `storage.onChanged`, never by
 * messaging: a storage read does not wake the event page (the whole point of the
 * design), and `storage.onChanged` fires in every tab (strictly more reliable
 * than the `settingsChanged` broadcast). We deliberately do NOT register a
 * content-side `settingsChanged` handler — having both fire would double-handle
 * every change; that broadcast stays for the popup (Phase 6). // WHY-note for
 * Phase 6: do not "fix" this by adding a settingsChanged listener here.
 *
 * This module is a thin composition root: all logic lives in the pure gate
 * reducer ({@link computeGateAction}) and the scanner/queue/overlay modules.
 * Every entry point is wrapped so an exception can never escape into the host
 * page (handoff rule 6).
 */
import browser from "webextension-polyfill";
import { createLogger } from "../shared/log";
import { createMessageRouter, sendToBackground } from "../shared/messages";
import {
  SETTINGS_KEY,
  getAutoTranslate,
  migrateSettings,
  peekSettings,
  type Settings,
} from "../shared/settings";
import { activeAfter, computeGateAction, type GateState } from "./gate";
import { createScanner, type Scanner } from "./scanner";
import { createViewportQueue, type ViewportQueue } from "./viewportQueue";
import { OverlayManager } from "./overlay/OverlayManager";
import { createRegionSelector, type RegionSelector } from "./regionSelect";
import { ToastManager } from "./toast";
import { buildContentRouterHandlers } from "./contentRouter";

const log = createLogger("content");

let gateState: GateState = { active: false };

// Live subsystems while active; all undefined while inert.
let scanner: Scanner | undefined;
let viewportQueue: ViewportQueue | undefined;
let overlay: OverlayManager | undefined;
let regionSelector: RegionSelector | undefined;
let toast: ToastManager | undefined;

/** Start the scan → queue → overlay pipeline for the enabled page. */
function activate(settings: Settings): void {
  if (overlay) deactivate(); // defensive: never double-activate
  const hostname = location.hostname;

  // Toasts for the two actionable failures (Phase 7 item 6); a fresh manager per
  // activation resets the once-per-activation dedupe (see toastPolicy).
  toast = new ToastManager({
    onOpenSettings: () =>
      void sendToBackground("openOptionsPage").catch((err) =>
        log.warn("openOptionsPage failed", err),
      ),
  });

  overlay = new OverlayManager({
    settings,
    hostname,
    // An overlay noticing its image left the DOM asks the scanner to reconcile,
    // which unregisters the candidate (cancelling its in-flight request, item 4).
    onImageGone: () => scanner?.scan(),
  });
  overlay.start();

  // Auto-translate only on a per-site opt-in (Phase 7.2 item 3): global-enabled
  // activates the content script everywhere (overlays, drag-select, Translate
  // all), but visibility never auto-sends page images to the provider unless the
  // user turned this site on. A re-request on the getAutoTranslate flip rebuilds
  // the queue with the new value (see gate.ts).
  viewportQueue = createViewportQueue({
    overlay,
    prefetchAhead: settings.prefetchAhead,
    autoEnqueue: getAutoTranslate(settings, hostname),
    onProviderError: (kind) => toast?.showError(kind),
  });

  scanner = createScanner({
    onAdded: (c) => viewportQueue?.register(c),
    onRemoved: (c) => viewportQueue?.unregister(c),
  });
  scanner.start();

  // Drag-select fallback (F10). Region results render through the same overlay.
  regionSelector = createRegionSelector({
    overlay,
    onError: (kind) => toast?.showError(kind),
    onNotice: (message) => toast?.showMessage(message),
  });

  log.debug("activated");
}

/** Total teardown (handoff item 1): observers, overlays, in-flight requests. */
function deactivate(): void {
  // Order matters: stop discovering, then cancel in-flight + drop observers,
  // tear down any in-progress selection, then remove overlay hosts + toasts.
  scanner?.stop();
  viewportQueue?.stop(); // cancels every outstanding request (item 4)
  regionSelector?.stop(); // tears down an in-progress drag + cancels region requests
  overlay?.stop(); // also resets peek state (item 6)
  toast?.stop();
  scanner = undefined;
  viewportQueue = undefined;
  regionSelector = undefined;
  overlay = undefined;
  toast = undefined;
  log.debug("deactivated");
}

/** Apply a settings snapshot through the pure gate reducer. */
function applySettings(settings: Settings): void {
  const action = computeGateAction(gateState, settings, location.hostname);
  switch (action) {
    case "activate":
      activate(settings);
      break;
    case "deactivate":
      deactivate();
      break;
    case "restyle":
      overlay?.setSettings(settings);
      break;
    case "re-request":
      // Clear everything and re-scan; the queue re-requests (cache-cheap).
      deactivate();
      activate(settings);
      break;
    case "no-op":
      break;
  }
  gateState = {
    active: activeAfter(action, gateState.active),
    settings,
  };
}

// Settings are read WITHOUT waking the event page via the shared
// `peekSettings` (raw storage read + pure migrate — never `loadSettings`,
// which persists on first run; a content script must never write storage).

/** Recompute the gate from a raw stored blob (from storage.onChanged). */
function onSettingsChanged(rawNewValue: unknown): void {
  try {
    applySettings(migrateSettings(rawNewValue).settings);
  } catch (err) {
    log.warn("settings-change handling failed", err);
  }
}

/** True once the initial `readSettings` → `applySettings` has completed. */
let initialApplied = false;
/** The latest raw settings blob seen via storage.onChanged before the initial
 *  apply finished, held so it can be re-applied afterwards (item 8). */
let bufferedChange: { value: unknown } | undefined;

async function bootstrap(): Promise<void> {
  // Popup → this tab: F8 "translate all" (Phase 6). Registered even while
  // inert — a passive onMessage listener touches nothing on the host page and
  // sends nothing (unlike the Phase 0 liveness ping this file used to have).
  // While inactive there is no queue, so the popup just gets { count: 0 }.
  // This is NOT the forbidden settingsChanged listener (see module WHY-note):
  // settings changes still arrive exclusively via storage.onChanged below.
  // Phase 7 commands / popup button + F8 translate-all. Like translateAll, these
  // are passive onMessage handlers registered even while inert — they touch nothing
  // on the host page and simply report "not started" / `{ count: 0 }` (NOT the
  // forbidden settingsChanged listener; settings still arrive via storage.onChanged).
  // The handler-map construction lives in the pure buildContentRouterHandlers so its
  // inert-vs-active behavior is unit-tested (item 5); this stays a composition root.
  browser.runtime.onMessage.addListener(
    createMessageRouter(
      buildContentRouterHandlers({
        getQueue: () => viewportQueue,
        getRegionSelector: () => regionSelector,
        getOverlay: () => overlay,
      }),
    ),
  );

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    // WHY buffer until the initial apply lands: a change firing while
    // `readSettings()` is still awaiting would be applied first and then clobbered
    // by the STALER initial snapshot (an async read that started earlier). Record
    // the latest raw value instead and re-apply it once the initial apply is done,
    // so newest-wins holds. A single `bufferedChange` beats a queue — only the last
    // value matters (applySettings is a full snapshot, not a delta).
    if (!initialApplied) {
      bufferedChange = { value: change.newValue };
      return;
    }
    onSettingsChanged(change.newValue);
  });

  const settings = await peekSettings();
  applySettings(settings);
  // Everything from here is synchronous (no await), so no listener can interleave:
  // drain any change buffered during the read, then go live.
  if (bufferedChange) onSettingsChanged(bufferedChange.value);
  bufferedChange = undefined;
  initialApplied = true;
}

// Wrap the whole bootstrap: a failure here must never surface on the host page.
bootstrap().catch((err) => log.warn("content bootstrap failed", err));
