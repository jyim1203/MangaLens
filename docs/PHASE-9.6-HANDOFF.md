# Phase 9.6 — Translate-all tail resilience: soft-cancel, dead-signal guards, recycle-persistent sends (handoff)

You are implementing **Phase 9.6** of the MangaLens Firefox extension: the
fix-list from the **thirteenth live-pass evidence** (2026-07-21 HAR
`devtools_Archive [26-07-21 23-46-44].har`, MangaDex, OpenAI `gpt-5.6-luna`, on
the Phase 9.5 build). The user clicked **Translate all** at the top of a
chapter, scrolled through at reading pace, and the **pages at the end were
never translated**. This phase pays the deferral the 9.5 handoff explicitly
recorded: *"Retry-on-recycle for cancelled pages (P3) … a future queue
refinement, not this phase."* The new HAR shows the class at scale — **6 of 19
pages lost** — so it is no longer benign.

**The root cause, established from the HAR + the code (do NOT re-litigate):**

- 19 `translatePage` jobs went out (solo path — `pagesPerRequest` 1, so
  `batchEligible` is false; every request single-image). Requests **0–12
  succeeded** (HTTP 200, valid `finish=stop` region JSON, ~22 s/page, min 13.1 s
  / max 27.8 s) at exactly **concurrency 6** — the queue's dispatch pattern is
  textbook.
- Requests **13–18 died client-side**: HAR `status 0`, `time 0–1 ms`, every
  timing field zero, yet each carries a **fully serialized body** (195–257 KB
  with the image data URL). The request objects were built and the `fetch` was
  created, but it was killed at creation — the signature of a fetch launched
  with an **already-/immediately-aborted `AbortSignal`**. Zero 429s, zero 4xx/
  5xx, no network faults anywhere in the capture: **this is NOT a provider,
  auth, rate-limit, or network problem.**
- Each dead request's start pairs with a *successful* response's end to within
  ~0.1 s (44.8→44.9, 45.3→45.4, 45.8→45.8, 46.0→46.1, 49.5→49.6, 52.3→52.3):
  the queue dequeued the next job the instant a slot freed, and that job's
  signal was dead (or died) within the dequeue→fetch window (image prep +
  base64, ~100–500 ms in the slot).
- The only production writers of those aborts are content-initiated cancels:
  candidate **unregister** on DOM reconcile
  ([index.ts:95](../src/content/index.ts) →
  [viewportQueue.ts `unregister`/`cancel`](../src/content/viewportQueue.ts) →
  [`cancelTranslation`](../src/background/translateHandlers.ts) at ~L1187,
  which aborts the per-request controller unconditionally). The reconcile is
  driven by the overlay noticing `!el.isConnected` on scroll
  ([OverlayManager.ts:193](../src/content/overlay/OverlayManager.ts)) and by
  the scanner's MutationObserver. MangaDex's reader **detaches/replaces `<img>`
  elements while the user scrolls** (lazy-load hydration + node recycling), so
  tail pages whose jobs sat behind the ~90 s backlog (19 pages ÷ 6 lanes ×
  ~22 s) had their elements churned before their jobs ran — each reconcile
  cancelled a still-pending job. The user never paused, never navigated: the
  pause path (`cancelQueuedTranslations`) and teardown (`stop()`) are NOT the
  trigger.
- The blank stays blank: `unregister` deletes the tracked record, the recycled
  element re-registers as a **fresh candidate**, and nothing re-sends it —
  translate-all already ran, and (on a non-auto site) visibility never sends.
  A cache-only hydrate probe misses because the job never completed.

**The economics that shape the fix (do NOT re-litigate):** aborting an HTTP
request that has already been **sent** does not refund anything — the provider
processes and bills the call regardless of client disconnect. So cancelling a
STARTED provider call destroys the cache value while saving ~zero spend. The
existing "stop paying for work nobody will see" rationale is only true for
jobs still **queued**. The pause feature already draws exactly this line with
`startedRequests` ([translateHandlers.ts ~L351–367](../src/background/translateHandlers.ts));
this phase extends that line to the unregister path.

Three fronts, plus one diagnostic aid:

