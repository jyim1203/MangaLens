# Phase 7.2 — Live-site fixes: blob pages, rate-limit cooldown, auto-translate opt-in (handoff)

You are implementing **Phase 7.2** of the MangaLens Firefox extension — a small
point-phase (precedent: 4.1 / 5.1 / 7.1) driven by the FIRST live-browser
verification (2026-07-10, Firefox release build, real Gemini key,
mangadex.org). It lands **before Phase 8** (docs/PHASE-8-HANDOFF.md); Phase 8's
e2e and batching work builds on these paths.

The live test produced three findings, all root-caused from the code + the
user's background-console export:

1. **MangaDex detects zero pages.** Its reader downloads page images over XHR
   and assigns them `blob:` object URLs; `classifyImageUrl` (scanner.ts)
   deliberately skips `blob:` because the background can't fetch a
   document-scoped blob URL (§7.3). Correct per spec — but one of the largest
   manga sites is 100 % blob-served, so the spec is wrong in practice. The
   Phase 7 drag-select path already solves the hard part (content-side bytes
   over structured-clone messaging); this phase extends it to the auto
   pipeline.
2. **The global toggle auto-translates junk on every site.** The console
   export shows real Gemini calls for `i.ytimg.com/vi/…` YouTube thumbnails
   and `mangadex.org/img/miku.jpg` (the site mascot) — every ≥ 180 px-rendered
   / ≥ 400 px-natural image on every enabled page is sent to the provider.
   That burns paid quota AND sends arbitrary page images off-browser without a
   per-site decision. This is a cost and privacy bug, not a scanner bug.
3. **A rate-limited key produces a 429 storm.** `ProviderBase`'s per-job
   backoff ladder (2 s / 8 s / 30 s, `retry-after`-aware) is correct in
   isolation, but every queued job burns the ladder independently — up to 4
   HTTP calls per job at concurrency 6 while the key is *globally* exhausted.
   The export shows 40+ consecutive 429s. There is no cross-job brake.

Read first: `docs/ARCHITECTURE.md` §7.1 (scanner), §7.3 (CORS/permission
model — the blob paragraph), §7.5 (queue); the Phase 5 and 7/7.1 summaries in
`PROGRESS.md`; `src/content/regionSelect.ts` (the source-classification +
byte-acquisition code you will factor out, NOT rewrite). Baseline is green:
420 unit tests, typecheck, ESLint, `vite build`, `web-ext lint` (0 errors /
0 warnings / the known `data_collection_permissions` notice, which Phase 8
clears — not this phase).

**Already shipped — do NOT rebuild:**
- `sourceKindForUrl` / `acquisitionPlan` / the content-side byte acquisition
  in `regionSelect.ts` — item 1 *moves* them to a shared module and reuses
  them; regionSelect behavior stays byte-identical.
- `ProviderBase`'s rate-limit ladder + `parseRetryAfter` + `MAX_RETRY_AFTER_MS`
  — keep them; item 2 adds a *global* gate above, it does not touch the
  per-job ladder or any adapter.
- Cache / negative cache / `coalesce` / `SharedAbort` — the bytes path slots
  in ABOVE them (identity is the content hash, so nothing downstream changes).
- The rate-limit toast (toastPolicy, once per activation) — no new UI surface
  for item 2.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3
   **event pages**.
2. Every exported function/class gets JSDoc; every module gets Vitest coverage
   (pure-core / thin-shell split: fetch, timers, observers, DOM stay in thin
   shells; every decision is a pure tested function).
