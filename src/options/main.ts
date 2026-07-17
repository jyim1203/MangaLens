/**
 * Options page (Phase 6): full settings UI — provider/keys with test buttons
 * (F2/§7.6), translation prefs (F9/F11/F18/F19), font controls with live
 * preview (F5), per-site rules with per-site cache clear (F15/F13), the
 * performance/cost knobs (F7/F12), the usage table (F17), cache management,
 * and host-permission status (§7.3).
 *
 * Thin shell: decisions live in the pure {@link import("./optionsLogic")}
 * helpers. Reads never wake the background event page (raw storage /
 * same-origin IndexedDB); ALL settings writes go through the background's
 * `setSettings` message (single write path), and the cost reset goes through
 * `resetCostStats` (its write chain lives in the background).
 */
import browser from "webextension-polyfill";
import {
  clearAllCache,
  clearCacheForSite,
  getCacheStats,
} from "../background/cache";
import { COST_KEY, getCostStats } from "../background/costTracker";
import { DEFAULT_MODELS, PROVIDER_LABELS } from "../shared/constants";
import { resolveI18n } from "../shared/i18nDom";
import { languageOptions } from "../shared/languages";
import { createLogger } from "../shared/log";
import { sendToBackground } from "../shared/messages";
import {
  SETTINGS_KEY,
  peekSettings,
  type Settings,
  type SettingsPatch,
} from "../shared/settings";
import { PROVIDER_IDS, type ProviderId } from "../shared/types";
import { formatBytes, formatTokens, formatUsd } from "../shared/format";
import {
  NUMERIC_FIELDS,
  type NumericFieldSpec,
  apiKeyPatch,
  costRows,
  honorificsPatch,
  honorificsValue,
  maskApiKey,
  modelPatch,
  normalizeHostname,
  numericFieldPatch,
  numericFieldValue,
  parseNumericField,
  sanitizeFontBounds,
  siteRulePatch,
  siteRuleRows,
  type NumericFieldId,
} from "./optionsLogic";

const log = createLogger("options");

/** Get a required element by id; a missing one is a build-time HTML bug. */
function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`options: missing #${id}`);
  return el as T;
}

/** Latest settings snapshot; change handlers read from it. */
let current: Settings;

/** Skip writing a control the user is mid-edit in (re-render safety). */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement === el) return;
  el.value = value;
}

function fillSelect(
  el: HTMLSelectElement,
  options: { value: string; label: string }[],
  value: string,
): void {
  if (document.activeElement === el) return;
  el.textContent = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  }
  el.value = value;
}

// --- Save plumbing -----------------------------------------------------------

const saveStatus = must<HTMLSpanElement>("save-status");
let saveFlashTimer: ReturnType<typeof setTimeout> | undefined;

/** Persist a patch through the background and flash the "Saved" indicator. */
async function save(patch: SettingsPatch): Promise<void> {
  try {
    const next = await sendToBackground("setSettings", patch);
    render(next);
    saveStatus.classList.add("show");
    clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => saveStatus.classList.remove("show"), 1200);
  } catch (err) {
    log.warn("settings save failed", err);
    saveStatus.textContent = "Save failed";
    saveStatus.classList.add("show");
  }
}

// --- Provider rows (built once, values synced on render) ---------------------

interface ProviderRowEls {
  keyInput: HTMLInputElement;
  clearBtn: HTMLButtonElement;
  testBtn: HTMLButtonElement;
  result: HTMLSpanElement;
  modelInput: HTMLInputElement;
  endpointInput?: HTMLInputElement;
}

const providerRows = new Map<ProviderId, ProviderRowEls>();

