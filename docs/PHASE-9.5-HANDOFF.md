# Phase 9.5 — Whole-balloon detection, duplicate-region cleanup, fallback cover-pad (handoff)

You are implementing **Phase 9.5** of the MangaLens Firefox extension: the
fix-list from the **twelfth live-pass evidence** (2026-07-20 HAR +
screenshots, MangaDex, `claude-sonnet-5`, on the Phase 9.4 build). This phase
attacks the chronic "text floats out of the bubble" defect at its **root** — a
prompt instruction — instead of adding a sixth round of downstream snap
recovery. The 9.4 handoff itself flagged this as the deferred "future, paid
iteration"; this is that iteration.

**The root cause, established from the HAR + the code (do NOT re-litigate):**
the system prompt tells the model, verbatim, *"The box must tightly enclose the
TEXT itself, not the entire bubble outline"* ([prompt.ts:213](../src/background/providers/prompt.ts)).
For vertical-CJK dialogue that box is a **narrow strip of glyphs**, offset from
the round balloon's center and barely overlapping its white interior. Every
Phase 9.0–9.4 mechanism (flood snap, seed rescue, confinement cascade, opaque
fallback) exists to *reverse-engineer the balloon from a box we deliberately
told the model not to draw around the balloon.* On a snap failure the fallback
render **is** that narrow strip, so the opaque patch + English land off the real
bubble and the source bleeds around it — the "floating" symptom, worst on
connected/spanning bubbles where the strips are most offset. Fix the box at the
source and the whole failure class shrinks: seeds land dead-center (snap
succeeds far more often → tight shaped fills), and even a residual failure boxes
the *balloon*, so text fits and the fill covers it.

Three fronts, plus one optional dev aid:

- **Whole-balloon bounding boxes (§1, the root fix — PAID).** Rewrite the
  bbox rule so `bubble`/`thought` kinds are boxed as the **entire balloon** (the
  enclosed white/solid shape, margin included), while `caption`/`sfx`/`sign`/
  `other` (text on artwork) keep the tight-text rule. Add "one box per balloon
  lobe" so a sentence spanning joined balloons yields one region per lobe. Bump
  `PROMPT_VERSION` 2 → 3. This is the single biggest expected win and the ONLY
  paid change (it re-keys the cache → pages re-translate on next view).
- **Duplicate + degenerate region cleanup (§2, P1 — free).** The HAR's Call 11
  (the "magic power" ad page) shows the model emitting the SAME bubble two/three
  times (`與此類似` ×3 → *"it's similar to magic power too."* ×3; `讓其結合並提高密度的話`
  ×2) plus a **negative-height** corner box that `parseBbox` balloons into a
  quarter-page rectangle. Today's dedupe (`IoU > 0.85` AND identical `original`)
  is far too strict to catch them (they land at IoU ≤ 0.32, some disjoint). Two
  small sanitizer fixes: an overlap-gated identical-text collapse (conservative —
  does NOT touch disjoint duplicates, so legitimately repeated dialogue in
  separate bubbles is preserved), and dropping the noisy-corner box instead of
  reinterpreting it as width/height. Runs on the §1 re-translate for free.
- **Snap-failure fallback cover-pad (§3, render safety net — free).** Enable the
  outward cover-pad the 9.4 handoff deliberately deferred, now with a
  **neighbour-aware clamp** so it can't spill onto an adjacent region. Handles
  the residual pages where the model still boxes tight despite §1. Pure render
  change; reaches cached pages on the next repaint, no re-snap.
- **Snap-outcome instrumentation (§4, OPTIONAL dev aid — not in the DoD).** A
  debug-flagged per-region log of snapped-vs-fallback, so the NEXT live pass can
  see the failure modes instead of guessing. Ship only if cheap.

**What the prior live-pass evidence established (do NOT re-litigate):**

- **The provider-resolution ceiling is real and binding.** `maxImageEdgePx`
  1200 sits just under Anthropic's ~1.15 MP / 1568 px vision cap; 1600/1800 were
  tested WORSE (a second downsample smears CJK strokes). Resolution is NOT a
  quality lever. No `maxImageEdgePx`/`jpegQuality`/tiling changes this phase.
