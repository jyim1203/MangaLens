/**
 * Curated language names — the single source of truth for both the prompt
 * layer (which needs a human-readable name to drive translation quality,
 * PROMPTS.md §7) and the popup/options dropdowns (F9 target language, F11
 * source pin). Lives in shared/ because it crosses the background ⇄ UI
 * boundary; keep it dependency-free so any context can import it.
 *
 * Moved here from providers/prompt.ts in Phase 6 (prompt.ts re-exports
 * {@link languageName} so its public API is unchanged).
 */

/**
 * Code → English name for the languages users actually target/read, in
 * display order for the UI dropdowns. Region-tagged keys (`zh-tw`) get their
 * tag appended for disambiguation (PROMPTS.md §7: `zh-TW` → "Traditional
 * Chinese (zh-TW)"). Anything not here falls back to `Intl.DisplayNames`,
 * then to the raw code.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-tw": "Traditional Chinese",
  "zh-cn": "Simplified Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  ru: "Russian",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
  nl: "Dutch",
};

/**
 * Human-readable language name for a code, for the prompt and the UI. The
 * name drives translation quality; region tags (`zh-TW`) are preserved in
 * parentheses so the model disambiguates variants.
 *
 * @param code an ISO 639-1 code, optionally region-tagged (e.g. "en", "zh-TW").
 * @returns e.g. "English", "Traditional Chinese (zh-TW)".
 */
export function languageName(code: string): string {
  const key = code.toLowerCase();
  const exact = LANGUAGE_NAMES[key];
  if (exact) return key.includes("-") ? `${exact} (${code})` : exact;

  // Only reachable for region-tagged keys the exact lookup missed (a bare key
  // would have hit above), so the tag is always appended for disambiguation.
  const primary = key.split("-")[0] ?? key;
  const primaryName = LANGUAGE_NAMES[primary];
  if (primaryName) return `${primaryName} (${code})`;

  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== key) return name;
  } catch {
    // Intl.DisplayNames unavailable in some contexts — fall through.
  }
  return code;
}

/** One `<option>` for a language dropdown. */
export interface LanguageOption {
  code: string;
  name: string;
}

/**
 * The curated languages as dropdown options, in {@link LANGUAGE_NAMES}
 * display order.
 *
 * @param current a code to force-include (the user's stored value may not be
 *   in the curated list — e.g. seeded from an uncommon browser locale); it is
 *   appended if missing so the dropdown never silently shows the wrong value.
 */
export function languageOptions(current?: string): LanguageOption[] {
  const options = Object.keys(LANGUAGE_NAMES).map((code) => ({
    code,
    name: languageName(code),
  }));
  const cur = current?.toLowerCase();
  if (cur && !LANGUAGE_NAMES[cur]) {
    options.push({ code: current as string, name: languageName(cur) });
  }
  return options;
}
