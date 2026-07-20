# Phase 9 — Reading-window prefetch budget + shaped bubble fills (handoff)

You are implementing **Phase 9** of the MangaLens Firefox extension: (A) a hard
**reading-window budget** on auto-translate so at most `prefetchAhead` pages
beyond the user's actual reading position are ever sent to the provider — plus
the visibility-confirmation pass that makes the budget trustworthy — and (B)
**shaped bubble fills**: the overlay's fill layer follows the actual speech-
bubble outline (oval / cloud / wavy / thought) instead of covering art with a
rounded rectangle, by keeping the contour the `bubbleSnap` flood fill already
computes and currently throws away. WHY "Phase 9": Architecture §8 numbers
post-submission work "Phase 9+"; "1.0" stays reserved for the store-submission
milestone itself.

Both items are driven by the sixth live pass (2026-07-17, Anthropic
`claude-sonnet-5`, HAR captured from the background page):

- **The prefetch evidence.** The user opened a chapter on an auto-opted reader,
  stayed near the top, and the HAR shows **14 `v1/messages` POSTs in one
  25-second burst** starting the moment the page loaded (02:29:18 → 02:29:43,
  first ~6 staggered over ~5 s as candidates registered, the rest as
  concurrency-6 slots freed). With the default `prefetchAhead: 3` the expected
  cold-open spend is ~5–6 pages (visible + near + 3). The whole chapter went
  out. Root cause is structural, not a regression: `planEnqueues` bounds only
  the *extra* prefetch per visibility event — every candidate the browser
  reports as intersecting is sent at its own tier, and manga readers generate
  **false tier events** during load (lazy-load accordion: image N briefly sits
  at the fold while pages above it are still collapsed; or stacked pages hidden
  via `opacity`/`visibility`, which still "intersect" to an
  IntersectionObserver). The exact mechanism on the live reader is unconfirmed
  (the HAR was captured on the background page, so it names no site); the fix
  below is deliberately site-agnostic and §6 adds the e2e regression that
  reproduces the *class*. The user is cost-sensitive — this burst is real money
  on Sonnet — so item A is the priority item of the phase.
- **The immersion request.** Rectangles cover art. The user supplied a
  bubble-taxonomy reference (oval / blast / cloud / wavy / rectangular /
  thoughts / electronic / flash / inverted-flash) and asked for fills that hug
  the bubble. The key observation: **`snapRegionToBubble` already flood-fills
  the exact bubble blob** — the rectangle we paint is the bounding box of a
  shape we computed and discarded. Item B keeps it.

Read first: `docs/ARCHITECTURE.md` §7.5 (priority/prefetch design this phase
hardens), §7.7 (render rules), §9 (handoff rules); the Phase 5/5.1 viewportQueue
summaries, Phase 7.5/7.6 bubbleSnap summaries, and Phase 8 §2/§3 + 8.1 §6 in
`PROGRESS.md`; `src/content/viewportQueue.ts` (`planEnqueues`, `onTierChange`,
`reobserve`, `sendTranslate`); `src/background/bubbleSnap.ts` (`floodFill`,
`snapRegionToBubble`, `snapAllRegions`, `splitGroup`); `src/content/overlay/
BubbleBox.ts` + `textFit.ts`; `tests/e2e/smoke.spec.mjs` + `mockProvider.mjs`.

**Verified-green baseline (2026-07-16, do NOT rebuild/re-verify): 640 unit
tests via `npm run check`, `npm run test:e2e` 3/3 on this machine, `vite build`
clean, `web-ext lint` 0 errors / 0 warnings / 0 notices.**

**Already shipped — do NOT rebuild:**
- `planEnqueues` (tier planning + §2 upgrade instructions), `reobserve()`
  (transition-only IO workaround), pause, hydrate probes, translate-all with
  the backlog-scaled timeout, live `setPrefetchAhead`. Item A *extends* the
  planner; it does not replace this machinery.
