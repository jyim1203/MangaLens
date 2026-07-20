# Phase 9.4 — Graceful fill fallback, confinement cascade, contained-fill suppression (handoff)

You are implementing **Phase 9.4** of the MangaLens Firefox extension: the
fix-list from the **eleventh live-pass evidence** (2026-07-20, MangaDex,
vertical-CJK series, Anthropic `claude-sonnet-5`, on the Phase 9.3 build). Phase
9.3 did its job — the cross-panel white-fill leaks are gone. What remains is the
*flip side*: where a bubble can't be snapped, the fallback render is poor, so the
symptom shifted from "paint spills out" to "text floats over an unpainted bubble
and the original Chinese leaks through." This phase makes the **failure path**
graceful and recovers more real bubbles before we ever reach it. Every change is
client-side — **zero provider cost, no cache clear, no re-pay.**

Three fronts:

- **Graceful snap-failure fallback (§1).** When the snap accepts no blob
  (`fillColor` undefined) on a speech bubble, BubbleBox today draws the raw
  provider box as an 8 px rounded rect filled at the user's `bubbleFillOpacity`
  (default **0.92**). Two defects compound: the fill is translucent, so 8 % of
  the source ink bleeds through under the English; and on an offset/tight
  provider box the English floats over an area with no meaningful paint while the
  real bubble sits unpainted. Fix: a snap-failure fallback on an eligible bubble
  paints **fully opaque** (we couldn't find the paper, so cover the source
  completely) — the single biggest visible win, and it reaches cached pages on
  the next repaint with NO re-snap.
- **Bounded confinement cascade (§2).** Reduce how often we hit that fallback at
  all. Phase 9.3's hard 2×-box wall rejects a genuinely undersized/offset
  provider box the same way it rejects a margin leak — binary, no middle ground.
  Add a bounded cascade: try `confineExpand` 0.5, and only if that yields nothing
  retry at 1.0 (3× per axis) before giving up. Recovers real bubbles whose true
  extent runs just past 2× the box, WITHOUT reopening the cross-panel leak (the
  4×-area cap and the compactness guard still bound the looser pass — see §2).
- **Contained-fill suppression (§3).** The "weird overlaps": `trimOverlaps`
  deliberately leaves *containment* pairs alone (one box fully inside another — a
  duplicate detection) and relies on draw order. In the Phase 9 fill era two
  stacked fills then double-paint / patch-fight visibly. Fix: when a region's
  draw box is fully contained by another's, suppress the INNER region's fill
  (paint only its label). Safe in every overlap scenario — the outer fill already
  covers that area — and it directly removes the stacked-fill artifact.

**What the live-pass evidence established (do NOT re-litigate):**

- **The provider-resolution ceiling is real and binding.** Bumping
  `maxImageEdgePx` 1200 → 1600 → 1800 (with a cache clear + full re-translate)
  made detection **significantly worse**: more missed bubbles, more untranslated
  regions, more fallbacks. Mechanism: Anthropic's vision API caps effective
  input at ~1.15 MP / 1568 px long edge and downsamples anything larger on its
  own side. A portrait manga page at 1200 long edge (~0.96 MP) sits just under
  the ceiling and is seen essentially as-sent; at 1600/1800 (1.7–2.4 MP) it is
  resampled a SECOND time on top of our JPEG-0.8 encode, smearing thin CJK
  strokes and thin bubble outlines. **`maxImageEdgePx` is NOT a quality lever —
  1200 is at the ceiling; higher is strictly worse. Revert to 1200. Do not
  re-open resolution as an option.**
- **Fill opacity < 1 is a direct bleed-through cause.** The default 0.92 lets 8 %
  of the source ink show wherever a fill sits over ink — visible under the
  English even on GOOD hits. §1 makes the *fallback* opaque; the user can also set
  bubble fill opacity to 100 % in Options today as an immediate, no-code, no-cost
  workaround for the good-hit case.
- **Snap failure is sometimes unsolvable by flood fill** — captions on textured
  or patterned backgrounds, near-outline-less narration, bubbles whose provider
  box is offset beyond the §4 rescue's reach. Flood fill has no floodable region
  there by design; the fix for those is a good *fallback render* (§1), not more
  snap tuning.
- Cache reset does NOT fix any of this and costs a full re-translate; §1/§3 are
  pure render changes (reach cached pages on the next repaint), §2 arrives via
  the existing SNAP_VERSION re-snap machinery. Nothing here needs a cache clear.

