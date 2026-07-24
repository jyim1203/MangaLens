# Phase 10 — transparent hover-peek (F14 v2) + query-string chapter drift + doc corrections (handoff)

You are implementing **Phase 10** of the MangaLens Firefox extension: two small
features and a doc fix, user-requested 2026-07-24.

- **§1 Transparent hover-peek (F14 v2).** Peek currently swaps the hovered
  bubble's text back to `region.original` ON TOP of the still-painted fill.
  The user wants hover to instead make the bubble **fully transparent** — no
  fill, no label — so the untouched page `<img>` underneath (original art AND
  original text) shows through under the cursor. This REPLACES the text-swap
  behavior entirely (user decision; no settings toggle).
- **§2 Query-string page-drift tolerance.** Lifts the recorded 9.9 limitation:
  a reader that tracks pages as `?page=N` still permanently disarms the
  translate-all intent on the first scroll, exactly the pre-9.9 bug class.
- **§3 Doc corrections.** ARCHITECTURE.md still describes a batch response
  schema that was never built.

**Context established (do NOT re-litigate):**

- Multi-page batching (F12) is **already fully implemented** (Phase 8 §1:
  `background/batch.ts` collector, `ProviderBase.translateBatch`, per-adapter
  `buildBatchRequest`, split-on-failure ladder, per-member cache stores, e2e
  Scenario B). It is dormant only because `DEFAULT_SETTINGS.pagesPerRequest`
  is 1; activation is a user settings flip, NOT code. Do not build anything
  batching-related beyond §3's doc sentence.
- Long-chapter translate-all coverage is already built (9.6 intent, 9.8 staged
  window + sweeper, 9.9 chapter scope). Nothing to build there.
- The overlay is a separate shadow-DOM layer positioned over the page's
  untouched `<img>` — hiding a bubble's paint genuinely reveals the original
  art; no compositing tricks are needed.

Read first: `src/content/overlay/peek.ts` (whole file — the pure helpers you
are extending), `src/content/overlay/BubbleBox.ts` (`RenderBubbleOptions`,
`renderBubbleBox` — especially the §6 stacking-context comment at ~L198–203,
the peek outline block at ~L217–222, the fill block at ~L231–246, and the
`options.peek ? region.original : region.translated` branch at ~L248),
`src/content/overlay/OverlayManager.ts` (peek state ~L84–98, `togglePeekAll`
~L222–235, `shouldPeek` ~L238–245, `processPeek` ~L270–300, `paint()`
~L456–528 — the `suppressFills`/`rects`/`coverRects` parallel arrays and the
`paintedRects` push), `src/content/overlay/overlapTrim.ts`
(`computeContainedFillSuppression`) and `src/content/overlay/coverPad.ts`
(`computeFallbackCoverRects`) for the fill-coverage doctrine,
`src/content/viewportQueue.ts` `sameChapterHref` (~L219–258, incl. the
limitation JSDoc at ~L200–203), the 9.9 truth-table suite in
`tests/unit/viewportQueue.test.ts`, and `tests/unit/peek.test.ts`.

**Verified-green baseline (2026-07-24, this machine, do NOT rebuild/re-verify):
`npm run check` 874 unit tests, `npm run build` clean, `npm run lint:ext`
0/0/0, `npm run test:e2e` 5/5.** Phases 9.8+9.9 are now COMMITTED (`c0fa169`);
the working tree is clean. **Do not commit** — the main session reviews, then
commits.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; JSDoc on every export; `// WHY:` on every non-obvious
   decision; pure-core / thin-shell (every new DECISION is a pure, browser-free,
   unit-tested function; DOM stays in the shells).
2. **Sanctioned surface changes — flag each in the PROGRESS summary:**
   (a) `src/content/overlay/peek.ts` — the §1 pure helpers + module-header
   update.
   (b) `src/content/overlay/BubbleBox.ts` — the §1 peek render branch +
   `RenderBubbleOptions.peek` JSDoc + module-header wording.
   (c) `src/content/overlay/OverlayManager.ts` — the §1 paint()/peek wiring,
   `shouldPeek` deletion, comment updates.
   (d) `src/content/viewportQueue.ts` — the §2 `sameChapterSearch` helper +
   `sameChapterHref` wiring + JSDoc.
   (e) `src/shared/messages.ts` — `togglePeekOriginal` DOC COMMENT only (no
   shape change).
   (f) `src/shared/types.ts` — the `original` field's DOC COMMENT only (no
   shape change).
   (g) `public/_locales/en/messages.json` — `commandPeekOriginalDescription`
   message wording (+ optionally the stale `optionsPagesPerRequestHint`
   *description* tag); command/message IDs unchanged.
   (h) `docs/ARCHITECTURE.md` — the §3 batching-schema sentence.
   (i) `tests/unit/peek.test.ts`, `tests/unit/BubbleBox.test.ts`,
   `tests/unit/viewportQueue.test.ts` — new cases.
   **NO manifest change, no new/changed message shapes, no `shared/types.ts`
   shape change, no styles.css change (the cue is an inline style), no other
   file.** Anything beyond: stop and flag.
