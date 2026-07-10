/**
 * Settings schema, defaults, load/save, and migration (gap resolution #5).
 *
 * All user configuration lives in `browser.storage.local` under a single key
 * (never `storage.sync` — it would leak API keys across devices, §7.6). Reads
 * always run stored data through {@link migrateSettings} + {@link mergeSettings}
 * so older or partial blobs are healed into a complete, current-version object.
 *
 * The pure functions (merge / migrate / effective-enabled / derive) carry all
 * the logic and are unit-tested without a browser; {@link loadSettings} and
 * {@link saveSettings} are thin storage wrappers.
 */
import browser from "webextension-polyfill";
import { isPlainObject } from "./guards";
import type { LogLevel } from "./log";
import type { ProviderId, ProviderSettings } from "./types";
import { PROVIDER_IDS } from "./types";

/** storage.local key holding the settings blob. */
export const SETTINGS_KEY = "mangalens:settings";

/**
 * A recursively-optional view of a type: every field (and nested field) may be
 * omitted. Used for update patches so a caller can send just
 * `{ font: { color } }` — which {@link mergeSettings} merges one level deep —
 * without the type demanding a whole {@link FontSettings}.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * The patch type accepted by {@link saveSettings} / the `setSettings` message.
 *
 * Identical to `DeepPartial<Settings>` except that entries in the OPEN-KEYED
 * records ({@link Settings.perSiteOverrides}, {@link Settings.apiKeys},
 * {@link Settings.models}) may be `null`, meaning **delete this entry**.
 * WHY: the one-level merge can only add/overwrite keys, so without a delete
 * sentinel there would be no way to remove a per-site override or wipe a
 * stored API key — both are user-data-removal paths we must support (§7.6).
 * `null` is never persisted; {@link mergeSettings} strips it.
 */
export type SettingsPatch = Omit<
  DeepPartial<Settings>,
  "perSiteOverrides" | "apiKeys" | "models"
> & {
  perSiteOverrides?: Record<string, boolean | null>;
  apiKeys?: Partial<Record<ProviderId, string | null>>;
  models?: Partial<Record<ProviderId, string | null>>;
};

/**
 * The open-keyed record fields, where keys are user data (hostnames,
 * providers) rather than schema: `null` deletes the entry. In fixed-shape
 * nested objects (`font`) a `null` is corrupt data and heals to the base
 * value instead.
 */
const OPEN_RECORD_KEYS: ReadonlySet<keyof Settings> = new Set([
  "perSiteOverrides",
  "apiKeys",
  "models",
]);

/**
 * Bump when the {@link Settings} shape changes in a way that needs data
 * transformation (not just a new field with a default — those are handled by
 * merge). Each increment gets a step in {@link migrateSettings}.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** How overlay text is sized and styled (F5). */
export interface FontSettings {
  /** CSS font-family stack. */
  family: string;
  /** `auto` = binary-search fit to bbox (textFit.ts); `fixed` = always fixedSizePx. */
  sizeMode: "auto" | "fixed";
  /** Font size used when `sizeMode: "fixed"`. */
  fixedSizePx: number;
  /** Lower/upper bounds for `auto` fitting. */
  minSizePx: number;
  maxSizePx: number;
  /** Text color (any CSS color). */
  color: string;
  /** Draw a contrasting stroke/outline behind glyphs for readability over art. */
  stroke: boolean;
  strokeColor: string;
  /** Bubble fill behind text: color + opacity (0–1). */
  bubbleFillColor: string;
  bubbleFillOpacity: number;
}

/**
 * The complete user configuration. Everything is global except
 * {@link perSiteOverrides}, which lets a hostname opt in/out regardless of the
 * global {@link enabled} flag (F1/F15). Resolve the two with
 * {@link getEffectiveEnabled}.
 */
export interface Settings {
  /** Present so {@link migrateSettings} can detect and upgrade old blobs. */
  schemaVersion: number;

  // --- Activation (F1, gap resolution #7: inert-by-default) ---
  /** Global master switch. When false, the content script stays fully inert. */
  enabled: boolean;
  /**
   * Per-hostname override of {@link enabled}. `true` forces on, `false` forces
   * off; absent = follow the global flag. Keyed by bare hostname (no scheme).
   */
  perSiteOverrides: Record<string, boolean>;

  // --- Provider / BYOK (F2) ---
  provider: ProviderId;
  /** Per-provider API keys, so switching providers doesn't lose a key. Local-only. */
  apiKeys: Partial<Record<ProviderId, string>>;
  /** Per-provider selected model id, so switching providers keeps each choice. */
  models: Partial<Record<ProviderId, string>>;
  /** Base URL used when `provider: "custom"`. */
  customEndpoint: string;