- **§1 Soft-cancel: unregister spares started jobs (the spend-preserving fix).**
  `cancelTranslation` gains an optional `mode`; the unregister path sends
  `"queued-only"`, so a STARTED provider call runs to completion and **caches**.
  Queued jobs still cancel (they cost nothing yet). Teardown (`stop()`) and
  drag-select keep today's hard abort.
- **§2 Translate-all persistence across element recycling (the blank-page fix).**
  `requestAll` arms a persistent intent: while it is armed (same page URL, not
  paused, not torn down), any candidate **registered later** — a recycled
  element's fresh candidate OR a late lazy-loaded page — is auto-sent at
  `TRANSLATE_ALL_PRIORITY`. Combined with §1, a recycled in-flight page
  re-sends, coalesces onto the still-running job by cacheKey (or cache-hits
  after it lands), and renders when ready.
- **§3 Dead-signal guards: no HTTP request is ever created on an aborted
  signal.** Belt-and-braces at three seams (queue task start, post-prep,
  immediately before `fetch`), so the status-0 ghost-request class becomes
  impossible and any residual cancel is a clean, logged, early abort.
- **§4 Cancel diagnostics (cheap, in scope).** One debug log line per cancel
  with mode + started/queued disposition, so the NEXT live pass can attribute
  any cancellation without guessing.

**What the prior evidence established (do NOT re-litigate):**

- The provider/model observed here is OpenAI `gpt-5.6-luna` (~22 s/page). The
  fix is **provider-agnostic**; do not add provider-specific branches. Model
  latency is an aggravator, not the cause, and model choice is out of scope.
- The Phase 9/9.1 anchored reading window governs **visibility-driven** spend.
  Translate-all is explicit intent and **bypasses the window** (existing
  doctrine — `requestAll` calls `sendTranslate` directly). The §2 auto-send is
  a continuation of that explicit intent and also bypasses it; it must NOT be
  gated on `confirmed` anchors.
- The 9.5 whole-balloon prompt work (PROMPT_VERSION 3), dedupe, cover-pad, and
  the whole snap pipeline are **untouched** by this phase. No prompt, prep,
  or render changes.

Read first: `src/content/viewportQueue.ts` (`unregister`, `cancel`,
`requestAll`, `register`, `setPaused`, `stop`, the `Tracked` record);
`src/background/translateHandlers.ts` (`cancelTranslation` ~L1187,
`cancelQueuedTranslations` ~L1226, `startedRequests` ~L351, `requestControllers`
~L348, the solo `addJob` + `onStarted` wiring ~L1020, `translatePrepared`/
`translateTiles` ~L461/486); `src/background/queue.ts` (`start`/`runWithRetry`
~L220/L332, the per-job abort listener ~L241); `src/background/providers/ProviderBase.ts`
(`callOnce` ~L889, `throwIfAborted` ~L1112); `src/shared/messages.ts`
(`cancelTranslation` ~L161); `src/background/sharedAbort.ts` (refcount
semantics — §1 must not break the "abort only when every waiter left" rule);
the Phase 7.4 pause notes and Phase 9.5 summary in `PROGRESS.md`.

**Verified-green baseline (2026-07-21, do NOT rebuild/re-verify): 805 unit
tests via `npm run check`, `npm run test:e2e` 4/4 (A–D) on this machine
(Firefox 153 needs `--remote-allow-system-access`, already wired), `vite build`
clean, `web-ext lint` 0/0/0.**

**Already shipped — do NOT rebuild:** the pause/resume started-boundary
(`startedRequests`), the SharedAbort refcount, the coalesce map, the priority
queue with per-job abort removal, reprioritization (§2 Phase 8), the anchored
reading window, hydrate probes, and the whole Phase 9.x render pipeline.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages. Every exported function/class gets JSDoc; `// WHY:` on every
   non-obvious decision.
2. Pure-core / thin-shell split: the cancel-mode decision table, the
   translate-all-intent predicate ("should this fresh registration auto-send?"),
   and any new planner logic are pure, browser-free, unit-tested functions; DOM
   and messaging stay in the shells.
