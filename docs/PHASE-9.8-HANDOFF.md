# Phase 9.8 — Staged translate-all dispatch + per-page translating indicator (handoff)

You are implementing **Phase 9.8** of the MangaLens Firefox extension. Two fronts:

- **§1 Staged translate-all dispatch (the reliability + pacing rework).** Today a
  real `requestAll` fires EVERY pending candidate at once. On long chapters that
  builds a deep backlog (~22 s/page at concurrency 6 ⇒ minutes of queue depth for
  the tail), which is exactly the environment where the 9.6 recycle-cancel class
  and per-send timeouts live. This phase converts translate-all into a **sliding
  dispatch window**: an initial batch of `TRANSLATE_ALL_BATCH = 12` pages, then a
  constant ~12-page lead ahead of the user's confirmed reading position, refilled
  as they scroll. The refill pass doubles as a **sweeper** that re-dispatches any
  window-covered candidate whose earlier send reset (timeout/abort) — closing a
  real hole (see below).
- **§2 Per-page translating indicator (the wolf spinner).** A small spinning
  wolf badge in the **top-left corner of each page** while its translation is in
  flight, so the user can tell "being worked on" from "never dispatched". The SVG
  asset is **provided verbatim** in this doc — do not redraw it.

**Evidence status (be honest about it):** the fifteenth live pass (2026-07-23)
reported "still some pages not translated after Translate all", but the exported
HAR was **0 bytes** — there is no request-level evidence this time. Do NOT claim
a diagnosed root cause in PROGRESS. What code reading DOES establish:

- The 9.6 persistence intent re-sends **only on candidate registration**
  (`maybeAutoSendForTranslateAllIntent` fires from `register`). A job whose
  `sendTranslate` times out or resolves `aborted` has its record **reset in
  place** (`requested = false`, re-observe) — and on a **non-auto site the
  re-observe never sends** (observers aren't attached; visibility never
  dispatches). If the element is NOT recycled afterwards, nothing ever re-sends
  it: a permanently blank page with zero HAR evidence. The §1 sweeper closes
  this class structurally.
- Staging also shrinks the backlog every remaining failure class feeds on
  (fewer queued jobs ⇒ shorter dequeue windows, smaller timeout budgets,
  less element churn while queued).

**What prior phases established (do NOT re-litigate, do NOT rebuild):** the 9.6
soft-cancel/intent/dead-signal machinery and 9.7 temperature-race fix are
implemented and reviewed; the anchored reading window (Phase 9/9.1) governs
visibility spend on auto sites; translate-all bypasses that window by doctrine —
**§1 keeps the bypass** (the staged window is a much wider, explicit-intent
window layered on the same confirmed-anchor signal, not the prefetch window);
provider resolution is capped at 1200 px (not a lever); drag-select, hydrate
probes, and priority upgrades bypass everything and are untouched.

Read first: `src/content/viewportQueue.ts` (whole header comment, `requestAll`
~L1152, `register` ~L1110, `maybeAutoSendForIntent` ~L987, `runConfirm` ~L666,
`onTier0Event` ~L762, `classifyRegisterIntent`, `confirmedFlags`,
`anchoredWindowAllows`, `requestAllTimeoutMs`); `src/content/overlay/OverlayManager.ts`
(`setPending` ~L131, `clearContent`, paint lifecycle); `src/content/styles.css`
(`.mangalens-skeleton`, `.mangalens-badge` precedents); `src/content/contentRouter.ts`
(`translateAll` count contract); `src/popup/main.ts` (~L205, ~L224 — how `count`
is shown); `tests/e2e/README.md` + `smoke.spec.mjs` + `chapter.html` +
`mockProvider.mjs`; the Phase 9.6/9.7 summaries in `PROGRESS.md`.

**Verified-green baseline (2026-07-22, do NOT rebuild/re-verify): 828 unit tests
via `npm run check`, `npm run test:e2e` 4/4 (A–D) on this machine (Firefox 153
needs `--remote-allow-system-access`, already wired in the harness `before()`),
`vite build` clean, `web-ext lint` 0/0/0.** Everything since Phase 7.6 is
uncommitted on `master` — that is expected; do not commit.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages. Every exported function/class gets JSDoc; `// WHY:` on every
   non-obvious decision.
2. Pure-core / thin-shell split: the window planner, the max-confirmed helper,
   and the extended register-intent predicate are pure, browser-free, unit-tested
   functions; DOM/observer/messaging stays in the shells.
