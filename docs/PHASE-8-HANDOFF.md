# Phase 8 — Perf hardening + e2e + AMO prep (handoff)

You are implementing **Phase 8** of the MangaLens Firefox extension: multi-page
batching (F12), queue/prefetch tuning (priority upgrades, translate-all timeout
budget), the mock-provider e2e smoke suite with the two Architecture acceptance
criteria (10-page chapter < 5 s; no leaks after 100 navigations), a memory
audit, and AMO listing prep (`data_collection_permissions`, popup/options i18n
migration, privacy/listing docs). This is the last planned phase before the
extension is store-submittable. **It adds no new user-facing translation
capability** — the pipeline has been end-to-end since Phase 5; this phase makes
it faster, cheaper, verified, and shippable.

Read first: `docs/ARCHITECTURE.md` §7.5 (latency targets), §8 Phase 8 + its
acceptance line, §9 (handoff rules), §10 (AMO risk row); `docs/PROMPTS.md` §4.2
(batch prompt — implement verbatim), §5.2 (endpoint-mode persistence), §8
(batch golden fixtures); the Phase 4/4.1, 5/5.1, 6, and 7/7.1 summaries in
`PROGRESS.md` (they name every deferral this phase closes). Baseline state is
verified green: **420 unit tests**, typecheck, ESLint, `vite build`, and
`web-ext lint` (0 errors / 0 warnings; the lone `data_collection_permissions`
notice is the one THIS phase finally clears). **Phase 7.2
(docs/PHASE-7.2-HANDOFF.md — blob-page support, rate-limit gate, auto-translate
opt-in) lands before this phase**: read its PROGRESS.md summary first; the test
count and the `translatePage` message shape will have moved past this baseline.

**Already shipped — do NOT rebuild:**
- The concurrency-limited `PriorityQueue` (priority + FIFO + abort merge) and
  its live `setConcurrency` sync on every request (`getTranslationQueue`).
- Prefetch plumbing: `planEnqueues` already sends N+1..N+prefetchAhead at
  priority 2 when a page becomes visible; `requestAll` (translate-all) already
  fills the rest at `TRANSLATE_ALL_PRIORITY` with dry-run counting.
- Cache-first + negative cache + in-flight coalescing + `SharedAbort`
  refcounting (`translateHandlers.ts` / `coalesce.ts` / `sharedAbort.ts`).
- The i18n *mechanism* (`shared/i18n.ts` `t()`, `_locales`, `__MSG_*__`
  manifest strings) — Phase 8 only migrates the remaining popup/options static
  HTML strings onto it.
- Overlay teardown paths (scanner reconcile → `unregister` → cancel + clear;
  `!el.isConnected` reaping). Phase 8 *audits* these for leaks, it does not
  redesign them.
- `pagesPerRequest` already exists in `Settings` (default 1, clamped 1–4 by the
  options `NUMERIC_FIELDS` table) with an options hint saying "takes effect
  when batching ships (Phase 8)" — update that hint, don't re-add the field.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 **event
   pages** (not Chrome service workers).
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Every module gets Vitest coverage (happy path + edge cases). Keep the
   repo-wide **pure-core / thin-shell split**: timers, HTTP, canvas, IndexedDB,
   and DOM stay in thin untested shells; every *decision* (batch grouping,
   eligibility, split-retry classification, priority-upgrade planning, timeout
   budgets) lives in a pure, browser-free function and is unit-tested.
4. Do not change interfaces in `shared/types.ts` without flagging it.
   **This phase expects NO `shared/types.ts` change** — batch types are
   background-local (`createProvider` already returns `ProviderBase`, so
   `translateBatch` lives there, NOT on the shared `Translator` interface).
   `shared/messages.ts` gains ONE message (`reprioritizeTranslation`, item 2)
   — flag it. Anything beyond: stop and flag before building.
5. All bbox coordinates stay normalized 0–1 relative to the ORIGINAL full
   image. Batch pages are single-tile by construction (item 1), so no new
   remap code — `pages[i]`'s regions are already full-image space for image i.