function buildProviderRows(): void {
  const host = must<HTMLDivElement>("provider-rows");
  for (const provider of PROVIDER_IDS) {
    const row = document.createElement("div");
    row.className = "provider-row";

    const title = document.createElement("h3");
    title.textContent = PROVIDER_LABELS[provider];
    row.appendChild(title);

    let endpointInput: HTMLInputElement | undefined;
    if (provider === "custom") {
      const endpointField = document.createElement("label");
      endpointField.className = "field";
      const endpointLabel = document.createElement("span");
      endpointLabel.textContent = "Endpoint URL";
      endpointInput = document.createElement("input");
      endpointInput.type = "url";
      endpointInput.placeholder = "https://host/v1 (OpenAI-compatible)";
      endpointInput.spellcheck = false;
      endpointField.append(endpointLabel, endpointInput);
      row.appendChild(endpointField);
      endpointInput.addEventListener("change", () => {
        void save({ customEndpoint: endpointInput!.value.trim() });
      });
    }

    const keyField = document.createElement("div");
    keyField.className = "field";
    const keyLabel = document.createElement("span");
    keyLabel.textContent = "API key";
    const keyControls = document.createElement("span");
    keyControls.className = "inline";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.className = "danger";
    const testBtn = document.createElement("button");
    testBtn.textContent = "Test";
    const result = document.createElement("span");
    result.className = "test-result";
    keyControls.append(keyInput, testBtn, clearBtn, result);
    keyField.append(keyLabel, keyControls);
    row.appendChild(keyField);

    const modelField = document.createElement("label");
    modelField.className = "field";
    const modelLabel = document.createElement("span");
    modelLabel.textContent = "Model";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.spellcheck = false;
    modelField.append(modelLabel, modelInput);
    row.appendChild(modelField);

    // WHY the input rests EMPTY with the mask as placeholder: the stored key is
    // never round-tripped into the DOM in full, so it can't be shoulder-surfed
    // or leak via autofill/session restore (§7.6). Typing a key and committing
    // saves it, then the field returns to its masked resting state.
    keyInput.addEventListener("change", () => {
      const value = keyInput.value.trim();
      if (!value) return; // blank is the resting state, not a delete (Clear does that)
      void save(apiKeyPatch(provider, value)).then(() => {
        keyInput.value = "";
        result.textContent = "";
        result.className = "test-result";
      });
    });

    clearBtn.addEventListener("click", () => {
      void save(apiKeyPatch(provider, "")); // null-delete sentinel
    });

    testBtn.addEventListener("click", () => {
      void runKeyTest(provider);
    });

    modelInput.addEventListener("change", () => {
      void save(modelPatch(provider, modelInput.value));
    });

    host.appendChild(row);
    providerRows.set(provider, {
      keyInput,
      clearBtn,
      testBtn,
      result,
      modelInput,
      endpointInput,
    });
  }
}

/** Run the §7.6 key test for one provider row (typed-but-unsaved key wins). */
async function runKeyTest(provider: ProviderId): Promise<void> {
  const row = providerRows.get(provider);
  if (!row) return;
  const apiKey = row.keyInput.value.trim() || current.apiKeys[provider] || "";
  const customEndpoint =
    provider === "custom"
      ? row.endpointInput?.value.trim() || current.customEndpoint
      : undefined;

  row.result.textContent = "Testing…";
  row.result.className = "test-result";
  row.testBtn.disabled = true;
  try {
    const res = await sendToBackground("testApiKey", {
      provider,
      apiKey,
      customEndpoint,
    });
    row.result.textContent = res.ok ? "✓ Key works" : `✗ ${res.message ?? "Failed"}`;
    row.result.className = `test-result ${res.ok ? "ok" : "err"}`;
  } catch (err) {
    log.warn("key test failed", err);
    row.result.textContent = "✗ Test failed — see console";
    row.result.className = "test-result err";
  } finally {
    row.testBtn.disabled = false;
  }
}

function renderProviderRows(settings: Settings): void {
  for (const provider of PROVIDER_IDS) {
    const row = providerRows.get(provider);
    if (!row) continue;
    const stored = settings.apiKeys[provider] ?? "";
    row.keyInput.placeholder = stored ? maskApiKey(stored) : "not set";
    row.clearBtn.hidden = !stored;
    setValue(row.modelInput, settings.models[provider] ?? "");
    row.modelInput.placeholder =
      DEFAULT_MODELS[provider] || "model id (required)";
    if (row.endpointInput) setValue(row.endpointInput, settings.customEndpoint);
  }
}

// --- Static controls ---------------------------------------------------------