3. **Sanctioned surface changes — flag each in the PROGRESS summary:**
   (a) `content/viewportQueue.ts`: the §1 staged machinery (constant, pure
   planner, pump, seed pass, observer attach/detach for non-auto sites, the
   extended register-intent decision, per-wave budgets, §4 debug logging).
   (b) `content/overlay/OverlayManager.ts`: `setPending` grows the spinner badge.
   (c) `content/styles.css`: `.mangalens-spinner` + its keyframes +
   reduced-motion arm.
   (d) NEW `content/overlay/spinnerWolf.ts`: the SVG constant + element factory.
   (e) `tests/e2e/`: a NEW long-chapter fixture + Scenario E (§3) + mock-provider
   support it needs; **Scenarios A–D stay byte-identical**.
   (f) JSDoc-only wording updates where behavior descriptions go stale
   (`shared/messages.ts` `translateAll` count doc, `contentRouter.ts` comment).
   **NO `shared/types.ts` change, no new/changed message shapes, no manifest
   change, no options/popup UI change.** Anything beyond: stop and flag.
4. **No version bumps.** `PROMPT_VERSION` 3 / `SNAP_VERSION` 4 /
   `CACHE_VERSION` 2 untouched — nothing here changes prompts, cache keys, or
   cached shapes. A **free** phase (no forced re-translation).
5. Fail soft, in the cost direction. Every new decision point must degrade to
   "dispatch less / later", never to a burst beyond today's behavior. A
   non-finite/negative batch or index must clamp to the SAFE side (the
   `anchoredWindowAllows` NaN precedent). The seed pass wraps every
   `getBoundingClientRect` in try/catch (detached elements) and fails to
   index 0. The spinner must never throw out of `setPending` (wrap the parse;
   fall back to skeleton-only).
6. No test hooks in shipped code (use the existing injectable-seam pattern —
   `getViewport`, `getHref`, `createObserver` — for anything the shell tests
   need). When done: `npm run check` + `npm run build` + `npm run lint:ext`
   clean (0/0/0), **`npm run test:e2e` green with Scenarios A–D UNMODIFIED plus
   the new Scenario E on this machine**, and a Phase 9.8 summary appended to
   `PROGRESS.md` in the house style (deliberate calls + honest
   manual-verification status).

## Suggested landing order

**§1 pure planner + shell**, then **§3 Scenario E** (it locks §1 while it is
fresh), then **§2 spinner** (independent), then §4 logging alongside §1.

---

## 1. [Content] Staged translate-all dispatch

**The design (user-approved, deliberate deviation flagged):** the user proposed
"send 12, then after ~6 pages scrolled send the next 12". Implement the
equivalent but simpler **continuous sliding horizon** instead of chunked
refills, and record the deviation + WHY in PROGRESS: the dispatch horizon is
derived fresh per check as

```
horizon = maxConfirmedIndex(confirmedFlags()) + TRANSLATE_ALL_BATCH
```

so the user always has a constant ~12-page dispatched lead (the chunked scheme
lets the lead sag to 6 before refilling; same total spend, worse pacing, plus a
stored frontier index that goes stale under register/unregister churn — the
exact staleness trap the derived-cursor design already avoids, see the §1 Phase
9 notes in PROGRESS).

**Build (`content/viewportQueue.ts`):**

- `export const TRANSLATE_ALL_BATCH = 12;` — THE tuning knob, next to
  `TRANSLATE_ALL_MAX_TIMEOUT_MS`.
- Pure `maxConfirmedIndex(confirmed: boolean[]): number` → highest `true` index,
  `-1` when none.
- Pure planner `planTranslateAllWindow(input)` with
  `input = { count, anchor, batch, requested: boolean[] }` → the index list to
  dispatch: every `i` with `i <= min(count - 1, max(anchor, 0) + batch - ???)`
  … define it exactly as: `limit = boundedAnchor + batch` where
  `boundedAnchor = max(0, anchor)` (an `anchor` of `-1` — nothing confirmed —
  yields `limit = batch`, i.e. indices `0..batch` — one extra page beyond 12 is
  fine; pick either `batch` or `batch - 1` and pin it in a test) and dispatch
  `{ i | i <= limit && !requested[i] }`. Everything **behind** the anchor is
  always inside the window — translate-all is a whole-chapter promise; a page
  the user scrolled back to must never stay blank. Non-finite/negative `batch`
  clamps to 0 (fail-cheap, rule 5).
