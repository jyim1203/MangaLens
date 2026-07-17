# Phase 8.1 — Phase 8 review findings: e2e is red + batch/§2 fixes (handoff)

This is the **review verdict on the Phase 8 implementation** (reviewed
2026-07-16, on the target Windows machine with a real Firefox). The short
version: **everything statically verifiable is genuinely green and well built —
but the e2e suite, run for the first time ever this session, FAILS 2 of 3
scenarios**, and the failure analysis surfaced one real product bug in the
batch path plus two smaller §2 races. Phase 8's DoD line "`npm run test:e2e`
green" is therefore **not met**; this phase closes it.

**Re-verified green this session (do NOT re-do, do NOT rebuild):**
- `npm run check` — typecheck, ESLint, **627/627 unit tests**.
- `npm run build` clean; `npm run lint:ext` **0 errors / 0 warnings /
  0 notices** (the data-collection notice really is gone); `npm run build:ext`
  produces `web-ext-artifacts/mangalens-0.1.0.zip`.
- Code review of every Phase 8 item: the batch pure core + collector
  (`batch.ts`), `translateBatch`/`finishBatch`/token split (`ProviderBase.ts`),
  all four adapters' `buildBatchRequest`, batch schema dialects derived from the
  single-page ones, `PROMPT_VERSION` untouched, `queue.addJob`/`setPriority`
  (upgrade-only, listener cleanup correct), the reprioritize handler (collector
  pull-out → solo, queued → `setPriority`, unknown id no-op), registry cleanup
  in every `finally`, `hydrateAll`/`hydrateCached`/`canShowCached`/popup button,
  `endpointModes` (separate storage key, startup hydrate, generic downgrade),
  `data_collection_permissions` (confirmed live: `permissions.getAll()` reports
  `data_collection: ["websiteContent"]`), contract changes limited to the two
  flagged messages, and `docs/PRIVACY.md` / `docs/AMO-LISTING.md` (accurate).
- **The e2e infrastructure itself works on this machine.** `npm install` now
  brings in selenium-webdriver + geckodriver (they are in devDependencies);
  geckodriver finds the Store-installed Firefox automatically; headless runs
  fine. The "no geckodriver / no display" blocker from the implementation
  session is gone — there is no remaining excuse for not running e2e locally.

**Actual e2e result (first real run):** Scenario A ✖ (grant-button click),
Scenario B ✖ (`expected 4 batched requests, got 0`), Scenario C ✔ — but
**vacuously** (see item 1: zero overlays ever painted, so "host count stable"
was trivially true). Probe runs with the grant step patched confirmed the
deeper causes below; all probe files were removed, the working tree is as the
implementer left it.

Read first: `docs/PHASE-8-HANDOFF.md` §5–§7 (the e2e contract this phase
repairs), the Phase 8 summary in `PROGRESS.md`, `tests/e2e/mockProvider.mjs`,
`tests/e2e/smoke.spec.mjs`, `src/background/translateHandlers.ts`
(`runBatchSingles`, `executeBatchGroup`), `src/content/viewportQueue.ts`
(`sendUpgrade`, `sendTranslate`).

## Ground rules

Unchanged from Phase 8 (Architecture §9): strict TS, JSDoc, pure-core /
thin-shell, `// WHY:` comments, fail-soft, no test hooks in shipped code, no
`shared/types.ts` or `PROMPT_VERSION`/`CACHE_VERSION` changes. **This phase
expects NO new messages and NO manifest change.** When done: `npm run check`,
`npm run build`, `npm run lint:ext` clean, **`npm run test:e2e` green ON THIS
MACHINE**, and a Phase 8.1 summary appended to `PROGRESS.md`.

---

## 1. [e2e BLOCKER — root cause of A and B] The mock's SVG pages cannot be decoded by the extension

`mockProvider.mjs` serves the chapter pages as **SVG** images.
`prepareImage` decodes via `createImageBitmap`, and **Firefox's
`createImageBitmap` rejects SVG blobs** — so every single job dies at the prep
stage, before any provider call. Verified live: permission granted,
`translateAll` delivered (`{count: N}` came back), and the mock's `/stats`
stayed `{"chatRequests":0,"images":0}` forever; painted-overlay count stayed 0
for 12 s. **No scenario that needs a translation can ever pass with this
fixture.** (This also means Scenario C's ✔ proved nothing — re-read its result
only after this fix.)