3. **Sanctioned surface changes — flag each in the PROGRESS summary:**
   (a) `shared/messages.ts`: `cancelTranslation` request gains
   `mode?: "hard" | "queued-only"` (absent ⇒ `"hard"`, so every existing caller
   is byte-compatible). **No new message types, no other message changes.**
   (b) `background/translateHandlers.ts`: the `cancelTranslation` handler honors
   `mode` via the existing `startedRequests` set; a debug log line (§4).
   (c) `background/queue.ts` + `background/providers/ProviderBase.ts` +
   `translateTiles`: the §3 dead-signal guards (a few lines each).
   (d) `content/viewportQueue.ts`: the §2 translate-all persistence state +
   register-time auto-send + the §1 `"queued-only"` cancel from `unregister`.
   Anything beyond: stop and flag before building.
4. **No version bumps.** `PROMPT_VERSION` = 3, `SNAP_VERSION` = 4,
   `CACHE_VERSION` = 2 untouched — nothing in this phase changes prompts, the
   cache key, or cached shapes. This is a **free** phase (no forced
   re-translation).
5. Fail soft, in the cost direction. §1 only ever *narrows* what an abort
   kills (started jobs survive; the spend was already committed). §2 only
   auto-sends under an intent the user explicitly bought (translate-all on this
   exact page URL) and stops the moment that intent lapses (pause, teardown,
   URL change). §3 only *prevents* provider requests (never creates one). A
   failure in any new code must degrade to today's behavior, not to extra
   spend.
6. No test hooks in shipped code (use the existing `…ForTest` seam pattern
   where a seam is genuinely needed). When done: `npm run check` +
   `npm run build` + `npm run lint:ext` clean, **`npm run test:e2e` green with
   Scenarios A–D UNMODIFIED on this machine**, and a Phase 9.6 summary appended
   to `PROGRESS.md` in the house style (deliberate calls + honest
   manual-verification status).

## Suggested landing order

**§3 first** (small, independent, immediately kills the ghost-request class and
gives §1/§2 a clean substrate), then **§1** (message + handler + unregister
call-site), then **§2** (the content-side persistence), then §4 alongside §1.

## New files

None expected. If the §2 intent predicate reads cleaner as a small pure module
next to `viewportQueue.ts`, that is acceptable (flag it). Tests extend
`tests/unit/queue.test.ts`, `providers.test.ts` (or `ProviderBase`-focused
file), `translateHandlers`-adjacent tests if present, and
`tests/unit/viewportQueue.test.ts`.

---

## 1. [Background] Soft-cancel: `cancelTranslation` mode honors the started boundary

**Symptom (HAR):** six jobs cancelled by DOM-reconcile unregisters; the ones
whose provider calls had effectively started were killed for zero refund, and
their near-complete results (~20 s of paid inference each on the 200s that DID
land mid-scroll in past sessions) never reach the cache.

**Build:**