- **Arm + initial wave.** `requestAll(dryRun = false)` (real run):
  - Compute `seedIndex`: the LOWEST index whose element's
    `getBoundingClientRect()` intersects the viewport (`getViewport()` seam),
    try/catch per element, fail-soft to `0`. // WHY: a mid-chapter click on a
    non-auto site has NO confirmed anchors; without a seed the initial wave
    would ignore where the user actually is.
  - Initial dispatch = `planTranslateAllWindow` with
    `anchor = max(seedIndex, maxConfirmedIndex(...))`.
  - Per-wave budget: `requestAllTimeoutMs(n, concurrency, requestTimeoutMs)`
    where `n` must cover the worst backlog a wave can sit behind — use
    `dispatchedThisWave + outstandingTranslateAllSends` or a flat `2 × batch`;
    implementer's call, pin it in a test and flag it. Store the arm-time budget
    on the intent for register-path sends as today.
  - **Return value stays the TOTAL pending count** (`pending.length`), not the
    initial wave size — the popup's "Translate N pages?" flow and the
    dry-run/real-run symmetry keep meaning "what this click buys overall".
    Update the `translateAll` JSDoc wording in `shared/messages.ts` (doc-only).
  - Chapters with `pending.length <= batch` behave byte-identically to today
    (everything dispatches in the initial wave) — this is what keeps e2e A/B
    untouched (the fixture is 10 pages).
- **The pump (refill + sweeper).** `pumpTranslateAllWindow()`: if the intent is
  armed (and href still matches — one cheap `getHref()` compare, disarm on
  mismatch) and not paused, run the planner against live
  `order`/`confirmedFlags`/requested flags and `void sendTranslate(...)` each
  planned index at `TRANSLATE_ALL_PRIORITY` with the per-wave budget. // WHY
  this is also the sweeper: `sendTranslate`'s timeout/aborted arms reset
  `requested = false` in place; on a non-auto site NOTHING re-sends such a
  candidate today (observers absent, element not recycled) — every future
  confirm now re-plans it. Call sites: (a) `runConfirm` after a successful
  confirmation (the anchor just advanced); (b) `requestAll` right after arming
  (subsumes the initial wave if you prefer one code path).
- **Confirmed anchors on non-auto sites (the piece that makes the horizon move
  there).** Today observers attach only when `autoEnqueue`. Change:
  - On arming a real translate-all intent with `!autoEnqueue`: attach
    `visibleObserver` to every registered candidate; `register` while armed
    also observes the fresh element. (The `nearObserver` stays auto-only.)
  - `onTier0Event`: the immediate within-window `onTierChange` plan call is
    **gated on `autoEnqueue`** (a non-auto site must never visibility-plan);
    the confirm scheduling runs for both.
  - `runConfirm`: the existing `onTierChange(...)` + `slideWindow(...)` pair is
    **gated on `autoEnqueue`**; both modes then call `pumpTranslateAllWindow()`.
  - On disarm (`setPaused(true)`, `stop()`, href mismatch): when `!autoEnqueue`,
    unobserve all + cancel pending confirms (hygiene — flags may remain; they
    are inert while unarmed on a non-auto site). `stop()` already disconnects.
- **Register-time decision (extends 9.6 §2).** Replace the unconditional
  auto-send: compute the fresh candidate's index (it is already inserted into
  `order` at that point) and the live horizon; extend `classifyRegisterIntent`
  (pure) to take `{ index, limit }` (or equivalent) and return `"send"` only
  when `index <= limit`; beyond-horizon registrations return `"ignore"` and
  stay armed — the pump dispatches them when the horizon arrives. Recycled
  elements (index inside the window) keep the exact 9.6 re-send → coalesce/
  cache-hit behavior.
- Hydrate-probe interplay: `register` still skips the probe only when it
  actually auto-sent; a beyond-horizon registration probes as today (free,
  invisible).

**Tests (`tests/unit/viewportQueue.test.ts` — extend; mechanical updates to
existing translate-all assertions are expected and sanctioned):**
`maxConfirmedIndex` (empty/none/some/last); planner truth table (no anchor ⇒
first batch; anchor advance slides; behind-anchor holes re-planned; requested
skipped; count clamp; batch 0/NaN ⇒ initial-batch-only/empty per the pinned
rule); shell: real `requestAll` on a 30-candidate queue dispatches exactly the
initial wave; a confirm on index k pumps up to `k + batch`; a timeout-reset
candidate inside the window re-sends on the next pump (the sweeper); a
beyond-horizon late registration does NOT send but sends once the horizon
reaches it; non-auto arming attaches observers (fake-observer seam) and disarm
detaches; A/B-equivalent small-chapter (≤ batch) dispatches everything at once;
paused/href-mismatch pumps do nothing. Budget rule pinned.