- `bubbleSnap.ts` end-to-end: seeds, flood fill, glyph-counter/leak guards,
  7.6 shared-blob split + swallow guard, both call sites
  (`translateHandlers.ts` / `regionHandlers.ts`). Item B adds contour capture
  *inside* the accepted-fill path; the seed/guard/group logic is untouched.
- The overlay repaint machinery (`displayedSizeChanged` re-render on resize,
  rAF-coalesced position sync). Shaped fills recompute per repaint for free —
  add NO new listeners.
- `trimOverlaps`, `filterRegions`, `regionToPx` — render pipeline order stays
  `filterRegions → trimOverlaps → regionToPx`.
- The e2e harness (selenium + geckodriver, PNG mock pages, two-tab pattern,
  conditional grant). §6 adds one scenario; the driver stays.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3
   **event pages**.
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Pure-core / thin-shell split everywhere: timers, IntersectionObserver,
   canvas, and DOM stay in thin untested shells; every *decision* (window
   gating, cursor advance, visibility confirmation, contour trace, simplify,
   path building, inscribed-rect search, fill-color pick) is a pure,
   browser-free, unit-tested function.
4. **This phase sanctions ONE `shared/types.ts` change** (flag it in the
   PROGRESS summary as prior phases did): `TranslatedRegion` gains
   `shape?: Array<[number, number]>` and `fillColor?: string` — both optional,
   both additive (§3/§5). Anything beyond: stop and flag before building.
   **NO new `shared/messages.ts` entries** (shape/fill ride inside
   `PageTranslation`), no manifest change.
5. All coordinates normalized 0–1 relative to the ORIGINAL full image
   (`shape` points included); convert only at render time.
6. Fail soft: a missing/degenerate shape renders exactly today's rounded
   rect; a failed contour trace keeps the snapped bbox; a window-gate bug must
   err toward *suppressing* sends, never bursting. Nothing may break the host
   page.
7. `// WHY:` on every non-obvious decision.
8. **`PROMPT_VERSION` stays 2** (no prompt-layer change of any kind) and
   **NO `CACHE_VERSION` bump** (§3 — the new fields are additive; pre-Phase-9
   entries simply render rectangles until they age out; retiring the store
   re-pays provider $ for every cached page, the exact cost the 7.6 precedent
   refused).
9. No test hooks in shipped code; e2e seeds via prefs/driver only.
10. When done: `npm run check` + `npm run build` + `npm run lint:ext` clean,
    `npm run test:e2e` green (now four scenarios) **on this machine**, and a
    **Phase 9 summary** appended to `PROGRESS.md` in the house style (flag the
    types change, the deliberate calls, and honest manual-verification status).

## New files

```
src/content/overlay/shapePath.ts        # pure: shape → box-local smoothed path + inscribed text rect
tests/unit/shapePath.test.ts
tests/unit/viewportWindow.test.ts       # pure window/cursor/confirm planners (or fold into viewportQueue.test.ts)
```

Touched: `src/content/viewportQueue.ts` (§1 window gate + cursor, §2
confirmation), `src/content/overlay/BubbleBox.ts` (§5 shaped fill + inscribed
text rect + §7 fill color), `src/background/bubbleSnap.ts` (§3 contour capture +
§7 sampled color + dark-polarity fill), `src/shared/types.ts` (rule 4, the two
optional fields), `src/options/index.html` + `public/_locales/en/messages.json`
(§1 prefetch hint copy), `tests/e2e/smoke.spec.mjs` + `tests/e2e/chapter.html`
if needed (§6 Scenario D), plus the touched modules' existing test files.

---

## 1. [PRIORITY — the cost guarantee] Reading-window budget in the viewport queue

Make `prefetchAhead` a **hard invariant**, not a per-event increment: no
auto-send (visibility tier OR prefetch) may target a candidate more than
`prefetchAhead` positions past the furthest page the user has *confirmed*
visible. Translate-all, drag-select, upgrades of already-sent requests, and
hydrate probes (zero spend) all bypass the window — explicit intent is never
gated.

**Build (all in `viewportQueue.ts`, pure planner + thin shell):**

