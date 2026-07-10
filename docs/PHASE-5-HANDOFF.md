# Phase 5 — Content Script: Scan + Overlay (handoff)

You are implementing **Phase 5** of the MangaLens Firefox extension: the content
script that finds manga images, requests translations, and renders overlays —
the first phase where the extension does anything user-visible, and the first
time the full pipeline (content → background → provider → cache → overlay) runs
end to end.

Read first: `docs/ARCHITECTURE.md` §7.1 (scanner heuristics), §7.2 (overlay
positioning), §7.5 (latency/priority), §7.7 (text fitting), §8 Phase 5, §9
(handoff rules); `docs/PROMPTS.md` §9 (watermark post-filter — deferred here
from Phase 3); the Phase 1.1, 3, 4 and 4.1 summaries in `PROGRESS.md`. Baseline
state is verified green: 215 unit tests, typecheck, ESLint, `vite build`, and
`web-ext lint` (0 errors / 0 warnings; the lone `data_collection_permissions`
notice is Phase-8-deferred and expected).

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 **event
   pages** (not Chrome service workers).
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Every module gets Vitest coverage (happy path + edge cases). Keep the
   repo-wide **pure-core / thin-shell split**: observers (Mutation/Intersection/
   Resize), Shadow-DOM manipulation, and layout reads stay in thin untested
   shells; every *decision* (candidate scoring, priority tiers, geometry math,
   text fitting, watermark filtering, abort refcounting) lives in a pure,
   browser-free function and is unit-tested.
   - The Vitest environment is `node` (`vitest.config.ts`). Tests that need a
     DOM must opt in per file with the `// @vitest-environment jsdom` pragma,
     and `jsdom` must be added as a devDependency (`npm i -D jsdom`).
   - jsdom does **no layout**: `getBoundingClientRect` returns zeros. Design the
     shells so metrics are read through an injectable seam, and test the pure
     logic on synthetic metrics rather than fighting jsdom.
4. Do not change interfaces in `shared/types.ts` without flagging it explicitly.
   (This phase should not need to. `shared/messages.ts` changes ARE expected —
   see item 4 — flag them in PROGRESS.md the same way.)
5. **All bbox coordinates are normalized 0–1 relative to the ORIGINAL full
   image; convert to pixels only at render time.** This is the phase where that
   rule finally bites — the conversion happens in exactly one pure helper
   (item 5) and nowhere else. Regions arrive already remapped from tile space
   to full-image space by the background (§7.4); the overlay never sees tiles.
6. **Fail soft: any error must degrade to "no overlay" + a console-grouped
   warning, never break the host page.** The content script runs on arbitrary,
   possibly hostile pages: wrap every entry point (observer callbacks, message
   handlers, bootstrap) so an exception can never escape into the page's world,
   and never let overlay DOM or CSS leak outside a shadow root.
7. Comment every non-obvious decision with a `// WHY:` prefix.
8. When done: `npm run check` + `npm run build` + `npm run lint:ext` all clean,
   and append a **Phase 5 summary** paragraph to `PROGRESS.md` in the existing
   style (what changed, what was flagged, test counts).

## New files

```
src/content/index.ts              # REWRITE: enable gate + bootstrap/teardown
src/content/scanner.ts            # candidate discovery (§7.1)
src/content/viewportQueue.ts      # visibility → priority → translate requests (§7.5)
src/content/overlay/OverlayManager.ts
src/content/overlay/BubbleBox.ts
src/content/overlay/textFit.ts
src/content/styles.css            # shadow-root-only styles (vite `?inline` import)
tests/fixtures/testpage.html      # manual test page (§8 Phase 5)
tests/unit/{scanner,viewportQueue,overlay*,textFit,...}.test.ts
```

Plus small background/shared changes for cancellation (item 4):
`shared/messages.ts`, `background/translateHandlers.ts`, and a new pure abort
helper (suggested: `background/sharedAbort.ts`).

---

## 1. Enable gate (`content/index.ts`) — storage read, NOT messaging

The in-source note from Phase 1.1 (top of `content/index.ts`) is the spec:

- On load, read the raw settings blob with
  `browser.storage.local.get(SETTINGS_KEY)` and heal it with the **pure**
  `migrateSettings(raw).settings` — do NOT call `loadSettings()`.
  // WHY: `loadSettings` persists on first run; a content script running on
  every page must never write storage (write contention across N tabs), and a
  storage *read* does not wake the background event page, which is the whole
  point of this design.
- Gate on `getEffectiveEnabled(settings, location.hostname)` (already built and
  tested, `shared/settings.ts`).
- Subscribe to `browser.storage.onChanged` (area `local`, key `SETTINGS_KEY`)
  and recompute. The gate is a small **pure reducer** — (previous state,
  new settings, hostname) → `activate` / `deactivate` / `restyle` / `no-op` —
  so idempotence (enable twice = once) and clean teardown are unit-testable.
- **Teardown must be total**: disconnect all observers, remove all overlay
  hosts, cancel in-flight requests (item 4), drop listeners. Toggling
  off → on → off repeatedly must not leak DOM nodes or observers.
- Do **not** register a content-side handler for the `settingsChanged`
  broadcast. `storage.onChanged` is strictly more reliable (fires in every tab
  including ones the broadcast misses) and having both fire would double-handle
  every change. The broadcast stays for the popup (Phase 6). // WHY-note this
  in the router wiring so Phase 6 doesn't "fix" it.
- Settings changes while active: font/rendering changes restyle existing
  overlays in place; `targetLang`/provider/model changes clear rendered
  overlays and let the viewport queue re-request (cache makes this cheap).
  Enabled-state changes activate/deactivate.

🧪 *Tests:* gate reducer — off→on, on→off, on→on (idempotent), per-site
override beats global (both directions), restyle vs re-request vs no-op
classification of a settings diff.

## 2. `scanner.ts` — find candidate manga images (§7.1)

Split: a **pure candidate predicate + scorer** operating on plain metrics, and
a thin DOM walker that collects those metrics.

- Pure core, exported constants for thresholds: rendered area ≥ **180×180 px**,
  natural size ≥ **400 px** on at least one side, aspect-ratio filter loose
  (webtoon strips are extreme — do not reject tall). Score by rendered area and
  position (centered-in-content beats sidebar). The predicate takes
  `{ renderedW, renderedH, naturalW, naturalH, viewportW, ... }` — no DOM.
- v1 sources: `<img>` elements (use `currentSrc`, which reflects the chosen
  `srcset` candidate, falling back to `src`) and CSS `background-image` with a
  resolvable `http(s):` URL. Accept `http(s):` and `data:` URLs.
  - **Skip `blob:` URLs** — a blob URL is scoped to the document that created
    it; the background cannot fetch it (§7.3 names this exact fallback case).
    // WHY-note; the Phase 7 drag-select/screenshot path covers it.
  - **Skip `<canvas>`** — there is no URL to send under the §7.3 fetch-in-
    background model. Also Phase 7. Flag this scoping in PROGRESS.md.
- Dynamic pages: one debounced `MutationObserver` (childList + subtree +
  attribute filter `src`/`srcset`/`style`) re-scans for added/changed
  candidates; listen for `popstate` for SPA back/forward. Do NOT monkey-patch
  `history.pushState` — the MutationObserver already catches the DOM swap that
  follows a soft navigation, and patching page globals from an isolated world
  is exactly the kind of host-page interference rule 6 forbids. // WHY-note.
- **Lazy is load-bearing**: scanning only *registers* candidates with the
  viewport queue. Nothing is fetched, hashed, or translated at scan time.