## 2. [Content] Per-page translating indicator (wolf spinner)

**Build:**

- NEW `src/content/overlay/spinnerWolf.ts`: export the SVG below as a string
  constant `WOLF_SPINNER_SVG` plus
  `createSpinnerBadge(doc: Document): HTMLElement` — a
  `div.mangalens-spinner` (`aria-hidden="true"`) containing the SVG parsed via
  `DOMParser().parseFromString(WOLF_SPINNER_SVG, "image/svg+xml")` +
  `doc.importNode(...)`. // WHY DOMParser, not innerHTML: `web-ext lint` flags
  innerHTML sinks; parse failure (or a runtime without DOMParser) returns the
  bare badge div — fail-soft, rule 5. Do NOT redraw the SVG; paste it verbatim:

```svg
<svg viewBox="0 0 72 64" xmlns="http://www.w3.org/2000/svg">
  <g fill="#fff" stroke="#000" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round">
    <path d="M60 22 L68 28 L64 32 L69 38 L64 41 L67 48 L60 50 L62 44 L58 40 L60 35 L56 28 Z"/>
    <path d="M51 34 L51 53 Q51 56 48 56 L46 56 L46 34 Z"/>
    <path d="M58 32 L58 51 Q58 54 55 54 L53 54 L53 32 Z"/>
    <path d="M33 34 L33 53 Q33 56 30 56 L28 56 L28 34 Z"/>
    <path d="M40 34 L40 51 Q40 54 37 54 L35 54 L35 32 Z"/>
    <path d="M27 26 L22 30 L27 32 L22 36 L27 37 Q26 40 30 40 L41 40 Q44 36.5 47 40 L54 40 Q60 40 60 33 L61 26 Q61 19 56 16 L53 14 L51 10 L47 13 L42 12 L39 8 L36 12 Q30 13 27 18 Z"/>
    <path d="M12 12 L11 2 L17 8 Q20 7 24 8 L30 2 L29 12 L36 16 L31 18 L37 22 L31 24 L34 28 L28 28 L23 32 L20.5 33 L18 32 L13 28 L7 28 L10 24 L4 22 L10 18 L5 16 Z"/>
    <path d="M14 9 L14 5 L17 8 M24 8 L27 5 L27 9" fill="none" stroke-width="2"/>
    <path d="M13 17 L17 19 M28 17 L24 19" fill="none" stroke-width="2.6"/>
    <path d="M17.5 24 L23.5 24 L20.5 27.5 Z" fill="#000" stroke-width="1.4"/>
    <path d="M20.5 27.5 L20.5 29 M16.5 29.5 Q18.5 31 20.5 29 Q22.5 31 24.5 29.5" fill="none" stroke-width="1.8"/>
  </g>
</svg>
```

- `OverlayManager.setPending`: after appending the skeleton, append
  `createSpinnerBadge(document)`. The skeleton STAYS (deliberate — the shimmer
  communicates "this page area", the badge communicates "actively translating";
  flag it). Pending is the only state that shows it: `render`/`setError`/`clear`
  already rebuild the container content, so removal is free. Hydrate probes
  never call `setPending` (unchanged) — cache probes stay invisible.
- `content/styles.css`:
  `.mangalens-spinner` — `position:absolute; top:6px; left:6px; width:28px;
  height:28px; border-radius:50%; background:rgba(255,255,255,0.92);
  box-shadow:0 1px 4px rgba(0,0,0,0.35); display:flex; align-items:center;
  justify-content:center; pointer-events:none; user-select:none;` — the
  `.mangalens-badge` precedent, top-LEFT per the user's request (error badge is
  also top-left but the states are mutually exclusive). Inner `svg` 22×22 with
  `animation: mangalens-spin 1.6s linear infinite` (spin the wolf inside the
  static disc). `@keyframes mangalens-spin { to { transform: rotate(360deg); } }`
  and an `@media (prefers-reduced-motion: reduce)` arm setting `animation: none`
  (the skeleton already has this precedent — a static wolf badge still reads
  "translating").