- **Fill opacity < 1 is a direct bleed-through cause.** 9.4 §1 already makes the
  snap-FAILURE fallback opaque; the good-hit case is the user's Options knob.
- **The provider already splits sentences across bubbles correctly** (HAR Call 1:
  *"I will become your knight," / "and at the same time, your master."*). Do NOT
  build client-side sentence re-splitting — the model gets meaning-across-bubbles
  right when it translates the whole page in one call; the defect is *placement/
  fit of correctly-split text*, which §1 targets.
- **The 4 aborted requests in the HAR (status 0, ~40 ms) are client-side cancels
  on fast-scroll/navigation, not upload failures.** The existing
  reset-and-re-observe on an `aborted` result ([viewportQueue.ts:850](../src/content/viewportQueue.ts))
  already retries a still-registered image; the only gap is a node the reader
  recycled AND the user never scrolls back to — benign. **Retry-on-recycle is OUT
  OF SCOPE** (see "Explicitly out of scope").

Read first: `docs/PROMPTS.md` §2/§3 (the schema + system-prompt template);
`src/background/providers/prompt.ts` (the `SYSTEM_PROMPT_TEMPLATE` bbox rules at
~L207–214, the `bbox` schema `description` at ~L65–71); `src/shared/constants.ts`
(`PROMPT_VERSION`); `src/background/providers/ProviderBase.ts` (`parseBbox` at
~L354–397 — the corner/legacy fallback, `sanitizePage`/`dedupeIdentical` at
~L439–500, `IDENTICAL_DEDUPE_IOU`); the Phase 9/9.1/9.2/9.3/9.4 summaries in
`PROGRESS.md`; `src/content/overlay/BubbleBox.ts` (the fill layer + fallback at
~L206–228, `effectiveFillOpacity`, `region.fillColor` as the "snap accepted"
signal); `src/content/overlay/OverlayManager.ts` (the `paint` seam where the 9.4
`suppressFill` parallel array is computed and threaded — the cover-pad follows
the same pattern); `src/content/overlay/geometry.ts` (`PxRect`, `regionToPx`).

**Verified-green baseline (2026-07-20, do NOT rebuild/re-verify): 786 unit tests
via `npm run check`, `npm run test:e2e` 4/4 (A–D) on this machine, `vite build`
clean, `web-ext lint` 0/0/0.**

**Already shipped — do NOT rebuild:** the whole Phase 9/9.1/9.2/9.3/9.4 pipeline
(contour capture, outward offset, median fill + paper snap, `SNAP_VERSION` local
re-snap, seed rescue, centroid inscribed rect, z-index layering, ellipse gate,
confinement + wall-slam + the bounded 1.0 cascade, word-integrity cap,
`SNAP_MAX_EDGE` 768, opaque snap-failure fallback, contained-fill suppression).
`SNAP_VERSION` stays **4**, `CACHE_VERSION` stays **2**. Only `PROMPT_VERSION`
moves (§1).

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages. Every exported function/class gets JSDoc; `// WHY:` on every non-obvious
   decision.
2. Pure-core / thin-shell split: the dedupe policy (§2), the `parseBbox` guard
   (§2), and the cover-pad geometry (§3) are pure, browser-free, unit-tested
   functions; DOM stays in the shells. §1 is a pure string change to a pure
   module.