- De-dupe: an element already registered (same element, same `currentSrc`) is
  not re-registered; a changed `currentSrc` on a known element re-registers it
  (reader apps swap `src` in place — that in-place swap must also tear down the
  element's existing overlay, see item 5).

🧪 *Tests:* pure predicate/scorer — too-small icon rejected, avatar (natural
< 400) rejected, normal manga page accepted, extreme-aspect webtoon strip
accepted, scoring order (big centered image beats small footer image); URL
policy (http/data accepted, blob/canvas skipped). One jsdom test for the DOM
walker with an injected metrics seam.

## 3. `viewportQueue.ts` — visibility → priority (§7.5)

This wires the priority plumbing that has existed end-to-end since Phase 1
(`TranslatePageRequest.priority` → background `PriorityQueue`) but has never
had a real sender.

- Two `IntersectionObserver`s over registered candidates: rootMargin `0` →
  priority **0** (visible now); rootMargin ~one viewport (`"100%"`) → priority
  **1** (near). When a candidate becomes *visible*, also enqueue the next
  `settings.prefetchAhead` candidates in document order at priority **2**
  (§7.5 "when page N becomes visible, enqueue N+1..N+3").
- The tier/prefetch decision is a **pure planner**: (candidate order, index
  that just changed tier, already-requested set, prefetchAhead) → list of
  `{ index, priority }` to send. The observer callback is a thin shell.
- Send via `sendToBackground("translatePage", { imageUrl, priority, requestId })`
  (requestId from item 4). On `{ ok: true }` hand the `PageTranslation` to the
  OverlayManager; on `{ ok: false }` set the overlay error state with the
  `errorKind` (item 5). Never throws — but still wrap per rule 6 (the send
  itself can reject if the channel closes).
- One request per candidate, tracked in a requested set. **No priority
  upgrade** for an already-sent request: the background queue has no
  re-prioritize API, and a duplicate send would coalesce onto the same run
  anyway. // WHY-note; accepted for v1, revisit in Phase 8 if prefetch-starved
  visible pages show up in practice.
- Respect event-page reality (gap #8): in-flight jobs are NOT persisted by the
  background. If a translation neither resolves nor rejects (event page died),
  the content side's requested-set entry would wedge that image forever — put a
  generous timeout (e.g. 120 s) around the await and return the entry to
  "unrequested" on timeout so a later visibility event retries. // WHY-note.

🧪 *Tests:* pure planner — visible beats near beats prefetch, prefetch window
respects `prefetchAhead` and document order, already-requested indices are
skipped, prefetch never runs off the end of the candidate list.

## 4. Real cancellation (background carry-forward — the Phase 4 in-source note)

`translateHandlers.ts` creates an `AbortController` per request but nothing
ever aborts it; the coalesce comment (`translateHandlers.ts` ~line 266) says:
*"When Phase 5 adds real per-request cancellation, this needs a refcount (abort
only when the LAST waiter leaves)."* This phase builds both halves. Without it,
disabling the extension or closing a tab mid-chapter leaves the event page
paying the provider for pages nobody will see.

- `shared/messages.ts` (flag the contract change in PROGRESS.md):
  - `TranslatePageRequest` gains optional `requestId?: string` (content
    generates `crypto.randomUUID()`).
  - New message `cancelTranslation: { request: { requestId: string };
    response: void }`.
- Background: a module-level `Map<requestId, AbortController>`; the
  `translatePage` handler registers before calling `translateImage` and
  removes in `finally`; the `cancelTranslation` handler aborts + removes.
  Cancelling an unknown/already-settled id is a silent no-op (the normal race).
- **Coalesce refcount** — keep `coalesce()` itself untouched (it is pure and
  shipped); add a separate pure helper (suggested `background/sharedAbort.ts`):
  the underlying provider run owns a fresh `AbortController`; each coalesced
  waiter registers its own external signal; the underlying controller aborts
  only when **every** registered waiter has aborted. Waiters whose signal never
  fires count as live. This slots into `translateImage` where the current
  single `signal` is passed through to `runTranslateMiss`.
- An aborted waiter's `translatePage` response is the existing
  `{ ok: false, errorKind: "aborted" }` mapping (`errorToTranslateResult`
  already handles it); the content side treats `aborted` as silent (no error
  badge — the user scrolled away or toggled off, nothing is wrong).
- Content sends `cancelTranslation` on: teardown/disable (all outstanding ids)
  and when a candidate element is removed from the DOM or its `src` swapped.
  **Not** on scroll-away — visible→near→visible thrash would cancel work we
  are about to want; prefetched results also fill the cache regardless.
  // WHY-note; revisit with Phase 8 tuning.

🧪 *Tests:* shared-abort helper (pure): two waiters, one aborts → underlying
signal NOT aborted, run resolves for the other; both abort → underlying
aborted; a waiter with no signal keeps the run alive; late registration after
settle is a no-op. Handler wiring with fake-browser: cancel aborts the
registered controller; unknown id no-ops; registry entry removed on settle.

## 5. `overlay/OverlayManager.ts` — Shadow-DOM overlay per image (§7.2)

- One **host element per translated image, appended to `document.body`**, with
  an open shadow root. // WHY body-append, not a sibling: inserting siblings
  mutates the reader's own layout (`:last-child` selectors, flex/grid item
  counts) — rule 6 forbids observable interference. WHY open: debuggability;
  closed buys nothing against a hostile page that can see the host anyway.
