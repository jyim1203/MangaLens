# Phase 7.4 — Live-site fixes round 3: corner-format bboxes, edge clamp, overlap trim, pause queue (handoff)

You are implementing **Phase 7.4** of the MangaLens Firefox extension — a
point-phase (precedent: 4.1 / 5.1 / 7.1 / 7.2 / 7.3) driven by the THIRD
live-browser verification (2026-07-11, Firefox release build, **Anthropic
provider, `claude-haiku-4-5`** — the user switched off the Gemini default a
while back). It lands before Phase 8 (docs/PHASE-8-HANDOFF.md). Unlike 7.3,
this phase IS allowed to touch the prompt layer: it bumps `PROMPT_VERSION`
(7.3's step-8 evidence has been collected — see below).

## Live evidence (HAR capture, 2026-07-11)

A full network capture of one chapter's translation run (22 `v1/messages`
calls, keyoapp-style reader) was taken per 7.3's step 8. The raw `tool_use`
inputs settle the "sloppy boxes" question conclusively:

**Finding 1 — the model returns CORNER-format boxes.** The schema demands
`bbox: [x, y, width, height]` (fractions 0–1), but roughly half of all returned
regions are unmistakably `[x_min, y_min, x_max, y_max]`. Representative rows
(call 0 — the page from the user's screenshots):

```
[0.550, 0.320, 0.950, 0.420]  "呃…我們先整理一下狀況吧"   → as w/h: 95%-of-page wide, spills past the right edge
                                                          → as corners: a plausible bubble (0.55,0.32)–(0.95,0.42)
[0.550, 0.420, 0.950, 0.480]  "我成為妳的騎士"            → same pattern, and it OVERLAPS the row above when read as w/h
[0.350, 0.190, 0.650, 0.230]  "Episode 82-2"              → corners; as w/h it's 65% of the page wide
```

Some calls are entirely corner-format (calls 5, 10, 13–15), some entirely
legit w/h (calls 3, 11, 16), and some MIX the two row by row (call 17). Read
as w/h, a corner box renders roughly twice as wide/tall as reality, extending
right+down over its neighbours — exactly the overlapping, bubble-missing,
edge-spilling boxes in the user's screenshots, on BOTH the auto page path and
drag-select. Coordinates also sit on a coarse ~0.05 grid (the model estimates,
it doesn't measure), so mild residual sloppiness will remain after the format
fix; that residual is model quality, not geometry.

**Finding 2 — sanitize lets boxes escape the image.** `parseBbox`
(ProviderBase.ts) clamps each component to [0,1] INDEPENDENTLY, so `x + w` can
reach 2.0 — a box can legally render past the drawn bitmap's right/bottom edge.
The 7.3 handoff and PROGRESS.md claim "clamped to [0,1] by sanitizePage, so a
bubble physically cannot escape the bitmap" — that claim is FALSE as written
and the 7.4 PROGRESS summary must correct it.

**Finding 3 — observed, NO code change:** (a) call 7 hit `stop_reason:
"max_tokens"` at 8192 output tokens with zero regions (a degeneration loop);
the existing repair retry covered it — accept, don't build a guard. (b) call 12
contains true duplicate detections at different positions (same `original`,
IoU < 0.85) — the identical-dedupe correctly can't catch them; the item-3
overlap trim softens the cosmetic damage. (c) Haiku 4.5's *transcription* of
vertical CJK is visibly garbled (wrong column order); that's model quality —
out of scope, note for the user (Sonnet or Gemini transcribe manga better).

The user also requested one small feature: **pause the translate-all queue**
("stop translating more pages than already started") — item 4.

Read first: docs/PROMPTS.md §2–§3 (canonical schema + system prompt — this
phase edits both), `src/background/providers/prompt.ts`,
`src/background/providers/ProviderBase.ts` (`parseBbox` / `sanitizePage`),
`src/content/viewportQueue.ts`, `src/background/translateHandlers.ts`
(`requestControllers`, `cancelTranslation`), `src/background/queue.ts` (per-job
abort while queued already dequeues — queue.ts:210), `src/content/contentRouter.ts`,
`src/popup/popupLogic.ts`. Baseline is green: 477 unit tests, typecheck,
ESLint, `vite build`, `web-ext lint` (0 errors / 0 warnings / the known
`data_collection_permissions` notice — Phase 8 clears it, not this phase).

**Already shipped — do NOT rebuild:**
- The Phase 7.3 object-fit geometry (`contentBox.ts`, host-covers-content-rect,
  drag-crop normalization). The mapping is CORRECT; this phase fixes what the
  provider puts INTO it.
- `regionToPx` / `geometry.ts` — still the ONE bbox→px conversion, byte-identical.
- `remapBboxFromTile` and the crop-as-tile region path — corner→{x,y,w,h}
  conversion happens in `parseBbox`, BEFORE remap, so tiles/crops need zero change.
- The `cancelTranslation` message + `requestControllers` registry + SharedAbort
  refcounting — item 4 composes with them, it does not replace them.
- `sanitizePage`'s area floors/ceilings, empty-text drops, needs-retry fraction,
  identical-dedupe — all unchanged; only `parseBbox` inside it changes.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages.
2. Every exported function/class gets JSDoc; every module gets Vitest coverage
   (pure-core / thin-shell split).
3. Contract scope for THIS phase: `prompt.ts` wording + canonical schema,
   `PROMPT_VERSION` (→ 2), `shared/messages.ts` (three new entries), popup +
   contentRouter + viewportQueue + translateHandlers wiring. **NO
   `shared/types.ts` shape changes** (`BBox` stays `{x,y,w,h}`), **no
   `shared/settings.ts` changes** (pause is runtime state, not a setting),
   cache-key COMPOSITION untouched (the PROMPT_VERSION value inside it changes —
   that's the point: old entries with old-format-era boxes go stale naturally).
4. Fail soft: a malformed bbox degrades to a dropped region, a failed pause
   message degrades to "nothing paused", never to a thrown listener.
5. `// WHY:` comments on non-obvious decisions; PROGRESS.md summary paragraph
   in house style when done.

## New files

```
tests/unit/overlapTrim.test.ts     # item 3 pure coverage
src/content/overlay/overlapTrim.ts # item 3 pure function (or fold into regionFilter.ts — implementer's call; flag which)
```

Touched: `docs/PROMPTS.md` (§2 schema, §3 bounding-box rules),
`src/background/providers/prompt.ts`, `src/shared/constants.ts`
(PROMPT_VERSION), `src/background/providers/ProviderBase.ts` (parseBbox),
`src/content/overlay/OverlayManager.ts` (paint chains the overlap trim),
`src/content/viewportQueue.ts`, `src/background/translateHandlers.ts`,
`src/shared/messages.ts`, `src/content/contentRouter.ts`,
`src/popup/popupLogic.ts` + `src/popup/main.ts` + popup HTML, `PROGRESS.md`,
plus the pinned-prompt tests (`tests/unit/prompt.test.ts`,
`tests/unit/constants.test.ts`) and the viewportQueue/contentRouter test files.

---

## 1. Canonical bbox format → corners (the Finding-1 fix; PROMPT_VERSION bump)

Change the canonical schema's `bbox` to the format the model demonstrably
wants to emit — **`[x_min, y_min, x_max, y_max]`, fractions of the image
dimensions, x-first** — instead of fighting its training with `[x, y, w, h]`.
The HAR shows Haiku already emits exactly this (x-first, 0–1 fractions) about
half the time DESPITE being asked for w/h; asking for corners turns its failure
mode into compliance.

- `CANONICAL_SCHEMA` bbox description becomes: `"[x_min, y_min, x_max, y_max]:
  the box's top-left and bottom-right corners, as fractions 0-1 of the image
  dimensions. x is horizontal (0 = left edge), y is vertical (0 = top edge).
  x_max must be greater than x_min, y_max greater than y_min."` Keep `type:
  number, minimum: 0, maximum: 1, minItems/maxItems: 4` — all dialect
  converters (Gemini strip-additionalProperties, OpenAI strict strip-ranges,
  Anthropic as-is) derive unchanged.
- `SYSTEM_PROMPT_TEMPLATE` BOUNDING BOX RULES rewritten to match: format line
  says corners; keep the rules that earn their keep verbatim where possible
  ("tightly enclose the TEXT itself…", "Never let boxes extend past the image
  edges.", "Two different bubbles must never share one box…"). Add one line:
  "Boxes for different regions should not overlap." (cheap, targets Finding 3b).
- **`PROMPT_VERSION` → 2** (constants.ts). Update the pinned tests
  (`prompt.test.ts` pins prompt bytes, `constants.test.ts` pins the version).
  Update docs/PROMPTS.md §2/§3 so the doc and module stay mirror images —
  the module header demands it.
- WHY x-first fractions and not Gemini's native y-first 0–1000 `box_2d`: the
  live provider is Anthropic and the HAR shows x-first fractions are Haiku's
  natural emission. A Gemini-specific schema dialect (y-first, 0–1000) is a
  plausible future follow-up but needs its own live evidence — see out-of-scope.

🧪 *Tests:* update the pinned prompt/schema strings; assert all three dialect
converters carry the new description through; PROMPT_VERSION === 2.

## 2. `parseBbox`: corners-first parse + JOINT edge clamp (Findings 1+2 defense)

`parseBbox` (ProviderBase.ts) becomes format-defensive, so a model that
ignores the new instructions (or a third-party OpenAI-compatible endpoint that
still emits w/h) degrades gracefully instead of rendering garbage:

- **Array `[a, b, c, d]`** (the schema path): read as corners — `x = a, y = b,
  w = c − a, h = d − b`. If `w ≤ 0` or `h ≤ 0`, the row can't be corners: fall
  back to the legacy w/h reading (`w = c, h = d`). // WHY corners-first: the
  schema now ASKS for corners, so corners is the compliant reading; the
  ambiguous case (both readings geometrically plausible) must trust the schema.
- **Object `{x, y, w, h}`**: unchanged (back-compat with any model emitting the
  old object form).
- **Joint clamp, ALL paths (the Finding-2 fix):** after the format is resolved,
  clamp `x, y` to [0,1], then `w = min(w, 1 − x)`, `h = min(h, 1 − y)` (and
  drop the region if `w ≤ 0` or `h ≤ 0` after clamping, as today via the area
  floor). This makes "a bubble physically cannot escape the bitmap" TRUE at
  last — no box can render past the drawn page's right/bottom edge regardless
  of what the model emits.
- Everything downstream is untouched: `sanitizePage`'s area/dedupe rules,
  `remapBboxFromTile` (conversion happens before remap, so tiles and
  drag-select crops inherit the fix for free), the cached `BBox` shape.

🧪 *Tests* (extend the existing parseBbox/sanitizePage suites; use HAR literals
as fixtures): `[0.550, 0.320, 0.950, 0.420]` → `{x:0.55, y:0.32, w:0.40,
h:0.10}`; a legacy w/h row whose corners reading is invalid (`d < b`, e.g.
`[0.35, 0.18, 0.25, 0.08]`) → w/h fallback; ambiguous-but-corner-valid row →
corners; joint-clamp: `x=0.85, w→x_max=0.99` style overflow can't exceed the
edge; object form unchanged; degenerate-after-clamp dropped; non-finite → null.

## 3. Render-time overlap trim (Finding 3b / the user's "boxes overlapping")

Live evidence now exists (7.3 deferred this "until live evidence"): even under
the corner reading, adjacent returned boxes overlap (coarse-grid estimates,
plus true duplicates like call 12). Add a small, deterministic, PURE post-step
applied at paint time — the cache keeps the provider's honest boxes; this is a
*view* fix, same principle as `filterRegions`.

`trimOverlaps(regions: TranslatedRegion[]): TranslatedRegion[]` (new pure
function, content overlay layer):

- For each ordered pair (i < j, reading order) whose bboxes intersect with
  positive area: shrink BOTH boxes along the single axis with the SMALLER
  overlap extent, each giving up half the overlap (split the difference). Work
  on copies; never mutate the cached page.
- **Cap** each box's cumulative shrink at 30% of its original size per axis;
  if the cap would be exceeded (or one box CONTAINS the other), leave the pair
  overlapping — a contained duplicate is a detection error that trimming would
  mangle, and draw order already stacks them readably. // WHY trim, not merge:
  merging two different-text regions would invent a bubble that doesn't exist.
- Wire: `OverlayManager.paint` chains it after `filterRegions` (regions →
  filter → trim → regionToPx loop). `paintedRects`/peek indexing needs no
  change — it already indexes the painted array, and paint re-derives the same
  order deterministically (both functions are pure).

🧪 *Tests:* disjoint boxes unchanged; horizontal-neighbour overlap split
evenly on x; vertical on y; axis choice (wide-flat overlap trims y);
cap honoured (deep overlap left alone past 30%); containment untouched;
input array not mutated; deterministic (same input → same output).

## 4. Pause the translate queue (user feature: "stop translating more pages than already started")

Semantics (spec'd): pausing **lets every already-STARTED provider call finish
and render**, **aborts every queued-but-not-started page job**, and **stops new
sends** (visibility, prefetch, translate-all) until resumed. Pause is per-tab
RUNTIME state — it dies with the content script on navigation (WHY not a
setting: a persisted pause that silently disables translation across sessions
is a support trap).

Background — one new message + a started-marker:

- `translateHandlers.ts`: next to `requestControllers`, add
  `const startedRequests = new Set<string>()`. Thread an `onStarted` callback
  from the `translatePage` handler down through `translateImage` →
  `runTranslateMiss`, invoked as the FIRST statement inside the queue task
  closure (`queue.add((qSignal) => { onStarted?.(); return translatePrepared(…) }`).
  The handler registers `() => req.requestId && startedRequests.add(req.requestId)`
  and deletes the id in the same `finally` that clears `requestControllers`.
  // WHY the task closure: `PriorityQueue` invokes it exactly when the job
  leaves the wait list — the precise "started" boundary; nothing else needs to
  know about queue internals.
- New message `cancelQueuedTranslations: { request: { requestIds: string[] },
  response: { cancelled: number } }` (background handler): for each id with a
  registered controller AND `!startedRequests.has(id)`, abort it (same
  DOMException as `cancelTranslation`) and count it. Already-started/unknown
  ids are silently skipped — that's the feature.
- Coalescing caveat (WHY-note, accept): a FOLLOWER of a coalesced run never
  reaches `queue.add`, so it is never marked started; pausing aborts the
  follower's waiter while the leader's run completes and caches. The paused
  page then renders from cache on resume — correct and free.
- The abort path needs NO new content handling: each aborted `translatePage`
  promise resolves `{ok:false, errorKind:"aborted"}`, and viewportQueue's
  existing aborted branch (reset `requested`, clear skeleton, reobserve)
  becomes reachable exactly as its comment anticipated.

Content — `ViewportQueue` gains pause state:

- `setPaused(paused: boolean): Promise<number>` + `isPaused(): boolean`.
  Pausing: set the flag, collect every tracked rec's live `requestId`, send ONE
  `cancelQueuedTranslations`, resolve with the cancelled count (0 on failure —
  fail soft). Resuming: clear the flag, then `reobserve` every tracked
  candidate with `requested === false` so still-visible images re-plan on auto
  sites (IntersectionObserver fires on transitions only — same reasoning as the
  timeout retry path). On non-auto sites resume restores nothing by itself; the
  user re-clicks Translate all (WHY-note it).
- `sendTranslate` gates: early-return while paused BEFORE flipping `requested`
  and before `overlay.setPending`; re-check the flag after the async
  `acquireBytes` gap (same pattern as the teardown re-check).
- `requestAll` while paused: no-op returning 0 (both dry-run and real) — the
  popup disables the button anyway.

Messages + router + popup:

- `setTranslationsPaused: { request: { paused: boolean }, response: { paused:
  boolean; cancelledQueued: number } }` and `getTranslationsPaused: { request:
  void, response: { paused: boolean } }` — popup → content (tab message).
  `contentRouter.ts`: extend the `getQueue` Pick with
  `setPaused`/`isPaused`; inert tab → `{ paused: false, cancelledQueued: 0 }` /
  `{ paused: false }` without touching anything (same inert-safety as
  translateAll).
- Popup: one toggle button next to Translate all — "Pause queue" ↔ "Resume" —
  reflecting `getTranslationsPaused` on open; hidden/disabled when the page is
  inert (same gate as `regionSelectEnabled`). While paused, disable Translate
  all. Decision helpers (label/disabled states) go in `popupLogic.ts` pure and
  tested, per house style.

🧪 *Tests:* viewportQueue (existing seams): pause blocks a visibility send;
pause blocks requestAll (returns 0); an in-flight request that resolves during
pause still renders; a request aborted by pause resets to unrequested + clears
overlay; resume reobserves unrequested candidates (fake observer records
re-observation); the acquireBytes-gap re-check. contentRouter: inert-tab
responses for both new messages. translateHandlers: `cancelQueuedTranslations`
aborts a registered-not-started id, skips a started id (drive `onStarted`),
skips unknown ids, response counts correctly. popupLogic: label/disabled
decisions.

## Manual verification (REQUIRED — append results to PROGRESS.md)

Steps 2–5 double as the 7.3 manual pass that was never fully executed — record
them as covering both phases.

1. Build, load as temporary add-on, Anthropic key (`claude-haiku-4-5`, the
   live-evidence model), site opted in.
2. **The Eminence-in-Shadow page from the 2026-07-11 screenshots**: auto
   translate → boxes sit ON their bubbles (top-right bubble column no longer
   spans half the page), nothing renders past the drawn page's edges, no
   gross box-on-box overlap.
3. **Drag-select the two right-side bubbles** (the manual sample that looked
   wrong): the two boxes land inside the selection on their own bubbles.
4. **Letterboxed reader, "Fit Both"** (the 7.3 case): bubbles letterbox-align;
   switch Fit Both → Fit Width → overlays re-align; peek over a letterbox bar
   does nothing (7.3 steps 2/3/5).
5. MangaDex spot-check (blob + default layout): unregressed (7.3 step 7).
6. **Pause:** Translate all on a 10+ page chapter; while skeletons are up,
   hit Pause → in-flight pages (concurrency count) finish and render, every
   other skeleton clears, network shows no new `v1/messages` calls. Resume →
   on an auto site scrolled-to pages re-queue; on a manual site re-click
   Translate all → the rest translate (cache serves any coalesced stragglers).
7. **Cost sanity:** the popup counter increments only for calls that actually
   ran (paused pages cost nothing).
8. If box quality is still poor AFTER the format fix: capture one raw response
   (same HAR method) and compare against the corner reading — if the model now
   emits garbage in BOTH readings, that's model quality; note it and consider
   trying `claude-sonnet-5` / Gemini before any further prompt surgery.

## Explicitly out of scope (do NOT build)

- **Per-provider bbox schema dialects** (e.g. Gemini's native y-first 0–1000
  `box_2d`) — needs Gemini live evidence; the canonical corner format is
  expected to help all providers.
- **A max_tokens degeneration guard** (Finding 3a) — one occurrence, the
  repair retry absorbed it.
- **Merging duplicate detections** (call 12) — the overlap trim's containment
  rule deliberately leaves them; revisit only if they're common.
- **Persisting pause state** across navigations/sessions, or a global
  (all-tabs) pause.
- **Prompt work beyond the bbox format + one no-overlap line** — transcription
  quality on vertical CJK is model choice, not prompt surgery; the golden eval
  guards against regressions, not model limits.
- Everything in PHASE-8-HANDOFF.md.

## Definition of done

- `npm run check` green (all 477 existing tests green, updated where this
  phase changed pinned strings/behavior; new coverage per the 🧪 blocks).
  `npm run build` clean; `npm run lint:ext` 0 errors / 0 warnings (the
  `data_collection_permissions` notice remains — Phase 8).
- `PROMPT_VERSION === 2`; docs/PROMPTS.md §2/§3 match `prompt.ts` byte-for-byte
  where the doc quotes it; cache-key COMPOSITION unchanged.
- **`npm run eval:live` re-run** (PROMPTS.md §8 — prompt wording changed).
  Needs a real key; if the implementation session can't run it, record that
  honestly in PROGRESS.md as the outstanding item (7.3 precedent).
- `shared/types.ts` and `shared/settings.ts` untouched; `shared/messages.ts`
  gains exactly the three new entries.
- The manual pass above EXECUTED and recorded honestly in PROGRESS.md.
- PROGRESS.md gets a Phase 7.4 summary flagging: the HAR evidence (corner-format
  emission, with call numbers), the canonical-format reversal and why
  (schema-follows-model, not model-follows-schema), the corners-first + joint
  clamp defense in `parseBbox` — **including the explicit correction of the
  7.3 "bboxes are clamped so a bubble can't escape the bitmap" claim** —
  the render-time overlap trim (view-layer, cache untouched), and the pause
  feature's started-vs-queued semantics with the coalesced-follower caveat.
