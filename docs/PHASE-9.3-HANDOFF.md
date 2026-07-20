# Phase 9.3 — Leak confinement, word-integrity text fit, sharper snap (handoff)

You are implementing **Phase 9.3** of the MangaLens Firefox extension: the
fix-list from the **tenth live-pass evidence** (2026-07-19 screenshots, MangaDex,
vertical-CJK series, Anthropic `claude-sonnet-5`, on the Phase 9.2 build). Three
fronts, all free to iterate (snap changes re-apply to paid pages via the §3
re-snap machinery; text changes are render-side):

- **Leak confinement (§1).** The worst remaining fill defect: bubbles near panel
  borders leak through the WHITE page margin/gutters into neighbouring panels and
  produce giant cross-panel blobs whose outer-contour fill swallows enclosed art
  (white paint over a character's dark hair). Every existing guard is blind to
  this: the escaped margin region is SOLID white, so the 9.2 bbox-fill
  compactness guard passes; its area stays under the 4×-box / 35 %-image caps.
  Fix structurally: hard-wall the flood fill to a window around the provider box
  and reject blobs that slam into that wall.
- **Word-integrity text fit (§2).** "Pleas e!" / "Besi des" at LARGE font sizes.
  Root cause found and it is in `textFit.ts`'s blind spot: the shadow measurer
  has `word-break: break-word`, so when a word fragments the measurement still
  "fits" — the binary search happily picks a big px and never knows it shredded
  the word. (The Phase 9.2 widen-then-refit reuses the same blind predicate,
  which is why fragmentation survived 9.2.) Fix: cap the search at the largest
  px where the longest word fits UNBROKEN.
- **Sharper snap bitmap (§3).** `SNAP_MAX_EDGE` 512 → 768. Thin panel borders
  erode at 512 — that is exactly how the §1 escapes open up — and edge
  quantization (1 snap-px ≈ 2–2.5 display px) limits how closely fills can hug
  the ink. 768 keeps borders alive and drops quantization to ≈ 1.5–1.7 display
  px. Safe to do NOW because §1 bounds the blast radius of any new outline-gap
  leaks that the weaker low-res blur no longer self-closes.

**What the live-pass evidence established (do NOT re-litigate):**

- The leak mechanism: escapes run through white page margins/gutters (thin panel
  borders alias away at snap resolution), not through bubble outlines alone; the
  contour tracer then paints everything ENCLOSED by the outer boundary (by
  design, for glyph holes), which is how white lands on dark art.
- Cache reset does NOT fix pixel defects — re-snap already re-runs the current
  logic on identical inputs. A reset only re-rolls PROVIDER boxes (sampling
  variance; the "sometimes great, sometimes misses easy bubbles" pattern), at
  full provider cost. The user is cost-sensitive; do not design anything that
  needs a cache clear.
- Provider-side defect classes seen in the same screenshots are OUT OF SCOPE
  (future prompt phase, collect examples): whole-bubble detection misses,
  several bubbles merged into ONE region/translation, boxes offset beyond the
  §4 rescue's reach (translation renders beside still-visible original).
- Phase 9.2's narrow-rect widen (`longestWord`, `widenLabelRect`,
  `WORD_PROBE_WIDTH` probe in BubbleBox) shipped and works as designed — §2
  RESTRUCTURES its call-site logic (cap before fit, widen as fallback), it does
  not rebuild those pure helpers.

Read first: `docs/ARCHITECTURE.md` §7.5/§7.7; the Phase 9.1 + 9.2 summaries in
`PROGRESS.md`; `src/background/bubbleSnap.ts` (`floodFill` + its window
parameters, `snapRegionToBubble` — the seed loops, the `accept` closure with the
9.2 sprawl guard, the §4 rescue grid, `computeSnapSize`); the Phase 7.6 stage-3
windowed re-fill in `snapAllRegions` (the existing `opts.window` semantics §1
must compose with); `src/content/overlay/textFit.ts` (`fitTextSize`,
`resolveFontSize`, `longestWord`) + `BubbleBox.ts` (the 9.2 narrow-rect rescue
block, `WORD_PROBE_WIDTH`, `createShadowMeasurer`).

**Verified-green baseline (2026-07-19, do NOT rebuild/re-verify): 747 unit tests
via `npm run check`, `npm run test:e2e` 4/4 (A–D) on this machine, `vite build`
clean, `web-ext lint` 0/0/0.**