- Position: `position: absolute`, `top/left` = `getBoundingClientRect()` +
  `window.scrollX/Y`, sized to the rect. Sync on: one manager-level passive
  `scroll` + `resize` listener pair (shared by all overlays — not per-overlay),
  a `ResizeObserver` per tracked image, and the image's `load` event (late
  decode changes the rect). `pointer-events: none` on everything (this phase
  has no interactive bits; F14 peek-original is Phase 7).
- **The one bbox→pixel conversion in the codebase** (rule 5) is a pure helper:
  `regionToPx(bbox, displayedW, displayedH)` → `{ left, top, width, height }`
  in overlay-local px. Because bboxes are normalized to the original image,
  responsive resizing is free — re-running layout with the new rect is the
  entire resize story.
- Overlay states: `pending` (subtle skeleton/spinner — §7.5 perceived latency),
  `done` (BubbleBoxes), `error` (small ⚠ badge, `title` from the errorKind →
  user-message map: `auth` → "check your API key", `rate-limit` → "rate
  limited — try again shortly", `refusal` → "provider declined this image",
  `network`/`unknown` → generic; `aborted` → render nothing). The map is pure
  and shared with Phase 6/7 toasts later.
- Teardown per image when: element leaves the DOM (`!img.isConnected` checked
  during sync — cheaper and more robust than a second MutationObserver),
  `currentSrc` swaps (scanner item 2 signals this), or global deactivation.
  Remove host, disconnect its ResizeObserver, cancel its request if in flight.
- **Watermark post-filter (PROMPTS §9, deferred here from Phase 3), applied at
  render time**: drop a region iff `kind === "sign"` AND its bbox lies within
  2% of any image edge AND its text (original or translated) matches a
  URL/domain pattern (the host page's hostname, or a generic
  domain-with-TLD/URL regex). Pure function; **never mutate the cached
  `PageTranslation`** — the same cache entry must render unfiltered elsewhere
  if rules change.
- Also filter at render: regions with `isSfx: true` when
  `settings.translateSfx` is false (F19 default skip).

🧪 *Tests:* `regionToPx` (round-trip at several display sizes, degenerate
0-size rect); watermark filter (sign+edge+domain-text dropped; sign in the
middle kept; edge caption kept; sign at edge with non-URL text kept; matches
against hostname and generic URL forms); errorKind→message map totality (every
`ProviderErrorKind` maps, `aborted` maps to "render nothing"); SFX filtering
on/off.

## 6. `overlay/BubbleBox.ts` + `overlay/textFit.ts` — render one region (§7.7)

- BubbleBox renders one `TranslatedRegion` inside the overlay: rounded-rect
  fill from `settings.font.bubbleFillColor` at `bubbleFillOpacity`, text in
  `font.family`/`font.color`, optional stroke (`font.stroke`,
  `font.strokeColor` — CSS `paint-order: stroke` + `-webkit-text-stroke`, or
  text-shadow fallback), 6% padding, `overflow: hidden`. Horizontal text
  regardless of source direction (§7.7 normal case).
- `textFit.ts` is the **pure binary search**: given the box inner size, the
  text, `[minSizePx, maxSizePx]`, and an injected `measure(text, px) →
  { w, h }` callback, return the largest integer px size whose wrapped text
  fits. The DOM measurer (offscreen element in the shadow root, or canvas
  `measureText` + line-height math) lives in the thin shell.
  - `sizeMode: "fixed"` bypasses the search and uses `fixedSizePx`.
  - Edge cases (JSDoc + tests): text that never fits → clamp to `minSizePx`
    and let `overflow: hidden` crop (// WHY: an unreadably tiny overlay is
    worse than a cropped one); empty/whitespace text → render nothing; a
    single word wider than the box at min size → same clamp.