const els = {
  provider: must<HTMLSelectElement>("provider"),
  targetLang: must<HTMLSelectElement>("target-lang"),
  sourceLang: must<HTMLSelectElement>("source-lang"),
  honorifics: must<HTMLSelectElement>("honorifics"),
  readingDirection: must<HTMLSelectElement>("reading-direction"),
  translateSfx: must<HTMLInputElement>("translate-sfx"),
  fontFamily: must<HTMLInputElement>("font-family"),
  sizeMode: must<HTMLSelectElement>("size-mode"),
  fixedSizeField: must<HTMLLabelElement>("fixed-size-field"),
  autoSizeField: must<HTMLLabelElement>("auto-size-field"),
  fontColor: must<HTMLInputElement>("font-color"),
  stroke: must<HTMLInputElement>("stroke"),
  strokeColor: must<HTMLInputElement>("stroke-color"),
  bubbleFillColor: must<HTMLInputElement>("bubble-fill-color"),
  opacityLabel: must<HTMLSpanElement>("opacity-label"),
  previewBubble: must<HTMLDivElement>("preview-bubble"),
  siteRules: must<HTMLTableSectionElement>("site-rules"),
  siteRulesEmpty: must<HTMLParagraphElement>("site-rules-empty"),
  newSite: must<HTMLInputElement>("new-site"),
  newSiteRule: must<HTMLSelectElement>("new-site-rule"),
  addSite: must<HTMLButtonElement>("add-site"),
  usageRows: must<HTMLTableSectionElement>("usage-rows"),
  usageEmpty: must<HTMLParagraphElement>("usage-empty"),
  usageTotal: must<HTMLElement>("usage-total"),
  resetUsage: must<HTMLButtonElement>("reset-usage"),
  cacheStats: must<HTMLParagraphElement>("cache-stats"),
  clearCache: must<HTMLButtonElement>("clear-cache"),
  permStatus: must<HTMLParagraphElement>("perm-status"),
  grantPerm: must<HTMLButtonElement>("grant-perm"),
  revokePerm: must<HTMLButtonElement>("revoke-perm"),
};

/** All inputs marked data-num, keyed by their {@link NumericFieldId}. */
const numericInputs = new Map<NumericFieldId, HTMLInputElement>();

function wireNumericInputs(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>("[data-num]")) {
    const id = el.dataset.num as NumericFieldId;
    if (!(id in NUMERIC_FIELDS)) {
      log.warn(`unknown numeric field ${id}`);
      continue;
    }
    numericInputs.set(id, el);
    // Widen from the `as const` literal union so `integer` (absent on the
    // float specs) reads as an optional property.
    const spec: NumericFieldSpec = NUMERIC_FIELDS[id];
    // The range input carries its own min/max/step in the HTML.
    if (el.type === "number") {
      el.min = String(spec.min);
      el.max = String(spec.max);
      if (!el.step) el.step = spec.integer ? "1" : "0.01";
    }

    el.addEventListener("change", () => {
      const parsed = parseNumericField(id, el.value);
      if (parsed === undefined) {
        el.value = String(numericFieldValue(current, id)); // revert garbage input
        return;
      }
      if (id === "minSizePx" || id === "maxSizePx") {
        // Keep min ≤ max: the edited bound wins and drags the other along.
        const bounds = sanitizeFontBounds(
          id === "minSizePx" ? parsed : current.font.minSizePx,
          id === "maxSizePx" ? parsed : current.font.maxSizePx,
          id === "minSizePx" ? "min" : "max",
        );
        void save({ font: bounds });
      } else {
        void save(numericFieldPatch(id, parsed));
      }
    });
  }
  // Live opacity label + preview while dragging (persist only on change above).
  const opacity = numericInputs.get("bubbleFillOpacity");
  opacity?.addEventListener("input", () => {
    els.opacityLabel.textContent = `${Math.round(Number(opacity.value) * 100)}%`;
    renderPreview(current, Number(opacity.value));
  });
}

// --- Appearance preview -------------------------------------------------------

/** Paint the sample bubble like BubbleBox does: separate fill layer so opacity
 *  never fades the text. `liveOpacity` overrides while the slider is dragged. */
function renderPreview(settings: Settings, liveOpacity?: number): void {
  const font = settings.font;
  const bubble = els.previewBubble;
  bubble.textContent = "";

  const fill = document.createElement("div");
  fill.style.cssText = "position:absolute;inset:0;border-radius:10px;";
  fill.style.backgroundColor = font.bubbleFillColor;
  fill.style.opacity = String(liveOpacity ?? font.bubbleFillOpacity);

  const text = document.createElement("span");
  text.textContent = "Sample bubble text";
  text.style.position = "relative";
  text.style.fontFamily = font.family;
  const size =
    font.sizeMode === "fixed"
      ? font.fixedSizePx
      : Math.min(font.maxSizePx, Math.max(font.minSizePx, 16));
  text.style.fontSize = `${size}px`;
  text.style.color = font.color;
  if (font.stroke) {
    text.style.textShadow = `0 0 2px ${font.strokeColor}, 0 0 2px ${font.strokeColor}, 0 0 2px ${font.strokeColor}`;
  }

  bubble.append(fill, text);
}

// --- Per-site rules -----------------------------------------------------------

