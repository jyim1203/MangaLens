/**
 * Toolbar popup (Phase 6): global toggle (F1), per-site rule (F15), target
 * language (F9), provider/model quick-pick (F2), translate-all (F8), cost
 * line (F17), and the in-flow §7.3 host-permission grant.
 *
 * Thin shell over {@link import("./popupLogic")}: every decision is a pure,
 * tested function; this file only reads state, renders it, and forwards user
 * actions. Reads never wake the background event page (raw storage reads via
 * `peekSettings`/`getCostStats`); ALL settings writes go through the
 * background's `setSettings`/`toggleEnabled` messages (single write path).
 */
import browser from "webextension-polyfill";
import { getCostStats, COST_KEY } from "../background/costTracker";
import { DEFAULT_MODELS, PROVIDER_LABELS } from "../shared/constants";
import { languageOptions } from "../shared/languages";
import { createLogger } from "../shared/log";
import { sendToBackground, sendToTab } from "../shared/messages";
import {
  SETTINGS_KEY,
  getEffectiveEnabled,
  peekSettings,
  type Settings,
} from "../shared/settings";
import { PROVIDER_IDS } from "../shared/types";
import {
  costSummary,
  hostnameFromUrl,
  needsApiKey,
  planTranslateAll,
  regionSelectEnabled,
  siteChoice,
  siteChoicePatch,
  statusLine,
  type SiteChoice,
} from "./popupLogic";

const log = createLogger("popup");

/** Get a required element by id; a missing one is a build-time HTML bug. */
function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: missing #${id}`);
  return el as T;
}

const els = {
  enabled: must<HTMLInputElement>("enabled"),
  status: must<HTMLParagraphElement>("status"),
  bannerKey: must<HTMLDivElement>("banner-key"),
  bannerPerm: must<HTMLDivElement>("banner-perm"),
  addKey: must<HTMLButtonElement>("add-key"),
  dismissKey: must<HTMLButtonElement>("dismiss-key"),
  grantPerm: must<HTMLButtonElement>("grant-perm"),
  dismissPerm: must<HTMLButtonElement>("dismiss-perm"),
  siteChoice: must<HTMLSelectElement>("site-choice"),
  targetLang: must<HTMLSelectElement>("target-lang"),
  provider: must<HTMLSelectElement>("provider"),
  model: must<HTMLInputElement>("model"),
  translateAll: must<HTMLButtonElement>("translate-all"),
  selectRegion: must<HTMLButtonElement>("select-region"),
  actionStatus: must<HTMLParagraphElement>("action-status"),
  cost: must<HTMLSpanElement>("cost"),
  openOptions: must<HTMLButtonElement>("open-options"),
};

/** Latest rendered snapshot (change handlers read from it). */
let current: Settings | undefined;
/** Active tab (for the site rule + translate-all target). */
let tabId: number | undefined;
let tabHost: string | undefined;
/** Set while the translate-all button is in its "click again to confirm" step. */
let pendingConfirmCount: number | undefined;
/** Banners the user ✕-ed away. Popup-instance-scoped (not persisted): the
 *  banners are state-driven and would otherwise reappear on the next render. */
const dismissed = { key: false, perm: false };

/** Set a control's value unless the user is mid-edit in it (re-render safety). */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement === el) return;
  el.value = value;
}

/** Fill a <select> with options once (id-stable across re-renders). */
function fillSelect(
  el: HTMLSelectElement,
  options: { value: string; label: string }[],
): void {
  el.textContent = "";
  for (const { value, label } of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    el.appendChild(opt);
  }
}

function resetTranslateAllButton(): void {
  pendingConfirmCount = undefined;
  els.translateAll.textContent = "Translate all pages";
}

function render(settings: Settings): void {
  current = settings;

  els.enabled.checked = settings.enabled;
  els.status.textContent = statusLine(settings, tabHost);

  // Site rule control: meaningless without an http(s) tab.
  els.siteChoice.disabled = !tabHost;
  if (tabHost) setValue(els.siteChoice, siteChoice(settings, tabHost));

  // Dropdown contents depend on settings (current lang may be uncurated), so
  // (re)fill each render — cheap at this size, and setValue skips focused ones.
  if (document.activeElement !== els.targetLang) {
    fillSelect(
      els.targetLang,
      languageOptions(settings.targetLang).map((o) => ({
        value: o.code,
        label: o.name,
      })),
    );
    els.targetLang.value = settings.targetLang;
  }
  if (document.activeElement !== els.provider) {
    fillSelect(
      els.provider,
      PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] })),
    );
    els.provider.value = settings.provider;
  }

  setValue(els.model, settings.models[settings.provider] ?? "");
  els.model.placeholder = DEFAULT_MODELS[settings.provider] || "model id (required)";

  els.bannerKey.hidden = dismissed.key || !needsApiKey(settings);

  const active = tabHost ? getEffectiveEnabled(settings, tabHost) : false;
  els.translateAll.disabled = !active;
  els.translateAll.title = active
    ? "Queue every detected image on this page"
    : "Enable MangaLens on this page first";

  els.selectRegion.disabled = !regionSelectEnabled(settings, tabHost);
  els.selectRegion.title = active
    ? "Drag-select a region to translate (Alt+Shift+S)"
    : "Enable MangaLens on this page first";
}

/** Re-check the optional <all_urls> grant and toggle its banner (§7.3). */
async function renderPermissionBanner(): Promise<void> {
  try {
    const granted = await browser.permissions.contains({
      origins: ["<all_urls>"],
    });
    els.bannerPerm.hidden = dismissed.perm || granted;
  } catch (err) {
    log.warn("permission check failed", err);
    els.bannerPerm.hidden = true; // fail quiet — the banner is a convenience
  }
}

