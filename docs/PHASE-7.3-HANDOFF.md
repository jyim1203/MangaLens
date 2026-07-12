# Phase 7.3 — Live-site fixes round 2: object-fit-aware overlay geometry (handoff)

You are implementing **Phase 7.3** of the MangaLens Firefox extension — a small
point-phase (precedent: 4.1 / 5.1 / 7.1 / 7.2) driven by the SECOND live-browser
verification (2026-07-10, Firefox release build, real Gemini key, a
keyoapp-style reader in "Fit Both" mode). It lands **before Phase 8**
(docs/PHASE-8-HANDOFF.md).

The live test produced ONE root-caused finding:

**Overlay bubbles land far off the artwork and cover whole panels on
letterboxed readers.** The user's screenshot shows translated boxes stretched
across ~3× the drawn page width, overlapping panels, and — the smoking gun —
extending PAST the right edge of the drawn bitmap into the black letterbox
area. Region bboxes are clamped to [0, 1] by `sanitizePage`, so under a correct
mapping a bubble physically cannot escape the bitmap; the mapping itself is
wrong. Cause: every geometry consumer treats the `<img>` **element box**
(`getBoundingClientRect()`) as the drawn bitmap. That equality holds only under
the default `object-fit: fill`. The reader's "Fit Both" mode is `object-fit:
contain`: the element spans the whole reader column while the bitmap is
letterboxed inside it, so every normalized bbox is stretched across the element
box. This is precisely the limitation Phase 7.1 recorded as accepted
("`object-fit: contain/cover` divergence — a shared pre-Phase-5 limitation");
a mainstream reader mode triggers it, so accepted no longer.

Four consumers share the wrong assumption:

1. `OverlayManager.positionEntry` — hosts are positioned/sized to the element
   box, so the skeleton, error badge, and every bubble sit in element space.
2. `OverlayManager.paint` — `displayedW/H` (fed to `regionToPx` and textFit)
   are element-box dimensions.
3. `OverlayManager.processPeek` — hover hit-testing computes overlay-local
   coordinates relative to the element rect.
4. `regionSelect.selectionToImageBbox` via `defaultCollectTargets` — the drag
   crop is normalized against the element rect, so on a letterboxed reader the
   background crops the WRONG part of the bitmap (silent wrong-answer bug: the
   provider translates a different area than the user selected).

Read first: `docs/ARCHITECTURE.md` §7.2 (overlay), the Phase 5/5.1/7/7.1
summaries in `PROGRESS.md`, `src/content/overlay/geometry.ts` (the ONE bbox→px
conversion — it stays the one), `src/content/overlay/OverlayManager.ts`,
`src/content/regionSelect.ts` (`defaultCollectTargets`). Baseline is green:
451 unit tests, typecheck, ESLint, `vite build`, `web-ext lint` (0 errors /
0 warnings / the known `data_collection_permissions` notice — Phase 8 clears
it, not this phase).

**Already shipped — do NOT rebuild:**
- `regionToPx` + `displayedSizeChanged` (geometry.ts) — both stay byte-
  identical; they just get fed content-box dimensions instead of element-box
  dimensions.
- `positionEntry`'s residual-error correction (Phase 5.1 item 2) — keep it;
  only its TARGET rect changes.
- The rAF-coalesced sync/peek batching, the `ResizeObserver` + img `load`
  re-sync wiring, and the disconnected-element teardown paths — the content-box
  read slots INSIDE them.
- `selectionToImageBbox` / `pickTargetImage` / `normalizeDragRect` (pure rect
  math) — untouched; only the `RegionTarget.rect` they are fed changes.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3
   event pages.
2. Every exported function/class gets JSDoc; every module gets Vitest coverage
   (pure-core / thin-shell split: DOM/layout reads stay in thin shells; every
   decision is a pure tested function).
3. **NO `shared/types.ts`, `shared/messages.ts`, or `shared/settings.ts`
   change.** Cache-key composition and `PROMPT_VERSION` untouched. This phase
   is content-script-only.
4. Fail soft: any failure in the new geometry path degrades to the CURRENT
   behavior (element box), never to a broken overlay or a thrown listener.
5. `// WHY:` comments on non-obvious decisions; PROGRESS.md summary paragraph
   in house style when done.