Read first: `docs/ARCHITECTURE.md` §7.5/§7.7; the Phase 9.1/9.2/9.3 summaries in
`PROGRESS.md`; `src/content/overlay/BubbleBox.ts` (the fill layer at ~L170–185,
the geometry-mode branch at ~L114–140, `region.fillColor` as the "snap accepted"
signal); `src/content/overlay/overlapTrim.ts` (`trimOverlaps`, the `contains`
helper, the containment skip at ~L74); `src/background/bubbleSnap.ts`
(`snapRegionToBubble` seed loops + `accept` closure + the §1 confinement window,
`snapAllRegions` Stage 1b where the confined final snap runs, `SNAP_CONFINE_EXPAND`,
the leak caps `MAX_BLOB_BOX_RATIO`/`MAX_BLOB_IMAGE_FRACTION`, the compactness guard
`MIN_BLOB_BBOX_FILL`, `SNAP_VERSION`); `src/shared/settings.ts`
(`bubbleFillColor`/`bubbleFillOpacity` defaults).

**Verified-green baseline (2026-07-20, do NOT rebuild/re-verify): 763 unit tests
via `npm run check`, `npm run test:e2e` 4/4 (A–D) on this machine, `vite build`
clean, `web-ext lint` 0/0/0.**

**Already shipped — do NOT rebuild:** the whole Phase 9/9.1/9.2/9.3 pipeline
(contour capture, outward offset, median fill + paper snap, `SNAP_VERSION` local
re-snap, seed rescue, centroid inscribed rect, z-index layering, ellipse gate,
§1 confinement + wall-slam, the word-integrity cap, `SNAP_MAX_EDGE` 768). The
cache store/LRU/key — `CACHE_VERSION` stays 2, `PROMPT_VERSION` stays 2. Every
section below adjusts render call sites / adds one guarded snap retry.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages. Every exported function/class gets JSDoc; `// WHY:` on every
   non-obvious decision.
2. Pure-core / thin-shell split: the fallback-opacity decision (§1), the cascade
   policy (§2), and the containment suppression (§3) are pure, browser-free,
   unit-tested functions or tested closures; DOM/canvas stays in the shells.
3. **NO `shared/types.ts` change, no new messages, no manifest change.**
   Sanctioned surface changes, flag them in the PROGRESS summary:
   (a) a new module-local `SNAP_CONFINE_EXPAND_LOOSE` constant + the Stage-1b
   cascade in `snapAllRegions` (no new `SnapOptions` field — the cascade passes
   `confineExpand` through the EXISTING option);
   (b) a small render-side helper for the fallback fill opacity (content-internal);
   (c) contained-fill suppression inside `trimOverlaps` (or a sibling pure
   helper it calls). Anything beyond: stop and flag before building.
4. All coordinates stay normalized 0–1 against the ORIGINAL image.
5. Fail soft, in the cost direction: every snap rejection still falls back to the
   provider box; nothing changes WHAT is sent to the provider or when. §2's
   looser pass must never ACCEPT something 0.5 would have had to reject as a leak
   — it only rescues fills the *wall* (not a leak cap or the compactness guard)
   blocked.
6. **`SNAP_VERSION` → 4** (§2 changes snap output; delivered via free re-snap on
   cache hit — NEVER in `buildCacheKey`, ground rule 8 of 9.1). §1 and §3 are
   pure render changes and need NO version bump (they redraw the cached page).
   `PROMPT_VERSION` and `CACHE_VERSION` untouched.
7. No test hooks in shipped code. When done: `npm run check` + `npm run build` +
   `npm run lint:ext` clean, **`npm run test:e2e` green with Scenarios A–D
   UNMODIFIED on this machine**, and a Phase 9.4 summary appended to `PROGRESS.md`
   in the house style (deliberate calls + honest manual-verification status).

## New files