6. Fail soft: any error must degrade to "no overlay" + a console-grouped
   warning, never break the host page. A batch failure must never take down
   pages that would have succeeded solo (the split-retry guardrail exists for
   exactly this).
7. Comment every non-obvious decision with a `// WHY:` prefix.
8. When done: `npm run check` + `npm run build` + `npm run lint:ext` all clean
   (and now truly 0-notice), `npm run test:e2e` green, and append a **Phase 8
   summary** paragraph to `PROGRESS.md` in the existing house style.
9. **No test hooks in shipped code.** The e2e suite drives the extension the
   way a user does (options UI, real messages); seeding shortcuts go through
   browser prefs / driver capabilities, never a prod code path.

## New files

```
src/background/batch.ts                 # batch eligibility/grouping/split-retry (pure) + collector (thin)
src/background/endpointModes.ts         # storage-backed §5.2 per-endpoint mode memo
tests/fixtures/golden/batch_3_pages.json
tests/fixtures/golden/batch_wrong_length.json
tests/e2e/mockProvider.mjs              # OpenAI-compatible mock w/ latency + static fixture host
tests/e2e/chapter.html                  # 10-page fixture chapter (SVG placeholder pages, http-served)
tests/e2e/smoke.spec.ts                 # perf acceptance + leak scenario
docs/PRIVACY.md                         # keys local-only, images → user's chosen provider only
docs/AMO-LISTING.md                     # listing copy draft (name, summary, description, permissions rationale)
tests/unit/{batch,endpointModes,...}.test.ts
```

Touched: `background/queue.ts` (priority-change handle), `background/
translateHandlers.ts` (batch wiring + requestId→job registry + reprioritize
handler), `background/providers/prompt.ts` (§4.2 batch text + batch schema,
additive), `background/providers/ProviderBase.ts` + the four adapters
(multi-image request build + batch envelope parse), `shared/messages.ts` (the
one new message), `content/viewportQueue.ts` (upgrade planning, prefetchAhead
setter, translate-all timeout budget), `content/index.ts` (apply prefetchAhead
on settings change), `src/manifest.ts` (`data_collection_permissions`),
`src/popup/*` + `src/options/*` (i18n walker + batching hint text),
`public/_locales/en/messages.json`, `package.json` (e2e deps + scripts).

Suggested build order: 1 → 2 → 3 → 4 (unit-testable core), then 5 → 6 → 7
(e2e infra proves 1–3 under realistic latency), then 8 (AMO polish last, so
the lint/i18n pass covers final strings).

---

## 1. Multi-page batching (F12) — the core of this phase

`pagesPerRequest ≥ 2` groups multiple page images into ONE provider request,
amortizing the ~600-token system prompt (PROMPTS §4.2). Behavioral contract:

- **Only priority-2 jobs batch** (prefetch + translate-all). Priority 0/1
  (visible/near-viewport) jobs always go solo — a visible page must never wait
  for batch-mates. // WHY-note.
- **Only single-tile pages batch.** A webtoon strip (multi-tile after
  `planPrep`) keeps the existing per-tile parallel path. A batch member has no
  `tileOffset`; its regions come back in full-image space (rule 5).
