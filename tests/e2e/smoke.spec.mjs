/**
 * e2e smoke suite (Phase 8 §6) — the two Architecture acceptance criteria plus
 * the batching scenario, driven against a real Firefox with the built extension
 * temporarily installed and the dependency-free mock provider (mockProvider.mjs).
 *
 * DRIVER: selenium-webdriver + geckodriver. `installAddon(path, temporary=true)`
 * is first-class in geckodriver, and the internal UUID is PINNED via the
 * `extensions.webextensions.uuids` pref set BEFORE install so `moz-extension://…`
 * page URLs are known to the test (the handoff's preferred approach; Playwright's
 * Firefox build does not reliably support extensions).
 *
 * HOW TO RUN (excluded from `npm run check` — the unit config only globs
 * tests/unit):
 *   1) npm install --no-save selenium-webdriver geckodriver
 *   2) npm run test:e2e        # vite build → node --test tests/e2e/smoke.spec.mjs
 *   Env: MOCK_LATENCY_MS (default 2000 — the acceptance latency),
 *        E2E_PERF_BUDGET_MS (default 5000), E2E_HEADLESS=0 to watch it,
 *        E2E_FIREFOX_BIN to point at a specific Firefox binary.
 *
 * Assertions are on OBSERVABLE behavior only — the DOM (overlay hosts carry
 * OVERLAY_HOST_ATTR on document.body; painted bubbles are `.mangalens-bubble`
 * inside each host's shadow root) and the mock's request log (`GET /stats`) —
 * never on extension internals (handoff rule 9).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startMockProvider } from "./mockProvider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ZIP = resolve(HERE, "../../web-ext-artifacts/mangalens-0.1.0.zip");
const ADDON_ID = "mangalens@mangalens.dev";
const PINNED_UUID = "d3adbeef-0000-4000-8000-000000000001";
const OVERLAY_HOST_ATTR = "data-mangalens-overlay";
const PERF_BUDGET_MS = Number(process.env.E2E_PERF_BUDGET_MS ?? 5000);
const PAGE_COUNT = 10;

let mock;
let driver;
let By, until, firefox, Builder;

/** moz-extension:// URL of one of the extension's pages, via the pinned UUID. */
const extUrl = (path) => `moz-extension://${PINNED_UUID}/${path}`;

/** Count overlay hosts that have PAINTED bubbles (the "done" state), via DOM. */
async function paintedOverlayCount() {
  return driver.executeScript(
    `const hosts = document.querySelectorAll('[${OVERLAY_HOST_ATTR}]');
     let painted = 0;
     for (const h of hosts) {
       if (h.shadowRoot && h.shadowRoot.querySelector('.mangalens-bubble')) painted++;
     }
     return painted;`,
  );
}

/** Total overlay hosts on <body>, painted or not. */
async function overlayHostCount() {
  return driver.executeScript(
    `return document.querySelectorAll('[${OVERLAY_HOST_ATTR}]').length;`,
  );
}