## New files

```
src/content/overlay/contentBox.ts   # object-fit-aware drawn-bitmap rect: pure math + thin readContentBox shell
tests/unit/contentBox.test.ts
```

Touched: `content/overlay/OverlayManager.ts` (items 1–3 integration),
`content/regionSelect.ts` (item 4), `tests/fixtures/testpage.html` (item 5),
`PROGRESS.md`.

---

## 1. Pure core: `computeContentBox` (`src/content/overlay/contentBox.ts`)

The math of where a replaced element draws its bitmap inside its content box.
Everything here is browser-free and exhaustively tested.

```ts
export type ObjectFit = "fill" | "contain" | "cover" | "none" | "scale-down";

/** One resolved object-position component: a fraction of the free space or an
 *  absolute px offset. */
export type PositionComponent =
  | { kind: "fraction"; value: number }   // e.g. 50% → 0.5
  | { kind: "px"; value: number };

/** Rect of the drawn bitmap, in the element CONTENT box's local coordinates
 *  (offsets can be negative under `cover`/`none` — the bitmap overflows). */
export function computeContentBox(
  boxW: number, boxH: number,          // element content-box size (CSS px)
  naturalW: number, naturalH: number,  // intrinsic bitmap size
  fit: ObjectFit,
  posX: PositionComponent, posY: PositionComponent,
): { left: number; top: number; width: number; height: number }
```

