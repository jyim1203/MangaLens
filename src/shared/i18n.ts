/**
 * `t()` — a thin, fail-soft wrapper over `browser.i18n.getMessage` (Phase 7
 * i18n scaffolding).
 *
 * WHY read the global instead of importing `webextension-polyfill`: pure logic
 * modules (e.g. `overlay/errorMessages.ts`) call `t()`, and importing the
 * polyfill drags in its import-time "must run in a browser extension" throw,
 * which would force every one of their node tests to mock the polyfill. Reading
 * `globalThis.browser`/`chrome` needs no import and simply returns the fallback
 * when the API isn't present (node tests), the same defensive posture as
 * `localeTargetLang` in settings.ts.
 *
 * WHY fallback-first: modules pass their real English string as the fallback, so
 * their existing tests keep asserting real text (not "key soup") even though the
 * i18n API is absent under vitest. In the built extension `browser.i18n` is a
 * native Firefox global and returns the localized message from
 * `_locales/<lang>/messages.json`.
 */

/** Substitutions accepted by `browser.i18n.getMessage` (one string or a list). */
export type Substitutions = string | readonly string[];

/** The minimal `i18n.getMessage` surface we call. */
interface I18nApi {
  getMessage(key: string, substitutions?: Substitutions): string;
}

/** Find the platform i18n API without importing the polyfill (see module WHY). */
function resolveI18n(): I18nApi | undefined {
  const g = globalThis as {
    browser?: { i18n?: I18nApi };
    chrome?: { i18n?: I18nApi };
  };
  return g.browser?.i18n ?? g.chrome?.i18n;
}

/**
 * Look up a localized message by key, falling back safely.
 *
 * @param key the `messages.json` key.
 * @param substitutions optional placeholder substitutions passed through to the
 *   platform API.
 * @param fallback returned when the API is unavailable (node tests) or the key
 *   resolves to an empty string (missing/untranslated). When omitted, the `key`
 *   itself is returned so a missing string is at least identifiable.
 * @returns the localized message, or `fallback ?? key`.
 */
export function t(
  key: string,
  substitutions?: Substitutions,
  fallback?: string,
): string {
  try {
    const i18n = resolveI18n();
    if (i18n) {
      const message = i18n.getMessage(key, substitutions);
      // getMessage returns "" for an unknown key — treat that as "no translation".
      if (message) return message;
    }
  } catch {
    // API present but threw (very defensive) — fall through to the fallback.
  }
  return fallback ?? key;
}