- **Cursor.** Each `Tracked` record gains `confirmedVisible?: boolean`, set
  only by the §2 confirmation pass. The cursor is derived, not stored:
  `max(index of tracked candidates with confirmedVisible)` over the current
  doc-ordered list (pure helper over the same map `sentPriorities()` builds).
  WHY derived-per-plan and element-keyed: `order` mutates on lazy
  registration/unregistration, so a stored numeric cursor goes stale; deriving
  from flags survives reorder and removal. O(n) per tier event is nothing at
  chapter scale.
- **Window gate in the planner.** `PlanInput` gains `cursor: number | undefined`
  (undefined = nothing confirmed yet). `planEnqueues` suppresses **fresh
  sends** (not `upgrade` instructions — those jobs are already paid for) whose
  index exceeds `cursor + prefetchAhead`; a *confirmed* tier-0 candidate is by
  definition within the window (it just advanced the cursor). While `cursor`
  is undefined, only the confirmed tier-0 candidate itself may send. WHY gate
  in the planner and not `sendTranslate`: `requestAll` calls `sendTranslate`
  directly and must stay ungated.
- **Suppressed candidates re-plan when the window slides.** Track
  `suppressed: boolean` on the record when the gate rejects it. On every
  cursor advance, `reobserve()` suppressed candidates now inside the new
  window (the existing transition-only-IO workaround — `observe()` redelivers
  current state, which re-plans them). Without this a suppressed page whose
  tier never changes again would wedge exactly like the Phase 5.1 item-6 bug.
- **Options copy.** Update the `prefetchAhead` hint (options HTML +
  `_locales`) to state the new guarantee: "at most this many pages past your
  reading position are ever auto-sent".

Priorities, the queue, batching, pause, and the background are untouched —
this is entirely a content-side send-authorization change.

🧪 *Tests (pure planner):* beyond-window fresh send suppressed at tier 0 and
tier 1; within-window unchanged (byte-identical plans for the existing cases
with a generous cursor); upgrades never suppressed; `cursor` undefined → only
the confirmed candidate; prefetch clamped to the window edge (window, then
count). *Shell (fake observers, existing harness):* suppressed candidate
re-observed + sent after cursor advance; never re-observed while still outside;
`requestAll` ignores the window (sends everything); prefetchAhead=0 → strictly
on-view sends only; unregister of the cursor-holding element → cursor falls
back to the next confirmed index (no crash, no burst).

## 2. [PRIORITY — makes §1 trustworthy] Tier-0 confirmation (kill false "visible" events)

The window only holds if the cursor can't be advanced by a page that *streaked
through* the viewport during lazy-load layout shift, or by a stacked page
hidden with `opacity`/`visibility` (both still fire `isIntersecting`).

**Build:** a tier-0 IO event no longer acts directly. It schedules a
**confirmation** after `CONFIRM_DELAY_MS` (~300 ms; exported constant,
injectable for tests like `requestTimeoutMs`): re-read
`getBoundingClientRect()` and require (a) a meaningful viewport overlap —
pure `confirmVisibility(rect, viewportW, viewportH)` with an exported
threshold (suggest: overlap height ≥ 48 px or ≥ 50% of the candidate's
height, whichever is smaller) — and (b)
`el.checkVisibility({ opacityProperty: true, visibilityProperty: true })`
(feature-detect; absent → treat as visible, fail-open — the window still
bounds the damage). On confirm: set `confirmedVisible`, re-run the plan at
tier 0. On reject: drop the event silently; the observer pair will fire again
on the next real transition (and `reobserve` on window slides covers the
rest). One pending confirm per element, cancelled on unregister/stop.

- WHY confirm-then-plan instead of plan-then-confirm: an unconfirmed tier-0
  *within* the current window may send immediately (it's inside the budget the
  user already accepted — zero added latency while reading normally); only
  **cursor advancement** — the thing that slides the window forward — requires
  confirmation. A reader jumping mid-chapter pays one ~300 ms confirm before
  the window recenters. Note this in-source.