**Already shipped — do NOT rebuild:**
- The whole Phase 9/9.1/9.2 pipeline: contour capture, outward offset (0.5),
  median fill color + paper snap, `SNAP_VERSION` local re-snap, seed rescue,
  centroid inscribed rect, z-index layering, ellipse gate, anchored window,
  loaded-image guard, the 9.2 sprawl guard (`MIN_BLOB_BBOX_FILL`) and
  narrow-rect helpers. Every section below adjusts call sites and adds guards.
- The cache store/LRU/key. `CACHE_VERSION` stays 2, `PROMPT_VERSION` stays 2.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages. Every exported function/class gets JSDoc; `// WHY:` on every
   non-obvious decision.
2. Pure-core / thin-shell split: every decision below (window derivation, hard
   walls, wall-slam classification, word-cap px) is a pure, browser-free,
   unit-tested function or a tested closure inside the existing pure core;
   DOM/canvas stays in shells.
3. **NO `shared/types.ts` change, no new messages, no manifest change.**
   Sanctioned surface changes, flag them in the PROGRESS summary:
   (a) `SnapOptions` gains `confineExpand?: number` (module-local);
   (b) `resolveFontSize` gains an optional `wordCapPx` parameter
   (content-internal). Anything beyond: stop and flag before building.
4. All coordinates stay normalized 0–1 against the ORIGINAL image; windows and
   walls are computed in snap-px space inside the pure core.
5. Fail soft, in the cost direction: every rejection falls back to the provider
   box (rule 4 of the original snap handoff — a loose box is less harm than a
   wrong shape); nothing may change WHAT is sent to the provider or when.
6. **`SNAP_VERSION` → 3** (one bump covering §1 + §3 — both change snap output;
   NEVER in `buildCacheKey`, ground rule 8 of 9.1). `PROMPT_VERSION` and
   `CACHE_VERSION` untouched.
7. No test hooks in shipped code. When done: `npm run check` + `npm run build` +
   `npm run lint:ext` clean, **`npm run test:e2e` green with Scenarios A–D
   UNMODIFIED on this machine**, and a Phase 9.3 summary appended to
   `PROGRESS.md` in the house style (deliberate calls + honest
   manual-verification status).

## New files

None. Changes land in `bubbleSnap.ts`, `textFit.ts`, `BubbleBox.ts`; tests
extend `bubbleSnap.test.ts`, `textFit.test.ts`, `BubbleBox.test.ts` (and touch
`shapePath.test.ts` only if an expectation shifts).

---

## 1. [Fills] Confine the flood fill; reject wall-slams

**Symptom (screenshot-verified):** a fill seeded in a bubble escapes through the
white page margin/gutter (panel border aliased away at snap resolution), wanders
into a NEIGHBOURING panel, connects to other white regions, and paints a giant
cross-panel blob — including enclosed dark art, because the shape is the OUTER
contour. Solid-white escapes pass the 9.2 compactness guard and both area caps.

**Build (`bubbleSnap.ts`):**

- `export const SNAP_CONFINE_EXPAND = 0.5` — the confinement window is the
  provider box expanded by this fraction of the box's width/height PER SIDE
  (⇒ a 2×-per-axis window), clamped to the bitmap. WHY 0.5: snap growth was
  always bounded at 4× box AREA (= 2× per axis when square), so the wall does
  not tighten legitimate growth — the existing "grows a too-small seed box"
  fixture (bubble ≈ 1.75× box per side) must still pass untouched.
- **Effective fill window** = intersection of the existing `opts.window` (the
  7.6 stage-3 lobe slab, when present) and the confinement window. Seeds clamp
  into it exactly as they do today.
- **Hard walls:** a confinement edge is "hard" iff it is strictly inside the
  bitmap (an edge clamped to the image boundary is NOT hard — a bubble at the
  page edge legitimately touches it) AND it is the binding edge on that side
  (an `opts.window` slab edge that cuts tighter is NOT a confinement wall —
  lobes legitimately touch their group cut).
