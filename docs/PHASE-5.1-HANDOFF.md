# Phase 5.1 — Content Script Review Fixes (handoff)

You are implementing **Phase 5.1** of the MangaLens Firefox extension: fixes
from a review of the Phase 5 content-script pipeline (scan → viewport queue →
overlay) against Architecture §7.1/§7.2/§7.5 and real-page behavior. Phase 5's
Definition of Done was independently verified green before this review: 284
unit tests, typecheck, ESLint, `vite build`, and `web-ext lint` (0 errors /
0 warnings; the `data_collection_permissions` notice stays Phase-8-deferred).

Read first: `docs/PHASE-5-HANDOFF.md` (the ground rules and item numbering
below refer to it), Architecture §7.2/§7.5, and the Phase 5 summary in
`PROGRESS.md`. All Phase 5 ground rules apply unchanged (strict TS, JSDoc,
pure-core/thin-shell, `// WHY:` comments, fail soft, no `shared/types.ts`
changes). **No `shared/messages.ts` changes are expected this phase either** —
if you find yourself needing one, stop and flag it first.

Items are ordered by priority: 1–2 are correctness bugs a user would hit on
real pages, 3–6 are robustness/UX gaps, 7–8 are cleanups. 9 lists reviewed
behaviors that are **accepted as-is** — note them, don't build them.

---

## 1. Overlay bubbles go stale on resize (P1 — `overlay/OverlayManager.ts`)