  // --- Translation (F9/F11/F19) ---
  /** Target language (ISO 639-1). Defaulted from browser locale at first load. */
  targetLang: string;
  /** Pinned source language, or "auto" to let the model detect (F11). */
  sourceLang: string;
  /** Keep honorifics in output. */
  preserveHonorifics: boolean;
  /** Translate SFX/onomatopoeia rather than skipping them (F19, default skip). */
  translateSfx: boolean;
  /** Sampling temperature (PROMPTS.md §1). */
  temperature: number;

  // --- Rendering (F5) ---
  font: FontSettings;

  // --- Performance / cost (F7/F12, §11 defaults) ---
  /** Max in-flight provider requests. */
  concurrency: number;
  /** How many pages ahead to prefetch when one becomes visible. */
  prefetchAhead: number;
  /** Downscale target: longest image edge in px before sending. */
  maxImageEdgePx: number;
  /** JPEG quality 0–1 for the sent image. */
  jpegQuality: number;
  /** Pages batched per provider request, 1–4 (F12). */
  pagesPerRequest: number;
  /** IndexedDB cache size cap in MB (F13). */
  cacheCapMb: number;

  // --- Misc ---
  /** Manga reading direction, affects bubble ordering (F18). */
  readingDirection: "rtl" | "ltr" | "auto";
  /** Hidden debug knob for the leveled logger. */
  logLevel?: LogLevel;
}

/**
 * Canonical defaults (Architecture §11). {@link targetLang} is a placeholder
 * here; {@link loadSettings} fills it from the browser locale on first run so
 * this object stays a pure constant (no browser calls at module load).
 */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,

  enabled: false,
  perSiteOverrides: {},

  provider: "gemini",
  apiKeys: {},
  models: {},
  customEndpoint: "",

  targetLang: "en",
  sourceLang: "auto",
  preserveHonorifics: true,
  translateSfx: false,
  temperature: 0.25,

  font: {
    family: "system-ui, sans-serif",
    sizeMode: "auto",
    fixedSizePx: 16,
    minSizePx: 10,
    maxSizePx: 28,
    color: "#111111",
    stroke: true,
    strokeColor: "#ffffff",
    bubbleFillColor: "#ffffff",
    bubbleFillOpacity: 0.92,
  },

  concurrency: 6,
  prefetchAhead: 3,
  maxImageEdgePx: 1200,
  jpegQuality: 0.7,
  pagesPerRequest: 1,
  cacheCapMb: 200,

  readingDirection: "auto",
};

/**
 * Deep-merge a stored (possibly partial) settings blob onto the defaults.
 *
 * WHY not a spread: `font` is a nested object; a shallow spread of a partial
 * `{ font: { color } }` would drop every other font field. We merge nested
 * plain objects one level deep (which covers `font`, `apiKeys`, `models`,
 * `perSiteOverrides`) and take scalars/arrays from the stored value when
 * present. Unknown keys in `stored` are ignored.
 *
 * Pure and browser-free — this is the unit-tested core of settings loading.
 */
export function mergeSettings(
  defaults: Settings,
  stored: unknown,
): Settings {
  if (!isPlainObject(stored)) return { ...defaults, font: { ...defaults.font } };

  const out: Settings = { ...defaults, font: { ...defaults.font } };

  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (!(key in stored)) continue;
    const incoming = stored[key];
    // Top-level null is never valid — treat like undefined (heals corrupt blobs).
    if (incoming === undefined || incoming === null) continue;

    const base = defaults[key];
    if (isPlainObject(base) && isPlainObject(incoming)) {
      // One-level nested merge (font, apiKeys, models, perSiteOverrides).
      const merged: Record<string, unknown> = { ...base, ...incoming };
      for (const k of Object.keys(merged)) {
        if (merged[k] !== null) continue;
        if (OPEN_RECORD_KEYS.has(key)) {
          // `null` in an open-keyed record = delete the entry (SettingsPatch).
          delete merged[k];
        } else {
          // `null` in a fixed-shape object (font) is corrupt — heal from base.
          merged[k] = (base as Record<string, unknown>)[k];
        }
      }
      (out[key] as Record<string, unknown>) = merged;
    } else {
      (out[key] as unknown) = incoming;
    }
  }

  return out;
}

/**
 * Bring any raw stored value up to the current schema, then merge onto
 * defaults. Returns the healed settings and whether anything changed (so the
 * caller can decide whether to re-persist).
 *
 * WHY a version switch with fallthrough: each future schema bump adds one
 * `case` that transforms the blob in place; `mergeSettings` afterward supplies
 * any brand-new fields from defaults, so migrations only handle real
 * *transformations* (renames, reshapes), never plain additions.
 */