None required. Changes land in `BubbleBox.ts`, `overlapTrim.ts`, `bubbleSnap.ts`;
tests extend `BubbleBox.test.ts`, `overlapTrim.test.ts`, `bubbleSnap.test.ts`. A
tiny shared `isBubbleKind` helper (if you factor the kind check out of
`bubbleSnap`'s `SNAP_KINDS`) may live in `shared/` — flag it if you add it.

---

## 1. [Fills] Graceful snap-failure fallback (opaque cover)

**Symptom (screenshot-verified):** on a speech bubble the snap accepted no blob,
so `region.fillColor` is undefined and BubbleBox draws the raw provider box as an
8 px rounded rect filled `bubbleFillColor` at `bubbleFillOpacity` (0.92). The
translucent fill lets the source Chinese bleed through under the English, and
where the box is tight/offset the English floats over near-unpainted paper while
the real bubble sits uncovered.

**Build (`BubbleBox.ts` + a pure helper):**

- Add a pure decision (content-internal, unit-tested): the fill layer's effective
  opacity. A region that is a **snap-eligible bubble kind** (`bubble`/`thought`)
  with **`fillColor === undefined`** (snap did not accept a blob) → **opacity 1**.
  Everything else — a successfully-snapped bubble (`fillColor` set), and every
  non-bubble kind (SFX/narration, which we must NOT white out) — keeps the user's
  `bubbleFillOpacity`. WHY opaque only for the bubble fallback: a fallback means
  "we could not find the paper here," so fully hiding the source is strictly
  better than a faint leak; a real snapped bubble legitimately honors the user's
  art-peek translucency, and SFX art must stay visible.
- Wire it at the fill layer (~L179): `opacity: String(effectiveFillOpacity(...))`
  instead of the bare `font.bubbleFillOpacity`. No other change to the fill node.
- The fallback rect stays the provider box (no geometry invented). OPTIONAL knob,
  behind a named constant, default OFF: a small outward pad (~2–3 % of box extent,
  clamped to `[0,1]`) so a slightly-tight provider text-box fully covers its CJK.
  WHY off by default: padding risks nudging over a neighbour; ship the opacity fix
  first, expose the pad as a tunable, decide from the live pass.
- Do NOT touch the successful-snap path (shaped fill, ellipse gate, inscribed
  rect) — the user reports good hits look right; this section only rescues the
  failure render.

🧪 *Tests (`BubbleBox.test.ts` + the helper's own suite):* the opacity helper —
`bubble` + undefined `fillColor` → 1; `bubble` + a `fillColor` → user opacity;
`thought` + undefined → 1; `sfx`/`narration` + undefined → user opacity (NOT
whited out); a rendered fallback bubble's fill node has `opacity: "1"` while a
snapped bubble's honors the setting. Determinism.

## 2. [Fills] Bounded confinement cascade (recover real bubbles)

**Symptom:** an undersized or slightly-offset provider box on a real white bubble
whose true extent runs just past the 9.3 2×-box wall — the fill slams the wall,
`accept` rejects it (correct for a margin leak, wrong here), the rescue grid also
misses, and we fall to the §1 fallback. The bubble was real; we just walled it
off too tightly.

**Build (`bubbleSnap.ts`, in `snapAllRegions` Stage 1b):**

- `export const SNAP_CONFINE_EXPAND_LOOSE = 1.0` — the second, looser confinement
  (3× per axis). WHY 1.0 and NOT `Infinity`: keep a hard wall so a cross-panel
  margin leak is still bounded; 1.0 doubles the reach of the 0.5 window while
  staying well inside the 4×-box area leak cap.
- Stage 1b non-grouped final snap becomes a cascade: try
  `snapRegionToBubble(img, r.bbox, opts)` (default 0.5); if it returns `null`,
  retry `snapRegionToBubble(img, r.bbox, { ...opts, confineExpand:
  SNAP_CONFINE_EXPAND_LOOSE })`. First non-null wins; still-null keeps the
  provider box (→ §1 fallback). The DETECTION pass (Stage 1a, `confineExpand:
  Infinity`) and grouped/lobe fills are UNCHANGED — the cascade is only the lone-
  region final result.
- WHY this can't reopen the 9.3 leak: the looser pass is still gated by the
  UNCHANGED `MAX_BLOB_BOX_RATIO` (4× box area) / `MAX_BLOB_IMAGE_FRACTION` caps
  and by `MIN_BLOB_BBOX_FILL` — a real undersized bubble fills a COMPACT region
  (high bbox-fill ratio) that merely extends past 2× box, so the compactness
  guard passes and the wall was the only thing rejecting it; a margin leak is
  SPINDLY (runs through a thin gutter — large bounding box, small area), so at 1.0
  the compactness guard rejects it exactly as before. The wall at 2× was the
  discriminator for undersized bubbles; the compactness guard is the
  discriminator for leaks. Loosening the wall shifts the leak defense to the guard
  that was already catching it.

🧪 *Tests (`bubbleSnap.test.ts`):* an undersized-box fixture — a white bubble
whose true extent is ~2.5× the provider box per side, COMPACT — returns `null` at
`confineExpand: 0.5`, snaps at `1.0`, and the Stage-1b cascade in `snapAllRegions`
recovers it end-to-end. The 9.3 margin-leak fixture STILL returns `null` at BOTH
0.5 and 1.0 (pins the rejection on the compactness guard, not the wall — assert
it also rejects with `confineExpand: 1.0` directly). A fully-inside bubble is
byte-identical across 0.5/1.0 (the cascade never runs a second pass when the
first accepts). `SNAP_VERSION === 4`. Determinism.

## 3. [Layout] Contained-fill suppression (kill stacked-fill overlaps)

**Symptom (the "weird overlaps"):** `trimOverlaps` nudges overlapping neighbours
apart but deliberately SKIPS containment pairs (one box fully inside another — a
duplicate detection error it won't distort) and skips overlaps beyond its 30 %
shrink cap, leaving them to draw order. Pre-Phase-9 that was fine (text stacked
readably); now each region also paints a FILL, so two stacked fills double-paint
or patch-fight and read as a smeared overlap.

**Build (`overlapTrim.ts` or a sibling pure helper):**

- Compute, for the trimmed regions, a per-region boolean `suppressFill`: true iff
  this region's (trimmed) draw box is fully `contains`-ed by another region's
  draw box. Return it alongside the region (extend the render metadata the
  overlay already carries, WITHOUT adding a `shared/types.ts` field — thread it as
  a parallel array or a render-local wrapper, whichever the overlay's current
  seam prefers; flag which you chose).
- BubbleBox / the overlay: when `suppressFill` is set, skip appending the fill
  node (paint the label only). The outer fill already covers that area, so the
  inner fill can only ever double-cover it. Labels are UNAFFECTED — both still
  draw at z-index 2, so no text is lost.
- WHY suppress the fill and not the whole region: the two detections may carry
  DIFFERENT text (the model split one bubble, or OCR'd it twice) — dropping a
  region would lose a translation. Suppressing only the redundant paint is the
  minimal, always-safe fix. WHY not merge (as `trimOverlaps`' own header warns):
  merging invents a bubble that doesn't exist.
- Keep it tie-stable and deterministic: exact-equal boxes (mutual containment)
  suppress the LATER one in reading order only (never both — that would expose the
  art with no paint).

🧪 *Tests (`overlapTrim.test.ts`):* a contained pair → inner `suppressFill` true,
outer false; equal boxes → only the later suppresses; disjoint / partial-overlap
pairs → neither suppresses (regression: trimming behaviour unchanged);
three-region nest → only the middle and inner suppress. Purity/determinism. If a
render assertion is added, the suppressed region emits no fill node but still its
label.

## Explicitly out of scope

- **Prompt / detection phase (future, paid iteration):** whole-bubble misses,
  boxes offset beyond the §4 rescue's reach (English renders beside still-visible
  original — a *placement* miss no client fill can fix), several bubbles merged
  into one region. Collect the 2026-07-20 screenshot set as its evidence;
  `PROMPT_VERSION` stays 2 this phase.
- **Resolution / image-prep:** settled — 1200 is at the provider ceiling (see the
  evidence note). No `maxImageEdgePx`/`jpegQuality`/tiling changes.
- Inpainting, shaped text layout, local OCR; convex-hull / ellipse-fit shape
  smoothing; settings/UI redesign; Chrome port; F16/F18.

## Immediate no-code levers (tell the user; independent of this phase)

1. Revert `maxImageEdgePx` to **1200** in Options (undo the 1600/1800 test).
2. Set bubble fill opacity to **100 %** in Options — kills source bleed-through on
   good hits today, no re-pay (pure re-render of cached pages). §1 makes the
   FALLBACK opaque regardless; this covers the snapped-hit case for a user who
   otherwise wants translucency.

## Manual verification (live key + MangaDex; record honestly if not run)

WITHOUT clearing the cache (§1/§3 arrive on the next repaint; §2 via re-snap):

1. Background console shows `re-snapped cache hit … (snapVersion → 4)` on
   previously-paid pages; network panel shows ZERO provider calls for them.
2. Snap-failure bubbles (captions, textured-background panels, the offset boxes
   from the 2026-07-20 screenshots) now render an OPAQUE fill — no Chinese
   bleeding through under the English; worst case a clean opaque box, not a faint
   floating overlay.
3. Some previously-fallback bubbles now snap tight (the §2 cascade recovered
   them); no NEW cross-panel fills appear (the leak defense held at 1.0).
4. The "weird overlap" pages: stacked/duplicate bubbles no longer show a smeared
   double-fill — only one fill paints per contained pair, both labels present.
5. Spend behavior unchanged: chapter open ≤ ~6 requests, forward reading tracks
   `prefetchAhead`, reverse skim buys ~nothing.

## Definition of done

- `npm run check` green (763 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` 4/4 with Scenarios A–D
  UNMODIFIED on this machine**.
- Only sanctioned surface changes (`SNAP_CONFINE_EXPAND_LOOSE` + the Stage-1b
  cascade; the fallback-opacity helper; contained-fill suppression). `SNAP_VERSION`
  = 4 and NOT in the cache key; `PROMPT_VERSION` = 2, `CACHE_VERSION` = 2; no
  `shared/types.ts` / message / manifest changes.
- `PROGRESS.md` Phase 9.4 summary in the house style: the eleventh-live-pass
  evidence (the resolution-ceiling finding, the opacity bleed-through), each
  section's deliberate calls (opaque fallback scoped to bubble kinds, the bounded
  1.0 cascade + why it can't leak, fill-suppression-not-region-drop), any surface
  you flagged (the `isBubbleKind` factor-out, the `suppressFill` threading seam,
  the optional cover-pad constant), and honest manual-verification status.
