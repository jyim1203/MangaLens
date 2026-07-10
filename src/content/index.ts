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
import {
  SETTINGS_KEY,
  migrateSettings,
  type Settings,
} from "../shared/settings";
import { activeAfter, computeGateAction, type GateState } from "./gate";
import { createScanner, type Scanner } from "./scanner";
import { createViewportQueue, type ViewportQueue } from "./viewportQueue";
import { OverlayManager } from "./overlay/OverlayManager";

const log = createLogger("content");

let gateState: GateState = { active: false };

// Live subsystems while active; all undefined while inert.
let scanner: Scanner | undefined;
let viewportQueue: ViewportQueue | undefined;
let overlay: OverlayManager | undefined;

/** Start the scan → queue → overlay pipeline for the enabled page. */
function activate(settings: Settings): void {
  if (overlay) deactivate(); // defensive: never double-activate
  const hostname = location.hostname;

  overlay = new OverlayManager({
    settings,
    hostname,
    // An overlay noticing its image left the DOM asks the scanner to reconcile,
    // which unregisters the candidate (cancelling its in-flight request, item 4).
    onImageGone: () => scanner?.scan(),
  });
  overlay.start();

  viewportQueue = createViewportQueue({
    overlay,
    prefetchAhead: settings.prefetchAhead,
  });

  scanner = createScanner({
    onAdded: (c) => viewportQueue?.register(c),
    onRemoved: (c) => viewportQueue?.unregister(c),
  });
  scanner.start();

  log.debug("activated");
}

/** Total teardown (handoff item 1): observers, overlays, in-flight requests. */
function deactivate(): void {
  // Order matters: stop discovering, then cancel in-flight + drop observers,
  // then remove overlay hosts and shared listeners.
  scanner?.stop();
  viewportQueue?.stop(); // cancels every outstanding request (item 4)
  overlay?.stop();
  scanner = undefined;
  viewportQueue = undefined;
  overlay = undefined;
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

/**
 * Read settings WITHOUT waking the event page: a raw `storage.local` read healed
 * by the PURE {@link migrateSettings} (never `loadSettings`, which persists on
 * first run — a content script on every page must never write storage).
 */
async function readSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return migrateSettings(raw).settings;
}

/** Recompute the gate from a raw stored blob (from storage.onChanged). */
function onSettingsChanged(rawNewValue: unknown): void {
  try {
    applySettings(migrateSettings(rawNewValue).settings);
  } catch (err) {
    log.warn("settings-change handling failed", err);
  }
}

async function bootstrap(): Promise<void> {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    onSettingsChanged(change.newValue);
  });

  const settings = await readSettings();
  applySettings(settings);
}

// Wrap the whole bootstrap: a failure here must never surface on the host page.
bootstrap().catch((err) => log.warn("content bootstrap failed", err));