export function migrateSettings(raw: unknown): {
  settings: Settings;
  changed: boolean;
} {
  if (!isPlainObject(raw)) {
    // Nothing stored (or corrupt) → pristine defaults, mark changed so we persist.
    return { settings: mergeSettings(DEFAULT_SETTINGS, {}), changed: true };
  }

  const fromVersion =
    typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
  const working: Record<string, unknown> = { ...raw };
  const changed = fromVersion !== SETTINGS_SCHEMA_VERSION;

  // Migration ladder: each `if (fromVersion < N)` transforms the blob up to vN.
  // v0 (pre-versioning / unknown) → v1 needs no data transform — new fields are
  // supplied by mergeSettings below — so we only stamp the version. Add further
  // steps here as the schema grows.
  if (fromVersion < 1) {
    working.schemaVersion = 1;
  }

  const settings = mergeSettings(DEFAULT_SETTINGS, working);
  return { settings, changed };
}

/**
 * Resolve whether MangaLens is active for a given hostname, combining the
 * global {@link Settings.enabled} flag with any per-site override (F1/F15,
 * gap resolution #7). A per-site value always wins over the global flag.
 *
 * @param hostname bare hostname, e.g. `location.hostname` ("reader.example.com").
 */
export function getEffectiveEnabled(
  settings: Settings,
  hostname: string,
): boolean {
  const override = settings.perSiteOverrides[hostname];
  if (typeof override === "boolean") return override;
  return settings.enabled;
}

/**
 * Extract the provider-facing slice a {@link import("./types").Translator}
 * needs, picking the active provider's key/model. Keeps the providers/ layer
 * decoupled from the full settings object.
 */
export function deriveProviderSettings(settings: Settings): ProviderSettings {
  const provider = settings.provider;
  return {
    provider,
    apiKey: settings.apiKeys[provider] ?? "",
    model: settings.models[provider] ?? "",
    customEndpoint: settings.customEndpoint || undefined,
    targetLang: settings.targetLang,
    sourceLangHint:
      settings.sourceLang && settings.sourceLang !== "auto"
        ? settings.sourceLang
        : undefined,
    readingDirection: settings.readingDirection,
    preserveHonorifics: settings.preserveHonorifics,
    translateSfx: settings.translateSfx,
    temperature: settings.temperature,
  };
}

/** Best-effort ISO 639-1 target language from the browser UI locale. */
function localeTargetLang(): string {
  // WHY split on "-": browser.i18n.getUILanguage() returns tags like "en-US";
  // we only key on the primary subtag.
  try {
    const ui = browser.i18n?.getUILanguage?.();
    if (ui) return ui.split("-")[0] || DEFAULT_SETTINGS.targetLang;
  } catch {
    // i18n not available in some test contexts — fall through to default.
  }
  return DEFAULT_SETTINGS.targetLang;
}

/**
 * Load settings from storage, migrating/merging as needed. On first run (no
 * stored blob) the target language is seeded from the browser locale and the
 * result is persisted so subsequent loads are stable.
 */
export async function loadSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const isFirstRun = raw === undefined;

  const { settings, changed } = migrateSettings(raw);

  if (isFirstRun) {
    settings.targetLang = localeTargetLang();
  }

  if (changed || isFirstRun) {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  return settings;
}

/**
 * Read the current settings WITHOUT ever writing storage — for contexts that
 * must not be a settings write path (the popup and options pages render from
 * this and send all writes through the background's `setSettings`, keeping the
 * Phase 1.1 single-write-path invariant; the content script has its own copy
 * of this pattern). Unlike {@link loadSettings} this never persists the healed
 * blob or seeds the first-run locale — the background does that on its first
 * real load.
 */
export async function peekSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return migrateSettings(raw).settings;
}

/**
 * Merge a partial update into the stored settings and persist. Returns the full
 * updated settings. Nested objects in `patch` (e.g. `{ font: {...} }`) are
 * merged onto existing values, not replaced wholesale. A `null` entry in
 * `perSiteOverrides` / `apiKeys` / `models` deletes that entry (see
 * {@link SettingsPatch}).
 */
export async function saveSettings(
  patch: SettingsPatch,
): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings(current, patch as unknown);
  next.schemaVersion = SETTINGS_SCHEMA_VERSION;
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Known provider ids as a Set for O(1) validation (e.g. options page). */
export const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set(PROVIDER_IDS);
