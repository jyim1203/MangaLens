/**
 * The pure core of the popup/options `data-i18n` walker (Phase 8 §8 — the
 * deferred UI-string i18n migration). The DOM walk itself is a thin shell in each
 * page's `main.ts`; the key→text decision lives here so it's unit-testable
 * without a DOM.
 *
 * Each target pairs a message key with the element's CURRENT English text as the
 * fallback, so a missing/untranslated key (or the API being absent, as in node
 * tests) leaves the real English wording in place — never `__MSG_…__` soup and
 * never an empty node.
 */
import { t } from "./i18n";

/** One element to localize: its `data-i18n` key plus its English fallback text. */
export interface I18nTarget {
  key: string;
  /** The element's current text, used as the fallback (see module doc). */
  fallback: string;
}

/**
 * Resolve each target's localized text (pure over {@link t}). Result[i]
 * corresponds to targets[i]. A key that resolves to nothing keeps its `fallback`.
 */
export function resolveI18n(targets: readonly I18nTarget[]): string[] {
  return targets.map((target) => t(target.key, undefined, target.fallback));
}
