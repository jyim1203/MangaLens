/**
 * The enable-gate reducer (handoff item 1). A PURE function that classifies what
 * the content script should do when settings change, so idempotence (enable
 * twice = enable once) and the restyle-vs-re-request-vs-no-op distinction are
 * unit-testable without any DOM. The thin shell (`content/index.ts`) reads
 * settings from `storage.local`, calls this, and dispatches the action.
 *
 * WHY a storage read (not messaging) drives this: a `storage.local` read does
 * NOT wake the background event page, whereas `sendMessage` would — and this runs
 * on every page the user visits. See `content/index.ts`.
 */
import {
  deriveProviderSettings,
  getAutoTranslate,
  getEffectiveEnabled,
  type Settings,
} from "../shared/settings";

/**
 * What the shell should do in response to a settings snapshot:
 *  - `activate` — was inactive, now enabled: start scanner/queue/overlays.
 *  - `deactivate` — was active, now disabled: total teardown.
 *  - `restyle` — still active, only font/SFX changed: re-render overlays in place.
 *  - `re-request` — still active, a translation-affecting setting changed: clear
 *    overlays and let the viewport queue re-request (cache makes this cheap).
 *  - `no-op` — nothing actionable changed (or stayed disabled).
 */
export type GateAction =
  | "activate"
  | "deactivate"
  | "restyle"
  | "re-request"
  | "no-op";

/** The gate's memory between settings snapshots. */
export interface GateState {
  /** Whether overlays/observers are currently running. */
  active: boolean;
  /** The settings last applied while active (undefined before first activate). */
  settings?: Settings;
}

/**
 * Fields whose change means existing overlays are stale and must be re-requested.
 * Derived via {@link deriveProviderSettings} so this stays in lockstep with the
 * provider slice.
 *
 * WHY `apiKey` is INCLUDED even though it is NOT part of the cache key: the key
 * is deliberately key-agnostic so a produced translation survives a key change
 * (cache-cheap for successes — a previously-translated page re-renders instantly
 * from cache). But after an `auth` error every candidate sits at `requested:true`
 * with a ⚠ badge, and re-requesting is the ONLY recovery path — entering a
 * correct key must reclassify as `re-request` (full teardown/re-activate) so
 * errored pages actually retry while cached successes re-render for free. Without
 * this, the first-run flow (Phase 6: see auth badges → paste key → nothing
 * happens) is broken. `temperature` stays excluded (a continuous knob, also
 * excluded from the cache key).
 */
function translationSignature(s: Settings): string {
  const p = deriveProviderSettings(s);
  return JSON.stringify([
    p.provider,
    p.model,
    p.customEndpoint ?? "",
    p.targetLang,
    p.sourceLangHint ?? "",
    p.readingDirection,
    p.preserveHonorifics,
    p.apiKey,
  ]);
}

/** Fields that only change *rendering* (re-drawn in place, no re-translation). */
function renderSignature(s: Settings): string {
  return JSON.stringify([s.font, s.translateSfx]);
}

/**
 * Classify the transition from `prev` to the new `settings` for `hostname`.
 * Pure — no side effects, no DOM.
 *
 * @param prev the gate's previous state.
 * @param settings the healed new settings snapshot.
 * @param hostname the current page hostname (per-site override resolution).
 * @returns the action the shell should perform.
 */
export function computeGateAction(
  prev: GateState,
  settings: Settings,
  hostname: string,
): GateAction {
  const enabled = getEffectiveEnabled(settings, hostname);

  if (!prev.active) {
    return enabled ? "activate" : "no-op";
  }
  // Currently active:
  if (!enabled) return "deactivate";

  const prevSettings = prev.settings;
  if (!prevSettings) return "no-op"; // defensive; active always carries settings

  // Auto-translate opt-in flip (Phase 7.2 item 3): the content script stays
  // active either way (effective-enabled didn't change — e.g. global flag ON,
  // per-site override added/removed), so without this an override flip that
  // toggles auto-sending would classify as a lesser action and the viewport
  // queue would keep its old observe/no-observe wiring. re-request rebuilds the
  // queue with the new `autoEnqueue` (index.ts reads getAutoTranslate on
  // activate). Fires in BOTH directions.
  if (getAutoTranslate(prevSettings, hostname) !== getAutoTranslate(settings, hostname)) {
    return "re-request";
  }

  if (translationSignature(prevSettings) !== translationSignature(settings)) {
    return "re-request";
  }
  if (renderSignature(prevSettings) !== renderSignature(settings)) {
    return "restyle";
  }
  return "no-op";
}

/**
 * The active flag implied by an action, given the previous flag. Keeps the shell
 * from re-deriving activation state (and keeps that logic testable).
 */
export function activeAfter(action: GateAction, prevActive: boolean): boolean {
  switch (action) {
    case "activate":
    case "re-request":
      return true;
    case "deactivate":
      return false;
    case "restyle":
    case "no-op":
      return prevActive;
  }
}