- **Wall-slam rejection:** in the `accept` closure, alongside the 9.2 sprawl
  guard (before the trace): if the blob's pixel bounds touch any hard wall
  (`blob.minX === winMinX` on a hard-left side, etc.), return null. WHY in
  `accept` (next-seed semantics, not the leak's abandon-all): identical
  placement to the sprawl guard, and the repeated re-fill cost is bounded by
  the window area (≤ 4× box). WHY reject rather than accept-the-clip: a fill
  pressed against the wall wanted to keep going — the true region extends
  beyond 2× the box, which is essentially never a real bubble for a
  roughly-placed provider box; and a wall-clipped contour would render an
  artificial straight edge mid-art.
- **Rescue path:** derive the confinement window from the RESCUE-expanded box
  (the existing 1.25×-per-side grid box), same `SNAP_CONFINE_EXPAND` on top.
  WHY: rescue exists because the box is offset — confining to the raw box
  would wall off the very bubble the grid is trying to reach; the ≥ 40 %
  provider-overlap acceptance guard still anchors the result to the box.
- `SnapOptions.confineExpand?: number` override (default the constant;
  `Number.POSITIVE_INFINITY` disables confinement — tests that exercise OTHER
  guards in isolation use this).
- Keep `MAX_BLOB_BOX_RATIO` / `MAX_BLOB_IMAGE_FRACTION` / `MIN_BLOB_BBOX_FILL`
  unchanged — the window makes the first nearly redundant but it stays as the
  backstop (WHY-note).

🧪 *Tests (`bubbleSnap.test.ts`):* margin-leak fixture (bubble ellipse whose
outline has a gap onto a white margin strip running to another white region
entirely outside 2× box) → null by default, accepted with
`confineExpand: Infinity` (pins the rejection on the wall, not another guard);
bubble fully inside the window snaps identically with/without confinement
(byte-identical `SnapResult`); bubble at the IMAGE edge with the box near it →
still snaps (clamped edge is not hard); 7.6 peanut/group fixtures pass unchanged
(slab edges are not hard walls); rescue fixtures pass unchanged (window derived
from the expanded box); the existing 9.2 sprawl-guard cross fixtures: the
default-null expectations stand, and the `minBlobBboxFill: 0` CONTROL runs must
now also pass `confineExpand: Infinity` (the cross slams the wall before the
ratio is consulted) — **this is the only sanctioned existing-test edit; keep the
control's intent (prove which guard rejected) by asserting both variants.**
Determinism throughout.

## 2. [Text] Word-integrity font cap (kill letter-columns at the root)

**Symptom:** "Pleas e!", "Besi des", "Yuanx i Qingli u" rendered at LARGE sizes.
`fitTextSize`'s predicate measures with break-word active, so a fragmented word
still "fits"; the search maximizes px and fragments freely. The 9.2 widen only
changed the rect, then refit with the same blind predicate.

**Build (`textFit.ts` + `BubbleBox.ts`):**

- New pure `maxWordFitPx(word, widthPx, minPx, maxPx, probeMeasure): number |
  null` in `textFit.ts`: the largest integer px in `[minPx, maxPx]` at which
  `probeMeasure(word, px).w ≤ widthPx`, or null when even `minPx` overflows.
  Binary search (monotonic predicate — same skeleton as `fitTextSize`); empty
  word → `maxPx` (no cap). The probe measurer is the caller's business (the
  shell passes the `WORD_PROBE_WIDTH`-bound measurer so words never wrap).
- `resolveFontSize` gains optional `wordCapPx?: number`: in AUTO mode the
  effective max becomes `min(font.maxSizePx, wordCapPx)`. FIXED mode ignores
  the cap (the user chose that size; the 9.2 widen still helps them) —
  WHY-note.