function renderSiteRules(settings: Settings): void {
  const rows = siteRuleRows(settings);
  els.siteRules.textContent = "";
  els.siteRulesEmpty.hidden = rows.length > 0;

  for (const { hostname, enabled } of rows) {
    const tr = document.createElement("tr");

    const tdHost = document.createElement("td");
    tdHost.textContent = hostname;

    const tdRule = document.createElement("td");
    const select = document.createElement("select");
    for (const [value, label] of [
      ["on", "Always on"],
      ["off", "Always off"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.value = enabled ? "on" : "off";
    select.addEventListener("change", () => {
      void save(siteRulePatch(hostname, select.value === "on"));
    });
    tdRule.appendChild(select);

    const tdActions = document.createElement("td");
    tdActions.className = "inline";
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear cache";
    clearBtn.title = `Delete cached translations for ${hostname}`;
    clearBtn.addEventListener("click", () => {
      clearBtn.disabled = true;
      void clearCacheForSite(hostname)
        .then((n) => {
          clearBtn.textContent = `Cleared ${n}`;
          return renderCache();
        })
        .finally(() => (clearBtn.disabled = false));
    });
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.className = "danger";
    removeBtn.addEventListener("click", () => {
      void save(siteRulePatch(hostname, null));
    });
    tdActions.append(clearBtn, removeBtn);

    tr.append(tdHost, tdRule, tdActions);
    els.siteRules.appendChild(tr);
  }
}

// --- Usage / cache / permissions panels ----------------------------------------

async function renderUsage(): Promise<void> {
  const stats = await getCostStats();
  const rows = costRows(stats);
  els.usageRows.textContent = "";
  els.usageEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      PROVIDER_LABELS[row.provider],
      String(row.calls),
      String(row.images),
      formatTokens(row.tokensIn),
      formatTokens(row.tokensOut),
      formatUsd(row.estCostUsd),
    ];
    cells.forEach((textContent, i) => {
      const td = document.createElement("td");
      td.textContent = textContent;
      if (i > 0) td.className = "num";
      tr.appendChild(td);
    });
    els.usageRows.appendChild(tr);
  }
  els.usageTotal.textContent = `Total: ${formatUsd(stats.totalEstCostUsd)}`;
}

async function renderCache(): Promise<void> {
  const stats = await getCacheStats();
  els.cacheStats.textContent = `${stats.entries} cached translation${
    stats.entries === 1 ? "" : "s"
  } · ${formatBytes(stats.bytes)}`;
}

async function renderPermissions(): Promise<void> {
  try {
    const granted = await browser.permissions.contains({
      origins: ["<all_urls>"],
    });
    els.permStatus.textContent = granted
      ? "Image access: granted for all sites."
      : "Image access: not granted — translation can't fetch images yet.";
    els.grantPerm.hidden = granted;
    els.revokePerm.hidden = !granted;
  } catch (err) {
    log.warn("permission check failed", err);
    els.permStatus.textContent = "Image access: status unavailable.";
  }
}

// --- Render + wiring -----------------------------------------------------------

function render(settings: Settings): void {
  current = settings;

  fillSelect(
    els.provider,
    PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] })),
    settings.provider,
  );
  renderProviderRows(settings);

  fillSelect(
    els.targetLang,
    languageOptions(settings.targetLang).map((o) => ({
      value: o.code,
      label: o.name,
    })),
    settings.targetLang,
  );
  fillSelect(
    els.sourceLang,
    [
      { value: "auto", label: "Auto-detect" },
      ...languageOptions(
        settings.sourceLang !== "auto" ? settings.sourceLang : undefined,
      ).map((o) => ({ value: o.code, label: o.name })),
    ],
    settings.sourceLang,
  );
  setValue(els.honorifics, honorificsValue(settings));
  setValue(els.readingDirection, settings.readingDirection);
  els.translateSfx.checked = settings.translateSfx;

  setValue(els.fontFamily, settings.font.family);
  setValue(els.sizeMode, settings.font.sizeMode);
  els.fixedSizeField.hidden = settings.font.sizeMode !== "fixed";
  els.autoSizeField.hidden = settings.font.sizeMode !== "auto";
  setValue(els.fontColor, settings.font.color);
  els.stroke.checked = settings.font.stroke;
  setValue(els.strokeColor, settings.font.strokeColor);
  setValue(els.bubbleFillColor, settings.font.bubbleFillColor);
  els.opacityLabel.textContent = `${Math.round(settings.font.bubbleFillOpacity * 100)}%`;

  for (const [id, el] of numericInputs) {
    setValue(el, String(numericFieldValue(settings, id)));
  }

  renderSiteRules(settings);
  renderPreview(settings);
}

