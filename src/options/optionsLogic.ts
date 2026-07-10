/**
 * Pure decision logic for the options page (Phase 6): numeric-field
 * validation, key masking, hostname normalization for per-site rules, patch
 * builders, and display formatting. Browser-free and unit-tested; `main.ts`
 * is the thin DOM shell.
 */
import type { CostStats, ProviderCostStats } from "../background/costTracker";
import type { SettingsPatch, Settings } from "../shared/settings";
import { PROVIDER_IDS, type ProviderId } from "../shared/types";

// --- Numeric fields ----------------------------------------------------------

/** Validation bounds for one numeric settings field. */
export interface NumericFieldSpec {
  min: number;
  max: number;
  /** Round to an integer (counts/pixels); floats keep 2 decimals. */
  integer?: boolean;
}

/**
 * Every numeric field the options form exposes, with its accepted range.
 * WHY explicit bounds: a typo'd `concurrency: 600` or `jpegQuality: 70`
 * (percent instead of fraction) would silently wreck performance or uploads;
 * clamping at the form edge keeps stored settings always-sane. Ranges are the
 * sensible envelopes around the §11 defaults.
 */
export const NUMERIC_FIELDS = {
  concurrency: { min: 1, max: 16, integer: true },
  prefetchAhead: { min: 0, max: 10, integer: true },
  maxImageEdgePx: { min: 480, max: 4096, integer: true },
  jpegQuality: { min: 0.3, max: 0.95 },
  pagesPerRequest: { min: 1, max: 4, integer: true },
  cacheCapMb: { min: 1, max: 4096, integer: true },
  temperature: { min: 0, max: 1 },
  fixedSizePx: { min: 6, max: 72, integer: true },
  minSizePx: { min: 6, max: 48, integer: true },
  maxSizePx: { min: 8, max: 96, integer: true },
  bubbleFillOpacity: { min: 0, max: 1 },
} as const satisfies Record<string, NumericFieldSpec>;

/** Ids of the numeric form fields. */
export type NumericFieldId = keyof typeof NUMERIC_FIELDS;

/**
 * Parse + clamp one numeric form value. Returns undefined for unparseable
 * input (empty, "abc") so the caller reverts the control to the stored value
 * instead of persisting garbage.
 */
export function parseNumericField(
  id: NumericFieldId,
  raw: string,
): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  const spec: NumericFieldSpec = NUMERIC_FIELDS[id];
  const clamped = Math.min(spec.max, Math.max(spec.min, n));
  return spec.integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/**
 * Read a numeric field's currently-stored value (the revert target for
 * garbage input).
 */
export function numericFieldValue(
  settings: Settings,
  id: NumericFieldId,
): number {
  switch (id) {
    case "fixedSizePx":
      return settings.font.fixedSizePx;
    case "minSizePx":
      return settings.font.minSizePx;
    case "maxSizePx":
      return settings.font.maxSizePx;
    case "bubbleFillOpacity":
      return settings.font.bubbleFillOpacity;
    default:
      return settings[id];
  }
}

/**
 * Build the settings patch for one numeric field. WHY an exhaustive switch
 * rather than a computed key: four of the fields live under `font`, and a
 * computed `{ [id]: value }` erases the key type so the patch would no longer
 * typecheck against {@link SettingsPatch}.
 */
export function numericFieldPatch(
  id: NumericFieldId,
  value: number,
): SettingsPatch {
  switch (id) {
    case "fixedSizePx":
      return { font: { fixedSizePx: value } };
    case "minSizePx":
      return { font: { minSizePx: value } };
    case "maxSizePx":
      return { font: { maxSizePx: value } };
    case "bubbleFillOpacity":
      return { font: { bubbleFillOpacity: value } };
    case "concurrency":
      return { concurrency: value };
    case "prefetchAhead":
      return { prefetchAhead: value };
    case "maxImageEdgePx":
      return { maxImageEdgePx: value };
    case "jpegQuality":
      return { jpegQuality: value };
    case "pagesPerRequest":
      return { pagesPerRequest: value };
    case "cacheCapMb":
      return { cacheCapMb: value };
    case "temperature":
      return { temperature: value };
  }
}

/**
 * Keep the auto-fit font bounds ordered (min ≤ max) after one of them changed:
 * the field the user just edited wins and drags the other along.
 */
export function sanitizeFontBounds(
  minSizePx: number,
  maxSizePx: number,
  changed: "min" | "max",
): { minSizePx: number; maxSizePx: number } {
  if (minSizePx <= maxSizePx) return { minSizePx, maxSizePx };
  return changed === "min"
    ? { minSizePx, maxSizePx: minSizePx }
    : { minSizePx: maxSizePx, maxSizePx };
}

// --- API keys ----------------------------------------------------------------

/**
 * Mask a stored API key for display: enough of the tail to recognize which
 * key it is, never enough to reconstruct it (§7.6). Empty stays empty (the
 * input shows its placeholder instead).
 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Patch storing (or, for empty input, deleting) one provider's API key. */
export function apiKeyPatch(provider: ProviderId, key: string): SettingsPatch {
  return { apiKeys: { [provider]: key.trim() || null } };
}

/** Patch storing (or, for empty input, deleting) one provider's model choice. */
export function modelPatch(provider: ProviderId, model: string): SettingsPatch {
  return { models: { [provider]: model.trim() || null } };
}

// --- Per-site rules (F15) ----------------------------------------------------

/**
 * Normalize user input into the bare hostname that keys
 * `Settings.perSiteOverrides` (must match `location.hostname` on the site).
 * Accepts a bare host ("Reader.Example.com"), a full URL, or host+path;
 * returns null for garbage so the form can reject it.
 */
export function normalizeHostname(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** Patch setting (true/false) or removing (null) one per-site rule. */
export function siteRulePatch(
  hostname: string,
  rule: boolean | null,
): SettingsPatch {
  return { perSiteOverrides: { [hostname]: rule } };
}

/** Per-site rules as sorted display rows. */
export function siteRuleRows(
  settings: Settings,
): { hostname: string; enabled: boolean }[] {
  return Object.entries(settings.perSiteOverrides)
    .map(([hostname, enabled]) => ({ hostname, enabled }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// --- Honorifics select (PROMPTS.md §3 slot ↔ boolean setting) -----------------

/** The options-page honorifics select value for the stored boolean. */
export function honorificsValue(settings: Settings): "keep" | "localize" {
  return settings.preserveHonorifics ? "keep" : "localize";
}

/** Patch for an honorifics select change. */
export function honorificsPatch(value: string): SettingsPatch {
  return { preserveHonorifics: value === "keep" };
}

// --- Usage table ---------------------------------------------------------------

/** One row of the F17 usage table. */
export interface CostRow extends ProviderCostStats {
  provider: ProviderId;
}

/** Usage stats as table rows, in provider display order, only providers used. */
export function costRows(stats: CostStats): CostRow[] {
  const rows: CostRow[] = [];
  for (const provider of PROVIDER_IDS) {
    const p = stats.byProvider[provider];
    if (p) rows.push({ provider, ...p });
  }
  return rows;
}