3. **NO `shared/types.ts` change.** Exactly ONE `shared/messages.ts` contract
   change (item 1's `TranslatePageRequest` extension) — flag it in
   PROGRESS.md. One `shared/settings.ts` addition (`getAutoTranslate`,
   item 3). Anything beyond: stop and flag first.
4. Cache-key composition and `PROMPT_VERSION` untouched.
5. Fail soft: every new failure path degrades to "no overlay" + a
   console-grouped warning, never breaks the host page.
6. `// WHY:` comments on non-obvious decisions; PROGRESS.md summary paragraph
   in house style when done.

## New files

```
src/content/imageSource.ts   # source classification + byte acquisition, factored OUT of regionSelect.ts
src/background/rateGate.ts   # global 429 cooldown: pure ladder + thin stateful wrapper
tests/unit/{imageSource,rateGate}.test.ts (+ extensions to scanner/viewportQueue/translateHandlers/gate/settings tests)
```

Touched: `content/scanner.ts` (URL policy + stale WHY), `content/
viewportQueue.ts` (bytes dispatch + auto-enqueue switch), `content/
regionSelect.ts` (imports from imageSource.ts), `content/gate.ts` +
`content/index.ts` (auto-translate wiring), `shared/messages.ts` (the flagged
payload extension), `shared/settings.ts` (`getAutoTranslate`), `background/
translateHandlers.ts` (provided-bytes path + gate wiring), `background/
regionHandlers.ts` (gate wiring), `src/popup/*` (site-rule copy).

Suggested build order: 1 (the site blocker) → 2 → 3.

---

## 1. Blob-sourced pages: extend auto-translate (the MangaDex blocker)

**Policy (pure):** `classifyImageUrl` returns a three-way `UrlPolicy`:
`"accept"` (http/https/data — background fetches by URL, as today),
`"accept-bytes"` (blob — content must ship bytes), `"skip"` (everything
else). The scanner registers both accept kinds; `Candidate` is unchanged
(`url` carries the blob URL — it is still the element's identity and the
log/coalesce-entry label). Update the stale `// WHY skip blob: … not our
problem until Phase 7.` comment to describe the bytes path.

**Shared acquisition module (`src/content/imageSource.ts`):** MOVE
`SourceKind`, `sourceKindForUrl`, `AcquisitionPlan`, `acquisitionPlan`, and
the byte-acquisition shell (blob `fetch(url)` → ArrayBuffer + mime; canvas
`toBlob`) out of `regionSelect.ts`; update regionSelect's imports. Pure parts
keep their tests (moved, not duplicated). No behavior change to drag-select.

**Content dispatch (`viewportQueue.ts` `sendTranslate`):** when the
candidate's URL classifies `accept-bytes`, acquire the bytes content-side
*inside* `sendTranslate` (after `rec.requested = true`) and add them to the
payload. // WHY lazy at dispatch, never at registration: a chapter can
register 200 candidates; holding 200 × ~1–3 MB ArrayBuffers would be a
content-side memory bomb — only jobs actually sent pay. Acquisition failure
(revoked object URL, fetch throw): `log.warn` + `overlay.setError(candidate,
"network")` and do NOT reset `requested` — a revoked blob never heals by
retry; the reader swapping the img `src` produces a fresh candidate via the
scanner reconcile, and that is the retry path (WHY-note it).

**Message (`shared/messages.ts` — the ONE flagged contract change):**
`TranslatePageRequest` gains `imageBytes?: ArrayBuffer; imageMime?: string`,
mirroring `TranslateRegionRequest` verbatim (same JSDoc WHY: Firefox
`runtime.sendMessage` structured-clones an ArrayBuffer intact; a future
Chrome port needs base64). `imageUrl` stays required — update its JSDoc: when
`imageBytes` is present the background must NOT fetch it; the URL is
identity/diagnostics only.

**Background (`translateHandlers.ts`):** the `translatePage` handler builds a
`Blob` from provided bytes (`imageMime` defaulting like regionHandlers does)
and passes it into `translateImage`, which uses it in place of the
`fetchImageBytes` result. EVERYTHING downstream is untouched:
`sha256Hex(blob)` → composite cache key → coalesce/SharedAbort keyed on that
cache key. // WHY this just works: page identity is the content hash, not the
URL — two tabs showing the same page under different ephemeral blob URLs
coalesce onto one provider run, and a revisit next session cache-hits even
though every blob URL is new. Say this in a WHY-note; it's the reason no
cache/coalesce code changes.

🧪 *Tests:* classify matrix (blob → accept-bytes; http/data → accept; about:/
empty → skip); scanner registers a blob-URL candidate (synthetic-metrics
seam); viewportQueue with an injected acquisition seam — blob candidate's
payload carries bytes+mime, http candidate's doesn't, acquisition failure →
setError + no send + candidate not wedged; translateImage bytes path —
`fetchImageBytes` NOT called, cache keyed on the provided blob's hash, second
call with same bytes under a different URL is a cache hit; translateAll
dry-run counts blob candidates.

## 2. Global rate-limit cooldown (`background/rateGate.ts`)

One shared brake so an exhausted key stops the whole pipeline instead of
letting every job independently discover the 429.

**Pure core:** `RateGateState = { untilMs, strikes }` plus
`reportRateLimit(state, now, retryAfterMs?)` → cooldown =
`min(60_000, max(retryAfterMs ?? 0, BASE_MS << strikes))` with suggested
`BASE_MS = 8_000` (so 8 s → 16 s → 32 s → 60 s cap while consecutive reports
continue), `clearRateLimit()` → zero state on any success, and
`waitMsFor(state, now)`.

**Thin wrapper:** `createRateGate(sleep?)` with abortable
`waitUntilClear(signal)` (re-checks after each sleep — a report landing
mid-wait extends it), `report(retryAfterMs?)`, `clear()`. One module-level
instance in the background.

**Wiring (single choke point per HTTP request):** await
`waitUntilClear(signal)` immediately before each provider call — the per-tile
fan-out in `translateHandlers.ts` AND the region path in
`regionHandlers.ts` (a drag-select during a storm must queue behind the
cooldown, not hammer). On a `ProviderError` with kind `rate-limit` →
`report(err.retryAfterMs)`; on success → `clear()`. // WHY the waits live
inside queue slots: sleeping occupies a concurrency lane, so during a
cooldown at most `concurrency` jobs idle and ZERO new HTTP fires — the queue
self-paces to the provider's rate. // WHY the ProviderBase ladder stays: it
handles transient per-request limits and honors `retry-after` on retries; the
gate stops NEW requests cross-job when the key is exhausted. Both layers are
intentional.

No new UI: the existing once-per-activation rate-limit toast is the surface.

🧪 *Tests:* pure ladder (escalation sequence, retry-after wins when larger,
60 s cap, success resets strikes); wrapper with injected instant sleep —
concurrent waiters all release, report-during-wait extends, abort mid-wait
rejects with the typed abort; handler seam — a rate-limit provider error
reports to the gate and the next job waits; success clears.

## 3. Auto-translate becomes per-site opt-in — **FLAGGED behavior change**

**The change:** visibility-driven auto-translate runs only on sites the user
explicitly opted in (`perSiteOverrides[hostname] === true`, i.e. the popup's
per-site "On"). The global toggle alone still ACTIVATES the content script —
overlays, drag-select, and the popup "Translate all" button work everywhere —
but nothing is sent to a provider without a user action. // WHY: page images
leaving the browser (and costing money) should follow an explicit per-site
decision; evidence: YouTube thumbnails and a site mascot were billed to the
user's key on day one.

This deviates from the shipped F1/F15 semantics ("global enable = full
pipeline everywhere"). **Flag it prominently in the PROGRESS.md summary.**
Existing behavior for a user who already site-enabled a reader is unchanged.

- **`shared/settings.ts`:** pure `getAutoTranslate(settings, hostname):
  boolean` → `settings.perSiteOverrides[hostname] === true`. Note the nuance:
  a site override of `true` with the global flag OFF already force-enables the
  site (existing `getEffectiveEnabled` behavior) — such a site is active AND
  auto, which is exactly right.
- **`content/gate.ts`:** classification must emit `re-request` when
  `getAutoTranslate` flips while active (today an override flip with the
  global flag on can classify as a lesser action since effective-enabled
  doesn't change). Pure + tested.
- **`content/index.ts` / `viewportQueue.ts`:** `createViewportQueue` gains
  `autoEnqueue: boolean`. When false: candidates are still registered,
  doc-ordered, and overlay-managed (translate-all needs the registry), but the
  IntersectionObservers never observe them — no tier events, no auto sends.
  `requestAll` (translate-all) and region select are unaffected. Guard
  `reobserve()` to no-op in this mode, and note the accepted consequence: a
  timed-out translate-all page won't visibility-retry on a non-auto site —
  the user re-clicks Translate all (WHY-note, don't engineer around it).
- **Popup copy:** the site-rule select and status line must communicate the
  split — suggested: site choice "On" label becomes "Auto-translate on this
  site"; when active-but-not-auto, the status line hints that Translate
  all / drag-select are ready and auto-translate is off for this site. Exact
  copy is your call (strings stay hardcoded-English here; Phase 8's i18n
  walker migrates them).

🧪 *Tests:* `getAutoTranslate` matrix (override true/false/absent × global
on/off); gate flip → `re-request` (both directions); viewportQueue
autoEnqueue=false — no sends on synthetic tier events, requestAll still sends
everything, reobserve no-ops; popupLogic label/status mapping if it's pure.

## Manual verification (REQUIRED — this phase exists because it was skipped; append results to PROGRESS.md)

Free-tier note first: free Gemini keys have single-digit-RPM and daily caps —
set `concurrency` 2–3 in options for the pass (or use a billing-enabled key),
and if every request 429s instantly the DAILY quota may already be exhausted
(check the Google AI Studio quota page; wait for reset). Don't misread quota
exhaustion as a code bug — that's what happened in the live test.

1. Build, load as temporary add-on, grant image access, real key.
2. **MangaDex chapter** (e.g. the /chapter/… URL from the 2026-07-10 test):
   popup → this site → Auto-translate on. Pages overlay as you scroll; the
   popup Translate-all dry-run counts > 0 (was "No manga images detected").
   Junk on an opted-in site (the mascot img) may still translate — accepted:
   it returns no regions and caches.
3. **Drag-select one bubble** on a blob page → skeleton then rendered overlay;
   background console shows a `translateRegion` round-trip, no warnings.
4. **YouTube** (global on, NO site override): browse; background console shows
   ZERO provider requests (this is finding 2's regression test).
5. `tests/fixtures/testpage.html` (http images): opt the host in, verify the
   pre-7.2 pipeline is unregressed.
6. If a real 429 occurs during any of this: requests visibly pace out (gate
   logs), one toast, no 40-request storm in the network panel.

## Explicitly out of scope (do NOT build)

- **Canvas auto-translate** — drag-select already covers `<canvas>` readers;
  auto-canvas has taint/redraw-churn problems. Record as decided-against for
  now in PROGRESS.md.
- Screenshot-capture fallback (`tabs.captureVisibleTab`) — still P2/stretch.
- Everything in PHASE-8-HANDOFF.md (batching, re-prioritization, e2e, AMO
  prep) — including `planEnqueues`' stale "no re-prioritize API" comment,
  which Phase 8 item 2 owns.
- Any default change to `concurrency` (Architecture §11 keeps 6; the gate
  self-paces under limits).

## Definition of done

- `npm run check` green (all existing tests stay green untouched; new modules
  covered). `npm run build` clean; `npm run lint:ext` 0 errors / 0 warnings
  (the `data_collection_permissions` notice remains — Phase 8 closes it).
- Contract changes limited to: `TranslatePageRequest.imageBytes/imageMime`
  (`shared/messages.ts`, flagged) and `getAutoTranslate`
  (`shared/settings.ts`). **NO `shared/types.ts` change**; cache-key
  composition and `PROMPT_VERSION` untouched.
- The manual MangaDex pass above is EXECUTED and recorded honestly in
  PROGRESS.md — do not defer it again; it is the point of this phase.
- PROGRESS.md gets a Phase 7.2 summary flagging: the blob-policy reversal of
  the Phase 5 scanner decision (and why the cache/coalesce layers needed no
  change), the auto-translate opt-in semantics change to F1/F15, the
  two-layer rate-limit design (per-job ladder kept + global gate above), and
  canvas auto-translate decided-against.