function wireEvents(): void {
  els.provider.addEventListener("change", () => {
    void save({ provider: els.provider.value as ProviderId });
  });
  els.targetLang.addEventListener("change", () => {
    void save({ targetLang: els.targetLang.value });
  });
  els.sourceLang.addEventListener("change", () => {
    void save({ sourceLang: els.sourceLang.value });
  });
  els.honorifics.addEventListener("change", () => {
    void save(honorificsPatch(els.honorifics.value));
  });
  els.readingDirection.addEventListener("change", () => {
    void save({
      readingDirection: els.readingDirection.value as Settings["readingDirection"],
    });
  });
  els.translateSfx.addEventListener("change", () => {
    void save({ translateSfx: els.translateSfx.checked });
  });

  els.fontFamily.addEventListener("change", () => {
    const family = els.fontFamily.value.trim();
    if (!family) {
      // Empty is not a valid font stack; revert rather than persisting it
      // (undefined in a patch would survive the merge and poison font.family).
      els.fontFamily.value = current.font.family;
      return;
    }
    void save({ font: { family } });
  });
  els.sizeMode.addEventListener("change", () => {
    void save({ font: { sizeMode: els.sizeMode.value as "auto" | "fixed" } });
  });
  els.fontColor.addEventListener("change", () => {
    void save({ font: { color: els.fontColor.value } });
  });
  els.stroke.addEventListener("change", () => {
    void save({ font: { stroke: els.stroke.checked } });
  });
  els.strokeColor.addEventListener("change", () => {
    void save({ font: { strokeColor: els.strokeColor.value } });
  });
  els.bubbleFillColor.addEventListener("change", () => {
    void save({ font: { bubbleFillColor: els.bubbleFillColor.value } });
  });

  els.addSite.addEventListener("click", () => {
    const hostname = normalizeHostname(els.newSite.value);
    if (!hostname) {
      els.newSite.setCustomValidity("Enter a hostname like reader.example.com");
      els.newSite.reportValidity();
      return;
    }
    els.newSite.setCustomValidity("");
    els.newSite.value = "";
    void save(siteRulePatch(hostname, els.newSiteRule.value === "on"));
  });
  els.newSite.addEventListener("input", () => els.newSite.setCustomValidity(""));

  els.resetUsage.addEventListener("click", () => {
    void sendToBackground("resetCostStats")
      .then(() => renderUsage())
      .catch((err) => log.warn("usage reset failed", err));
  });

  els.clearCache.addEventListener("click", () => {
    els.clearCache.disabled = true;
    void clearAllCache()
      .then(() => renderCache())
      .finally(() => (els.clearCache.disabled = false));
  });

  els.grantPerm.addEventListener("click", () => {
    void browser.permissions
      .request({ origins: ["<all_urls>"] })
      .then(() => renderPermissions())
      .catch((err) => log.warn("permission request failed", err));
  });
  els.revokePerm.addEventListener("click", () => {
    void browser.permissions
      .remove({ origins: ["<all_urls>"] })
      .then(() => renderPermissions())
      .catch((err) => log.warn("permission revoke failed", err));
  });

  // Live refresh: settings changed elsewhere (popup, keyboard toggle) or cost
  // totals moving as translations land.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY]) {
      void peekSettings().then(render).catch((err) => log.warn("refresh failed", err));
    }
    if (changes[COST_KEY]) {
      void renderUsage().catch((err) => log.warn("usage refresh failed", err));
    }
  });
}

/**
 * Localize every `data-i18n` element (Phase 8 §8 i18n walker), keeping each
 * element's English text as the fallback. Shared pure core: {@link resolveI18n}.
 */
function applyI18n(): void {
  const els = [...document.querySelectorAll<HTMLElement>("[data-i18n]")];
  const texts = resolveI18n(
    els.map((el) => ({ key: el.dataset.i18n ?? "", fallback: el.textContent ?? "" })),
  );
  els.forEach((el, i) => {
    el.textContent = texts[i]!;
  });
}

async function main(): Promise<void> {
  applyI18n(); // localize static strings first (§8)
  buildProviderRows();
  wireNumericInputs();
  wireEvents();
  render(await peekSettings());
  await Promise.all([renderUsage(), renderCache(), renderPermissions()]);
}

void main().catch((err) => log.warn("options bootstrap failed", err));
