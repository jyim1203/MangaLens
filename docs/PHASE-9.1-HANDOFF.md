# Phase 9.1 — Fill fidelity, placement rescue, and cost hardening (handoff)

You are implementing **Phase 9.1** of the MangaLens Firefox extension: the
fix-list from the **seventh live pass** (2026-07-18, MangaDex confirmed via the
HAR's `mangadex.org` entry, Anthropic `claude-sonnet-5`) — the first live pass
over the Phase 9 shaped fills and reading-window budget. Three fronts:

- **Fill fidelity (§1–§2).** Shaped fills render and often land, but a rim of
  original ink survives around many fills, and the sampled mean fill color
  reads grey against white bubble paper. Root causes are quantified below —
  this is tuning the Phase 9 §3/§7 pipeline, not rebuilding it.
- **Free fill iteration (§3).** The user clears the translation cache between
  fill tests to see snap changes take effect — **re-paying the provider for
  translations that did not change** to test purely-local pixel code. Cache
  the provider's RAW regions alongside the snapped result and re-snap locally
  when the snap logic version changes. The user is cost-sensitive; after this
  ships, iterating on §1/§2-style tuning costs zero provider dollars.
- **Placement & window hardening (§4–§9).** Offset provider boxes escape the
  snap entirely (seeds land on art) and then paint loose white ellipses over
  neighbors and leave the original text fully visible beside its translation;
  a neighbor's opaque fill can paint over an earlier bubble's text; and two
  cheap holes in the §1/§2 reading-window remain (unloaded lazy-load
  placeholders can confirm; backward scrolling buys pages instantly).

**What the live pass established (do NOT re-litigate):**

- The Phase 9 budget HELD at chapter open: 1 request at t=0 (vs 14 the day
  before on the same chapter). The later 21-request sequence was fully
  explained: the user had **cleared the cache**, toggled auto-translate ON
  mid-chapter, and **skimmed the whole chapter** — scroll-driven purchases at
  `prefetchAhead: 3`, first wave of exactly 6 (1–2 visible + near + 3 tail),
  then ~1 page/1–2 s tracking the skim. Working as designed; the §8/§9 items
  below are hardening, not a bug hunt.
- The user's live settings: `prefetchAhead: 3`, `pagesPerRequest: 1`,
  `concurrency: 6`, temporary install via about:debugging in the main profile
  (storage persists; cache misses in the HAR were manual clears only).
- Fills DO follow bubble outlines in good cases; text size is acceptable.
  The defects are the rim, the grey patch, offset-box misses, ellipse spill,
  and fill-over-neighbor-text — all addressed below with screenshots' symptoms
  named so the manual pass can re-check the same pages.

Read first: `docs/ARCHITECTURE.md` §7.5/§7.7/§9; the Phase 9 summary in
`PROGRESS.md` (especially the §2 sliver-retry deviation and the §5/§7 flagged
calls); `src/background/bubbleSnap.ts` (`floodFill`, `traceBlobShape`,
`simplifyClosed`, `snapRegionToBubble`, `blobMeanHex`);
`src/content/overlay/shapePath.ts` + `BubbleBox.ts`;
`src/content/viewportQueue.ts` (`planEnqueues`, `deriveCursor`,
`classifyConfirm`, `onTier0Event`, `runConfirm`, `slideWindow`);
`src/background/cache.ts` (`CacheRecord`, `estimatePageBytes`) +
`translateHandlers.ts` (the cache-hit path and the `snapPageRegions` call).

**Verified-green baseline (2026-07-18, do NOT rebuild/re-verify): 694 unit
tests via `npm run check`, `npm run test:e2e` 4/4 on this machine, `vite build`
clean, `web-ext lint` 0/0/0.**

**Already shipped — do NOT rebuild:**
- The whole Phase 9 pipeline: contour capture (dilate → marching squares →
  Douglas-Peucker), `shapePath.ts` (path mapping, inscribed rect, fallback,
  text flip), the §1 window gate + §2 confirmation with the sliver-retry
  backoff, e2e Scenario D. Every section below *adjusts* this machinery.
- `bubbleSnap` seeds/guards/7.6 group split; `trimOverlaps`; the overlay
  repaint machinery (no new listeners, ever).
- The cache store, LRU, key format. §3 adds FIELDS to `CacheRecord`; the key
  and `CACHE_VERSION` are untouched.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3
   event pages.
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Pure-core / thin-shell split everywhere: every *decision* (polygon offset,
   median color, re-snap eligibility, rescue-seed acceptance, centroid rect,
   ellipse gate, window allowance, confirm classification) is a pure,
   browser-free, unit-tested function; timers/IO/canvas/DOM stay in shells.
4. **Sanctioned contract changes for this phase — exactly these, flag them in
   the PROGRESS summary:** (a) `CacheRecord` (in `background/cache.ts`, NOT
   `shared/types.ts`) gains `rawPage?: PageTranslation` and
   `snapVersion?: number` (§3, both optional/additive); (b) `PlanInput` /
   the viewportQueue module-local planner types change shape for §8 (internal
   API, not a shared contract). **NO `shared/types.ts` change at all this
   phase. NO new `shared/messages.ts` entries, no manifest change.** Anything
   beyond: stop and flag before building.
5. All coordinates stay normalized 0–1 against the ORIGINAL full image;
   §1's outward offset happens in snap-px space BEFORE normalization.
6. Fail soft, in the cost direction: a failed re-snap serves the cached page
   as-is; a failed rescue keeps today's loose box; any window/confirm bug must
   err toward *suppressing* sends, never buying. Nothing may break the host
   page.
7. `// WHY:` on every non-obvious decision.
8. **`PROMPT_VERSION` stays 2, `CACHE_VERSION` stays 2, and the new
   `SNAP_VERSION` must NEVER be folded into `buildCacheKey`** — it exists so a
   snap-logic change does NOT invalidate cache entries (a key change would
   re-pay the provider for every page, the exact cost §3 eliminates).
9. No test hooks in shipped code; e2e seeds via prefs/driver only.
10. When done: `npm run check` + `npm run build` + `npm run lint:ext` clean,
    `npm run test:e2e` green (four scenarios, A–D unmodified) **on this
    machine**, and a **Phase 9.1 summary** appended to `PROGRESS.md` in the
    house style (flag the rule-4 contract changes, the deliberate calls, and
    honest manual-verification status).

## New files

No new `src/` modules — every change lands in an existing module next to the
machinery it adjusts. Tests extend the existing suites
(`bubbleSnap.test.ts`, `shapePath.test.ts`, `viewportQueue.test.ts`,
`viewportWindow.test.ts`, `cache.test.ts` or equivalent).

---

## 1. [Fill fidelity] Close the rim: outward offset + keep edge fidelity

**Symptom:** a 1–3 display-px rim of original ink (bubble-outline
anti-aliasing, edge-adjacent glyph strokes) survives around many shaped fills.

**Root cause arithmetic (put it in the WHY comments):** the snap bitmap's long
edge is capped at `SNAP_MAX_EDGE` 512, so on a typical ~800×1200 page
**1 snap-px ≈ 2–2.5 display px**. The flood fill stops at the anti-aliased
halo *inside* the bubble's ink outline (~1–1.5 snap-px short of the ink), the
ε-doubling in `traceBlobShape` (up to 2 snap-px) shaves convex edge, and the
Catmull-Rom smoothing undershoots convex arcs. Stacked: the fill edge lands
~4–6 display px inside the true bubble boundary.

**Build (`bubbleSnap.ts`):**

- New pure `offsetPolygonOutward(points, offsetPx)` applied AFTER
  simplification, in snap-px space: move each vertex outward along its vertex
  normal (average of adjacent edge normals; orient "outward" from the ring's
  signed area, not from a centroid — concave contours have vertices on the far
  side of any centroid). Exported constant `SHAPE_OUTWARD_OFFSET_PX = 1`
  (snap-px). WHY 1 and not more: dilation (1 px, unchanged) + this offset ≈
  2 snap-px ≈ 4–5 display px outward of the blob edge, which covers the AA
  halo and *kisses* the ink line without painting over it — the failure mode
  in the overshoot direction is erasing the drawn bubble outline. Note in the
  WHY that this is the tuning knob (raise to 1.5 if the live pass still shows
  rims).
- Drop the ε-doubling escape in `traceBlobShape`: simplify once at
  `SHAPE_SIMPLIFY_EPSILON_PX` (1), and if the ring still exceeds
  `SHAPE_MAX_POINTS`, go straight to uniform subsampling. WHY: doubling ε
  shaves convex detail exactly where the rim shows; subsampling keeps vertices
  ON the traced boundary.
- Self-intersection risk at 1 px offset is negligible for blob-scale contours;
  accept it (WHY-note) — a degenerate result still renders inside the box and
  `overflow: hidden` bounds it.

🧪 *Tests (`bubbleSnap.test.ts`):* offset of a known square/diamond moves each
vertex outward by the offset (exact expected coordinates); a concave L-shape's
concave vertex moves the correct way (the signed-area orientation case);
ellipse fixture's traced shape grows measurably vs the un-offset trace and
stays within bbox+pad after the (unchanged) clamp; point cap respected without
ε doubling; determinism; existing suites pass with only expected-coordinate
updates.

## 2. [Fill fidelity] Median fill color + paper-white snap

**Symptom:** the sampled mean is dragged grey by AA pixels (the existing test
fixture literally expects `#e6e6e6` for white paper) — a visible grey patch on
a white bubble, which reads as "poorly filled" even where coverage is right.

**Build (`bubbleSnap.ts`):**

- Replace the mean accumulation with **per-channel medians**: three 256-bin
  histograms accumulated during the fill (memory trivial, still one pass),
  median per channel at accept time. Replaces `sumR/sumG/sumB` +
  `blobMeanHex`.
- **Paper snap:** if the median luma ≥ 245 → `#ffffff`; ≤ 12 → `#000000`.
  WHY: manga paper is white and flash fills are black; the median of a clean
  blob is already close, and snapping removes the last seam against
  neighboring untranslated bubbles' true paper.

🧪 *Tests:* white fixture with AA-grey edge pixels → `#ffffff` (the mean would
have said grey — assert the distinction); dark fixture → `#000000`; a genuine
mid-grey screentone fill stays median-grey (no snap); histogram determinism.

## 3. [Cost — the user's testing workflow] Raw regions in cache + `SNAP_VERSION` local re-snap

**Goal:** snap/shape/fill-color logic changes apply to already-paid pages with
**zero provider spend**. Today the snapped result is what's cached, so seeing
a snap change requires clearing the cache and re-buying the chapter.

**Build:**

- `export const SNAP_VERSION = 1` in `bubbleSnap.ts`. Bump it in any future
  phase that changes snap output (say so in its JSDoc). **Never** in the cache
  key (ground rule 8).
- `CacheRecord` gains `rawPage?: PageTranslation` (the merged provider
  regions BEFORE `snapPageRegions`) and `snapVersion?: number` (rule 4).
  Write both on every new positive entry. `estimatePageBytes` must include
  `rawPage` in the sizing (the entry roughly doubles; the LRU cap handles it).
- **Cache-hit path (`translateHandlers.ts`):** on a positive hit where
  `record.snapVersion !== SNAP_VERSION` and `rawPage` is present and the
  request carries image bytes (the normal translate path and hydrate probes
  both do): re-run `snapPageRegions(blob, record.rawPage)`, serve the
  re-snapped page, and write the record back with the new `snapVersion` +
  re-snapped `page` (so the re-snap runs once per page per version, not per
  view). Any failure → serve the cached page as-is (rule 6). Entries without
  `rawPage` (pre-9.1) → serve as-is forever, exactly today's behavior.
- Drag-select tile entries: include them IF the crop is recoverable from the
  incoming request at hit time (it is passed with the request); otherwise
  full-page entries only — implementer's call, WHY-note which.
- A pure `classifyResnap(record, snapVersion, hasBytes)` decision function so
  the eligibility logic (hit + version mismatch + rawPage + bytes) is
  unit-tested browser-free.

🧪 *Tests:* `classifyResnap` decision table (miss/negative/no-raw/no-bytes/
version-match/version-mismatch); `estimatePageBytes` grows when `rawPage`
present; write-back carries the new version (pure record-shaping helper if the
IDB shell stays untested); pre-9.1-shaped record (no new fields) classifies
as serve-as-is.

## 4. [Placement] Seed rescue for offset provider boxes

**Symptom (screenshot-verified):** provider bbox offset from the drawn bubble
→ all nine seeds land on art → no snap → a loose, mispositioned box renders a
big white fill beside the still-visible original text (worst case as a §5
ellipse over a neighboring bubble).

**Build (`bubbleSnap.ts`, inside `snapRegionToBubble` after the existing
light+dark seed loops both fail):**

- Rescue pass: sample a fixed 5×5 grid over the provider bbox **expanded 25 %
  per side** (clamped to the image). Run the existing light-path fill from
  each qualifying seed (existing luminance gate, existing min-area/leak
  guards, deterministic grid order, first accepted blob wins). WHY light-only:
  the dark path exists for flash bubbles, which are rare and rarely offset —
  keep the new surface minimal.
- **Rescue acceptance guard:** the accepted blob's bbox must overlap the
  ORIGINAL provider bbox by ≥ 40 % of the provider bbox's area. WHY: the
  provider's box is evidence of where the text is; a rescue that wanders to a
  neighboring bubble fails this and returns null (today's behavior — rule 6).
- Rescued results flow through the existing accept path unchanged (shape,
  fillColor, swallow guard, group logic — no special-casing downstream).

🧪 *Tests:* ellipse fixture with the region bbox shifted so all standard seeds
miss → rescued, snapped bbox ≈ the ellipse, shape present; shift so the
expanded grid still misses → null; a rescue blob overlapping < 40 % (adjacent
bubble fixture) → null; guards (leak/min-area) still fire inside rescue;
determinism; unshifted fixtures never enter the rescue path (assert via
call-count or unchanged outputs).

## 5. [Placement] Centroid-centered inscribed text rect

**Symptom:** text sits off the visual bubble center (worst with asymmetric
shapes): `inscribedInnerRect` shrinks a rect centered on the BOX, so when the
polygon is off-center in its bbox the search shrinks to the 0.6× floor and the
text lands partly outside the shape.

**Build (`shapePath.ts` + `BubbleBox.ts`):**

- `inscribedInnerRect` centers the binary search on the polygon's **area
  centroid** (pure ring-centroid formula) instead of the box center, and
  returns a rect positioned at that centroid (clamped so the rect stays inside
  the box). The 0.6× floor stays (floor rect also centroid-centered, clamped).
- `BubbleBox` can no longer rely on flex centering for the label: position the
  label explicitly at the returned rect (absolute left/width; vertical
  centering within the rect via a wrapper or measured offset — thin-shell
  choice, keep it minimal). The no-shape paths (padded rect, ellipse) keep
  flex centering unchanged.

🧪 *Tests:* symmetric circle → identical result to today (regression); a
circle occupying the left half of its bbox → rect centered on the circle, not
the box; centroid of known polygons (square, triangle) exact; floor case stays
inside the box after clamping.

## 6. [Placement] Fills paint under ALL labels

**Symptom (the clipped-"Ev" bubble):** overlay boxes are siblings in DOM
order, so a later bubble's now-opaque sampled-color fill paints over an
earlier bubble's text.

**Build (`BubbleBox.ts`):** `z-index: 1` on every fill layer, `z-index: 2` on
every label. WHY this works across boxes: the box divs are
`position: absolute` with `z-index: auto`, so they do NOT create stacking
contexts — their children interleave in one root context, putting every label
above every fill. Guard the assumption with a WHY comment on the box style
("adding z-index/transform/filter to the box breaks §6 layering"). Verify the
peek dashed-outline cue is still visible in peek mode (the outline paints at
the box's level, under sibling fills — if a live check shows it swallowed,
raise the peeked box's label/outline pairing, implementer's call, WHY-note).
Text-over-text collisions remain possible and accepted (rare; text is
transparent-backed and `trimOverlaps` already minimizes box overlap).

🧪 *Tests (minimal DOM assertions per house style):* fill has z-index 1, label
z-index 2, box has none.

## 7. [Placement] Gate the §5 ellipse to snapped regions

**Symptom:** the §5 ellipse fallback fires on RAW (unsnapped, loose) provider
boxes — a big white oval spilling over neighboring art/bubbles. The Phase 9
flagged risk, realized in the opposite direction than expected.

**Build (`BubbleBox.ts`):** take the ellipse branch only when
`region.fillColor !== undefined` — the snap sets `fillColor` exactly when a
blob was accepted, so it is a reliable "this bbox is tight" proxy with no new
contract field (rule 4 stays clean). Unsnapped bubble/thought boxes keep the
pre-Phase-9 8 px rounded rect (small spill, soft corners — strictly less harm
than an ellipse on a loose box). `fallbackRadius` itself is unchanged (pure
decision table stays; the gate is its call-site condition — WHY-note that the
proxy lives at the call site so the pure table stays kind×aspect only).

🧪 *Tests:* snapped-but-shapeless (fillColor, no shape, roundish bubble) →
ellipse; unsnapped (no fillColor) → rounded rect regardless of kind/aspect;
shape present → shaped path (never fallback), regression.

## 8. [Window hardening — cost] Anchored reading window (backward sends confirm too)

**Symptom class:** any page BEHIND the cursor is inside the §1 window by
definition, so backward scrolling buys every page instantly (tier-0 AND tier-1
near events), even on a fast skim back to the top. With an empty cache the
2026-07-18 session bought ~8 pages this way in seconds. The user wants spend
to track *actual reading* as tightly as possible.

**Build (`viewportQueue.ts`) — generalize the single cursor to anchors:**

- **Pure allowance.** Replace the planner's `cursor` input with the
  `confirmed: readonly boolean[]` flags (already derived per plan). A fresh
  send at index `i` is allowed iff **some confirmed index `j` satisfies
  `i − prefetchAhead ≤ j ≤ i`** — i.e. the window is the UNION of
  `[j, j + prefetchAhead]` over confirmed pages, not `[0, cursor +
  prefetchAhead]`. O(n) via a running last-confirmed-at-or-before scan.
  WHY this shape: it keeps every Phase 9 forward property byte-identical for
  contiguous forward reading (confirmed 0..c ⇒ allowed 0..c+prefetchAhead),
  while backward/jumped-to pages are only allowed near a page the user
  actually confirmed — a fast reverse skim buys nothing, a backward jump
  confirms once (~300 ms) and then reads forward with the normal prefetch
  tail. Upgrades stay never-gated; `requestAll`/drag/hydrate bypass as today.
- **Shell.** `onTier0Event`: schedule a confirmation for EVERY unconfirmed
  tier-0 (not just cursor-advancing ones — a backward page must be able to
  become an anchor); the immediate within-allowance plan stays. `runConfirm`
  success → set the flag, re-plan tier 0, and slide: re-observe suppressed
  candidates inside the NEW anchor's `[j, j + prefetchAhead]` range
  (generalizes `slideWindow`; `deriveCursor` may become internal-only or be
  deleted — follow the code). `setPrefetchAhead` raise → recompute allowance
  and re-observe newly-allowed suppressed candidates (the Phase 9 call,
  generalized). Timer cost is bounded by elements physically in the viewport.
- The §2 confirm classification, sliver-retry backoff, and checkVisibility
  gate are UNTOUCHED — this changes only *which* events need confirmation and
  *what* the planner allows.
- WHY-note the cost contract at the module head: "auto-translate spends only
  within `prefetchAhead` of a page the user has confirmably looked at".

🧪 *Tests:* pure allowance table (nothing confirmed → nothing allowed;
contiguous forward identical to Phase 9 plans — reuse existing expectations;
lone mid-chapter anchor `{20}` → 5 not allowed; anchor at 5 after confirm →
5–8 allowed; multi-anchor union; NaN/negative safety unchanged). Shell (fake
timers/observers, extending `viewportWindow.test.ts`): backward tier-0 →
suppressed + confirm scheduled → confirmed → sent with forward tail; fast
reverse skim (element leaves before the confirm) → nothing bought; backward
tier-1 near event alone → suppressed, never buys; forward-reading scenarios
from Phase 9 pass unchanged (the regression bar for "zero added latency");
e2e Scenario D passes UNMODIFIED (cold open confirms page 0 → 4 sends; the
scroll-down walk anchors page-by-page — verify, don't adapt D).

## 9. [Window hardening] Loaded-image confirm guard

**Symptom class (MangaDex lazy-load):** a not-yet-loaded page renders as a
mid-height placeholder; parked in the viewport it PASSES `classifyConfirm`
(overlap ≥ min(48 px, height/2)) and `checkVisibility`, so placeholders can
confirm as "being read" and drag anchors deep while images are still loading.
(Not observed as the burst cause this pass — the skim explained it — but it is
a real, cheap-to-close hole in the §2 trust chain.)

**Build (`viewportQueue.ts`):** `classifyConfirm` gains a `loaded: boolean`
parameter (default true): `!loaded` with any overlap → `"retry"` (never
`"confirm"`; the no-overlap `"drop"` case is unchanged). The shell passes
`!(el instanceof HTMLImageElement) || (el.complete && el.naturalWidth > 0)` —
non-image candidates fail open (WHY: the scanner only registers images today,
but the guard must not brick a future candidate kind). The retry rides the
existing capped backoff, so a slow-loading page confirms within ~2.4 s of its
image arriving.

🧪 *Tests:* pure table (`loaded: false` + meaningful overlap → retry;
`loaded: false` + no overlap → drop; default true preserves every existing
expectation unchanged); shell: an unloaded-image candidate parked in the
viewport never confirms → flips loaded → confirms on the next retry tick.

## Explicitly out of scope

- Prefetch-tail pacing / per-priority concurrency slots (considered; deferred
  — at `prefetchAhead: 3` the tail is small and §8 already ties spend to
  confirmed reading).
- Prompt or schema changes of any kind; `PROMPT_VERSION` stays 2. Provider
  bubble-detection misses (true misses, not offset boxes — §4 covers those)
  stay a known limitation; collect examples for a future prompt phase.
- Changing the user's `pagesPerRequest`/batching defaults (cost lever noted
  to the user separately; settings stay as they are).
- New settings/UI surface; `shared/types.ts` changes; F16/F18, Chrome port,
  signing.
- Inpainting-style cleanup, shaped text layout, local OCR.

## Manual verification (needs a live key + MangaDex; record honestly if not run)

With the built `dist/`, `claude-sonnet-5`, the user's main-profile temp
install, and — NEW — **without clearing the cache** except where a step says
to (that is §3's point):

1. Re-visit the 2026-07-18 screenshot pages: the ink rim around shaped fills
   is gone (or ≤ ~1 px); no grey patch on white bubbles (fill matches paper).
2. The offset-box page (translation beside still-visible original): now
   snapped — fill covers the original text, no white oval over the neighbor.
3. The clipped-text page ("Ev"): the earlier bubble's text renders above the
   neighbor's fill.
4. Peek (F14) still shows the dashed cue above neighboring fills.
5. §3 workflow check: translate a fresh page (paid), then — in a LATER build
   with a bumped `SNAP_VERSION` (simulate by bumping locally once) — reload:
   the page re-renders with new snap output and the network panel shows ZERO
   provider calls.
6. Budget/§8: clear the cache (deliberate, one last time), open a chapter at
   the top, auto on, do not scroll for 60 s → ≤ ~6 requests. Read forward
   normally → requests track ~3 ahead, no added latency. Jump to mid-chapter
   → one ~300 ms pause, then normal. **Skim back to the top fast → at most
   1–2 purchases, not one per page.** Linger on an untranslated earlier page
   → it translates after ~300 ms.
7. §9: on a chapter with slow-loading pages (throttle if needed), pages do
   not confirm/purchase while still placeholders; they do shortly after the
   image appears.
8. Translate-all still fills the whole chapter (bypass intact).

## Definition of done

- `npm run check` green (694 + the new unit tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0.
- **`npm run test:e2e` green ON THIS MACHINE — Scenarios A–D pass
  UNMODIFIED** (D's budget arithmetic must hold under §8 without edits; if it
  doesn't, that is a §8 design bug, not a test to adapt).
- The ONLY contract changes are the rule-4 items (`CacheRecord.rawPage` /
  `snapVersion`, module-local planner types), flagged; NO `shared/types.ts`
  change, no new messages, no manifest change, `PROMPT_VERSION` = 2,
  `CACHE_VERSION` = 2, `SNAP_VERSION` introduced at 1 and NOT in the cache
  key.
- `PROGRESS.md` Phase 9.1 summary in the house style: the seventh-live-pass
  evidence (budget held at open; skim explained the 21; the screenshot
  defects), each section's deliberate calls (offset arithmetic, median+snap,
  re-snap write-back, rescue guard, fillColor-as-snapped proxy, anchored
  window semantics, loaded fail-open), and honest manual-verification status.