- WHY tier-1 (near) events are NOT confirmed: they cannot advance the cursor,
  and the §1 window already bounds them; confirming them would only add timers.
- Interaction with pause/hydrate: unchanged — confirmation gates planning,
  and `paused` still gates sends inside `sendTranslate`.

🧪 *Tests (fake timers + fake observers):* a tier-0 event followed by the
element leaving the viewport before the delay → no cursor advance, no send
beyond the old window; a persisting element → confirmed, cursor advances,
window slides, suppressed neighbours re-planned; `checkVisibility` false →
rejected; `checkVisibility` missing → fail-open confirmed; unregister during
the delay → timer cancelled, no dangling send; within-window tier-0 sends
immediately without waiting for its own confirmation.

## 3. [Feature B core] Contour capture in `bubbleSnap` + the sanctioned contract change

Keep the blob outline the accepted flood fill already traced.

**Build (`bubbleSnap.ts`; seed/guard/group logic untouched):**

- `floodFill` records a **`filled` mask** alongside `visited`. WHY a separate
  record (or a 2-state encoding): `visited` marks every *inspected* pixel
  including dark boundary rejects, so it is not the blob.
- On an **accepted** fill only: dilate the mask by 1 px (3×3 max — replaces
  the current scalar 1 px bbox pad for the shape; the bbox pad logic itself
  is unchanged), trace the **outer boundary** with marching squares (outer
  contour only — glyph holes inside the blob are covered automatically),
  simplify with Douglas-Peucker at ε ≈ 1 snap-px, cap at 64 points (double ε
  and re-run once if over), convert to full-image fractions clamped [0, 1].
  All pure, all on the synthetic-`SnapBitmap` test rig.
- `snapRegionToBubble` returns `{ bbox: BBox; shape?: [number, number][] } |
  null` (module-local API — update `snapAllRegions`, `splitGroup`, and tests;
  `shared/types.ts` is only touched for the region field, rule 4). The 7.6
  windowed per-lobe re-fills produce per-lobe contours with zero extra
  mechanism. Any trace failure → `shape` undefined, bbox kept (rule 6).
- `snapPageRegions` stamps `shape` (and §7 `fillColor`) onto the returned
  regions. **Shapes are cached** exactly as snapped boxes are (7.5 precedent:
  deterministic memoization, not a provider claim), so reloads replay shaped
  fills with zero spend; `estimatePageBytes` prices the points automatically
  (serialized-JSON sizing; ≤ 64 points ≈ 1 KB/region worst case). NO
  `CACHE_VERSION` bump (ground rule 8).
- Drag-select: `clampBoxToRect` still clamps only the bbox — shape points
  outside the selection are cropped at render time by the box's
  `overflow: hidden` (§5), so no polygon-clipping code is needed. WHY-note it.

🧪 *Tests (extend `bubbleSnap.test.ts` on the existing fixture helpers):*
white ellipse → shape traces the ellipse (all points within 1–2 snap-px of the
analytic boundary, ≤ 64 points, all inside the returned bbox + pad); glyph
holes in the interior do not perforate the contour; peanut fixture → each lobe
gets its OWN contour confined to its slab; leak/min-area/dark paths return
null exactly as before (regression: existing suite passes with only
return-shape mechanical updates); determinism; inputs never mutated;
normalized + clamped output.

## 4. [Feature B render] Shaped fill layer + inscribed text box (`shapePath.ts` + `BubbleBox.ts`)

**Build — new pure `overlay/shapePath.ts`:**

- `shapeToBoxPath(shape, bbox, rectW, rectH): string | null` — map each
  image-normalized point into box-local px
  (`(sx − bbox.x) × rectW / bbox.w`, same for y), smooth with Catmull-Rom →
  cubic Bézier, emit a closed SVG path string (round to 0.1 px). Degenerate
  input (< 3 points, non-finite, zero-extent bbox) → null. WHY this mapping
  is correct even for a `trimOverlaps`-trimmed copy: the trimmed bbox and the
  box rect describe the same displayed sub-rectangle, so the scale factor
  `rectW / bbox.w` is the full displayed-image scale and out-of-box points
  simply land outside [0, rectW] — where `overflow: hidden` crops them.