3. **NO `shared/types.ts` change, no new messages, no manifest change.**
   Sanctioned surface changes, flag them in the PROGRESS summary:
   (a) `PROMPT_VERSION` 2 → 3 (`shared/constants.ts`) + the `SYSTEM_PROMPT_TEMPLATE`
   / schema-description edits in `prompt.ts`;
   (b) sanitizer-local changes in `ProviderBase.ts` (`parseBbox` plausibility
   guard; `dedupeIdentical` overlap-gate + a new module-local IoU/​kind constant);
   (c) a render-side cover-pad: a pure helper (in `overlapTrim.ts` or a sibling
   pure module) + a parallel-array thread through `OverlayManager.paint` into a
   new `RenderBubbleOptions` field (render-local, like 9.4's `suppressFill`), and
   a module-local pad constant. Anything beyond: stop and flag before building.
4. All coordinates stay normalized 0–1 against the ORIGINAL image; the cover-pad
   works in overlay-local px (`PxRect`) at render time and never touches the
   cached page.
5. Fail soft, in the cost direction. §1 changes ONLY the prompt text + version;
   it does not change WHEN or WHAT triggers a provider call. §2 only ever DROPS or
   MERGES provider noise (never invents a region). §3 only grows a fallback fill's
   coverage; it never changes the label text or the snapped-hit path.
6. **`PROMPT_VERSION` → 3** (§1; folded into `buildCacheKey`, so every page
   re-translates once on next view — this is the accepted paid cost, confirmed
   with the user). `SNAP_VERSION` = 4 and `CACHE_VERSION` = 2 **untouched**: §2 is
   upstream of the snap and reaches pages via the §1 re-translate (NOT via
   re-snap — the cached `rawPage` is post-sanitize); §3 is a pure repaint. Old
   `p2` cache entries age out via the existing LRU; no `CACHE_VERSION` bump.
7. No test hooks in shipped code. When done: `npm run check` + `npm run build` +
   `npm run lint:ext` clean, **`npm run test:e2e` green with Scenarios A–D
   UNMODIFIED on this machine**, and a Phase 9.5 summary appended to `PROGRESS.md`
   in the house style (deliberate calls + honest manual-verification status).

## Suggested landing order

**§2 (P1) is independent and safe — land it first** (small, self-contained,
no version bump interactions). Then **§1** (the paid prompt change), then **§3**
(the render safety net that backs §1 up). §4 is optional and last.

## New files

None required. A new pure module for the cover-pad geometry is acceptable if it
reads cleaner than extending `overlapTrim.ts` (flag which you chose). Tests
extend `ProviderBase.test.ts` / the pipeline golden fixtures, `prompt.test.ts`,
`cache.test.ts` (key format), and `BubbleBox.test.ts` / `overlapTrim.test.ts`.

---

## 1. [Prompt] Whole-balloon bounding boxes (the root fix — PAID)

**Symptom (HAR + screenshot-verified):** the model boxes vertical-CJK dialogue
as a narrow glyph strip, offset from the round balloon. Snap seeds land on art or
just inside the strip; the rescue's ≥40 % provider-box-overlap guard
([bubbleSnap.ts:1200](../src/background/bubbleSnap.ts)) rejects the real balloon
because the offset strip barely overlaps it; the fallback paints the strip →
English floats off the balloon, source bleeds around it.

**Build (`prompt.ts` + `shared/constants.ts`):**

- Rewrite the `BOUNDING BOX RULES` block in `SYSTEM_PROMPT_TEMPLATE`
  (~L210–214). Replace the single tight-text line with a **kind-conditional**
  rule. Target text (tune wording to the surrounding template voice):

  ```
  BOUNDING BOX RULES:
  - Coordinates are FRACTIONS of the image dimensions, between 0 and 1.
  - Format: [x_min, y_min, x_max, y_max] — the top-left and bottom-right
    corners. x_max must be greater than x_min, and y_max greater than y_min.
  - For SPEECH BUBBLES and THOUGHT BUBBLES (kind "bubble" or "thought"): the
    box must enclose the ENTIRE balloon — the whole drawn white or
    solid-coloured bubble shape, INCLUDING the blank margin around the text —
    not just the glyphs. Use the balloon's drawn outline as the box extent.
  - For text that sits on the artwork — CAPTIONS, SOUND EFFECTS, SIGNS (kind
    "caption", "sfx", "sign", "other"): box the TEXT tightly, so the box does
    not cover the surrounding art.
  - One box per balloon. If a single line of dialogue spans two connected or
    joined balloons, emit a SEPARATE region for each balloon lobe, each boxed
    to its own lobe.
  - If unsure, err slightly larger, never smaller. Never let a box extend past
    the image edges.
  ```

- Update the `bbox` schema `description` (~L70) so it does NOT contradict the new
  rule — keep the corner-format sentence, drop/soften any "tight to text"
  implication; the per-kind guidance lives in the template, so the schema
  description can stay format-only.
- Bump `PROMPT_VERSION` 2 → 3 in `shared/constants.ts`. WHY: the bbox instruction
  is part of the cache key's prompt identity (Architecture §7.3 / the 4.1 key
  spec) — an un-bumped change would serve stale `p2` boxes from cache and never
  re-translate. This is the accepted paid cost.
