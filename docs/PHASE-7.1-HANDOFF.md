# Phase 7.1 — Drag-select / peek / toast review fixes (handoff)

You are implementing **Phase 7.1** of the MangaLens Firefox extension: fixes
from a review of the Phase 7 implementation (drag-select F10, peek-original
F14, error toasts, commands, i18n scaffolding) against
`docs/PHASE-7-HANDOFF.md`, Architecture §7.2/§7.3, and real-input behavior.

Phase 7's Definition of Done was independently verified green before this
review: **413 unit tests**, typecheck, ESLint, `vite build`, and `web-ext lint`
(0 errors / 0 warnings; the `data_collection_permissions` notice stays
Phase-8-deferred). Also spot-verified: `dist/_locales/en/messages.json` is
copied into the build and the dist manifest carries `default_locale: "en"` +
the `__MSG_*__` strings (lint resolves them all); `REGION_SUFFIX` matches
PROMPTS.md §4.3 **verbatim**; `PROMPT_VERSION` is untouched and the
byte-identical `buildUserText` stability test pins it; the region path provably
never touches the cache (spy test); contract changes are exactly the flagged
set (`TranslateJob.isRegion`, the four new messages, manifest commands +
`default_locale`). The two handoff deviations PROGRESS.md self-flags —
`commands.onCommand` living in `background/index.ts` with the fan-out helper
extracted, and `pickTargetImage` tie-breaking on rect area with
`scoreCandidate`'s JSDoc updated — were both pre-authorized by the Phase 7
handoff's own wording and stand as accepted.

Read first: `docs/PHASE-7-HANDOFF.md` (item numbering below refers to it) and
the Phase 7 summary in `PROGRESS.md`. All ground rules apply unchanged (strict
TS, JSDoc, pure-core/thin-shell, `// WHY:` comments, fail soft). **No
`shared/types.ts` or `shared/messages.ts` changes are expected this phase** —
if you find yourself needing one, stop and flag it first.

No P1s this time — the geometry, remap, caching-bypass, cancellation, and
prompt-stability cores are all correct. Items 1–2 are input-handling bugs a
real user can hit; 3–4 are small leak/waste guards; 5 is a test-coverage debt
the Phase 7 handoff explicitly asked for. 6 lists reviewed behaviors that are
**accepted as-is** — note them, don't build them. 7 is the outstanding manual
verification (human step, not yours).

---

## 1. Region-select pointer state machine lacks cancel + identity guards (P2 — `content/regionSelect.ts`)

Three related gaps in the marquee shell (`onPointerDown`/`Move`/`Up`), all
"weird but real input" cases:

- **No `pointercancel` handler → phantom selection.** If the browser cancels
  the pointer mid-drag (touch scroll/pinch takeover, the OS stealing the
  pointer, capture loss), `pointerup` never arrives and `anchor` stays set.
  The marquee then keeps following a button-less mouse on every `pointermove`,
  and the **next plain click finalizes a selection the user thought was dead**
  — an unintended paid translation request. Handle `pointercancel` as a cancel:
  treat it exactly like Esc (full `teardown()`; the mode is one-shot anyway).
- **No button / primary check.** `onPointerDown` anchors on ANY pointer button
  — a right-button drag starts a marquee while the native context menu opens on
  top of the crosshair. Ignore non-primary pointers and non-left buttons:
  `if (!e.isPrimary || e.button !== 0) return;`.
- **No pointerId identity on move/up.** With multi-touch, a second finger's
  `pointerup` (different `pointerId`) finalizes the FIRST finger's in-progress
  drag using the second finger's coordinates. `onPointerMove`/`onPointerUp`
  should ignore events whose `e.pointerId` doesn't match the anchored one
  (`pointerId` is already stored for capture — reuse it).

Keep it shell-thin; the pure rect math is untouched. // WHY-note the
pointercancel case (it is invisible in mouse-only testing).

🧪 *Tests:* the pointer plumbing is shell (house style: untested), and building
a jsdom PointerEvent harness for it is contrived — WHY comments + the suite
staying green is acceptable. If you find a cheap seam while in there, a single
"pointercancel ends the drag" test is welcome, not required.

## 2. Stale hover-peek after toggling peek-all off (P3 — `content/overlay/OverlayManager.ts`)

While `peekAll` is on, `processPeek` early-returns (correct — toggle-all wins),
so `peekHover` is **frozen** at whatever bubble the mouse was over when
peek-all engaged. Toggling peek-all OFF repaints every done entry with
`shouldPeek` consulting that frozen `peekHover` — a bubble the pointer left
long ago keeps showing its original text until the next `mousemove` happens to
re-run the hit-test. A keyboard-only user (Alt+Shift+O on, read, Alt+Shift+O
off, hands never on the mouse) sees one bubble permanently stuck on the
original.

- Reset `this.peekHover = null` in `togglePeekAll()` (both directions is fine
  and simplest). The next real mousemove re-establishes a live hover via the
  normal reducer path. // WHY-note that hover state is unmaintained while
  peekAll is on.

🧪 *Tests:* the pure reducer (`peekRepaintTargets`) is already covered; this is
one line of private shell state — WHY comment + suite green is acceptable.

## 3. Region request timeout abandons the background job (P3 — `content/regionSelect.ts`)

When `withTimeout` rejects in `translateCrop` (120 s: event page died — or
merely saturated), the catch deletes the `requestId` from `inflight` and clears
the overlay, but never sends `cancelTranslation`. If the event page is alive
but slow, the provider call keeps running — and unlike the viewport queue's
timeout path, a region result is **never cached**, so the orphan run is pure
wasted spend for a result nobody will render.