async function renderCost(): Promise<void> {
  els.cost.textContent = costSummary(await getCostStats());
}

/** Send the real (non-dry-run) translate-all and report the outcome. */
async function runTranslateAll(): Promise<void> {
  if (tabId === undefined) return;
  resetTranslateAllButton();
  try {
    const { count } = await sendToTab(tabId, "translateAll", { dryRun: false });
    els.actionStatus.textContent =
      count > 0 ? `Queued ${count} page${count === 1 ? "" : "s"}.` : "Nothing left to queue.";
  } catch (err) {
    log.warn("translateAll failed", err);
    els.actionStatus.textContent = "Couldn't reach this page — reload it and try again.";
  }
}

async function onTranslateAllClick(): Promise<void> {
  if (tabId === undefined) return;
  // Second click of the inline confirm step → actually run.
  if (pendingConfirmCount !== undefined) {
    await runTranslateAll();
    return;
  }
  els.actionStatus.textContent = "";
  let count: number;
  try {
    ({ count } = await sendToTab(tabId, "translateAll", { dryRun: true }));
  } catch (err) {
    log.warn("translateAll dry run failed", err);
    els.actionStatus.textContent = "Couldn't reach this page — reload it and try again.";
    return;
  }
  switch (planTranslateAll(count)) {
    case "none":
      els.actionStatus.textContent = "No manga images detected on this page.";
      break;
    case "run":
      await runTranslateAll();
      break;
    case "confirm":
      // WHY inline confirm: window.confirm from a browser-action popup is
      // unreliable (focus loss closes the popup). See planTranslateAll.
      pendingConfirmCount = count;
      els.translateAll.textContent = `Translate ${count} pages?`;
      els.actionStatus.textContent = "That's a lot of pages — click again to confirm.";
      break;
  }
}

/**
 * Enter drag-select mode on the active tab, then close the popup so it isn't
 * covering the page during the drag (item 7). If the content script reports it
 * didn't start (site disabled / extension off), keep the popup open and surface a
 * hint instead of closing on nothing.
 */
async function onSelectRegionClick(): Promise<void> {
  if (tabId === undefined) return;
  try {
    const { started } = await sendToTab(tabId, "startRegionSelect");
    if (started) {
      window.close();
    } else {
      els.actionStatus.textContent = "Enable MangaLens on this page first.";
    }
  } catch (err) {
    log.warn("startRegionSelect failed", err);
    els.actionStatus.textContent = "Couldn't reach this page — reload it and try again.";
  }
}

function wireEvents(): void {
  els.enabled.addEventListener("change", () => {
    void sendToBackground("toggleEnabled")
      .then(render)
      .catch((err) => log.warn("toggle failed", err));
  });

  els.siteChoice.addEventListener("change", () => {
    if (!tabHost) return;
    const choice = els.siteChoice.value as SiteChoice;
    void sendToBackground("setSettings", siteChoicePatch(tabHost, choice))
      .then(render)
      .catch((err) => log.warn("site rule save failed", err));
  });

  els.targetLang.addEventListener("change", () => {
    void sendToBackground("setSettings", { targetLang: els.targetLang.value })
      .then(render)
      .catch((err) => log.warn("target lang save failed", err));
  });

  els.provider.addEventListener("change", () => {
    void sendToBackground("setSettings", { provider: els.provider.value as Settings["provider"] })
      .then(render)
      .catch((err) => log.warn("provider save failed", err));
  });

  els.model.addEventListener("change", () => {
    if (!current) return;
    const value = els.model.value.trim();
    // Empty deletes the entry (null sentinel) → provider default applies.
    void sendToBackground("setSettings", {
      models: { [current.provider]: value || null },
    })
      .then(render)
      .catch((err) => log.warn("model save failed", err));
  });

  els.translateAll.addEventListener("click", () => void onTranslateAllClick());

  els.selectRegion.addEventListener("click", () => void onSelectRegionClick());

  els.grantPerm.addEventListener("click", () => {
    // permissions.request MUST run in a user-input handler (§7.3 in-flow grant).
    void browser.permissions
      .request({ origins: ["<all_urls>"] })
      .then(() => renderPermissionBanner())
      .catch((err) => log.warn("permission request failed", err));
  });

  const openOptions = (): void => {
    void browser.runtime.openOptionsPage();
    window.close();
  };
  els.addKey.addEventListener("click", openOptions);
  els.openOptions.addEventListener("click", openOptions);

  els.dismissKey.addEventListener("click", () => {
    dismissed.key = true;
    els.bannerKey.hidden = true;
  });
  els.dismissPerm.addEventListener("click", () => {
    dismissed.perm = true;
    els.bannerPerm.hidden = true;
  });

  // Live refresh while open: settings from any context (keyboard toggle,
  // options page) and cost totals as translations land.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY]) {
      resetTranslateAllButton();
      void peekSettings().then(render).catch((err) => log.warn("refresh failed", err));
    }
    if (changes[COST_KEY]) {
      void renderCost().catch((err) => log.warn("cost refresh failed", err));
    }
  });
}

async function main(): Promise<void> {
  const [tabs, settings] = await Promise.all([
    browser.tabs.query({ active: true, currentWindow: true }),
    peekSettings(),
  ]);
  const tab = tabs[0];
  tabId = tab?.id;
  tabHost = hostnameFromUrl(tab?.url);

  wireEvents();
  render(settings);
  await Promise.all([renderPermissionBanner(), renderCost()]);
}

void main().catch((err) => {
  log.warn("popup bootstrap failed", err);
  els.status.textContent = "Failed to load — see console.";
});
