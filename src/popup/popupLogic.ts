/**
 * Pure decision logic for the toolbar popup (Phase 6) — every choice the popup
 * makes lives here, browser-free and unit-tested; `main.ts` is the thin DOM
 * shell that renders these decisions.
 */
import type { CostStats } from "../background/costTracker";
import { formatUsd } from "../shared/format";
import {
  deriveProviderSettings,
  getEffectiveEnabled,
  type Settings,
  type SettingsPatch,
} from "../shared/settings";

/** The tri-state of the per-site override control (F15). */
export type SiteChoice = "default" | "on" | "off";

/** Read the current per-site choice for a hostname from settings. */
export function siteChoice(settings: Settings, hostname: string): SiteChoice {
  const override = settings.perSiteOverrides[hostname];
  if (override === true) return "on";
  if (override === false) return "off";
  return "default";
}

/**
 * Build the settings patch for a site-choice selection. "default" DELETES the
 * override (the `null` sentinel, see {@link SettingsPatch}) so the site
 * follows the global flag again.
 */
export function siteChoicePatch(
  hostname: string,
  choice: SiteChoice,
): SettingsPatch {
  return {
    perSiteOverrides: {
      [hostname]: choice === "default" ? null : choice === "on",
    },
  };
}

/**
 * Hostname of a tab URL the extension can actually run on. Only http/https
 * pages have a content script that can scan (about:, moz-extension:, file
 * pickers etc. don't) — returns undefined for those so the popup disables the
 * site controls instead of writing a meaningless override.
 */
export function hostnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/** One-line status of what MangaLens is doing on the current page. */
export function statusLine(
  settings: Settings,
  hostname: string | undefined,
): string {
  if (!hostname) return "Not available on this page.";
  const active = getEffectiveEnabled(settings, hostname);
  const overridden = typeof settings.perSiteOverrides[hostname] === "boolean";
  if (active) {
    return overridden ? `Active on ${hostname} (site rule).` : "Active on this page.";
  }
  return overridden
    ? `Off on ${hostname} (site rule).`
    : "Off — flip the switch to translate.";
}

/** True when the active provider has no stored API key (drives the setup banner). */
export function needsApiKey(settings: Settings): boolean {
  return deriveProviderSettings(settings).apiKey.trim() === "";
}

/** Total provider image requests across all providers (F17). */
export function totalImages(stats: CostStats): number {
  return Object.values(stats.byProvider).reduce(
    (sum, p) => sum + (p?.images ?? 0),
    0,
  );
}

/** The popup's one-line usage summary, e.g. "≈ $0.0042 · 17 images". */
export function costSummary(stats: CostStats): string {
  return `≈ ${formatUsd(stats.totalEstCostUsd)} · ${totalImages(stats)} images`;
}

/**
 * Whether the "Select region" button (F10 drag-select, Phase 7) should be
 * enabled: only when MangaLens is effectively active on the current page (the
 * content script has a live region selector to enter). Same gate as
 * translate-all. Pure.
 */
export function regionSelectEnabled(
  settings: Settings,
  hostname: string | undefined,
): boolean {
  return hostname ? getEffectiveEnabled(settings, hostname) : false;
}

/**
 * Above this many pages, "translate all" asks for confirmation first
 * (Architecture §10 Risks: cost surprises).
 */
export const TRANSLATE_ALL_CONFIRM_THRESHOLD = 30;

/** What the translate-all button should do for a dry-run count. */
export type TranslateAllAction = "none" | "confirm" | "run";

/**
 * Decide the translate-all flow from the dry-run count: nothing to do, run
 * immediately, or show the inline confirm step first (WHY inline rather than
 * `window.confirm`: modal dialogs from a browser-action popup are unreliable
 * in Firefox — the popup can lose focus and close).
 */
export function planTranslateAll(count: number): TranslateAllAction {
  if (count <= 0) return "none";
  return count > TRANSLATE_ALL_CONFIRM_THRESHOLD ? "confirm" : "run";
}