**Fix (mock-side, not product-side):** serve **raster PNGs**. Keep it
dependency-free: hand-roll a minimal PNG encoder with `node:zlib` (`deflateSync`
over filtered scanlines — ~30 lines for a solid-color/simple-pattern image) and
generate the 10 pages at ~800×1200. **Each page's bytes MUST differ** (vary a
color/band by page index) — page identity is the content hash, and identical
bytes would collapse all 10 pages into one cache entry/coalesced job. Do NOT
add an image library, and do NOT teach `prepareImage` to decode SVG (manga
pages are never SVG; that would be product code for a test's convenience —
rule 9's spirit).

🧪 The existing standalone self-check (`node tests/e2e/mockProvider.mjs`) plus
one Node assertion that two pages' bytes differ and both parse as PNG (magic
bytes) is enough; the browser run is the real test.

## 2. [e2e BLOCKER] The grant step clicks a button that never appears under a temporary install

Verified live: `driver.installAddon(zip, temporary=true)` **auto-grants**
`<all_urls>` — the options page correctly renders "Image access: granted for
all sites", `#grant-perm` stays `hidden`, `#revoke-perm` is visible. The
spec's `grantHostPermission` then dies with `ElementNotInteractableError`
(first failure in the log; everything after it in Scenario A never ran).

**Fix (spec-side):** make the step conditional — ask the page
(`browser.permissions.contains({ origins: ["<all_urls>"] })` via
`executeAsyncScript`) and **skip the click when already granted**; keep the
click path (with `until.elementIsVisible`, not just `elementLocated` — the
button starts `hidden` in static HTML and is revealed async) for any install
mode that doesn't auto-grant. The options page itself is CORRECT — do not
touch it.

## 3. [e2e BLOCKER] Scenario B destroys the chapter tab before messaging it

`driver.get(extUrl(options))` navigates the SAME tab that held
`chapter.html`; the subsequent `tabs.query` finds no chapter tab and the
`executeAsyncScript` times out (observed: `ScriptTimeoutError: Timed out after
30000 ms` — also fix that script's `NO TAB` path to call `done()` explicitly
so a miss fails fast with a message instead of hanging). Verified live that
the two-tab pattern works: open the extension page in a **new** tab
(`driver.switchTo().newWindow("tab")`), keep the chapter tab alive, send
`translateAll` from there — the content script answers with a count.

**Fix (spec-side):** two-tab flow for Scenario B (and anywhere else a
privileged page must coexist with the chapter). Remember to switch back to the
chapter tab before counting overlays.

## 4. [PRODUCT BUG — would still fail Scenario B after 1–3] A lone linger-flushed member goes out as a batch-of-1