- **Batch size = `pagesPerRequest` clamped 1–4**; value 1 (the shipped
  default) means batching is OFF. **Deliberate deviation, flag it in
  PROGRESS.md:** Architecture §6 says "'translate all' mode defaults to 2–3",
  but there is one knob and no way to distinguish an explicit user 1 from the
  default — we honor the setting everywhere and do NOT silently override it
  for translate-all (batching increases blast radius; opt-in beats surprise).
  The options hint text becomes the recommendation ("2–3 recommended for
  Translate all"; i18n'd, item 8).
- **One batch = one queue slot = one provider HTTP request** carrying up to N
  images. The global concurrency cap keeps meaning "provider requests in
  flight".

**Prompt layer (`prompt.ts`, additive only):** the §4.2 user text verbatim
(`Translate these {{n}} pages…` + the pages-array instruction) and the batch
schema that wraps the canonical single-page schema in a required top-level
`pages` array (derive it from the canonical constant; the three dialect
converters need batch variants — same stripping rules as today). **The
single-page prompt strings must stay byte-identical** — `PROMPT_VERSION` is
untouched (the existing stability test pins this; extend it to also pin the
single-page path with batching code present). Batch results are cached under
the SAME composite key as single results — // WHY: batch-vs-single is a
delivery mechanism, not a quality-affecting setting; folding it into the key
would halve cache hits for zero user benefit. Flag this in PROGRESS.md.

**Provider layer:** `ProviderBase` gains `translateBatch(jobs, settings,
signal): Promise<PageTranslation[]>` (background-local, NOT on the shared
`Translator` interface — rule 4). Request build: N base64 image blocks in
order + the §4.2 user text; each adapter extends its existing request shape
(Gemini: multiple inline-data parts; OpenAI/OpenRouter/custom: multiple
image_url blocks; Anthropic: multiple image content blocks — all four support
multi-image messages). Response: same envelope extraction, then parse the
`pages` array; run EACH page through the existing
`validatePageShape`/`sanitizePage` pipeline; stamp per-page `sourceLang`.

**Failure ladder (pure classifier, tested — PROMPTS §4.2 guardrails):**
- `pages.length !== n` → **split**: retry each member as a normal single-page
  request (which has its own repair path). Never re-batch.
- Malformed JSON → the engine's existing one-shot repair nudge counts as the
  ONE whole-batch retry; still malformed after that → split.
- Provider refusal of the batch → split (one bad image must not damn its
  batch-mates; the guilty single then negative-caches normally). // WHY-note.
- `auth` / `rate-limit` / `network` / abort → fail all members with that error
  (a split would just repeat it N times; rate-limit already backs off inside
  the engine before surfacing).

**Collector (`background/batch.ts`):** pure core — `batchEligible(priority,
pagesPerRequest)`, `batchSignature(providerSettings, prepOpts)` (provider +
resolved model + endpoint + targetLang + hint + honorifics + readingDirection
+ maxEdgePx + jpegQuality; members with different signatures NEVER mix — a
mid-flight settings change must not blend prompts), `planFlush(members,
batchSize, elapsedMs, lingerMs)` → flush decision. Thin shell: a module-level
collector that accumulates eligible cache-miss jobs and flushes when
`batchSize` members are ready OR a **linger window** (~300 ms suggested,
constant) elapses — translate-all bursts group; a lone prefetch pays at most
the linger. Wiring in `runTranslateMiss`: eligible misses submit to the
collector instead of `queue.add(translatePrepared…)`; the flush enqueues ONE
queue task at priority 2 which preps its members (inside the queue slot),
diverts any member that unexpectedly preps multi-tile to the per-tile path
within the same task, and runs `translateBatch` on the rest. Members keep
their own coalesce entries (`inflightTranslations`) — the batch task settles
each member's promise individually. Event-page death drops collector state;
that's gap #8's existing contract (content re-requests), no persistence.

**Abort:** reuse `SharedAbort` — the batch task's queue jobSignal aborts only
when EVERY member's signal has aborted. A single member aborting stays in the
batch and its result is still cached (it was nearly free) — same semantics as
today's coalesce followers. // WHY-note.

**Usage (F17):** record ONE usage event per batch call: aggregate
provider-reported tokens exactly once (no double count, no loss — the cost
totals must equal what the provider billed), `images += n`. Per-member cached
`PageTranslation.tokensIn/Out`: split the aggregate evenly (rounded) across
members, // WHY-noted as a ballpark attribution — F17 is an estimate surface.

🧪 *Tests:* eligibility matrix (priority × pagesPerRequest × tile count);
signature equality/inequality per field; flush planning (size-triggered,
linger-triggered, never mixes signatures); golden `batch_3_pages.json` (3
pages parse → 3 sanitized PageTranslations, order preserved) and
`batch_wrong_length.json` (→ split classification); split ladder per failure
kind (wrong-length/malformed-after-repair/refusal split; auth/rate-limit fail
all); per-adapter batch request shape (N image blocks, §4.2 text, batch
schema dialect); PROMPT_VERSION + single-page byte-stability pins; usage
aggregation (once per batch, images = n, even split); collector wiring with
mocked provider — members resolve individually, member results cached under
their own keys, all-abort cancels the batch, one-abort doesn't.

## 2. Priority re-prioritization (the Phase 5 "no priority upgrade" deferral)

Today a prefetched/translate-all page that scrolls into view sits at priority
2 behind the whole chapter — during a 200-page translate-all the user can
stare at a skeleton for minutes. Close the loop:

- **`queue.ts`:** add a handle-returning variant — suggested
  `addJob(task, priority, jobSignal): { promise, setPriority(p): boolean }` —
  `setPriority` re-inserts a still-queued entry at the new priority (fresh
  seq — back of the new class is fair) and returns false once
  started/settled. `add` stays as-is (thin wrapper). Do NOT add retry or any
  other behavior here.
- **`shared/messages.ts` (the ONE flagged contract change):**
  `reprioritizeTranslation: { request: { requestId: string; priority: number };
  response: void }`. Fire-and-forget from content; unknown/settled id is a
  silent no-op (same contract as `cancelTranslation`).
- **Background:** `translateImage` gains an optional `requestId?` param (the
  handler already has it) and registers `requestId → cacheKey` for the miss
  path (cleaned in `finally`, like `requestControllers`). The handler resolves
  requestId → cacheKey → (a) a member still in the batch collector: pull it
  out and enqueue it SOLO at the new priority (don't drag batch-mates up);
  (b) a queued job/batch: `setPriority(min(current, requested))` — upgrades
  only, never worsen; lifting a whole batch because one member is visible is
  accepted (WHY-note). Running/settled → no-op.
- **Content (`viewportQueue.ts`):** track the sent priority per candidate;
  extend `planEnqueues` (or a sibling pure planner) so a tier change on an
  already-requested, unsettled candidate with a strictly better priority
  yields an `upgrade` instruction instead of being skipped; the shell sends
  `reprioritizeTranslation`. `requestAll` records priority 2 for its sends.
  Update the two stale "no re-prioritize API" WHY comments (viewportQueue +
  planEnqueues JSDoc).

**Scroll-away downgrade is deliberately NOT built** (the symmetric case):
visible→gone thrash was the reason Phase 5 skipped scroll-away cancel, and the
same argument holds for downgrades; prefetched work fills the cache anyway.
Note it in PROGRESS.md as decided-against, closing the Phase 5 "revisit"
thread. Same for scroll-away cancel itself: **decided — keep no-cancel.**

🧪 *Tests:* queue — upgrade while queued reorders ahead of same-priority
earlier entries, after-start/after-settle returns false, downgrade attempt via
min() never worsens; planner — visible-transition on a requested candidate
emits upgrade with priority 0, near-transition on a priority-2 send emits
upgrade to 1, no upgrade when equal/worse or unrequested (send instead), no
instruction for settled candidates; handler — collector pull-out goes solo at
new priority, queued setPriority called, unknown id no-op; registry cleanup in
finally.

## 3. Queue/prefetch tuning odds and ends

- **Translate-all timeout budget** (the Phase 5.1 "120 s vs translate-all"
  revisit): a 200-page `requestAll` at concurrency 6 on a slow provider blows
  the flat 120 s `withTimeout`, churning resets. Pure, tested
  `requestAllTimeoutMs(count, concurrency, baseMs)` — suggested `min(baseMs +
  ceil(count / concurrency) * 30_000, 15 min)` — and `sendTranslate` accepts a
  per-send timeout override that `requestAll` supplies. Visibility-driven
  sends keep the flat 120 s. The existing timeout semantics (reset +
  re-observe, no cancel, coalesce absorbs re-sends) stay untouched — they are
  correct; document in the summary that the background finishes and caches
  regardless, so late pages render as instant cache hits on scroll.
- **Mid-session `prefetchAhead`** (Phase 5 accepted no-op): make it live.
  `ViewportQueue` gains `setPrefetchAhead(n)`; `content/index.ts` applies it
  on every settings apply (cheapest correct wiring — no gate classification
  change needed since the planner reads it per call; if you do route it
  through `gate.ts`, the classification must be pure + tested).
- `concurrency` is already live per-request via `getTranslationQueue` — verify
  with a test if not already pinned, don't rebuild.

🧪 *Tests:* budget formula (monotonic in count, floor = baseMs, cap holds);
requestAll passes the budget / visibility sends don't; setPrefetchAhead
affects the next plan (pure planner already covers the math — one shell-seam
test that the new value reaches it).

## 4. Endpoint-mode persistence (PROMPTS §5.2, deferred from Phase 6)

The OpenAI-compatible downgrade mode (`json_schema` vs `json_object`) is
memoized per endpoint in a module-level map — one wasted 400 per event-page
lifetime. Persist it: new `background/endpointModes.ts` owning a **separate
`storage.local` key** (NOT `Settings` — // WHY: settings writes broadcast to
every tab and re-run gate classification; this is background-internal state
with no UI surface, and keeping it out of `SettingsPatch` avoids schema/
migration churn). Load-once-per-lifetime into the existing in-memory memo,
write-through on learn, fail-soft on storage faults (a lost memo just re-pays
one 400). Keep the existing `reset*` test seams working.

🧪 *Tests:* learn → persisted shape; rehydrate on fresh lifetime (fake-browser
storage); corrupt stored value heals to empty; storage rejection doesn't break
the request path.

## 5. Mock provider + fixture chapter (e2e infrastructure)

`tests/e2e/mockProvider.mjs` — a dependency-free Node HTTP server, dev-only:

- **OpenAI-compatible surface** (`POST /v1/chat/completions`) — the `custom`
  provider exists precisely so tests never touch a real vendor. Configurable
  latency (env var, default 2000 ms — the Architecture acceptance number).
  Counts image blocks in the request: 1 → single-page canonical JSON, N →
  a `pages` array of length N (so batching is e2e-exercisable). Deterministic
  regions (2–3 bubbles per page, fixed bboxes). Sets permissive CORS headers
  (`Access-Control-Allow-Origin: *` + preflight) — // WHY: browser-origin
  provider calls, same as real vendors. Also answer `GET /models` (the Phase 6
  key-test path) so the options "Test" button works against it.
- **Static host** for `tests/e2e/chapter.html`: a 10-page chapter of
  hand-authored SVG-placeholder pages in the testpage.html style, but served
  over **http as separate image URLs** (not data URIs) — // WHY: the perf
  scenario must exercise the real §7.3 path (optional host permission →
  background fetch), not sidestep it.
- A second page (or query-param variant) for the leak scenario (item 7).
- Optional but cheap: give chapter.html one page whose `<img>` src is a
  `blob:` URL (fetch + `URL.createObjectURL` in an inline script) so the
  Phase 7.2 bytes path rides along in Scenario A. Not required for DoD.

## 6. e2e smoke suite + the perf acceptance criterion

**Driver:** the goal is scenario coverage, not a brand. Preferred: Playwright
with a Firefox temporary-add-on install (e.g. the `playwright-webextext`
launcher, or hand-rolled RDP `installTemporaryAddon` over
`-start-debugger-server`). **Equally acceptable fallback** (Playwright's
Firefox build may not support extensions — verify at build time):
`selenium-webdriver` + geckodriver, whose `installAddon(path, temporary=true)`
is first-class. Pin the extension's internal UUID via the
`extensions.webextensions.uuids` pref set BEFORE install so
`moz-extension://<uuid>/…` page URLs are known to the test. Whichever driver:
`npm run test:e2e` builds (`vite build`), starts the mock server, launches
Firefox, runs, tears down. e2e is **excluded from `npm run check`** (CI unit
job unchanged); document how to run it in a comment header or README section.

**Setup flow (drive the real UI — rule 9):** open the options page → enter the
custom endpoint (mock URL) + any key → click Test (asserts the Phase 6 key
path against the mock) → grant image access from the permissions panel (a
driver click IS the user gesture `permissions.request` needs) → set
`pagesPerRequest` where the scenario wants batching.

**Scenario A — the Architecture acceptance:** navigate to the 10-page chapter,
enable, and measure from navigation/enable until all 10 overlays have painted
bubbles (overlay hosts carry `OVERLAY_HOST_ATTR` on `document.body` — count
via DOM, look inside shadow roots for painted state). **Assert < 5 s with the
mock at 2 s latency** (concurrency 6 ⇒ two 2 s waves ≈ 4 s + overhead;
threshold configurable via env for slow CI, default 5000). Run once warm
(second navigation asserts the cache-hit path: all overlays < 1 s, zero
provider hits — the mock counts requests, expose a `GET /stats` endpoint).

**Scenario B — translate-all + batching:** `pagesPerRequest = 3`, use the
popup or send `translateAll` — assert the mock saw ceil-batched request counts
(e.g. 10 unrequested pages → 4 requests: 3+3+3+1) and all pages render.

🧪 The e2e specs ARE the tests here; keep assertions on observable behavior
(DOM, mock request log), never on extension internals.

## 7. Memory audit + the leak acceptance criterion

**Code audit (fix + WHY-note anything found; list findings in the summary):**
- Content: every `deactivate()`/`stop()` path drops ALL listeners — shared
  scroll/resize pair, per-image ResizeObservers, MutationObserver, the peek
  `mousemove`, toast host, rAF handles; overlay hosts removed from `body`;
  no map keeps a removed element alive (tracked/order/paintedRects).
- Background: `requestControllers`, `inflightTranslations`, `sharedAborts`,
  the new collector + requestId→cacheKey registry — every entry has a
  guaranteed removal path (finally/settle), including on abort and on error.
- The Phase 7.1 note about hosts appended for a since-removed image is fixed;
  verify no sibling case remains (e.g. a host orphaned by an unregister that
  raced a pending render).

**Scenario C — the Architecture leak criterion:** 100 "page navigations" —
SPA-style churn on one tab (swap the chapter's images / replace `<main>` 100
times, which exercises MutationObserver reconcile + overlay teardown, the
realistic reader pattern) plus a handful of full location loads. Assert after
settling: overlay-host count equals the count for the final DOM (no
accumulation), no per-cycle growth trend in host/node counts sampled every 10
cycles, and the mock's request log shows cancels/coalescing rather than 100×
duplicate spend (cache hits after the first cycle). Heap instrumentation is
NOT required (Firefox exposes no `performance.memory`) — DOM-count stability
is the assertable proxy; note that in the spec.

## 8. AMO listing prep

- **`data_collection_permissions`** (deferred since Phase 0): add
  `browser_specific_settings.gecko.data_collection_permissions` to
  `src/manifest.ts`. Verify the current schema/categories against Firefox
  docs at build time (the key was Nightly-only when Phase 0 deferred it —
  support has been riding to release); the honest declaration for MangaLens
  is required collection of **website content** (page images are transmitted
  to the user's chosen provider) and nothing else — no analytics, no
  telemetry. If the key demands a `strict_min_version` bump, flag it in
  PROGRESS.md before bumping. `web-ext lint` must end 0 errors / 0 warnings /
  **0 notices** — the deferral thread every phase summary has carried ends
  here.
- **Popup/options i18n migration** (deferred from Phase 7): a `data-i18n`
  attribute walker in each page's `main.ts` (pure key→apply mapping, tested;
  the DOM walk is shell) over the static HTML strings; strings move to
  `public/_locales/en/messages.json` with English fallbacks via `t()` where
  strings are built in TS. Includes the updated `pagesPerRequest` hint
  (item 1) and any new Phase 8 strings.
- **`docs/PRIVACY.md`**: keys stored in `browser.storage.local` only, never
  synced, never sent anywhere but the user's chosen provider; images leave the
  browser only to that provider; cache is local IndexedDB; no first-party
  server exists (Architecture §7.6 + Risks table — this is the AMO review
  doc).
- **`docs/AMO-LISTING.md`**: listing copy draft — name, one-line summary,
  description, permission-by-permission rationale (`<all_urls>` optional +
  in-flow, `storage`, `activeTab`, commands), screenshots checklist.
- Confirm `web-ext build` produces a submittable artifact (script it as
  `npm run build:ext` if trivial; don't build a signing pipeline).

🧪 *Tests:* walker key→apply mapping incl. missing-key fallback (English text
stays, never `__MSG_` soup or empty nodes); a constants test pinning the
manifest declaration shape so drift is caught.

## Manual verification (append results to PROGRESS.md; needs a real browser + key)

1. Build, load, grant access, set a real key. `pagesPerRequest = 3` in
   options (hint text reads as a live recommendation now, localized).
2. Translate-all on `tests/fixtures/testpage.html` — the network panel shows
   multi-image batched provider requests; every page renders; the popup cost
   line moves once with sane totals (F17 aggregate, not doubled).
3. During a translate-all of a long page set, scroll far ahead — the page
   under the viewport visibly jumps the queue (its overlay lands before the
   sequential backlog reaches it).
4. Change `prefetchAhead` in options mid-session — new value takes effect
   without a toggle cycle.
5. Break the key mid-batch — one auth toast, badges on the affected images,
   no unhandled-rejection noise in the event-page console.
6. `about:addons` shows the data-collection disclosure; popup/options render
   localized (no `__MSG_…__`).
7. **Also run the still-outstanding Phase 7 manual pass** (PHASE-7-HANDOFF.md
   §Manual verification) — it has never been executed (PROGRESS 7.1 left it
   accurately outstanding); record both results honestly. The e2e suite
   covers the mock-provider path structurally; the live-key pass is a human
   step by nature — do not fake or skip the ledger entry.

## Explicitly out of scope (do NOT build)

- Screenshot-capture fallback (`tabs.captureVisibleTab`) and scanner
  acceptance of `<canvas>` sources — P2/stretch, still OUT. Scanner acceptance
  of `blob:` sources was pulled forward into **Phase 7.2**
  (docs/PHASE-7.2-HANDOFF.md) after the 2026-07-10 live test found MangaDex
  serves reader pages exclusively as blob URLs — by this phase it is already
  shipped; don't rebuild it.
- Scroll-away cancel/downgrade — decided against in item 2; record, don't
  build.
- Export/import (F16), reading-direction bubble ordering (F18), local
  pipeline (F20), inpainting — stretch (Phase 9+).
- `npm run eval:live` (PROMPTS §8's manual prompt-tuning report) — valuable,
  not Phase 8; leave deferred unless it falls out for free.
- Signing/submission automation; Chrome port; any change to cache key
  composition or `PROMPT_VERSION`.

## Definition of done

- `npm run check` green — all 420 existing tests stay green untouched (except
  where an item explicitly extends a module's behavior).
- `npm run build` clean; `npm run lint:ext` **0 errors / 0 warnings / 0
  notices** (the `data_collection_permissions` deferral is closed).
- `npm run test:e2e` green, including the two Architecture acceptance
  criteria: **10-page fixture chapter < 5 s** against the mock provider at
  2 s latency, and **no leak growth after 100 page navigations** (DOM-count
  stability as specced in item 7).
- `PROMPT_VERSION` untouched; single-page prompt bytes pinned identical.
- Contract changes limited to: `shared/messages.ts` `reprioritizeTranslation`,
  the manifest `data_collection_permissions` key, package.json dev deps +
  scripts. **NO `shared/types.ts` change.** Anything beyond: stop and flag
  first.
- PROGRESS.md gets the Phase 8 summary in house style, flagging: the
  batching-is-opt-in deviation from Architecture §6's "translate-all defaults
  2–3"; batch results cached under unchanged keys; upgrade-only
  re-prioritization with scroll-away cancel/downgrade decided against;
  endpoint modes in a separate storage key; the e2e driver actually used and
  why; memory-audit findings; test counts and manual-verify results (or their
  honest "outstanding" status).
