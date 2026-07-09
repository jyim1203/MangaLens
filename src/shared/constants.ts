/**
 * Global constants shared across background, content, popup, and options.
 * Keep this file dependency-free (imported everywhere, including tests).
 */

/** Extension display name, used in logs and UI. */
export const EXTENSION_NAME = "MangaLens";

/**
 * Bumped whenever prompt text in providers/prompt.ts changes in a way that
 * affects output. Part of the translation cache key so stale translations
 * are never served after a prompt change. (Gap resolution #4 — see docs.)
 */
export const PROMPT_VERSION = 1;

/** Keyboard command id from manifest.json — keep in sync with src/manifest.ts. */
export const CMD_TOGGLE = "toggle-mangalens";
