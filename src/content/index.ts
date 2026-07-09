/**
 * Content script entry point.
 *
 * WHY inert-by-default: this script is injected on <all_urls>, so until the
 * user has enabled MangaLens (globally + for this site), it must do nothing
 * observable — no DOM mutation, no fetches, no observers. The enable gate
 * arrives with settings in Phase 1; for Phase 0 this only proves the
 * content ⇄ background message channel works.
 */
import { createLogger } from "../shared/log";
import { sendToBackground } from "../shared/messages";

const log = createLogger("content");

async function main(): Promise<void> {
  try {
    const reply = await sendToBackground("ping");
    log.debug("background reachable:", reply.ok);
  } catch (err) {
    // Fail soft (handoff rule 6): never let extension errors reach the page.
    log.warn("background not reachable", err);
  }
}

void main();