- In the catch, fire-and-forget
  `sendToBackground("cancelTranslation", { requestId }).catch(...)`, same
  pattern as `stop()`. Harmless when the event page really died (unknown id is
  a silent no-op — that is the existing contract).

🧪 *Tests:* the region-select shell has no unit harness (house style); WHY
comment + suite green. If you add a seam for item 1, cover this in the same
test file cheaply.

## 4. Overlay host created for an already-removed image (P3 — `content/overlay/OverlayManager.ts`)

`ensure()` happily creates a host for a candidate whose element is no longer
connected. The realistic path is Phase 7's own: the user drag-selects, the
reader swaps/removes the image (SPA page turn) during the multi-second
provider round trip, and the region result then `render()`s against a
disconnected element → an invisible zero-size host appended to `<body>` that
is only reaped by the NEXT scroll/resize position sync. If the page never
scrolls, the orphan lingers until deactivate.

- Guard `ensure()` with `if (!candidate.el.isConnected) return null;` (all
  callers already tolerate the null). This also hardens the page path's
  narrow render-vs-removal race for free, and matches the `syncPositions`
  convention (disconnected ⇒ no overlay).

🧪 *Tests:* OverlayManager is shell (no unit file); WHY comment + suite green.

## 5. The handoff's item-7 router test was skipped (P3 — tests)

Phase 7's item 7 test line asked for: *"content router responds
`{started:false}` while inert / `{started:true}` + mode entered while active
(jsdom or seam)"*. It shipped untested — PROGRESS.md self-flags the deviation
("stays untested composition"). The surrounding pieces (region selector math,
popup decision, command fan-out) ARE tested; what's missing is the one seam
the handoff named.

- Smallest honest fix: extract the handler-map construction in
  `content/index.ts` into a tiny factory (e.g.
  `buildContentRouterHandlers({ getQueue, startRegionSelection, getOverlay })`)
  and test THAT with fakes: inert → `{started:false}` and the selector
  untouched; active → `{started:true}` and `start()` called;
  `togglePeekOriginal` no-ops while inert. `index.ts` stays a composition root.
- While there, pin the toast reset mechanism the current test only implies:
  `activate()` constructs a **fresh** `ToastManager` per activation (the
  policy test proves an empty set shows again; nothing proves the set is
  actually fresh on re-activate). If extracting `activate()` internals is too
  invasive, a comment tying the two together is the fallback — flag which you
  chose.

🧪 *Tests:* the factory tests above (3–4 cases). Existing tests untouched.

## 6. Reviewed and accepted — note, don't build

- **Region prep runs outside the shared queue**: `resolveRegionBytes` (fetch)
  and `prepareRegionCrop` (decode + OffscreenCanvas) run before `queue.add`;
  only the provider call is queued. The page path preps *inside* the queue.
  Human-paced drag gestures can't overwhelm decode; noted for symmetry only.
- **Stacked-overlay hover precedence**: `processPeek` breaks at the first entry
  (Map insertion order) whose bubbles contain the pointer, so with a region
  overlay stacked on a full-page overlay the earlier entry wins even if the
  later bubble is tighter. Smallest-wins holds *within* an entry; cross-entry
  precedence is accepted alongside v1's accepted overlay stacking.
- **`object-fit: contain/cover` divergence**: the selection is normalized
  against the element's displayed rect, which equals natural-image space only
  under the default `object-fit: fill`. This is the same assumption the
  overlay renderer has made since Phase 5 — a shared pre-existing limitation,
  not a Phase 7 regression.
- **Inner-container scroll mid-drag**: the page-coordinate anchor is invariant
  to WINDOW scroll (the §8 test case, handled); a scrollable sub-container
  moving the image under a fixed page point is accepted.
- **Notice toasts aren't policy-deduped** ("no image under selection", "can't
  access this image", "selection too small"): immediate per-gesture feedback by
  design; they auto-dismiss in 8 s.
- **`defaultCollectTargets` drops the scanner's natural-size floor** (rendered
  ≥ `MIN_RENDERED_PX` only): deliberate — canvas/blob targets can lack an
  intrinsic size, and a user-drawn rect is its own relevance signal.
- **`processPeek` reads one `getBoundingClientRect` per done entry per
  mousemove frame**: rAF-coalesced with no interleaved writes; acceptable.
- **Hover-peek repaint re-fits every region of the affected entry**, not just
  the hovered bubble: transitions are rare relative to mousemove and the
  repaint is rAF-driven; acceptable.

## 7. Outstanding: Phase 7 manual verification (human step — NOT yours)

The Phase 7 DoD's 7 manual-verification steps (PHASE-7-HANDOFF.md §"Manual
verification") were **not executed** — they need a real Firefox, the built
extension, and a live API key. PROGRESS.md says so honestly. They should run
AFTER this phase lands (item 1 changes drag behavior), against
`tests/fixtures/testpage.html` served over http (it now includes the untainted
`<canvas>` fixture for the bytes path). Record the results in PROGRESS.md when
done. Do not attempt to fake or skip this — just leave its status accurate.

## Definition of done

- `npm run check` green — all **413** existing tests stay green untouched
  (item 5 adds new ones); `npm run build` clean; `npm run lint:ext` 0 errors /
  0 warnings (the `data_collection_permissions` notice remains,
  Phase-8-deferred).
- **No `shared/types.ts` or `shared/messages.ts` changes** (stop and flag if
  you think you need one). `PROMPT_VERSION` untouched.
- PROGRESS.md gets a **Phase 7.1 summary (review fixes)** paragraph in the
  existing house style: fixes numbered as above, the accepted-as-is notes from
  item 6, the honest manual-verification status from item 7, and test counts.
