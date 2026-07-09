/**
 * Popup stub (Phase 0). Real UI (toggle, language, model, translate-all,
 * cost display) lands in Phase 6. For now it pings the background so the
 * Phase 0 acceptance criterion ("popup opens", wiring works) is verifiable.
 */
import browser from "webextension-polyfill";

const statusEl = document.getElementById("status");

async function main(): Promise<void> {
  if (!statusEl) return;
  try {
    await browser.runtime.sendMessage({ type: "ping" });
    statusEl.textContent = "Background connected. Scaffold OK (Phase 0).";
  } catch {
    statusEl.textContent = "Background unreachable — check the console.";
  }
}

void main();