- Do NOT build hover peek-original (F14) or any keyboard interaction — Phase 7.

🧪 *Tests:* textFit with a fake fixed-advance measurer — converges to the
known-correct size, respects both bounds, fixed mode bypasses, monotonicity
(bigger box ⇒ ≥ font size), never-fits clamps to min, empty text handled.

## 7. Bootstrap, styles, and the manual test page

- `content/index.ts` composes it all: gate (item 1) → on activate, start
  scanner + viewport queue + overlay manager; on deactivate, tear all three
  down. Keep it a thin composition root — no logic of its own.
- `styles.css`: imported with vite's `?inline` suffix and injected as a
  `<style>` into **each shadow root** — never into the page document.
- `tests/fixtures/testpage.html`: a static page with (a) a normal manga-page
  image, (b) an extreme-aspect webtoon strip, (c) small icons/avatars that the
  scanner must ignore, (d) ideally one late-swapped image (`setTimeout` src
  swap) to exercise the MutationObserver. Note `tests/fixtures/images/` does
  not exist yet (Phase 2 tested on synthetic canvases) — add 2–3 small
  **public-domain** manga/webtoon images (note their source in the page).

## Manual verification (the first real end-to-end — this is new)

No phase before this could run the pipeline in a real browser; Phase 4's
"translate a page twice" check finally becomes executable. Include this in the
PROGRESS.md verify note:

1. `npm run build`, then `npm run start:firefox` (web-ext against `dist/`).
2. **Grant the optional host permission manually**: about:addons → MangaLens →
   Permissions → enable "Access your data for all websites". The in-flow
   `permissions.request` UX is Phase 6 (content scripts cannot call
   `permissions.request`; it needs the popup/options user-gesture context).
   Without this, the background image fetch fails CORS on most sites.
3. Set an API key from the background console (about:debugging → Inspect):
   `await browser.storage.local.set(...)` patching `apiKeys.gemini` (or use the
   `setSettings` message). The options UI is Phase 6.
4. Serve the test page over http (e.g. `npx serve tests/fixtures`) — `file:`
   image URLs are not background-fetchable.
5. Enable via the keyboard command (`Alt+Shift+M`, `toggle-mangalens`).
6. Verify: overlays appear on the two manga images and NOT the icons; the
   strip's regions land correctly across the full height (tile remap); resize
   the window — overlays track; **reload and re-translate: the second render is
   instant** (cache hit — no provider call in the network panel) and the cost
   figure only moved on the first; toggle off — every trace disappears and the
   page is untouched; toggle back on — overlays return (from cache, instant).

## Explicitly out of scope (do NOT build)

- Drag-select fallback, peek-original hover, keyboard shortcuts beyond the
  existing toggle, error toasts — **Phase 7**.
- Popup/options UI, `testApiKey` wiring, in-flow permission request, cache
  management / cost display surfaces — **Phase 6**.
- Prefetch tuning, multi-page batching (F12), priority upgrade /
  re-prioritization of sent requests, scroll-away cancellation — **Phase 8**.
- `<canvas>` and `blob:` image sources — Phase 7 (drag-select/screenshot path).
- Reading-direction bubble *ordering* (F18) — stretch; `readingDirection`
  already flows to the prompt, nothing to do here.

## Definition of done

- `npm run check` (typecheck + ESLint + full Vitest suite) green — 215 existing
  tests must stay green untouched (except where an item above explicitly
  changes behavior, e.g. providers tests are untouched, messages tests may
  grow).
- `npm run build` clean; `npm run lint:ext` 0 errors / 0 warnings (the
  `data_collection_permissions` notice remains, Phase-8-deferred).
- The `shared/messages.ts` contract additions (requestId, `cancelTranslation`)
  are flagged in the PROGRESS.md paragraph; **no `shared/types.ts` change** —
  if you find yourself needing one, stop and flag it first (rule 4).
- PROGRESS.md gets the Phase 5 summary paragraph in the existing style: what
  was built, design choices flagged (body-append hosts, no priority upgrade,
  no scroll-away cancel, blob/canvas scoping), deferrals, test counts, and the
  manual-verify results from the section above.
