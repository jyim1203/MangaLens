# Phase 7.5 — Bubble snap: pixel-refined bboxes + pause-log cleanup (handoff)

You are implementing **Phase 7.5** of the MangaLens Firefox extension — a
point-phase (precedent: 4.1 / 5.1 / 7.1–7.4) driven by the FOURTH live-browser
verification (2026-07-11, Firefox release build, **Anthropic provider,
`claude-sonnet-5`** — the user moved off `claude-haiku-4-5` mid-session). It
lands before Phase 8. **No prompt-layer changes** — `PROMPT_VERSION` stays 2;
this phase refines geometry with local pixels, not prompt surgery.

## Live evidence (two HAR captures, 2026-07-11)

**Capture 1 (Haiku 4.5, post-7.4 corner schema, 9 calls):** the 7.4 format fix
WORKED — every returned bbox is a valid corner box — but Haiku does not
localize; it emits a formulaic column-grid guess. Call 1: nearly every box is
`x 0.05–0.45` or `0.55–0.95`, width exactly 0.40; call 3: all twelve boxes
width 0.36; call 8: all width 0.30 in uniform 0.14-tall rows. A ~0.15-wide
bubble gets a 0.40-wide slot → the spilling/misshapen/size-varying boxes in the
user's screenshots. Its vertical-CJK transcription is also scrambled (call 0
reads 我成為妳的騎士 as "妳我的成騎為士"). **Conclusion: Haiku 4.5 is unusable
for detection AND transcription on manga; this is model capability, not
geometry or prompt.**

**Capture 2 (Sonnet 5, 2 calls):** call 0 is a 400 — `"temperature is
deprecated for this model"` — which the Phase 3.1 learn-on-400 sampling-param
downgrade absorbed (call 1 retried without `temperature` and succeeded; one
wasted 400 per model per event-page lifetime, as designed — NO code change).
Call 1: 13 regions, boxes land on the right bubbles (user-confirmed in
screenshots), `in=3336 out=1068` tokens ≈ **$0.017/page at Sonnet 5 intro
pricing** ($2/$10 per MTok through 2026-08-31; $0.026 at the standard $3/$15).
Residual: coordinates still sit on a coarse grid — the model estimates, it
does not measure — so boxes are correct-but-loose. That residual is what this
phase fixes, deterministically and for free.

