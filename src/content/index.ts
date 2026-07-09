/**
 * Content script entry point.
 *
 * WHY inert-by-default: this script is injected on <all_urls>, so until the
 * user has enabled MangaLens (globally + for this site), it must do nothing
 * observable — no DOM mutation, no fetches, no observers, and (since 1.1) not
 * even a message to the background, because that would wake the event page on
 * every page the user visits.
 *
 * The enable gate lands in Phase 5. Implementation note for then: read
 * settings via `browser.storage.local` directly and watch `storage.onChanged`
 * (a storage read does NOT wake the event page, unlike sendMessage); the
 * `settingsChanged` broadcast then only serves already-active pages.
 */
import { createLogger } from "../shared/log";

const log = createLogger("content");

// Suppressed in prod builds (warn-threshold logger); dev-only liveness marker.
log.debug("content script loaded (inert until Phase 5 enable gate)");