Scale rules (per the CSS spec):
- `fill` → the content box itself: `{0, 0, boxW, boxH}` (today's behavior).
- `contain` → `s = min(boxW/naturalW, boxH/naturalH)`.
- `cover` → `s = max(boxW/naturalW, boxH/naturalH)`.
- `none` → `s = 1`.
- `scale-down` → `s = min(1, containScale)`.

Position (identical semantics to background-position): with
`free = boxSize − drawnSize` per axis, a `fraction` component contributes
`fraction × free` (note: `free` is NEGATIVE under cover/none-overflow — the
formula handles it, don't special-case), a `px` component contributes its
value verbatim.

Degenerate inputs (`naturalW/H ≤ 0`, `boxW/H ≤ 0`, non-finite anything) →
return the full content box (`fill` result). // WHY: equals today's behavior,
so a broken/undecoded image can never make things WORSE than the status quo.

Also pure: `parseObjectPosition(computed: string): [PositionComponent,
PositionComponent]` — parses a COMPUTED `object-position` value. Firefox
resolves keywords at computed-value time, so the input is like `"50% 50%"` or
`"0px 12px"` or a `%`/`px` mix; handle exactly those two unit forms, treat a
missing second component as `50%`, and fall back to `{fraction: 0.5}` for
anything unparseable (calc(), exotic units). // WHY parse the computed value
rather than author keywords: getComputedStyle already did the keyword →
percentage resolution; re-implementing `left top` handling would be dead code.

And pure: `insetContentBox(rect, borders, paddings)` or equivalent — given the
border-box rect (from `getBoundingClientRect`) and the four computed border +
padding widths, produce the element's CONTENT box rect. object-fit lays out
within the content box, not the border box; manga readers rarely pad an img,
but a 1 px border shifting every bubble is exactly the class of off-by-a-little
this phase exists to kill.

🧪 *Tests:* fill identity; contain with a wide box + portrait bitmap (THE
reader case — assert the horizontal letterbox offsets); contain with a tall
box + landscape bitmap; cover (negative offsets both axes); none (larger and
smaller than the box); scale-down both branches; object-position 0% / 50% /
100% / px offsets / mixed / negative-free-space with cover; parse matrix
("50% 50%", "0px 12px", "25% 10px", single component, garbage → 50%);
degenerate fallbacks (natural 0, box 0, NaN); border/padding inset.

## 2. Thin shell: `readContentBox(el): PxRect | null` (same module)

The one place that reads the DOM for this. For an `HTMLImageElement` (use
`naturalWidth/naturalHeight`; 0 while undecoded → fall through to the fallback
inside `computeContentBox`) and an `HTMLCanvasElement` (use `width/height` —
object-fit applies to canvas too, and drag-select accepts canvas targets):
`getBoundingClientRect()` + ONE `getComputedStyle()` read (`objectFit`,
`objectPosition`, border/padding widths — computed values are px strings;
`parseFloat` them) → inset to the content box → `computeContentBox` → return
the drawn bitmap's rect in CLIENT coordinates. For every other element
(background-image hosts have no intrinsic size we can read without loading)
return the plain `getBoundingClientRect()` unchanged. Wrap the whole body in
try/catch → element rect on any throw (rule 4: the fallback IS the status
quo). // WHY client coords: both call sites (OverlayManager positioning, peek
hit-testing) work in client space; regionSelect adds scroll itself, same as it
does today.

Untested shell per house style (jsdom does no layout and its
`getComputedStyle` won't resolve object-position) — all decisions live in the
item-1 pure functions.

## 3. OverlayManager: host = drawn-bitmap rect (items 1–3 of the finding)

Design choice (spec'd, not open): **the host covers the CONTENT-BOX rect, not
the element rect** — alternative (b) (host on the element box, bubbles offset
inside) was rejected because (a) keeps `regionToPx` the untouched ONE
conversion (handoff rule: geometry.ts stays as-is), makes the skeleton/error
badge sit on the artwork for free, and keeps peek hit-testing a simple
host-local containment test.

- `positionEntry`: target rect = `readContentBox(entry.candidate.el)` instead
  of `getBoundingClientRect()`. The residual-error correction below it is
  UNTOUCHED (it compares the host's actual rect to the target rect — still
  idempotent). Have `positionEntry` RETURN the content rect so `paint` and
  `syncEntry` reuse it instead of re-reading. // WHY: keeps the one-read-per-
  entry-per-frame budget — the content-box read adds one getComputedStyle per
  entry per rAF flush, which replaces (not stacks on) today's second rect read.
- `paint`: `displayedW/H` = the content rect's size (feed `regionToPx` +
  textFit); `entry.lastPaintedSize` stores the CONTENT size.
- `syncEntry`: `displayedSizeChanged` compares against the content size (a
  reader switching Fit Both → Fit Width changes the drawn size even when the
  element box is stable — the repaint must key on what we painted with).
- `processPeek`: overlay-local coords + bounds check against the content rect
  (`readContentBox`), not the element rect — otherwise hovering the letterbox
  bar hit-tests as inside the image.
- The skeleton (`setPending`) and error badge inherit the fix via the host
  rect — no changes.

Accepted + WHY-note (don't engineer around): a pure CSS fit-mode flip that
keeps the element box byte-identical AND happens with zero scroll/resize/
ResizeObserver activity won't re-sync until the next sync trigger. Real reader
mode switches always reflow the element; not worth a style-attribute observer.

🧪 *Tests:* the pure item-1 suite carries the math. For the manager, extend
the existing jsdom overlay tests only where cheap: with a stubbed
`readContentBox` seam (if you inject one) or by asserting paint uses the
returned rect — if a seam would be contrived, the house-style fallback is the
pure coverage + WHY comment; flag which you chose.

## 4. regionSelect: crops normalize against the drawn bitmap (item 4)

`defaultCollectTargets`: for `<img>` and `<canvas>` targets, build
`RegionTarget.rect` from `readContentBox(el)` (+ scrollX/Y — same page-space
conversion as today) instead of the raw element rect. Background-image hosts
keep the element rect (no intrinsic size; `background-size` mapping is out of
scope, noted below). This fixes BOTH downstream consumers with zero changes to
the pure math: `pickTargetImage` now ranks by intersection with actual
artwork, and `selectionToImageBbox` normalizes the crop against the bitmap —
so the background's `planRegionCrop` cuts the pixels the user actually
selected. Keep the `MIN_RENDERED_PX` floor check on the ELEMENT rect (a
letterboxed-but-large image must stay selectable; the floor is about
click-target size, not bitmap size — WHY-note it).

Under `cover`/`none` the content rect can extend past the element box; the
selection is already clipped to the intersection by `selectionToImageBbox`,
and a crop of a clipped-off area is geometrically valid (the provider sees
pixels the user couldn't see — irrelevant edge, accept).

🧪 *Tests:* the existing pure regionSelect tests stay untouched (the math
didn't change). Add: a collect-targets-level test if you have a seam for it,
or extend `selectionToImageBbox` cases with a letterboxed-image rect to pin
the end-to-end expectation (selection over the letterbox bar only → null;
selection over the bitmap → bbox normalized to the BITMAP rect).

## 5. Test-page fixture: letterboxed variants

`tests/fixtures/testpage.html` gains two variants of the existing manga-page
SVG placeholder (keep them below the fold, don't disturb the existing
fixtures/ids the scanner tests reference):

1. A portrait image in a WIDE fixed-size container with `object-fit: contain`
   (the "Fit Both" reader case — bubbles must letterbox-align).
2. The same with `object-position: left top` (pins the position math).

This makes the fix manually verifiable without the live site, and gives the
next regression hunt a stable target.

## Manual verification (REQUIRED — append results to PROGRESS.md)

1. Build, load as temporary add-on, grant image access, real key,
   `concurrency` 2–3 on a free-tier key (see the 7.2 handoff's quota note).
2. **The letterboxed reader from the 2026-07-10 report** (keyoapp-style, "Fit
   Both" mode), site opted in: bubbles sit ON the balloons, nothing renders
   past the drawn page's edges, the pending skeleton covers the artwork (not
   the letterbox bars).
3. **Switch fit modes** (Fit Both → Fit Width → Long Strip): overlays re-align
   after each reflow (scroll a page-height if a repaint seems stale — the
   accepted sync-trigger caveat).
4. **Drag-select a single bubble while letterboxed**: the translation matches
   the selected balloon's text (this is the wrong-crop regression test — before
   this phase the crop was off by the letterbox offset).
5. **Peek**: hovering a bubble shows the original; hovering the letterbox bar
   next to it does nothing.
6. `tests/fixtures/testpage.html`: the two new fixtures overlay correctly; the
   pre-existing fixtures are unregressed (they're `object-fit: fill` — the
   identity path).
7. MangaDex spot-check (blob + default layout): unregressed.
8. **If bubbles still look sloppy relative to balloons after all of the
   above**: the residual is provider bbox quality, not overlay geometry —
   capture ONE raw Gemini response (background console) for the page and file
   it as a finding for a possible prompt-side follow-up. Do NOT start prompt
   tuning in this phase (`PROMPT_VERSION` is frozen here).

## Explicitly out of scope (do NOT build)

- **Provider bbox quality / prompt changes** — anything touching
  `providers/prompt.ts` or `PROMPT_VERSION` (step 8 above only *collects
  evidence*).
- **Overlap resolution between returned regions** (two bubbles sharing pixels)
  — cosmetic once geometry is right; revisit only with live evidence.
- **`background-size` mapping for background-image hosts** — no intrinsic
  size without fetching the image; the rendered-size proxy stays.
- **Scroll-container / transform edge cases** beyond what
  `getBoundingClientRect` already reflects.
- Everything in PHASE-8-HANDOFF.md (batching, re-prioritization, e2e, AMO
  prep, the `data_collection_permissions` notice).

## Definition of done

- `npm run check` green (all 451 existing tests stay green untouched; new
  module covered). `npm run build` clean; `npm run lint:ext` 0 errors /
  0 warnings (the `data_collection_permissions` notice remains — Phase 8
  closes it).
- **Zero contract changes**: `shared/types.ts`, `shared/messages.ts`,
  `shared/settings.ts`, cache-key composition, and `PROMPT_VERSION` all
  untouched.
- The manual pass above is EXECUTED and recorded honestly in PROGRESS.md
  (steps 2–7; step 8 only if triggered).
- PROGRESS.md gets a Phase 7.3 summary flagging: the reversal of the Phase
  7.1 "object-fit divergence accepted" note, the host-covers-content-rect
  design choice (option (a) and why), the element-rect fallback as the
  fail-soft path, and the drag-select wrong-crop fix.
