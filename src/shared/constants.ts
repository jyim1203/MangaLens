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

/**
 * Bumped whenever the {@link import("./types").PageTranslation} shape stored in
 * the IndexedDB cache (F13) changes structurally. It names the object store's
 * database (`background/cache.ts`), so an increment starts a fresh store and old
 * records are never read back with a mismatched schema. WHY separate from
 * {@link PROMPT_VERSION}: prompt changes invalidate individual entries (they are
 * folded into each cache KEY), whereas a value-shape change must retire the whole
 * database at once.
 *
 * v2 (Phase 4.1 item 6): added the `meta` object store holding a running
 * `totalBytes`, so eviction no longer deserializes the whole store on every
 * write. Old `mangalens-cache-v1` databases are swept on first open (item 8).
 */
export const CACHE_VERSION = 2;

/** Keyboard command id from manifest.json — keep in sync with src/manifest.ts. */
export const CMD_TOGGLE = "toggle-mangalens";

/**
 * The attribute the {@link import("../content/overlay/OverlayManager").OverlayManager}
 * stamps on every overlay HOST element. Lives here (dependency-free) so the
 * scanner can recognise our own hosts and skip the `style` mutations the overlay
 * writes on every scroll/resize sync — otherwise scrolling would drive an endless
 * self-triggered re-scan (Phase 5.1 item 4). Host children live in a shadow root,
 * so only the host itself is ever visible to the page-level MutationObserver.
 */
export const OVERLAY_HOST_ATTR = "data-mangalens-overlay";