/** Poll until `fn()` returns >= `target` or the budget elapses; returns elapsed ms. */
async function waitForCount(fn, target, budgetMs) {
  const start = Date.now();
  for (;;) {
    if ((await fn()) >= target) return Date.now() - start;
    if (Date.now() - start > budgetMs) return Infinity;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function mockStats() {
  return (await fetch(`${mock.baseUrl}/stats`)).json();
}
async function resetMockStats() {
  await fetch(`${mock.baseUrl}/reset`, { method: "POST" });
}

/**
 * Seed settings through the extension's OWN storage from an extension page
 * context (a permitted driver-capability seed, handoff rule 9 — NOT a prod
 * message path): custom provider → the mock endpoint, a key, per-site auto-on for
 * the fixture host, and `pagesPerRequest`.
 */
async function seedSettings({ pagesPerRequest, autoSite = true, prefetchAhead }) {
  await driver.get(extUrl("src/options/index.html"));
  await driver.executeAsyncScript(
    `const [endpoint, pagesPerRequest, autoSite, prefetchAhead, done] = arguments;
     browser.storage.local.get('mangalens:settings').then((cur) => {
       const prev = cur['mangalens:settings'] || {};
       const overrides = Object.assign({}, prev.perSiteOverrides);
       // Auto site → the per-site opt-in (auto-translate on scroll). Non-auto →
       // active (content script + Translate all work) but NOTHING is auto-sent on
       // load, so a translate-all count is clean (§3 Scenario B).
       if (autoSite) overrides['127.0.0.1'] = true; else delete overrides['127.0.0.1'];
       const patch = {
         enabled: true,
         provider: 'custom',
         customEndpoint: endpoint,
         apiKeys: Object.assign({}, prev.apiKeys, { custom: 'mock-key' }),
         targetLang: 'en',
         pagesPerRequest,
         perSiteOverrides: overrides,
       };
       // §6: a large prefetchAhead makes page 1 becoming visible enqueue ALL pages
       // at once, so the perf scenario paints all 10 in ~two concurrency-6 waves
       // WITHOUT scrolling (a real, user-configurable value — not a test hook).
       if (typeof prefetchAhead === 'number') patch.prefetchAhead = prefetchAhead;
       return browser.storage.local.set({ 'mangalens:settings': Object.assign({ version: 1 }, prev, patch) });
     }).then(() => done(), () => done());`,
    `${mock.baseUrl}/v1`,
    pagesPerRequest,
    autoSite,
    typeof prefetchAhead === "number" ? prefetchAhead : null,
  );
}

/**
 * Grant the optional `<all_urls>` host permission via a real driver click on the
 * options "Grant" button — a Marionette click IS the trusted user gesture
 * `permissions.request` needs (handoff §6). Auto-accepts the doorhanger.
 */
async function grantHostPermission() {
  await driver.get(extUrl("src/options/index.html"));
  // A TEMPORARY install auto-grants <all_urls>, so the "Grant" button never appears
  // (it stays hidden) — clicking it would throw ElementNotInteractableError. Ask the
  // page directly and skip the click when the permission is already held (§2).
  const alreadyGranted = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     browser.permissions.contains({ origins: ["<all_urls>"] }).then(
       (granted) => done(granted),
       () => done(false),
     );`,
  );
  if (alreadyGranted) return;
  // A non-auto-granting install mode: drive the real user gesture. The button
  // starts `hidden` in the static HTML and is revealed async, so wait for
  // VISIBILITY (not mere presence), then click — a Marionette click IS the trusted
  // gesture `permissions.request` needs; the doorhanger is auto-accepted via the
  // `extensions.webextensions.prompts` pref set before install.
  const grant = await driver.wait(until.elementLocated(By.id("grant-perm")), 5000);
  await driver.wait(until.elementIsVisible(grant), 5000);
  await grant.click();
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Send `translateAll` to the chapter tab from a SECOND, privileged extension tab,
 * keeping the chapter tab ALIVE (§3). WHY not the popup: driving a browser-action
 * popup headless is unreliable; WHY not the chapter tab itself: navigating it to an
 * extension page destroys it, so `tabs.query` finds nothing and the send hangs. The
 * caller must have already navigated the current tab to the chapter. Returns to the
 * chapter tab before resolving; returns the content response string (diagnostics).
 *
 * WHY translate-all for the perf acceptance (not visibility): a headless viewport
 * over 800×1200 pages only ever brings ~4 pages into view/near/prefetch without
 * scrolling, and pages register progressively so a large `prefetchAhead` still
 * can't reach pages that don't exist in the list when page 1 first intersects.
 * Translate-all enqueues ALL 10 at once → the intended ~two concurrency-6 waves.
 */
async function translateAllOnChapter() {
  const chapterHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  await driver.get(extUrl("src/options/index.html"));
  const res = await driver.executeAsyncScript(
    `const [chapterUrl, done] = arguments;
     browser.tabs.query({}).then((tabs) => {
       const tab = tabs.find((t) => t.url && t.url.includes('/chapter.html'));
       if (!tab) { done('NO TAB'); return; }   // fail fast, don't hang the script
       return browser.tabs
         .sendMessage(tab.id, { type: 'translateAll', payload: { dryRun: false } })
         .then((r) => done('SENT:' + JSON.stringify(r)), (e) => done('SEND ERR:' + e));
     }, (e) => done('QUERY ERR:' + e));`,
    `${mock.baseUrl}/chapter.html`,
  );
  await driver.close();
  await driver.switchTo().window(chapterHandle);
  return res;
}

before(async () => {
  // Lazy import so the file loads (and `node --test` reports a clear skip) even
  // when the optional selenium deps aren't installed.
  ({ Builder, By, until } = await import("selenium-webdriver"));
  firefox = (await import("selenium-webdriver/firefox.js")).default;

  mock = await startMockProvider(0);

  const options = new firefox.Options();
  if (process.env.E2E_HEADLESS !== "0") options.addArguments("-headless");
  if (process.env.E2E_FIREFOX_BIN) options.setBinary(process.env.E2E_FIREFOX_BIN);
  // Pin the extension's UUID so moz-extension:// URLs are deterministic.
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({ [ADDON_ID]: PINNED_UUID }),
  );
  // Auto-accept optional-permission prompts so the grant click doesn't hang.
  options.setPreference("extensions.webextensions.prompts", false);
  options.setPreference("xpinstall.signatures.required", false);

  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  await driver.installAddon(DIST_ZIP, true);
});

after(async () => {
  await driver?.quit();
  await mock?.close();
});

test("Scenario A — 10-page chapter paints all overlays < 5 s (cold), instant on warm reload", async () => {
  await seedSettings({ pagesPerRequest: 1 });
  await grantHostPermission();
  await resetMockStats();

  // COLD: navigate, let the scanner register all pages, then translate them ALL at
  // once and measure to all 10 painted. WHY translate-all not scroll: a headless
  // viewport can't bring pages 5–10 into view without scrolling, so the acceptance
  // is measured on the translate-all path (all 10 enqueued → ~two concurrency-6
  // waves at 2 s latency ≈ 4 s + overhead; budget 5 s, env-configurable for slow CI).
  await driver.get(`${mock.baseUrl}/chapter.html`);
  await new Promise((r) => setTimeout(r, 1500));
  const sent = await translateAllOnChapter();
  assert.match(String(sent), /^SENT:/, `cold translateAll not delivered: ${sent}`);
  const coldStart = Date.now();
  const painted = await waitForCount(paintedOverlayCount, PAGE_COUNT, PERF_BUDGET_MS);
  const coldMs = painted === Infinity ? Infinity : Date.now() - coldStart;
  assert.ok(coldMs < PERF_BUDGET_MS, `cold paint took ${coldMs}ms (budget ${PERF_BUDGET_MS}ms)`);

  // WARM: reload → re-translate-all → every page is a cache hit; all overlays paint
  // fast and ZERO new provider requests (the mock counts them).
  const beforeWarm = await mockStats();
  await driver.navigate().refresh();
  await new Promise((r) => setTimeout(r, 1500));
  const sentWarm = await translateAllOnChapter();
  assert.match(String(sentWarm), /^SENT:/, `warm translateAll not delivered: ${sentWarm}`);
  const warmStart = Date.now();
  const warmPainted = await waitForCount(paintedOverlayCount, PAGE_COUNT, 5000);
  const warmMs = warmPainted === Infinity ? Infinity : Date.now() - warmStart;
  assert.ok(warmMs < 2000, `warm paint took ${warmMs}ms (expected < 2 s cache hits)`);
  const afterWarm = await mockStats();
  assert.equal(
    afterWarm.chatRequests,
    beforeWarm.chatRequests,
    "warm reload must make ZERO new provider requests (cache hits)",
  );
});

test("Scenario B — translate-all with pagesPerRequest=3 issues ceil-batched requests", async () => {
  // Active but NOT auto-translating (§3): the content script scans + registers all
  // pages and Translate all works, but nothing is auto-sent on load — so the ONLY
  // provider traffic is the batched translate-all and the request count is clean.
  await seedSettings({ pagesPerRequest: 3, autoSite: false });

  // Force real requests: clear the cache Scenario A populated (batch and single
  // results share the SAME composite key, so those pages would otherwise all
  // cache-hit and the mock would see zero requests). WHY store.clear() over
  // deleteDatabase: a normal transaction is NOT blocked by the background's open
  // connection, so it can't hang the async script.
  await driver.executeAsyncScript(
    `const done = arguments[0];
     (async () => {
       const dbs = (await indexedDB.databases())
         .filter((d) => d.name && d.name.startsWith('mangalens-cache'));
       for (const info of dbs) {
         await new Promise((resolve) => {
           const req = indexedDB.open(info.name);
           req.onsuccess = () => {
             const db = req.result;
             if (!db.objectStoreNames.contains('translations')) { db.close(); resolve(); return; }
             const tx = db.transaction('translations', 'readwrite');
             tx.objectStore('translations').clear();
             tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
           };
           req.onerror = req.onblocked = () => resolve();
         });
       }
     })().then(() => done(), () => done());`,
  );
  await resetMockStats();

  // Navigate, let the content script scan + register all 10 candidates (nothing
  // paints yet — non-auto site), then translate them all via the two-tab flow (§3).
  await driver.get(`${mock.baseUrl}/chapter.html`);
  await new Promise((r) => setTimeout(r, 1500));
  const sendResult = await translateAllOnChapter();
  assert.match(String(sendResult), /^SENT:/, `translateAll not delivered: ${sendResult}`);

  // 10 pages @ batch 3 → ceil = 4 requests (3+3+3+1: three size-flushed groups of
  // 3, then the 10th linger-flushed SOLO — never a batch-of-1, §4). Wait for the
  // mock to settle (latency + concurrency waves).
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_LATENCY_MS ?? 2000) + 4000));
  const stats = await mockStats();
  assert.equal(stats.chatRequests, 4, `expected 4 batched requests, got ${stats.chatRequests}`);
  assert.equal(stats.images, PAGE_COUNT, `expected ${PAGE_COUNT} images across the batches`);
});

test("Scenario C — no overlay-host leak after 100 SPA-style page swaps", async () => {
  await seedSettings({ pagesPerRequest: 1, prefetchAhead: PAGE_COUNT });
  await driver.get(`${mock.baseUrl}/chapter.html?leak`);
  // Let the first cycle translate + cache — and assert it ACTUALLY painted, so the
  // host-count stability below is a real leak check and not vacuously true against
  // a page where nothing ever rendered (the prior SVG-decode failure, Phase 8.1 §1).
  const firstPaintMs = await waitForCount(paintedOverlayCount, 1, PERF_BUDGET_MS);
  assert.ok(
    firstPaintMs < PERF_BUDGET_MS,
    `no overlay ever painted in cycle 1 — leak check would be vacuous (${firstPaintMs}ms)`,
  );

  const samples = [];
  for (let cycle = 1; cycle <= 100; cycle++) {
    await driver.executeScript("window.__mangalensSwapPages && window.__mangalensSwapPages();");
    if (cycle % 10 === 0) {
      await new Promise((r) => setTimeout(r, 200)); // let the scanner reconcile
      samples.push(await overlayHostCount());
    }
  }
  // Settle, then the host count must equal the final DOM's page count (no growth).
  await new Promise((r) => setTimeout(r, 1000));
  const finalHosts = await overlayHostCount();
  assert.ok(finalHosts <= PAGE_COUNT + 1, `overlay hosts didn't settle: ${finalHosts}`);
  // No upward trend across the sampled cycles (DOM-count stability is the proxy —
  // Firefox exposes no performance.memory).
  const maxSample = Math.max(...samples);
  assert.ok(maxSample <= PAGE_COUNT + 2, `overlay-host count grew over cycles: ${samples.join(",")}`);
  // The mock shows cache hits after cycle 1, not 100× duplicate spend.
  const stats = await mockStats();
  assert.ok(stats.chatRequests < PAGE_COUNT * 5, `too much provider traffic: ${stats.chatRequests}`);
});