The whole point of normalized bboxes (§7.2: "responsive resizing is free —
re-running layout with the new rect is the entire resize story") is that the
re-run happens — but it never does. `positionEntry` (called from the shared
scroll/resize listeners, the per-image `ResizeObserver`, and `syncPositions`)
only moves/resizes the **host**; the BubbleBoxes inside were laid out in
absolute pixels computed from the displayed size at *paint* time. Shrink the
window (or let a responsive reader re-flow, or zoom) and the host tracks the
image while every bubble inside it stays at the old pixel offsets and sizes —
misaligned overlays on exactly the manual-verify step ("resize the window —
overlays track"). Only the `<img>` `load` listener currently re-paints.

- Track the last-painted displayed size on each `OverlayEntry`. When an entry
  is (re)positioned and its `state === "done"`, re-run `paint(entry)` iff the
  displayed size changed beyond an epsilon (~0.5 px). The size-changed
  predicate is a **pure helper** (unit-test it); the repaint call stays in the
  shell.
- While in there, **coalesce position syncs through one `requestAnimationFrame`**:
  the capture-phase scroll listener currently walks every entry and does a
  `getBoundingClientRect` + style write *per scroll event*. Mark dirty, schedule
  one rAF, sync once per frame. (This also throttles repaint churn from
  `ResizeObserver` loops during a continuous drag-resize.) The rAF plumbing is
  shell; no test needed beyond the suite staying green.
- Re-painting re-runs textFit per region — that is correct and required
  (`auto` size must re-fit; `fixed` must NOT visually scale), which is WHY the
  fix is "re-paint", not "CSS-transform-scale the container". // WHY-note it.

🧪 *Tests:* the pure size-changed predicate (changed beyond epsilon / within
epsilon / degenerate zero sizes). Existing overlay tests untouched.

## 2. Host mispositioned when `<body>` is a containing block (P1 — `overlay/OverlayManager.ts`)

`positionEntry` sets `left/top = rect + scrollX/Y`, which assumes the host's
containing block is the initial containing block anchored at the document
origin. That breaks whenever `document.body` (or `<html>`) establishes the
containing block — `position: relative` on body is common on reader sites, and
even the UA-default 8 px body margin then shifts every overlay by 8 px; a
`transform`/`filter` on body breaks it worse. (Content-level transforms are
fine: the image's `getBoundingClientRect` already reflects them, and our host
is outside that subtree — WHY body-append survives reader zoom.)

- Fix by **measuring the error and correcting it**, which is robust to every
  cause at once: after assigning `left/top`, read the host's own
  `getBoundingClientRect()`, compute the delta to the image rect, and if it
  exceeds ~0.5 px subtract it from `left/top`. The correction is idempotent
  (re-running with a correct position yields zero delta), and with item 1's
  rAF batching the extra rect read is once per frame, not per scroll event.
- Cache the measured correction per manager if you prefer (all hosts share one
  containing block), but per-entry correction is acceptable. // WHY-note the
  containing-block assumption this replaces.

🧪 *Tests:* none practical (jsdom does no layout — rects are zeros); keep the
correction in the shell with a WHY comment. The manual test page: add
`position: relative` + a margin to `<body>` in a copy, or just note manual
re-verification of overlay alignment in PROGRESS.md.

## 3. Unhandled rejection in the coalesce leader's cleanup (P2 — `background/translateHandlers.ts`)

In `translateImage`, the leader tears down the `SharedAbort` with
`void run.finally(() => { ... })`. `.finally()` returns a **new promise that
re-rejects** when `run` rejects — and it is `void`-ed, so every failed
coalesced run (auth error, refusal, network) fires an `unhandledrejection` in
the event page even though the real rejection is handled by the `await run`
below. Console noise on every failure path, and exactly the kind of thing that
gets flagged in AMO review.

- Swallow the derived promise's rejection: `run.finally(cleanup).catch(() => {})`
  (or equivalent). Cleanup must still run on both resolve and reject.

🧪 *Tests:* extend the translateHandlers suite: after a **rejected** coalesced
run, the sharedAborts map entry for the key is gone (cleanup ran), and no
unhandled rejection surfaces (vitest fails on unhandled rejections by default —
a test that rejects the run and settles cleanly covers it).

## 4. Scanner re-scan feedback loop + starvation (P2 — `content/scanner.ts`)

Three compounding problems with the MutationObserver-driven rescan:

- **Self-triggering**: the observer watches `attributes: ["style", ...]` on the
  whole document, and OverlayManager writes overlay-host `style` on every
  scroll/resize sync — so scrolling schedules a full re-scan forever. Skip
  mutation records whose target is one of our own hosts (they carry
  `data-mangalens-overlay`; children are inside a shadow root and never reach
  this observer). Filter in the observer callback before `scheduleScan`.
- **Starvation**: `scheduleScan` is a trailing-edge debounce (`clearTimeout` +
  new 250 ms timer). A page with any perpetually-animating inline style (
  sliders, progress bars) mutates faster than 250 ms forever → the scan never
  runs and late-added images are never found. Add a **max-wait**: guarantee a
  scan runs at most ~250 ms after quiet OR at least once per ~1 s of continuous
  mutations. Extract the "given last-run/first-scheduled timestamps, run now or
  in N ms" decision as a pure helper.
- **Sweep cost**: `defaultCollectElements` calls `getComputedStyle` on every
  non-`<img>` element in the document per scan. Cheapen it: read the rect
  first and skip elements smaller than `MIN_RENDERED_PX` before touching
  computed style (layout is already clean at that point; the style pass is the
  expensive part on 10k-element DOMs). // WHY-note the ordering.

🧪 *Tests:* pure debounce/max-wait decision helper (quiet → trailing delay;
continuous mutations → forced run at max-wait). The self-trigger filter can be
covered in the existing jsdom walker test by asserting a mutation on a
`data-mangalens-overlay` element does not schedule a scan (inject seams as
needed) — or keep it shell-thin with a WHY comment if the seam gets contrived.

## 5. API-key change must re-request (P2 — `content/gate.ts`)

`translationSignature` deliberately excludes `apiKey` ("a key change doesn't
invalidate a produced translation") — true for cached successes, but wrong for
failures: after an `auth` error every candidate sits at `requested: true` with
a ⚠ badge, and entering a correct key is a gate **no-op** — nothing recovers
until a page reload or toggle. Phase 6's options UI makes this the *first-run
path*: see auth badges → paste key → nothing happens.

- Include the derived `apiKey` in `translationSignature`. A key change while
  active then classifies as `re-request`: full teardown/re-activate, and since
  the API key is NOT part of the cache key, previously-translated pages
  re-render instantly from cache while errored ones actually retry. Update the
  WHY comment to explain the new reasoning (cache-cheap for successes, the only
  recovery path for auth failures).

🧪 *Tests:* gate — apiKey change while active → `re-request`; apiKey change
while inactive → `no-op`; unchanged apiKey unaffected.

## 6. The retry path never retries a statically-visible image (P2 — `content/viewportQueue.ts`)

The 120 s timeout (and the send-failure catch) resets the entry to
"unrequested" with a WHY comment saying "a later visibility event retries" —
but IntersectionObserver only fires on **transitions**. An image sitting in
the viewport when its request times out generates no new intersection event,
so it is wedged (no overlay, no retry) until the user scrolls it out and back.

- After resetting `requested = false` in the timeout/catch path, force a fresh
  intersection callback by `unobserve()` + `observe()` on both observers for
  that element — `observe()` always delivers an initial entry with the current
  intersection state, which re-plans and re-sends if the image is (near-)
  visible. // WHY-note the IO-transitions-only quirk.
- Same treatment for an `aborted` result that arrives while the candidate is
  **still registered** (today that leaves `requested: true` with no overlay —
  currently near-unreachable since cancels come from unregister/teardown, but
  it costs one line to make the invariant "terminal-without-render ⇒ retryable
  on next visibility").
- Make the timeout injectable (`requestTimeoutMs?: number` in
  `ViewportQueueOptions`, defaulted to 120 000) so this is testable without
  fake-timer gymnastics on a 2-minute wait.

🧪 *Tests:* with the existing `createObserver` seam + a mocked
`sendToBackground` that never settles and a small injected timeout: after the
timeout, the element is re-observed (fake observer records
unobserve/observe) and a subsequent visibility callback re-sends. Aborted-
while-registered resets `requested`.

## 7. Dead score sort in the scanner (cleanup — `content/scanner.ts`)

`scan()` sorts `found` by `scoreCandidate` before firing `onAdded`, with a
comment claiming "the viewport queue registers the main page(s) first —
prefetch and priority both read document/registration order". Both halves are
false: the viewport queue re-inserts every candidate into **document order**
(`insertInDocOrder`), so registration order has zero observable effect — the
sort is dead code and the comment is misleading.

- Remove the sort (and the `score` field of the scan accumulator); fix the
  comment. Keep `scoreCandidate` itself — exported, tested, and reserved for
  the §7.1 "score by size + position" ranking when something actually consumes
  it (drag-select default target / main-image heuristics, Phase 7) — note that
  status in its JSDoc so the next review doesn't flag it as unused.

🧪 *Tests:* existing scanner tests stay green (none asserted the ordering).

## 8. Small hardening (P3, cheap)

- **Bootstrap race** (`content/index.ts`): a `storage.onChanged` event that
  fires while `readSettings()` is awaiting can be applied first and then
  clobbered by the staler initial read. Serialize: buffer the latest raw value
  seen before the initial `applySettings` completes and re-apply it after (a
  simple `latestChange` variable + one re-apply beats a queue). 🧪 covered by
  gate-level reasoning; shell change, WHY comment.
- **Double stroke rendering** (`overlay/BubbleBox.ts`): the text-shadow
  fallback is applied *alongside* `-webkit-text-stroke`, so Firefox (which
  supports the prefixed property — our only target) renders stroke + halo,
  visibly thickening the outline. Gate the shadow on
  `!CSS.supports("-webkit-text-stroke", "1px red")`. 🧪 none (visual, shell).

## 9. Reviewed and accepted — note, don't build

- **Cache-store race**: `cacheStorePage` is fire-and-forget and the coalesce
  entry clears on settle, so a request landing in the (ms-wide) window between
  run-settle and IndexedDB commit re-pays one provider call. Accepted; add an
  in-source note at the `void cacheStorePage(...)` site.
- **Prefetch skeletons offscreen**: priority-2 prefetch creates pending-state
  hosts a viewport+ away. Invisible and cheap; accepted.
- **120 s request timeout vs. long queue waits**: fine for viewport + 3
  prefetch; will mass-timeout under Phase 6 "translate all" on big chapters —
  revisit with the Phase 8 queue tuning, not now.
- The Phase 5 deferrals stand: no scroll-away cancel, no priority upgrade, no
  blob/canvas sources, no mid-session `prefetchAhead` reactivity.

## Definition of done

- `npm run check` green (284 existing tests stay green except where an item
  explicitly changes behavior); `npm run build` clean; `npm run lint:ext`
  0 errors / 0 warnings (the `data_collection_permissions` notice remains).
- **No `shared/types.ts` or `shared/messages.ts` changes** (rule 4 — stop and
  flag if you think you need one).
- PROGRESS.md gets a **Phase 5.1 summary (review fixes)** paragraph in the
  existing style: what was fixed (numbered as above), what was flagged, the
  accepted-as-is notes from item 9, and test counts.