**Tests:** `spinnerWolf.test.ts` — the constant contains the viewBox + stroke
markers; `createSpinnerBadge` returns a div with the class, `aria-hidden`, and
(in jsdom, which has DOMParser) an `<svg>` child; parse-failure fallback
returns the bare div (inject a broken string via a seam or export the parse
step). OverlayManager-level: `setPending` appends BOTH skeleton and spinner;
`render`/`setError` remove them (extend the existing overlay suite patterns).

## 3. [e2e] Scenario E — staged translate-all on a long chapter

New fixture `tests/e2e/chapter-long.html`: same shape as `chapter.html` but
**30 pages** (server-generated `/pages/N.png` already scales; keep 1–2 blob
pages if cheap, else all plain — flag). New Scenario E in `smoke.spec.mjs`
(A–D byte-identical):

1. Fresh cache/profile, non-auto flow like Scenario A: open the long chapter at
   the top, click Translate all (or drive the same message the popup sends —
   reuse A's mechanism).
2. Assert the mock provider saw an initial burst of **≤ `TRANSLATE_ALL_BATCH`
   + a small slack** (pin the exact expected count from the pinned planner
   rule; the mock provider already counts requests) and the first-wave pages
   paint.
3. Stepped-scroll to ~mid-chapter (Scenario D has the stepping pattern);
   assert request count grows past the initial wave and mid pages paint.
4. Stepped-scroll to the bottom; assert **all 30 pages paint** and total
   requests ≈ 30 (no page left blank, no runaway duplicates — coalesce/cache
   keeps re-sends unpaid; assert on unique page URLs if the mock exposes them).

If the harness fights (timeouts on 30 mock pages, flaky confirms at 682 px
viewport), reduce to 24 pages before weakening assertions, and record honestly
in PROGRESS what E pins vs. what it tolerates.

## 4. [Diag] Dispatch logging

One `log.debug` per wave in the pump/initial dispatch:
`"translate-all wave: n=<sent> range=<lo>..<hi> horizon=<limit> total=<count>"`,
plus one on beyond-horizon register deferrals. // WHY: the 9.8 evidence was an
EMPTY HAR; the next report must be attributable from the console alone.

## Explicitly out of scope

- Any options/popup UI for the batch size (constant only; settings plumbing is
  a later phase if the knob proves contentious).
- Changing visibility/auto-site prefetch behavior, the anchored window, confirm
  thresholds, or `prefetchAhead` semantics.
- Replacing the skeleton shimmer, theming the spinner, or a progress
  counter/percent UI.
- Batch-request mode (`pagesPerRequest ≥ 2`) interactions beyond what the
  planner naturally does (it dispatches per-candidate `sendTranslate` exactly
  as today).
- Any provider/background change — §1 is content-side only.

## Manual verification (live key + MangaDex; record honestly if not run)

1. Long chapter (≥ 25 pages), top, Translate all: network shows ~12 initial
   requests, not the whole chapter; scrolling at reading pace keeps a steady
   ~12-page translated lead; reaching the end leaves **zero blank pages**.
2. Mid-chapter click: the visible page + the next ~12 dispatch first; earlier
   pages fill in; scrolling back up shows no blanks.
3. Kill one request mid-flight (devtools offline blip): the page's spinner
   persists/retries and the page eventually paints after later confirms (the
   sweeper), instead of staying blank.
4. Every pending page shows the wolf badge top-left, spinning; it disappears
   the moment the fill paints; `prefers-reduced-motion` shows it static.
5. Pause mid-burst still stops the queued sends and disarms persistence
   (unchanged 9.6 behavior); resume + re-click re-stages.

## Definition of done

- `npm run check` green (828 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` green: Scenarios A–D
  UNMODIFIED + new Scenario E on this machine**.
- Only sanctioned surface changes (ground rule 3); `PROMPT_VERSION` 3 /
  `SNAP_VERSION` 4 / `CACHE_VERSION` 2 untouched; no manifest change; no new
  messages; no `shared/types.ts` change.
- `PROGRESS.md` Phase 9.8 summary in the house style: the empty-HAR evidence
  status (claim the sweeper-hole closure as code-derived, NOT HAR-proven), the
  continuous-horizon deviation from the user's chunked proposal + WHY, the
  seed-index rationale, the non-auto observer attach/detach rules, the
  return-count contract call, the skeleton-stays call, the budget rule, and
  honest manual-verification status.