- `inscribedInnerRect(shape, bbox, rectW, rectH): PxRect` — the text box:
  binary-search the largest centered scale of the current padded inner box
  (`PADDING_RATIO`) whose four corners lie inside the polygon (pure
  point-in-polygon), floored at 0.6× so a ragged contour can't crush text to
  nothing. No/degenerate shape → today's inner box unchanged.

**`BubbleBox.ts`:** when `region.shape` yields a path, set it as `clip-path:
path("…")` on the **fill layer only** (text is never clipped); otherwise
today's `border-radius: 8px`. Feed `resolveFontSize` the inscribed rect's
dimensions and center the label in it. Peek mode keeps the shape (the dashed
outline cue stays on the box). Resize repaints already re-run this whole
function — no new listeners, no cached px.

🧪 *Tests:* `shapePath` mapping (known square/diamond shapes → expected px
path segments; trimmed-bbox mapping stays aligned; degenerate → null);
`inscribedInnerRect` (circle → ~1/√2 box; slab → full box; floor kicks in on a
star-like concave shape; no shape → identity); BubbleBox is a thin shell — its
decisions are these two helpers, so DOM assertions stay minimal (clip-path
present iff path non-null; label box uses the inscribed rect).

## 5. [Feature B fallback] Ellipse fallback for unsnapped `bubble`/`thought`

Regions with `kind ∈ {bubble, thought}` but no `shape` (pre-Phase-9 cache
entries, failed snaps) get `border-radius: 50%` when the box aspect `w/h` is
in [0.4, 2.5] (roundish — outside that range it's usually a mis-kinded caption;
keep 8 px), with the text box at 1/√2 of the inner rect. **Risk, flagged
deliberately:** an ellipse inscribed in a *tight* provider box can leave the
original glyph corners uncovered; the 7.5 evidence says provider boxes are
loose, so accepted — but keep this item **independent** (a single pure
`fallbackRadius(kind, aspect)` decision + its call site) so a bad live pass
can revert it alone without touching §3/§4.

🧪 *Tests:* the decision table (kinds × aspects), and that a region with a
shape never takes the fallback path.

## 6. [Regression proof] e2e Scenario D — the auto-visibility budget

The exact 2026-07-17 failure, as a permanent e2e assertion. New scenario in
`smoke.spec.mjs`: fresh profile, chapter opened on the auto-opted mock site,
**no translate-all**, wait ~8 s (2 s mock latency) → assert `/stats`
`chatRequests ≥ 1` **and ≤ 6** (viewport ~1366×768 over 800×1200 pages:
1–2 visible + 1–2 near + 3 prefetch; pin the bound with a comment showing the
arithmetic). Then scroll to the bottom in steps with settle pauses → assert
all 10 pages eventually paint (the window slides; nothing wedges). Scenarios
A–C are untouched (A/B use translate-all, which bypasses the window — verify
they still pass unmodified; that is itself the §1 bypass test).

🧪 This *is* the test. Keep assertions on observable behavior only
(`/stats` + painted `.mangalens-bubble` counts), per the e2e house rules.

## 7. [Cheap while pixels are in hand] Sampled fill color + dark-bubble polarity

- **Sampled color:** during an accepted fill, accumulate the running mean RGB
  of filled pixels (three sums + count — no second pass) → `region.fillColor`
  (hex). Render: when present, the fill layer uses it INSTEAD of
  `font.bubbleFillColor`, and a pure `pickTextStyle(fillLuma, font)` flips to
  light text + dark stroke when the fill luma < 128 (otherwise the user's font
  settings apply unchanged). WHY sampled-wins is safe as the default: the
  sampled color IS the bubble's actual paper color — for the overwhelmingly
  common white bubble it is visually identical to today's default; flag the
  call in PROGRESS so it can be settings-gated later if contested.