3. **No version bumps** (`PROMPT_VERSION` 3 / `SNAP_VERSION` 4 /
   `CACHE_VERSION` 2). §1 is render-time only (cached pages pick it up on the
   next repaint); §2 is content-scope logic. A **free** phase.
4. §1 fail direction: degrade toward "paint less" — a peek that hides too
   little is a cosmetic miss; never let peek changes break the non-peek paint
   path. §2 fail direction: DISARM (identical to 9.9 rule 4) — every ambiguous
   search comparison resolves to "different chapter".
5. When done: `npm run check` + `npm run build` + `npm run lint:ext` clean,
   `npm run test:e2e` 5/5 (Scenario bodies A–E untouched), Phase 10 summary
   appended to `PROGRESS.md` in the house style. Do not commit.

## 1. [Overlay] Transparent hover-peek — reveal the art

### 1a. `peek.ts` — `expandPeeked` (the co-peek decision)

New pure export + private helper, sibling to the existing point-in-rect
`contains`:

- `rectContains(outer: PxRect, inner: PxRect): boolean` — inclusive edges.
- `expandPeeked(hoverIndex: number | null, rects: readonly PxRect[]): boolean[]`
  — parallel boolean array: all-false for a `null`, out-of-range, or negative
  `hoverIndex` (fail-soft); otherwise true at `hoverIndex` plus every OTHER
  index whose rect fully CONTAINS or IS fully CONTAINED BY the hovered rect
  (both directions; containment is transitive, so one pass catches A ⊇ B ⊇ C
  chains).

// WHY expand at all: containment pairs are duplicate detections by
`overlapTrim`'s own doctrine — a fill-suppressed inner region
(`computeContainedFillSuppression`) is COVERED BY the outer's fill, so peeking
only the inner would leave the outer's paint over the revealed art; and
hovering the OUTER must also vanish the inner's floating label for the same
reason. // WHY containment, not intersection: post-`trimOverlaps` partial
overlaps are slivers — blanking a whole neighbouring bubble for a sliver would
float ITS label on raw art, worse than a sliver of fill overhanging the peeked
corner. Document the known limitation in the JSDoc: a diagonal neighbour's
GROWN cover rect (coverPad clamps only span-sharing neighbours) can overlap
the peeked rect without containing it and stays painted; the upgrade path is
swapping the predicate to intersection — one line — if it ever matters live.

Update the module header (it enumerates "the two decisions"; now three) and
its stale "original text is often CJK" rationale — the repaint-on-transition
requirement now comes from restoring textFit on UN-peek and from the co-peek
expansion, not from rendering source text.

### 1b. `BubbleBox.ts` — the peek render branch

- Rewrite `RenderBubbleOptions.peek` JSDoc: peek now means "reveal the art —
  paint no fill and no label so the page `<img>` shows through; hairline cue
  only". Keep a WHY: transparency comes from ABSENT CHILDREN, never `opacity`/
  `visibility` on the box — the §6 stacking-context contract (~L198–203)
  forbids box opacity, and an empty box with an outline creates no stacking
  context.
- In `renderBubbleBox`, immediately after the `Object.assign(box.style, …)`
  block: when `options.peek`, set the softened cue and return —
  `outline: "1px dashed rgba(90, 90, 90, 0.65)"`, `outlineOffset: "-1px"` —
  skipping the fill layer AND the entire textFit pipeline (word probe,
  `maxWordFitPx`, `resolveFontSize`, label build). // WHY keep a cue: with
  zero affordance the vanish reads as a rendering glitch; a 1px dashed line
  hugs the balloon's own inked rim and obscures near-nothing. // WHY thinner/
  fainter than the old 2px cue: it now sits over revealed art, not our fill.
- Delete the old peek outline block (~L217–222) and the
  `options.peek ? region.original :` branch (~L248 → just `region.translated`).
- Module header: reword the "peek-original swaps the text via a REPAINT"
  sentence to the new semantics (repaint still required — see 1a).

### 1c. `OverlayManager.ts` — paint wiring + index alignment

In `paint()`, after `coverRects` is computed and before the render loop:

```ts
const hoverIdx =
  !this.peekAll && this.peekHover !== null && this.peekHover.entryId === entry.candidate.id
    ? this.peekHover.regionIndex
    : null;
const peeked = expandPeeked(hoverIdx, coverRects);
```