- Do NOT change the JSON schema shape, the dialect converters, honorifics/reading
  slots, or any other template section — bbox rules + version only.

**Interactions to note (for the PROGRESS summary + the live pass):** balloon
boxes are larger and overlap neighbours more than tight strips did, so
`trimOverlaps` and the 9.4 contained-fill suppression will fire more often —
expected and handled (snap should now SUCCEED on most of these, producing tight
shaped fills that don't overlap even when the boxes do). Watch for two balloons
merged into one region (the "one box per lobe" line is the mitigation) and for a
balloon box tripping the sanitizer whole-page guard (it won't — balloons stay
well under `MAX_REGION_AREA` 0.9).

🧪 *Tests (`prompt.test.ts` + cache key):* the built system prompt CONTAINS the
new per-kind bbox language (assert on the "ENTIRE balloon" and "box the TEXT
tightly" substrings, and "one box per balloon"); it no longer contains the old
"tightly enclose the TEXT itself, not the entire bubble outline" line.
`PROMPT_VERSION === 3`. `buildCacheKey` tests that pin `p2` update **mechanically**
to `p3` (per-field change detection is unchanged — only the literal moves). Any
other test asserting the old prompt substring updates to the new text.

## 2. [Sanitizer] Duplicate + degenerate region cleanup (P1 — free)

**Symptom (HAR Call 11, screenshot-verified):** on a dense page the model
emitted `與此類似` → *"it's similar to magic power too."* as THREE overlapping/
nearby regions (r15/r16 overlap at IoU 0.32; r18 disjoint) and
`讓其結合並提高密度的話` twice (r12/r13). r12's corners are
`[0.480, 0.650, 0.650, 0.620]` — **y_max < y_min** — so `parseBbox` reads the row
as legacy `[x, y, w, h]` and clamps it into a `0.52 × 0.35` box across the
bottom-right, painted with the same sentence as r13. Result: stacked/duplicated
English covering the panel. Today's `dedupeIdentical` (IoU > 0.85 AND identical
`original`) catches none of it.

**Build (`ProviderBase.ts`, sanitizer-local — do NOT touch the contract):**

- **`parseBbox` plausibility guard.** When the array corner reading is
  non-positive (`cw ≤ 0 || ch ≤ 0`) and the code falls back to the legacy
  `[x, y, w, h]` reading, accept the legacy reading ONLY if it is plausibly a
  w/h box: `c > 0 && d > 0 && x + c ≤ 1 + ε && y + d ≤ 1 + ε` (ε ≈ 0.02). Else
  return `null` (drop). WHY: a real third-party w/h box fits the image
  (`x + w ≤ 1`); a noisy CORNER box like r12 (`c = 0.65` reinterpreted as a width
  from `x = 0.48` needs `x + c = 1.13`) does not, so heavy clamping is the tell
  that it was corners-with-noise, not w/h. Preserves w/h back-compat for the
  half-of-Haiku-emits-w/h case the corner heuristic was built for; drops the
  balloon. Keep the existing joint clamp as the final backstop.
- **Overlap-gated identical-text collapse in `dedupeIdentical`.** Add a new
  module-local `IDENTICAL_OVERLAP_IOU = 0.3`. For a pair whose NORMALIZED
  `original` (trim + collapse internal whitespace, so newline-wrapped OCR matches)
  is identical, whose `kind` is `bubble`/`thought`/`caption` (NOT `sfx`/`sign`/
  `other`), and whose IoU `> IDENTICAL_OVERLAP_IOU`, keep the **larger-area**
  region and drop the other. The existing IoU > 0.85 identical-`original` rule
  stays as the general path for all kinds. WHY overlap-gated + kind-scoped (the
  user's explicit steer): repeated dialogue across a real conversation lives in
  SEPARATE, non-overlapping balloons (IoU ≈ 0) — never collapse those; two
  detections of the SAME balloon overlap. `sfx` legitimately repeats verbatim at
  different spots (パチ/ドズ), and those are disjoint, so leaving sfx on the strict
  path is belt-and-suspenders. WHY keep-larger: the bigger box is likelier the
  real balloon; the smaller is the spurious echo. r18 (disjoint) intentionally
  SURVIVES — one stray copy is far less harm than risking a real repeated line.

**Reach:** these run in `sanitizePage`, so they clean NEW translations. Cached
pages are re-translated by §1's `PROMPT_VERSION` bump, so every page re-sanitizes
on next view — no separate cache-reach mechanism, no `SNAP_VERSION` bump.

🧪 *Tests (`ProviderBase.test.ts` / pipeline goldens):* `parseBbox` — the r12
vector `[0.480, 0.650, 0.650, 0.620]` → `null`; a genuine w/h box
`[0.1, 0.2, 0.3, 0.15]` (corners degenerate, legacy plausible) → still parsed as
`{0.1,0.2,0.3,0.15}` (back-compat pinned); a valid corner box unaffected.
`dedupeIdentical` — three identical-`original` `bubble` regions, two overlapping
+ one disjoint → the two overlapping collapse to the larger, the disjoint one
survives; two identical-`original` `sfx` regions overlapping → BOTH kept (kind
exemption); different-`original` overlapping regions → both kept; whitespace-only
difference in `original` treated as identical. A golden fixture modelled on Call
11 (24 regions in → the r12 balloon dropped, each duplicate cluster collapsed by
one) is the end-to-end pin.

## 3. [Fills] Snap-failure fallback cover-pad (render safety net — free)

**Symptom:** §1 should make most bubbles snap or at least box the balloon, but a
page where the model ignores the new rule (still tight) falls to the 9.4 opaque
fallback — an opaque patch smaller than the balloon, English cramped/off-centre.
The 9.4 handoff deferred the cover-pad ("padding risks nudging a fallback box
over a neighbour"); with a neighbour-aware clamp that risk is removed.

**Build (a pure helper + `OverlayManager.paint` + `BubbleBox.ts`):**

- Pure, unit-tested `computeFallbackCoverRects(regions, rects, opts)` returning a
  PxRect[] **parallel** to `rects` (same seam as 9.4's `suppressFill`). For each
  region: if `isBubbleKind(region.kind) && region.fillColor === undefined` (a
  snap-failure bubble), expand its rect outward by `FALLBACK_COVER_PAD` (module-
  local, default **0.12** of the box extent per side), **clamped** so no edge (a)
  leaves the image/overlay bounds or (b) crosses INTO any other region's draw
  rect that lies in that direction (per-edge min against the nearest neighbour).
  Every other region returns its rect UNCHANGED. Pure/deterministic.
- `OverlayManager.paint` computes the array once (it already holds all regions +
  rects for `suppressFill`) and passes each region's cover rect into
  `renderBubbleBox` via a new render-local option (e.g. `RenderBubbleOptions.drawRect`,
  defaulting to the region's own `rect`). BubbleBox uses that rect for the box
  geometry — so the fill AND the derived `inner` text rect both grow, giving the
  English room and covering more of the balloon. The successful-snap path (shape,
  ellipse, inscribed rect) is UNTOUCHED (only fires when `fillColor === undefined`).
- WHY a neighbour clamp, not a flat pad: an isolated tight box grows to cover its
  balloon; a crowded one grows only into empty space, never over a neighbour's
  bubble. WHY 0.12: covers a typical text-strip→balloon margin without being
  reckless; it is the tuning knob (lower if any spill appears, raise if tight
  boxes still show a CJK rim).

🧪 *Tests (`overlapTrim.test.ts` or the helper's suite + `BubbleBox.test.ts`):*
an isolated snap-failure bubble expands on all four sides by the pad; a
snap-failure bubble with a neighbour rect abutting its right expands less (or
not) on the right, full pad elsewhere; a SNAPPED bubble (`fillColor` set) and a
non-bubble kind return the rect unchanged; expansion clamps to image bounds. A
render assertion: a fallback bubble's box uses the padded rect (wider fill +
larger text rect) while a snapped one is unchanged. Purity/determinism.

## 4. [Dev] Snap-outcome instrumentation (OPTIONAL — not in the DoD)

Ship ONLY if it stays cheap; skip without penalty. Behind a `const DEBUG_SNAP =
false` (or an existing debug-log gate), have `snapAllRegions` emit a per-region
`console.debug` table: index, `kind`, provider bbox, and outcome —
`snapped` vs `fallback`. That alone (which `snapAllRegions` already knows without
new plumbing) lets the next live pass count how often §1 fixed the snap rate.
**Do NOT** refactor `snapRegionToBubble`'s `null` return into a reason union for
this — that is a larger change than the aid is worth; "snapped vs fell back" is
enough signal. No shipped behaviour change; the flag stays `false` in the build.

## Explicitly out of scope

- **Retry-on-recycle for cancelled pages (P3).** The HAR's 4 aborts are benign
  fast-scroll cancels; the existing reset-and-re-observe already retries a
  still-registered image. A recycled-node-plus-scroll-back retry is a future
  queue refinement, not this phase. Note it in PROGRESS as diagnosed-and-deferred.
- **Client-side sentence re-splitting across bubbles.** The provider already
  splits correctly (evidence note above). Do not build it.
- **Resolution / image-prep** (settled — 1200 is at the provider ceiling),
  inpainting, shaped text layout, local OCR, convex-hull/ellipse shape smoothing,
  settings/UI redesign, Chrome port, F16/F18.
- Any further snap-recovery tuning (rescue overlap guard, confinement constants):
  §1 changes the input to the snap; let the live pass re-measure BEFORE touching
  the recovery machinery again. Do NOT pre-emptively loosen the rescue guard.

## Immediate no-code levers (tell the user; independent of this phase)

1. `maxImageEdgePx` stays **1200** (do not re-test higher).
2. Bubble fill opacity **100 %** in Options kills source bleed-through on good
   hits today (pure re-render, no re-pay).
3. §1 will re-translate the whole cache once (the paid cost). Expect a one-time
   spend bump on the next chapters opened after this ships; cached pages are then
   `p3` and free again.

## Manual verification (live key + MangaDex; record honestly if not run)

§1 re-translates on view (network panel shows provider calls the first time a
previously-cached page is re-opened — that is EXPECTED, the `p2 → p3` re-key):

1. Re-open the 2026-07-20 screenshot pages. Bubbles now box the **balloon** —
   fills snap tight to the drawn outline, English sits centred INSIDE the bubble,
   no source bleeding around a floating strip. Connected/spanning bubbles: one
   fill per lobe, text in each lobe (not floating over the neck).
2. The "magic power" ad page (HAR Call 11): the tripled *"it's similar to magic
   power too."* and the panel-covering *"...bond and increase the density,"* box
   are GONE — at most one stray copy, no quarter-page rectangle.
3. A page where the model still boxes tight (if any): the §3 cover-pad grows the
   opaque fallback toward balloon size without spilling onto neighbours.
4. Spend: after the one-time re-translate, re-opening a page is free (cache hit,
   zero provider calls); chapter-open budget still ≤ ~6.
5. No regressions on good Phase 9.4 hits (shaped fills, dark/flash bubbles,
   peek, SFX left translucent, no new cross-panel fills).

## Definition of done

- `npm run check` green (786 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` 4/4 with Scenarios A–D
  UNMODIFIED on this machine**.
- Only sanctioned surface changes: `PROMPT_VERSION` 2 → 3 + the `prompt.ts` bbox
  text; `parseBbox` plausibility guard + `dedupeIdentical` overlap-gate (+ the new
  module-local constant) in `ProviderBase.ts`; the cover-pad pure helper + the
  `OverlayManager`→`RenderBubbleOptions.drawRect` parallel-array thread + the pad
  constant. `SNAP_VERSION` = 4, `CACHE_VERSION` = 2, no `shared/types.ts` /
  message / manifest change.
- `PROGRESS.md` Phase 9.5 summary in the house style: the twelfth-live-pass
  evidence (the tight-text prompt as the floating root; the Call 11 duplicate/
  degenerate regions; the benign aborts), each section's deliberate calls
  (whole-balloon boxes as the paid root fix; overlap-gated + kind-scoped dedupe
  that preserves repeated dialogue; keep-larger; the r12 plausibility drop; the
  neighbour-clamped cover-pad and its 0.12 knob), the P3/re-split deferrals with
  their evidence, and honest manual-verification status.