- **Dark-polarity fill:** today a dark-interior bubble (flash/inverted-flash)
  never snaps — every seed fails `LIGHT_FLOOR`. Add the inverse mode to
  `snapRegionToBubble`: when ALL nine seeds are dark (luminance ≤ an exported
  `DARK_CEILING` ≈ 80), re-run the fill with inverted polarity (fill pixels
  with luminance ≤ seedLum + tolerance), same min-area/leak guards, same
  bubble/thought kind gate. An accepted dark fill yields bbox + shape +
  a dark `fillColor` → the inverted-flash bubble gets a dark, shaped fill
  with light text instead of a white rectangle punched into black art.
  Mixed light/dark seeds keep today's behavior (light path only). This is the
  one place item B adds *mechanism* rather than keeping existing mechanism's
  output — keep it small and behind the all-seeds-dark trigger.

🧪 *Tests:* mean-color accumulation on a known fixture; `pickTextStyle`
threshold table; dark ellipse on white ground → snaps via the dark path with a
dark `fillColor` + correct shape; mixed-seed fixture → light path only; guards
(leak/min-area) fire identically in dark mode.

## Explicitly out of scope

- Shaped TEXT layout (CSS `shape-inside` does not exist; text stays in the
  inscribed rect) and any curved/warped text rendering.
- Inpainting-style bubble cleanup; local ML detection/OCR (F20); prompt or
  schema changes of any kind (a polygon-output prompt was considered and
  rejected: more tokens, less reliable than local pixels).
- New settings/UI surface for shapes or the window (the options hint copy
  change in §1 is the only UI text touched).
- Scroll-away cancel/downgrade (decided against in Phase 8 §2 — the window
  gates *sends*; in-flight work still completes into the cache).
- Screenshot fallback, F16/F18, Chrome port, signing, `eval:live`.

## Manual verification (needs a live browser + real key; record honestly if not run)

With the built `dist/`, `claude-sonnet-5`, and the user's reader (confirm
which reader the 2026-07-17 HAR came from before testing; MangaDex covers the
blob path):

1. Open a chapter on the auto-opted reader, stay at the top, network panel on
   the background page: **≤ ~6 `v1/messages` in the first minute**, not the
   chapter. Scroll steadily → requests follow ~`prefetchAhead` ahead of you;
   jump to mid-chapter → one short pause, then the window recenters there.
2. Translate all still fills the entire chapter (window bypassed).
3. Oval / cloud / wavy / thought bubbles → the fill hugs the drawn outline;
   compare against a pre-phase screenshot of the same page. Joined bubbles
   (the 7.6 Eminence page) → per-lobe shaped fills, no union swallow.
4. Reload the chapter → shaped fills replay instantly with ZERO provider
   calls (shapes came from cache).
5. Drag-select across a bubble → shaped fill clamped inside the selection.
6. A dark/inverted-flash bubble page → dark shaped fill + light text (§7);
   a captions/SFX page → unchanged rectangles (kind gate).
7. Peek (F14) → original text, shape retained, dashed cue visible.
8. Pre-Phase-9 cached pages (do NOT clear the cache first) → render as
   rectangles, no errors (additive-field compatibility).

## Definition of done

- `npm run check` green (640 + the new unit tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0.
- **`npm run test:e2e` green ON THIS MACHINE — four scenarios**, including the
  new Scenario D budget assertion; A–C pass unmodified.
- The ONLY `shared/types.ts` change is the two optional `TranslatedRegion`
  fields (`shape`, `fillColor`), flagged; NO new messages, no manifest change,
  `PROMPT_VERSION` = 2 and `CACHE_VERSION` = 2 untouched.
- `PROGRESS.md` Phase 9 summary in the house style: the HAR evidence and both
  root-cause layers, the cursor/confirmation design calls (confirm-only-for-
  cursor-advance, fail-open `checkVisibility`, derived cursor), the contour/
  cache/no-bump reasoning, the §5 ellipse risk and §7 sampled-wins call, and
  honest manual-verification status.