10 pages at `pagesPerRequest = 3` → three size-flushed groups of 3, then the
10th member linger-flushes as a **group of 1**, and `runBatchSingles` calls
`provider.translateBatch` with ONE job — a batch-shaped request (batch user
text + batch `pages` schema) carrying one image. Against the mock (whose
spec'd contract is "1 image → single-page JSON") the response has no `pages`
array → `malformed` → the one whole-batch repair retry (2nd request) → still
single-page → split → solo retry (3rd request) → success. **Scenario B's
assertion of 4 requests / 10 images actually meets 6 requests / 12 images.**
In production it "works" (real providers honor the schema and return
`pages:[…]` of length 1) but is strictly worse than the single-page path: the
batch envelope amortizes nothing over one page and swaps the proven
single-page prompt for the batch one.

**Fix (product-side, in the collector executor — NOT in the mock and NOT in
`ProviderBase`):** in `runBatchGroupTask`/`runBatchSingles`, when exactly ONE
single-tile member remains, route it through `translateSoloAndSettle` (which
already exists for the multi-tile divert and records its own usage) instead of
`translateBatch`. `// WHY:` a batch of one amortizes nothing and the
single-page prompt is the proven path. Leave `translateBatch` itself able to
take 1 job (it is exercised by unit tests and harmless); the collector just
never sends it one.

🧪 *Tests:* extend `translateHandlersBatch.test.ts` — a flushed group of 1
never calls `translateBatch` (mock provider asserts `translatePage` path /
one solo HTTP), records solo usage once; a group of 3 still makes ONE batch
call. The 3+3+3+1 ceil case: assert 4 provider calls total.

## 5. [§2 RACE — product, decide: fix or record-as-accepted] An upgrade that arrives before the background registers the requestId is silently lost forever

`translateImage` registers `requestId → cacheKey` only AFTER the image fetch +
hash + cache lookup (translateHandlers.ts, the miss path) — for a prefetched
page that fetch can take seconds. A `reprioritizeTranslation` landing in that
window finds no mapping → silent no-op. The content side has ALREADY
optimistically stamped the better `sentPriority` (`sendUpgrade`), and
IntersectionObserver fires on transitions only — so the upgrade is never
re-sent and the page stays at priority 2 behind the whole backlog: the exact
symptom §2 was built to fix, recurring in a timing window. Sibling race (6):
for a blob-sourced candidate `sendUpgrade` returns early while `acquireBytes`
is in flight (`rec.requestId` not yet stamped) — same silent loss, without
even updating `sentPriority`.

**Suggested fix (background-side, smallest):** register the requestId → cacheKey
mapping is not possible before the hash exists, so instead buffer unresolved
upgrades: a small `pendingReprioritize: Map<requestId, priority>` written by
the handler when no mapping exists (TTL/cap ~a few hundred entries, cleared in
the same `finally` that clears `requestIdToCacheKey`), consulted once in
`translateImage` right after the mapping is registered — apply via the same
collector-pull-out / `setPriority` path, then delete. Content side stays
untouched; race 6 collapses into the same fix (the content upgrade can then be
sent even before `requestId` is stamped — drop `sendUpgrade`'s `!rec.requestId`
early-return only if you also make it re-send later; otherwise leave content
as-is and accept the blob window). If you instead decide the window is
acceptable, say so in PROGRESS.md with the reasoning — don't leave it
undocumented.

🧪 *Tests:* handler receives reprioritize before registration → applied when
the miss registers (buffered); after settle → dropped + map not grown
unboundedly.

## 6. Scenario A's no-scroll wait may still time out after item 1 — decide the acceptance mechanics

With the decode failure fixed, check whether all 10 pages actually get
requested without scrolling: in a ~1366×768 headless viewport over 800×1200
pages, visibility + near-margin + `prefetchAhead` (default 3) plausibly covers
only ~5 pages; pages 6–10 then never paint and `waitForCount(…, 10, 5000)`
times out. **Could not be observed past the decode failure — verify first,
fix only if real.** Options if real (pick one, note it in PROGRESS.md):
scroll the chapter during the wait (closest to a real reader; measure
nav→last-paint), seed a larger `prefetchAhead`, or assert the acceptance on a
translate-all instead. Related observation from the probe (pre-existing
Phase 7 behavior, NOT a bug to fix here): a candidate whose request failed
with an error badge stays `requested = true`, so a later translate-all SKIPS
it — e2e scenarios must not reuse a tab whose pages already failed (the probe
saw `count: 6` = 10 − 4 badged auto-attempts). Fresh navigation per scenario,
as the spec already does, avoids it.

## 7. Smaller findings (fix cheaply or record deliberately)

- **Options i18n coverage is minimal:** `src/options/index.html` has ~40
  static strings but only TWO `data-i18n` attributes (title + the
  `pagesPerRequest` hint); the popup HTML is well covered (15). Popup TS-built
  strings (the Show-cached/others' `title` tooltips, the action-status
  feedback incl. §0's "Showing N cached…" / "No cached translations here.")
  are raw literals instead of `t()` with a key. Harmless while en is the only
  locale (fallback = the literal English, never `__MSG_` soup). Either finish
  the sweep or state the narrowed scope ("popup HTML + title only") in
  PROGRESS.md — the Phase 8 summary currently overstates it.
- **`endpointModes` clobber window:** `hydrated` flips synchronously before
  the startup `storage.get` resolves, so a `learnEndpointMode` racing the
  startup hydrate persists a memo that lacks previous-lifetime entries
  (storage stays clobbered until the next learn; memo itself heals).
  Fail-soft by design (costs one 400). One-line fix: latch on the hydrate
  PROMISE (`let hydrating: Promise<void> | undefined`) instead of a boolean.
- **`requestAll` timeout budget uses construction-time concurrency** — a
  mid-session concurrency change doesn't update the estimate. It is only a
  timeout heuristic; wire it like `setPrefetchAhead` or note it as accepted.

## Explicitly out of scope

- Everything Phase 8 already excluded (screenshot fallback, F16/F18/F20,
  inpainting, eval:live, signing, Chrome port).
- Re-architecting the e2e driver — selenium + geckodriver is proven working
  on this machine; keep it.
- The manual/live-key verification ledger (Phase 7 + Phase 8 §Manual) — still
  a human step; this phase does not fake it. With e2e green, the remaining
  human pass is the real-provider one.

## Definition of done

- `npm run check` green (627 + the new unit tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0 — all unchanged.
- **`npm run test:e2e` — all three scenarios green, run on this machine**, with
  the mock serving PNG pages, the conditional grant step, the two-tab
  Scenario B, and the batch-of-1 fix in place. Scenario B asserts 4 requests /
  10 images and now actually measures it; Scenario C re-verified
  non-vacuously (painted overlays > 0 in cycle 1).
- No new messages, no manifest change, no `shared/types.ts` change,
  `PROMPT_VERSION` untouched.
- `PROGRESS.md` Phase 8.1 summary: the four e2e root causes, the batch-of-1
  fix, the §5 decision (fixed or accepted-with-reasoning), the Scenario A
  mechanics decision, and honest status of the i18n-scope correction.