- **BubbleBox flow (replaces the 9.2 probe-after-fit block):**
  1. `cap = maxWordFitPx(longestWord(text), inner.width, minPx, maxPx,
     probeMeasure)`.
  2. `cap === null` (whole word cannot fit the rect at ANY legal size) → widen:
     `inner = widenLabelRect(...)` (when it widens), recompute `cap` on the new
     width.
  3. `px = resolveFontSize(font, text, inner.width, inner.height, wrapMeasure,
     cap ?? undefined)`. A still-null cap after widening means fragmentation is
     unavoidable at `minPx` — accept it (today's floor-and-crop policy).
  WHY cap-then-widen (deliberate change from 9.2's widen-eagerly): a word that
  fits the inscribed rect at a smaller size now renders SMALL AND WHOLE inside
  the bubble instead of large and overhanging — the user's complaint list
  includes text too big for its paint; `minSizePx` remains the legibility floor.
- Keep `longestWord` / `widenLabelRect` / `WORD_PROBE_WIDTH` as-is.

🧪 *Tests:* `maxWordFitPx` table in `textFit.test.ts` (exact cap with the
fixed-advance measurer; null when minPx overflows; empty word → maxPx;
monotonic determinism); `resolveFontSize` honors the cap in auto mode, ignores
it in fixed mode, `min(maxSizePx, cap)` order both ways. `BubbleBox.test.ts`:
a word that fits the narrow rect only at a small px → renders at that px, NOT
widened, label width = inscribed width (the 9.2 "Extraordinary" fixture's
expectations may legitimately shift to the capped size — update them with a WHY
comment); a word that can't fit even at minPx → widened rect + capped refit
(layout assertions as in 9.2); short text unaffected (regression).

## 3. [Fills] `SNAP_MAX_EDGE` 512 → 768

**Build (`bubbleSnap.ts`):** change the constant; update its WHY comment
honestly: the ≤512 gap-self-closing rationale traded away thin PANEL BORDERS
(the §1 escape route) and edge sharpness; at 768 borders survive (fewer margin
escapes at the source), 1 snap-px ≈ 1.5–1.7 display px (fills hug ink tighter),
and §1's wall bounds any new leak a no-longer-blurred outline gap admits. Note
the interaction: `SHAPE_OUTWARD_OFFSET_PX` (0.5) + dilation are in SNAP-px, so
the outward reach SHRINKS in display px at 768 (≈ 2–2.5 display px total) —
that is the desired direction after the 9.2 overshoot fix; it remains the rim
knob if a live pass shows ink rims returning. `SNAP_MIN_SHORT_EDGE` (256)
unchanged. Snap cost grows ≈ 2.25× in pixels — still trivial (one pass per
region over a ≤ 768-long-edge bitmap, event-page local).

🧪 *Tests:* `computeSnapSize` expectations update mechanically (the cap
constant is imported in the suite — verify no test hard-codes 512); full-suite
green is the real assertion here since fixtures are 100×100 (below the cap,
scale 1, unaffected).

## Explicitly out of scope

- **Prompt phase (future, paid iteration):** bubble-merge (one region spanning
  several bubbles), whole-bubble misses, boxes offset beyond the §4 rescue.
  Collect the 2026-07-19 screenshot set as its evidence; `PROMPT_VERSION`
  stays 2 this phase.
- Hyphenation / locale-aware line breaking; convex-hull or ellipse-fit shape
  smoothing (considered; deferred until confinement's effect is seen live).
- Inpainting, shaped text layout, local OCR; settings/UI surface; batching
  defaults; Chrome port; F16/F18.

## Manual verification (live key + MangaDex; record honestly if not run)

WITHOUT clearing the cache (that is the point — §1/§3 arrive via re-snap):

1. Background console shows `re-snapped cache hit … (snapVersion → 3)` on
   previously-paid pages; network panel shows ZERO provider calls for them.
2. The cross-panel blob pages (2026-07-19 screenshots: the "My sword is—" /
   "assassin's blade" double-bubble page): no fill crosses a panel border or
   gutter any more; worst case those bubbles show a plain loose box.
3. "Pleas e!" / "Besi des" / "Yuanx i Qingli u" pages: whole words at a smaller
   size (or, where genuinely impossible, the widened rect) — NO letter columns.
4. Fill edges visibly tighter to the ink at 768; no return of ink rims (if rims
   appear, note it — the knob is `SHAPE_OUTWARD_OFFSET_PX`, not a revert of
   §3).
5. Spend behavior unchanged: chapter open ≤ ~6 requests, forward reading tracks
   `prefetchAhead`, reverse skim buys ~nothing (§8/§9 untouched this phase).

## Definition of done

- `npm run check` green (747 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` 4/4 with Scenarios A–D
  UNMODIFIED on this machine**.
- Only sanctioned surface changes (`SnapOptions.confineExpand`,
  `resolveFontSize` `wordCapPx`); `SNAP_VERSION` = 3 and NOT in the cache key;
  `PROMPT_VERSION` = 2, `CACHE_VERSION` = 2; no `shared/types.ts` / messages /
  manifest changes.
- `PROGRESS.md` Phase 9.3 summary in the house style: the tenth-live-pass
  evidence, the margin-leak mechanism, each section's deliberate calls (hard
  walls + wall-slam-in-accept, rescue window derivation, cap-then-widen, the
  512→768 trade), the sanctioned test edits (sprawl-guard controls,
  "Extraordinary" fixture), and honest manual-verification status.