**Decision (user-approved):** keep the VLM for detection + OCR + translation
(one call, the part it's good at); add a **local pixel-refinement pass** —
"bubble snap" — that treats the provider's box as a *seed* and snaps it to the
actual speech-bubble blob via flood fill on the decoded bitmap. Classic manga
bubbles (near-white interior, dark outline) are the best case for this; every
failure path falls back to the provider's box, so the worst case is exactly
today's behavior (rule 4). Full local ML detection (onnxruntime-web etc.) was
considered and REJECTED for now — tens of MB of weights, WASM seconds/page,
AMO review weight — revisit only if VLM boxes stay bad across providers.

Read first: `src/background/translateHandlers.ts` (`translatePrepared`, the
snap's page-path wire point), `src/background/regionHandlers.ts`
(`translateRegionImage`, the drag-select wire point),
`src/background/imagePrep.ts` (the existing pure-math/canvas-shell split to
imitate), `src/content/overlay/overlapTrim.ts` (stays render-time and
untouched), `src/shared/guards.ts` (`isAbortError`, item 2). Baseline is
green: 504 unit tests, typecheck, ESLint, `vite build`, `web-ext lint`
(0 errors / 0 warnings / the known `data_collection_permissions` notice —
Phase 8).

**Already shipped — do NOT rebuild:** the 7.4 corner-format schema +
corners-first `parseBbox` + joint edge clamp; the render-time `trimOverlaps`;
the 7.3 object-fit geometry; the pause feature. Snap composes AFTER all of
them: parseBbox normalizes → snap refines → (cache) → filter/trim at paint.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages.
2. Pure-core / thin-shell split: every *decision* (thresholds, seed choice,
   flood fill, accept/reject) is a pure, browser-free, Vitest-covered
   function; the only untested surface is the OffscreenCanvas decode shell
   (same env reason as `prepareImage`).
3. Contract scope: **NO `shared/types.ts` / `shared/messages.ts` /
   `shared/settings.ts` changes** (`BBox` in/out), **no `PROMPT_VERSION` or
   cache-key COMPOSITION change**, no new settings (snap constants are
   module-level, tuned by tests).
4. Fail soft: any snap failure (decode throw, no accepting seed, degenerate
   input) returns the region/page UNCHANGED — never a thrown handler.
5. `// WHY:` comments on non-obvious decisions; PROGRESS.md summary in house
   style when done.

## New files

```
src/background/bubbleSnap.ts     # pure core + thin decode shell
tests/unit/bubbleSnap.test.ts    # synthetic-ImageData coverage (below)
```

Touched: `src/background/translateHandlers.ts` (wire + item 2),
`src/background/regionHandlers.ts` (wire), `src/popup/main.ts` (item 2),
`PROGRESS.md`.

---

## 1. `bubbleSnap.ts` — the snap pass

**WHY background, not content:** the content script cannot read pixels of a
cross-origin `<img>` (canvas taint); the background already holds the clean
bytes in both paths. **WHY snapped boxes are CACHED** (unlike the render-time
`trimOverlaps`): snap is a deterministic function of (image bytes, provider
box) — the same inputs always produce the same output, so caching it is
memoization, not a lie about what the provider said. No `CACHE_VERSION` bump:
pre-7.5 entries simply render with unsnapped (status-quo) geometry until they
age out.

### Pure core (all exported, all tested)

Operate on a minimal `SnapBitmap = { data: Uint8ClampedArray; width: number;
height: number }` (RGBA, as from `getImageData`) so tests build fixtures with
typed arrays — no DOM.

- `snapRegionToBubble(img, bbox, opts?) → BBox | null` — bbox in/out is the
  normalized 0–1 `BBox`; internally work in snap-bitmap pixels. Algorithm:
  1. **Seeds:** center of the box plus 8 offsets at ±25% of the box
    width/height (9 candidates), clamped inside the bitmap. Try in order:
    center first.
  2. A seed pixel must be **light**: luminance (`0.299R+0.587G+0.114B`) ≥
    `LIGHT_FLOOR` (default 160). Dark seed (landed on a stroke or art) → next
    seed.
  3. **Flood fill** (iterative, 4-connected, visited bitmap — no recursion)
    over pixels with luminance ≥ `max(LIGHT_FLOOR, seedLum − SEED_TOLERANCE)`
    (tolerance default 24; relative component tolerates off-white paper and
    mild screentone).
  4. **Reject small** (the glyph-counter trap — user's concern #2): blob area
    < `MIN_BLOB_FRACTION` (default 0.25) × seed-box pixel area ⇒ the fill
    found the white inside a character (a 口/O counter) or a speck — discard,
    try the next seed. // WHY this works: at snap resolution a glyph counter
    is a few px²; a real bubble interior is comparable to the seed box.
  5. **Reject leak** (the unenclosed-bubble trap — user's concern #1): blob
    area > `MAX_BLOB_BOX_RATIO` (default 4) × seed-box area OR >
    `MAX_BLOB_IMAGE_FRACTION` (default 0.35) of the whole bitmap ⇒ the fill
    escaped through an outline gap / open tail / panel-edge white into the
    page background — abandon ALL seeds (a leak from one seed will leak from
    every seed in the same blob) and return null.
  6. **Accept:** the blob's bounding box, padded by 1 snap-px, converted back
    to fractional `BBox`, and finally **intersection-sanity-checked**: the
    snapped box must contain the winning seed and overlap the original box
    (IoU > 0, trivially true by construction — pin it anyway).
  Return null when no seed accepts; the caller keeps the provider box.
- `shouldSnapKind(kind) → boolean` — snap **only `bubble` and `thought`**
  (white-interior shapes). `caption`/`sfx`/`sign`/`other`/undefined sit on
  art where a fill leaks or lands dark; leave them at the provider box. // WHY
  conservative: a wrong snap is worse than a loose box.
- Constants exported for tests; defaults above are starting points — pin
  whatever the fixture tests converge on.

### Thin shell (untested, minimal)

`snapPageRegions(blob: Blob, page: PageTranslation) → Promise<PageTranslation>`:
`createImageBitmap(blob)` → draw onto an OffscreenCanvas downscaled to
`SNAP_MAX_EDGE = 512` on the long edge → `getImageData` → run the pure core
per region (skip non-snap kinds) → return a NEW page object (never mutate the
input; regions array rebuilt with snapped bboxes). Close the bitmap in a
`finally`. Whole body try/catch → return `page` unchanged on any throw.
// WHY 512: downsampling is load-bearing, not just cheap — at ≤512px a 1–2 px
outline gap closes by itself and glyph strokes blur toward gray (fewer
false-light seeds), while bubbles stay hundreds of px². Long strips: 512 on
the long edge of a 20000-px strip would crush it — clamp the SHORT edge to
≥ 256 by raising the cap for extreme aspect ratios, or snap per-tile if
simpler (implementer's call; flag which).

### Wiring (both provider paths)

- **Page path** — `translateHandlers.translatePrepared`: after
  `mergeTilePages` (≈ line 331), `merged = await snapPageRegions(blob,
  merged)` — `blob` (original full-image bytes) is already a parameter. This
  runs INSIDE the queue slot (fine: decode+fill at 512px is ms-scale next to
  a provider round trip) and BEFORE `cacheStorePage`, so hits replay snapped
  geometry for free.
- **Region path** — `regionHandlers.translateRegionImage`: the provider
  returns full-image-space boxes (crop-as-tile remap), and the full-image
  `blob` is in scope at the call site — snap against the FULL image, then
  additionally clamp each snapped box to the user's selection rect
  (a drag-select must never paint outside what the user selected).
- Paint order in content is unchanged: filterRegions → trimOverlaps →
  regionToPx. Snapped boxes rarely overlap; trim still guards true duplicate
  detections.

🧪 *Tests* (synthetic `SnapBitmap` fixtures — small helper that fills rects/
ellipses into a typed array): loose seed box over a white ellipse with a dark
2-px outline on gray → snaps to the ellipse bounds (±1 px + pad); oversized
seed box (2× bubble) → shrinks to the bubble; seed box smaller than the
bubble → GROWS to the bubble (snap is bidirectional); outline with a gap onto
a white page → leak cap → null (provider box kept); seed landing in a small
white counter inside dark strokes → min-area reject, offset seed recovers the
real bubble; all-dark seed region → null; `shouldSnapKind` matrix; input page/
regions not mutated; deterministic; degenerate bbox (w/h ≤ 0) → null;
off-white paper (lum ~230 interior) still fills under the relative tolerance.

## 2. Cleanup — pause/console noise (user's 2026-07-11 console export)

- `translateHandlers.ts` (≈ line 606): the catch logs `log.warn("translatePage
  failed …")` for EVERY aborted job — a 15-page pause floods the console with
  "All waiters aborted" warnings that read as failures. Gate on
  `isAbortError(err)` (shared/guards.ts): aborts → `log.debug`, real failures
  keep `log.warn`. The returned `errorToTranslateResult` mapping is already
  correct — this is log-level only.
- Popup: `[MangaLens:popup] getTranslationsPaused failed: Could not establish
  connection` — the popup queries the active tab's pause state on open, and a
  tab with no content script (about:, addons.mozilla.org, never-injected)
  rejects. Catch it where the popup sends `getTranslationsPaused` /
  `setTranslationsPaused` (popup/main.ts), default to `{ paused: false }`,
  and log at debug, mirroring how `translateAll`'s dry-run treats inert tabs.

🧪 *Tests:* translateHandlers: an aborted job produces no warn-level log (spy
on the logger; abort path already covered functionally). popupLogic stays
pure — if the catch lives in main.ts (thin shell), a WHY comment is the
house-style bar; add a pure helper only if one falls out naturally.

## Manual verification (REQUIRED — append results to PROGRESS.md)

1. Build, temporary add-on, Anthropic key, **`claude-sonnet-5`**, site opted
   in.
2. The Eminence-in-Shadow chapter from the 2026-07-11 screenshots: auto
   translate → boxes hug the bubble outlines (visibly tighter than the
   capture-2 run), text size varies less across bubbles, nothing paints over
   adjacent art.
3. Drag-select the two right-side bubbles → boxes land ON the bubbles and
   inside the selection.
4. A page with captions/SFX → those render at the provider box (unsnapped,
   unregressed).
5. MangaDex blob page spot-check (snap runs on content-shipped bytes too).
6. Cache: reload the chapter → instant render with the SAME tight boxes (snap
   was cached, no re-decode).
7. Pause mid-chapter → console shows NO warn-level "translatePage failed …
   All waiters aborted" spam; popup on a fresh about:blank tab shows no
   getTranslationsPaused error.
8. If a specific bubble snaps WRONG (box jumps to the wrong blob): screenshot
   it + note the page — tune constants before adding mechanism.

## Explicitly out of scope (do NOT build)

- **Local ML text detection / OCR** (onnxruntime-web, tesseract.js, manga-ocr)
  — rejected above; revisit only with cross-provider evidence that VLM boxes
  are unusable.
- **Non-rectangular overlays** (using the blob MASK to shape the bubble box) —
  the snap core's blob is the natural input for this later; note it, don't
  build it.
- **Prompt/schema changes** of any kind; `PROMPT_VERSION` stays 2.
- **Gemini box_2d dialect**; **prompt caching for the static prefix** (real
  input-cost saver — needs its own phase with cache-hit verification);
  **snapping caption/sfx/sign kinds**.
- Everything in PHASE-8-HANDOFF.md.

## Definition of done

- `npm run check` green (504 existing + new bubbleSnap/log coverage);
  `npm run build` clean; `web-ext lint` 0 errors / 0 warnings (the
  `data_collection_permissions` notice remains — Phase 8).
- `shared/*` untouched; cache-key composition and `PROMPT_VERSION` untouched.
- The manual pass above EXECUTED and recorded honestly in PROGRESS.md —
  and note there that steps 2–6 double as the outstanding 7.4 manual items
  (corner boxes + pause were already user-verified live on 2026-07-11; record
  that evidence: Haiku grid-guess finding, Sonnet 5 switch, the
  temperature-400 downgrade firing as designed).
- PROGRESS.md gets a Phase 7.5 summary flagging: background-not-content
  (canvas taint), snapped-boxes-are-cached-and-why (deterministic
  memoization vs. the render-time trim), the seed/reject constants and the
  two failure modes they guard (glyph-counter min-area, open-outline leak
  cap), kind gating, and the log-level cleanup.