- `shared/messages.ts`: `cancelTranslation` request becomes
  `{ requestId: string; mode?: "hard" | "queued-only" }`. Document: `"hard"`
  (default) aborts unconditionally (today's behavior); `"queued-only"` aborts
  only if the request has not crossed the started boundary — the same
  `startedRequests` line `cancelQueuedTranslations` already draws.
- `translateHandlers.ts` `cancelTranslation` handler: when
  `mode === "queued-only"` and `startedRequests.has(requestId)`, do NOT abort —
  leave the controller registered (the run finishes, caches, and its `finally`
  cleans the registries exactly as a normal completion does). Otherwise abort
  as today. // WHY: an already-sent HTTP call bills regardless of abort;
  finishing it converts sunk cost into a cache entry the recycled element's
  re-send (§2) will hit.
- `content/viewportQueue.ts` `cancel(rec)` (the unregister path): send
  `mode: "queued-only"`. **`stop()` keeps `"hard"`** — teardown is the user
  switching off/leaving; respect it. The region-select cancel path
  (`regionHandlers`/`regionSelect`) is untouched (explicit user cancel stays
  hard).
- SharedAbort interaction (verify, don't guess): with `"queued-only"` sparing a
  started run, the caller's controller never aborts, its waiter stays live, and
  the run proceeds — no refcount change needed. Confirm no listener leak: the
  caller-side `translateImage` `finally` still runs when the run settles
  normally.

**Tests (pure/handler level, using the existing `…ForTest` seams):**
queued id + `"queued-only"` → aborted + deregistered; started id +
`"queued-only"` → NOT aborted, controller retained; started id + `"hard"` (and
mode-absent) → aborted; unknown id → silent no-op. Content side: `unregister`
emits `mode: "queued-only"`; `stop()` emits hard.

## 2. [Content] Translate-all persistence across element recycling

**Symptom (HAR + code):** a recycled `<img>` re-registers as a fresh candidate
that nothing ever sends: translate-all already ran, visibility sends are absent
(non-auto site) or window-gated (auto site), and the hydrate probe misses
because the original job died (§1 now often fixes the *cache* side, but the
fresh candidate still needs a *send* to fetch/coalesce/render it). Late
lazy-loaded pages that register after the click have the same hole today.

**Build (`content/viewportQueue.ts`):**

- `requestAll` (non-dry-run) arms a module-level intent:
  `translateAllIntent = { href: location.href, budgetMs }` where `budgetMs` is
  the same `requestAllTimeoutMs(...)` budget the burst used. // WHY capture
  `href`: MangaDex is an SPA — a later chapter navigation re-registers a whole
  new chapter's images, and auto-sending THOSE would be spend the user never
  clicked for. The URL is the cheapest precise scope for "this chapter".
- `register(candidate)`: after the existing bookkeeping, if the intent is armed
  AND `location.href` still equals `intent.href` AND not `paused`, fire
  `void sendTranslate(candidate, TRANSLATE_ALL_PRIORITY, intent.budgetMs)`.
  The existing `requested` flag already dedupes against anything in flight.
  // WHY not gate on the anchored window: translate-all is explicit intent and
  bypasses the window by existing doctrine; the user bought the chapter.
  // WHY this also covers recycling: the recycled element's fresh candidate
  re-sends → background hashes the same bytes → coalesces onto the §1-spared
  in-flight run or cache-hits the finished one → renders. Cost on the recycle
  path is ~zero (coalesce/cache); real spend only occurs for pages never
  translated — which is exactly the intent.
- Disarm the intent on: `setPaused(true)` (user revoked), `stop()` (teardown),
  and lazily on an `href` mismatch at register time. `hydrateAll` and dry-run
  `requestAll` do NOT arm it.
- Keep the pure part pure: extract the predicate
  (`shouldAutoSend(intent, currentHref, paused, requested)` or similar) and
  unit-test it; the shell just wires it.
- Optional micro-cleanup if trivially safe: skip scheduling a hydrate probe for
  a candidate the intent is about to send (the probe is invisible and loses the
  race anyway — pure noise). Flag if done.

**Tests:** arming on requestAll (not on dry-run); fresh registration while
armed → sent at priority 2; registration after `setPaused(true)`/`stop()`/href
change → not sent; `requested` candidates untouched; the predicate's truth
table. Reuse the existing fake-observer/seam patterns in
`tests/unit/viewportQueue.test.ts`.

## 3. [Background] Dead-signal guards: never create an HTTP request on an aborted signal

**Symptom (HAR):** six fully-serialized requests reached `fetch` with dead
signals (status 0, zero timings). Under current code the cancel should have
either removed the queued job (per-job abort listener) or thrown at
`translatePage`'s entry `throwIfAborted` — the ghosts prove at least one
dequeue→fetch window slips through (the abort lands after the entry check,
during prep/base64/build). Close the class structurally instead of chasing the
exact interleaving:

- `queue.ts`: at the top of each `runWithRetry` attempt (before invoking the
  task), `if (signal.aborted) throw abortReason(signal)`. // WHY here: covers a
  merged signal that was aborted between enqueue-removal racing and task start,
  for every current and future task type.
- `translateHandlers.ts` `translateTiles`: check the signal once after
  `prepareImage` / at the top of the per-tile map, before `sha256Hex`+provider
  call, throwing the provider-shaped abort (`ProviderError("aborted", …)`).
  // WHY: prep is the longest in-slot window (~100–500 ms); a cancel landing
  there currently sails on to base64+fetch.
- `ProviderBase.ts` `callOnce`: `this.throwIfAborted(signal)` immediately
  before `this.fetchFn(...)`. This is the hard guarantee and the seam the
  regression test locks: **an aborted signal must mean `fetchFn` is never
  invoked** (spy assertion). Also covers the repair-retry and 400-downgrade
  re-entries for free.

All three throws must surface as the existing `aborted` kind so every
downstream arm (negative-cache exclusion, silent content handling) behaves
exactly as today.

**Tests:** queue — task never invoked when the job's signal aborted pre-start
(deferred-start seam); provider — `fetchFn` spy not called when the signal is
aborted at `callOnce` (both primary and repair paths); tiles — no provider call
when the signal aborts during prep (seam-injected prep).

## 4. [Diag] Cancel disposition logging

In the `cancelTranslation` and `cancelQueuedTranslations` handlers, one
`log.debug` per id: requestId (short), mode, and disposition
(`started-spared` / `queued-aborted` / `hard-aborted` / `unknown-noop`). No new
flags, no UI. // WHY: this HAR burned a session proving WHERE aborts came from;
the next one should read it off the console.

## Explicitly out of scope

- **Overlay/record migration across recycled elements** (transferring the
  `Tracked` record to the replacement `<img>` instead of cancel+re-send). The
  cacheKey coalesce/cache-hit path (§1+§2) achieves the same render for less
  machinery. Note as considered-and-rejected.
- **Debouncing the `isConnected` reconcile** in `OverlayManager.syncPositions`.
  With §1+§2 the reconcile's cancel is harmless (queued jobs re-send, started
  jobs finish); adding timing heuristics there risks real teardown bugs.
- **Model/latency/concurrency changes.** ~22 s/page on `gpt-5.6-luna` is the
  aggravator; do not change defaults, do not add model logic. (No-code lever
  below.)
- **Batch-path abort rework** (`pagesPerRequest ≥ 2`): batching was OFF in this
  evidence. The §3 queue/provider guards cover the batch path's fetches
  incidentally; anything deeper waits for batch-mode evidence.
- Any prompt, snap, render, cache-schema, or settings-UI change.

## Immediate no-code levers (tell the user; independent of this phase)

1. At ~22 s/page and concurrency 6, a 19-page translate-all needs ~90 s before
   the tail lands — skeletons at the end of the chapter during that window are
   expected, and with this phase they now resolve instead of dying.
2. If the OpenAI tier allows it, raising `concurrency` in Options shrinks the
   tail window linearly; a faster model shrinks it more.

## Manual verification (live key + MangaDex; record honestly if not run)

1. Translate-all at the top of a fresh ≥15-page chapter, then scroll through at
   reading pace without stopping. **Every** page ends translated; the network
   panel shows zero `status 0` provider entries; tail pages may re-send and
   must coalesce/cache-hit (no duplicate paid calls for the same page bytes).
2. Mid-burst, scroll fast to the end and back: recycled pages re-render from
   cache/coalesce; no page is permanently blank.
3. Pause mid-burst: started calls finish and render; queued ones stop (today's
   behavior, unchanged); resume re-plans.
4. Toggle the extension off mid-burst (`stop()` hard path): in-flight calls
   abort as today.
5. Console (debug on): every cancel logs a disposition line.

## Definition of done

- `npm run check` green (805 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` 4/4 with Scenarios A–D
  UNMODIFIED on this machine**.
- Only sanctioned surface changes (ground rule 3): the `cancelTranslation`
  `mode` field (default-hard, byte-compatible); the handler's
  started-boundary check + §4 logging; the three §3 guards; the
  `viewportQueue` intent state, register auto-send, and `"queued-only"`
  unregister cancel. `PROMPT_VERSION` 3 / `SNAP_VERSION` 4 / `CACHE_VERSION` 2
  untouched; no manifest change; no new messages.
- `PROGRESS.md` Phase 9.6 summary in the house style: the thirteenth-live-pass
  evidence (the 6/19 status-0 ghosts, the dequeue-pairing, the recycle-driven
  cancels, zero provider faults), each section's deliberate calls (the
  no-refund economics behind soft-cancel; the href-scoped intent; the
  three-seam guard placement; migration/debounce considered-and-rejected), and
  honest manual-verification status.