In the loop: `const peek = this.peekAll || peeked[i] === true;`.

**Index alignment (load-bearing):** push `drawRect` into `paintedRects`
**unconditionally** — even when `renderBubbleBox` throws (move the push above
the `try`). Painted index === raw region index BY CONSTRUCTION, which is what
lets `expandPeeked` run on the raw `coverRects` array. // WHY: today a thrown
region silently desyncs painted vs. raw indices; peek only worked because the
two spaces were never coupled. A thrown region now records its rect but
appends no box — hovering it re-throws the same deterministic skip, fail-soft.
The peeked region MUST keep pushing its rect regardless (dropping it would
make the hover hit-test flicker-loop).

- Delete the now-unused private `shouldPeek` (its two halves are the two lines
  above).
- Update stale comments: the `paintedRects` field JSDoc (~L61–65, add the new
  invariant "index-aligned with the raw region arrays; a render failure still
  records its rect"), the paint() peek comments (~L502–505), the class
  peek-state comment (~L84–85), `togglePeekAll` JSDoc (~L222 — the hotkey is
  now "view the raw page / hide all translation overlays"), and the
  `processPeek` JSDoc (~L266–268 "everything is already showing its
  original" → revealed).
- `processPeek` / `peekRepaintTargets` / error / pending handling: **unchanged**
  (same per-entry repaint granularity; peek applies to done entries only).

### 1d. Comment/string touch-ups (no behavior)

- `src/shared/messages.ts` `togglePeekOriginal` doc comment → new semantics
  (message name/shape unchanged — no protocol change).
- `src/shared/types.ts` `original` field comment: still load-bearing for the
  watermark filter (`regionFilter.ts`) and provider dedupe (`ProviderBase.ts`);
  no longer rendered by peek.
- `public/_locales/en/messages.json` `commandPeekOriginalDescription`: e.g.
  "Peek at the original page (hide translation overlays)". Optionally fix the
  stale `optionsPagesPerRequestHint` *description* tag ("Phase 8 batching").
  Command IDs, the manifest, and `shared/constants.ts` untouched.

**Tests (§1):**

- `tests/unit/peek.test.ts`, new describe for `expandPeeked`: null hover →
  all-false; empty rects → `[]`; no containment relations → only hover index
  true; outer-contains-hover → both true; hover-contains-inner → both true;
  exact-equal rects → both true (inclusive); PARTIAL overlap (intersecting,
  non-containing) → NOT expanded (locks in the containment decision); chain
  outer ⊇ mid ⊇ hover → all three true; out-of-range / negative hover index →
  all-false.
- `tests/unit/BubbleBox.test.ts`, new describe: `peek: true` → box has ZERO
  children even with non-empty text (no fill, no label); the cue is
  `1px dashed …` with `outlineOffset === "-1px"`; box `zIndex`/`opacity`
  styles stay unset (stacking contract); with a `drawRect` the box lays out at
  the cover rect (hit-test geometry intact); a measure factory that THROWS is
  never invoked under peek (proves textFit is fully skipped).
- Optional (skip if the module-graph mock fights back): a jsdom
  OverlayManager round-trip modeled on `tests/unit/overlaySpinner.test.ts`
  (mock `./contentBox` to a fixed rect): render a 2-region page,
  `togglePeekAll()` → every `.mangalens-bubble` childless with an outline;
  toggle back → fills + labels restored. The pure tests above carry the
  weight; do not fight jsdom for this one.
- No existing test asserts the old text-swap behavior (verified); nothing to
  delete. No e2e change (no peek scenario exists; hover simulation is not
  trivially cheap).

## 2. [Content] `sameChapterSearch` — query-string page drift

New pure, exported helper in `viewportQueue.ts`, wired into `sameChapterHref`
by replacing the strict `if (a.search !== b.search) return false;` (~L230)
with `if (!sameChapterSearch(a.search, b.search)) return false;`. Semantics
(mirror the 9.9 path rule's narrowness; fail toward DISARM):

- Exact string equality → `true` (fast path; covers two empties).
- Parse both with `URLSearchParams`; compare as SORTED `[key, value]` entry
  lists (order-insensitive: `?a=1&b=2` ≡ `?b=2&a=1` — reader frameworks
  reserialize params in arbitrary order).
- Tolerated drift, and nothing else:
  - all entries equal → `true`;
  - all equal except EXACTLY ONE key, present on both sides the same number of
    times (once), whose value differs and BOTH values are all-digits
    (`/^\d+$/`) → `true` (`?page=4` → `?page=9`);
  - one entry list is the other plus EXACTLY ONE extra param whose value is
    all-digits → `true` (`/reader` ↔ `/reader?page=2`, both directions — the
    reader adding the tracker on first scroll);
  - anything else → `false`: key renames (`?page=` → `?p=`), non-digit value
    changes, ≥2 drifted keys, a non-digit param added/removed, repeated-key
    mismatches (`?a=1&a=2` — treat any multiset mismatch beyond the single
    tolerated drift as a chapter change).
- // WHY digits-only again, and NO param-name allowlist (`page`/`p`): the
  identity heuristic is the same as the 9.9 path rule — the only thing readers
  rewrite while scrolling is a numeric counter, and a hardcoded name list goes
  stale (the endpointModes learn-don't-list philosophy).
- // WHY the path and search rules compose INDEPENDENTLY (a URL drifting a
  numeric path segment AND a numeric query value passes both): each rule is
  individually narrow; note it in the JSDoc.
- Hash handling unchanged (ignored entirely). `noteHrefDrift` logging
  unchanged — a tolerated search drift logs the same single
  `href drift tolerated` line via the existing call sites.
- Update the limitation JSDoc block (~L200–203) — the limitation is lifted;
  record what is STILL intolerated (non-numeric query drift, key renames,
  multi-key drift).

**Tests (§2, `tests/unit/viewportQueue.test.ts`):** a `sameChapterSearch`/
`sameChapterHref` truth table mirroring the 9.9 suite — identical searches
(incl. both empty); same-key digit drift `?page=4`→`?page=9`; single
digit-valued param added and removed (both directions, incl. from empty
search); non-digit value change → false; key rename → false; two drifted keys
→ false; extra NON-digit param → false; order-insensitivity → true;
repeated-key mismatch → false; digit drift combined with tolerated numeric
PATH drift → true (the compose-independently case); digit query drift on a
DIFFERENT origin → false (existing origin gate still dominates). Plus one
shell case on the non-auto seam: an armed intent with `getHref` drifting
`/reader?page=1` → `/reader?page=7` keeps the intent armed (register still
auto-sends / pump still refills), and a non-numeric search change
(`?chapter=abc` → `?chapter=xyz`) disarms. No e2e change — Scenario E already
proves both call sites route through `sameChapterHref`; the predicate is
carried by the unit truth table.

## 3. [Docs] ARCHITECTURE.md batching-schema correction

`docs/ARCHITECTURE.md` ~L186 ("Batching (F12)") still says the batch response
schema "gains a `page_index` per region". The implementation (and PROMPTS
§4.2) instead wrap the single-page schema in a required top-level `pages`
array, `pages[i]` ↔ image `i`. Correct the sentence to describe the `pages`
array. Doc-only; do not touch PROMPTS.md (already correct) or any code.

## Explicitly out of scope

- Any settings toggle for peek mode ("art" vs "original text") — the old
  behavior is deleted, not preserved behind a branch. (A future
  `peekMode` setting is the recorded upgrade path; do not build it.)
- Intersection-based co-peek expansion (recorded as the upgrade path in 1a's
  JSDoc; containment only this phase).
- Flipping `DEFAULT_SETTINGS.pagesPerRequest` (opt-in beats surprise — a
  recorded Phase 8 deliberate call; activation is the user's settings flip).
- Anything batching-related beyond §3's sentence.
- Re-arming a disarmed intent; `?page=N` readers with REPEATED page keys.

## Manual verification (live MangaDex; record honestly if not run)

1. Hover a translated bubble: the paint vanishes under a 1px dashed hairline,
   the original art + source text show through; moving off re-fits the
   translation back. Hovering an inner bubble of a nested pair vanishes the
   outer's covering fill too (no white sheet left over the art).
2. Alt+Shift+O: the whole page reverts to raw art; toggling back restores
   every translation.
3. On a query-string reader (`?page=N`): Translate all, scroll — with debug
   on, one `href drift tolerated` line, zero `disarm` lines, window keeps
   refilling. On MangaDex (path drift): unchanged 9.9 behavior.

## Definition of done

- `npm run check` green (874 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, `npm run test:e2e` 5/5 (Scenario bodies A–E
  untouched).
- Only sanctioned surfaces (ground rule 2); no version bumps; no message/
  manifest/shape changes.
- `PROGRESS.md` Phase 10 summary in the house style: the user request + the
  "batching already existed, activation is a settings flip" correction; the §1
  design calls (absent-children not box-opacity; containment-not-intersection
  co-peek + its diagonal-cover limitation; unconditional `paintedRects` push =
  painted-index === raw-index invariant; peekAll = view-raw-page; the softened
  cue) and the §2 rule + what stays intolerated; honest manual-verification
  status. **Do not commit.**
