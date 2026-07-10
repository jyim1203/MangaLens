# Phase 7 — Drag-select fallback + polish (handoff)

You are implementing **Phase 7** of the MangaLens Firefox extension: the
click-and-drag region-select fallback (F10), peek-original (F14), error toasts,
the new keyboard shortcuts, and i18n scaffolding for the extension UI. This is
the "universal fallback" phase — after it, a user can translate text on ANY
image (including the `blob:`/`<canvas>` sources the scanner deliberately
skips), and gets actionable feedback when a key is bad or a provider throttles.

Read first: `docs/ARCHITECTURE.md` §7.3 (CORS model — why crops happen in the
background), §7.7 (text fitting/peek), §8 Phase 7, §9 (handoff rules);
`docs/PROMPTS.md` §4.3 (the drag-select prompt suffix — implement verbatim);
the Phase 5, 5.1, 6 and 6.1 summaries in `PROGRESS.md`. Baseline state is
verified green: **354 unit tests**, typecheck, ESLint, `vite build`, and
`web-ext lint` (0 errors / 0 warnings; the lone `data_collection_permissions`
notice is Phase-8-deferred and expected).

**Already shipped — do NOT rebuild:** the SFX toggle (F19) listed under Phase 7
in Architecture §8 landed early: the render-time filter is Phase 5's
`filterRegions` (`content/overlay/regionFilter.ts`) and the options checkbox is
Phase 6. Same for per-image error badges (`errorKindToMessage` +
`OverlayManager.setError`) — Phase 7 adds *toasts on top of* the badges, not a
replacement. The global toggle shortcut (Alt+Shift+M) also exists.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 **event
   pages** (not Chrome service workers).
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Every module gets Vitest coverage (happy path + edge cases). Keep the
   repo-wide **pure-core / thin-shell split**: pointer/keyboard listeners,
   Shadow-DOM manipulation, canvas work, and layout reads stay in thin untested
   shells; every *decision* (selection-rect math, target picking, crop
   planning, hit-testing, toast policy, i18n fallback) lives in a pure,
   browser-free function and is unit-tested.
   - Vitest env is `node`; DOM tests opt in per file with
     `// @vitest-environment jsdom` (jsdom is already a devDependency). jsdom
     does no layout — keep metrics behind injectable seams like the scanner does.
4. Do not change interfaces in `shared/types.ts` without flagging it.
   **This phase has ONE pre-authorized exception** (item 3): `TranslateJob`
   gains optional `isRegion?: boolean`. Flag it in PROGRESS.md like the
   Phase 3 `readingDirection` addition. `shared/messages.ts` additions ARE
   expected (items 3/5/6/7) — flag those too.
5. All bbox coordinates are normalized 0–1 relative to the ORIGINAL full image.
   The crop rect you send to the background is a normalized `BBox` in
   full-image space; the provider's crop-local regions are lifted back via the
   existing `tileOffset` remap (a crop is geometrically a tile — item 3).
6. Fail soft: any error must degrade to "no overlay" + a console-grouped
   warning, never break the host page. The selection overlay is the FIRST
   interactive surface we put on a host page — it must be trivially escapable
   (Esc, or click-without-drag), never trap scroll, and tear down completely.
7. Comment every non-obvious decision with a `// WHY:` prefix.
8. When done: `npm run check` + `npm run build` + `npm run lint:ext` all clean,
   and append a **Phase 7 summary** paragraph to `PROGRESS.md` in the existing
   style (what changed, what was flagged, test counts).

## New files

```
src/content/regionSelect.ts        # selection mode: marquee UI + pure rect math (F10)
src/content/overlay/peek.ts        # (suggested) pure hit-test + peek state helpers (F14)
src/content/toast.ts               # page-level toast host + pure toast policy
src/background/regionHandlers.ts   # translateRegion message: crop → provider → remap
src/shared/i18n.ts                 # t() wrapper over browser.i18n with safe fallback
public/_locales/en/messages.json   # i18n scaffolding (manifest + new UI strings)
tests/unit/{regionSelect,regionCrop,peek,toast,i18n,...}.test.ts
```

Touched: `shared/messages.ts` (new messages), `shared/types.ts` (the one
flagged field), `src/manifest.ts` (two commands + `default_locale` +
`__MSG_*__` strings), `background/index.ts` + `background/settingsHandlers.ts`
(router + command fan-out), `background/providers/prompt.ts` (§4.3 suffix),
`background/imagePrep.ts` (crop planner, pure), `content/index.ts`
(composition), `content/overlay/OverlayManager.ts` + `BubbleBox.ts` (peek),
`src/popup/*` ("Select region" button).

---

## 1. `regionSelect.ts` — selection mode + rect math (F10)

The user activates region-select (command `select-region`, or the popup button
— item 7), drags a rectangle over any image, and that crop gets translated.

**Shell (untested, thin):**
- On activate: one full-viewport selection host — `position: fixed; inset: 0;
  cursor: crosshair`, max z-index, an **open** shadow root (house style), and
  `pointer-events: auto` — this overlay is *deliberately* interactive, the
  exception to the §7.2 rule. Mark the host with `OVERLAY_HOST_ATTR` so the
  scanner's `isOwnOverlayHost` drops its mutations (same trick as Phase 5.1
  item 4). Show a small hint label ("Drag to select · Esc to cancel" — via
  `t()`, item 8).
- `pointerdown` anchors, `pointermove` draws the marquee, `pointerup`
  finalizes. `Esc` cancels. `setPointerCapture` on the host so a drag that
  leaves the window still finishes. Do NOT preventDefault wheel/scroll — the
  page must keep scrolling under the overlay.
- **Anchor in page coordinates** (`pageX/pageY`), not client: if the user
  scrolls mid-drag (wheel while holding the button), a client-coord anchor
  would silently shift the selection. Convert to whatever space you need at
  finalize time. // WHY-note this — it is the "scrolled pages" case the §8
  Phase 7 test line names.
- One-shot: after a completed selection (or cancel), the mode tears down. Next
  use = trigger the command again.
- Selection mode is only available while the gate is active; `deactivate()`
  must also tear down an in-progress selection (add it to the content
  composition root's teardown order).

**Pure core (exported, tested):**
- `normalizeDragRect(anchor, current)` → a page-space rect from two points in
  any drag direction (up-left drags must work).
- `selectionToImageBbox(selectionRectPage, imageRectPage)` → the normalized
  crop `BBox` (0–1, relative to the image's displayed rect), clamped to the
  intersection; returns null when the intersection is degenerate. Because both
  rects are in CSS px of the same space, browser zoom cancels out — that is
  the "zoomed pages" test case.
- `MIN_DRAG_PX` (suggested 8): a drag smaller than this on either side is a
  click → cancel, not a 2-px translation request.
- `pickTargetImage(selectionRectPage, imageRects[])` → index of the best
  target: largest intersection area with the selection wins; break ties with
  `scoreCandidate` (scanner.ts says it is RESERVED for exactly this Phase 7
  consumer — if you end up not using it, update that JSDoc note instead).
  Returns null when nothing intersects → toast "No image under selection".
- Target *collection* (shell): all candidates the scanner registry would
  accept, PLUS the sources it skips — `blob:`-URL images and `<canvas>`
  elements ≥ the scanner's rendered-size threshold (reuse `MIN_RENDERED_PX`).
  Drag-select is the designated fallback for those (§7.3, Phase 5 scoping).

🧪 *Tests:* rect math — inverted drags normalize; selection clipped to the
image; normalized bbox correct at several image positions/sizes; page-coord
anchoring survives a simulated mid-drag scroll (anchor fixed in page space
while client coords shift); sub-`MIN_DRAG_PX` drag → cancel; target picking
(largest overlap wins, tie-break, none → null). All pure — no DOM.

## 2. Byte acquisition — the `blob:`/`<canvas>` fallback path

The background cannot fetch `blob:` URLs (document-scoped) and a canvas has no
URL at all (§7.3) — but the CONTENT script can read both, because it runs in
the page's origin. Acquire bytes content-side only for these two source kinds;
`http(s):`/`data:` URLs keep the Phase 2 background-fetch path (send the URL,
let `fetchImageBytes` reuse the HTTP cache).

- `blob:` image → `fetch(el.currentSrc)` → `ArrayBuffer` + mime.
- `<canvas>` → `canvas.toBlob()` → bytes. A cross-origin-tainted canvas throws
  `SecurityError` → fail soft: toast "Can't access this image" (the §7.3
  screenshot-capture fallback stays P2 — out of scope, item at bottom).
- Send bytes in the `translateRegion` payload (item 3). Firefox
  `runtime.sendMessage` uses structured clone, so `ArrayBuffer` crosses the
  boundary intact. // WHY-note: this is Firefox-only-safe (Chrome's message
  passing is JSON) — fine, we are a Firefox extension, but note it for any
  future Chrome port.
- The scanner does NOT start accepting blob/canvas for auto-translate — the
  fallback is drag-select only. Flag this scoping in PROGRESS.md.

🧪 *Tests:* the acquisition *decision* is pure — given a target's kind
(`img-http` / `img-data` / `img-blob` / `canvas`), return `{ send: "url" }` vs
`{ send: "bytes" }` vs `{ unsupported }`; test all kinds. The actual
fetch/toBlob stays in the shell.

## 3. Background: `translateRegion` (crop → provider → remap)

New message (flag the contract change):

```ts
translateRegion: {
  request: {
    imageUrl?: string;          // http(s)/data — background fetches
    imageBytes?: ArrayBuffer;   // blob/canvas — content acquired (item 2)
    imageMime?: string;         // required with imageBytes
    crop: BBox;                 // normalized, full-image space (item 1)
    targetLang?: string;
    requestId?: string;         // same cancellation contract as translatePage
  };
  response: TranslatePageResult; // reuse — never rejects (rule 6)
};
```

Handler (suggested `background/regionHandlers.ts`, wired into the router next
to `createTranslateHandlers`):

- Resolve bytes: `imageUrl` → `fetchImageBytes` (existing); `imageBytes` →
  `new Blob([bytes], { type: imageMime })`. Exactly one of the two must be
  present — anything else is a `network`-kind failure result.
- **Crop prep** — same split as `prepareImage`: a pure, tested planner
  `planRegionCrop(naturalW, naturalH, crop, maxEdgePx)` → integer source rect
  (`sx, sy, sw, sh`) clamped to the image, plus output dims long-edge-capped
  at `maxEdgePx` (never upscaled), rejecting crops smaller than ~16 px on a
  side after clamping (returns null → `malformed`-style failure with a "
  selection too small" message). The browser shell decodes → one
  `OffscreenCanvas` draw with the source rect → JPEG at `jpegQuality`, white
  underlay first (Phase 2.1's alpha rule). No tiling — a selection is one
  region by construction; an extreme-aspect selection just gets the long-edge
  cap. // WHY-note.
- **The crop is a tile**: build the `TranslateJob` with
  `tileOffset: crop` and the crop-blob's hash — the existing
  `remapBboxFromTile` path in ProviderBase then lifts the provider's
  crop-local bboxes back into full-image space with zero new remap code. The
  overlay renders them on the full image untouched.
- **`TranslateJob.isRegion?: boolean` — the ONE flagged `shared/types.ts`
  change.** ProviderBase threads it into the prompt build; `prompt.ts` appends
  the PROMPTS §4.3 user-text suffix verbatim ("This is a cropped region of a
  comic page selected by the user. …") when set. Do NOT bump `PROMPT_VERSION`:
  the shared page-prompt strings are untouched, so cached page translations
  stay valid; the suffix only exists on never-cached region requests.
  // WHY-note at the constant.
- **No caching, no coalescing** for region requests: identity would be the
  crop bytes' hash, and two hand-drawn rects are never pixel-identical, so a
  cache entry would never be hit again — skip `cacheLookup`/`cacheStorePage`/
  negative caching entirely. // WHY-note. Everything else reuses Phase 4
  plumbing: run through the shared `PriorityQueue` at **priority 0** (a user
  gesture is the most urgent thing we have), register the `AbortController`
  in the same `requestControllers` map so the existing `cancelTranslation`
  message covers regions too, record usage (`recordUsage(usageFromPage(page,
  1))` — F17 must count region calls), and map failures through
  `errorToTranslateResult`.

🧪 *Tests:* `planRegionCrop` — clamping to image bounds, integer px, long-edge
cap, never-upscale, too-small rejection, degenerate crop (zero-area after
clamp). Prompt: `buildUserText` (or its context) with the region flag appends
the §4.3 suffix, without it output is byte-identical to today (pin that —
it is the PROMPT_VERSION-stability guarantee). Handler wiring with mocked
provider/fetch: url-path happy case, bytes-path happy case, both/neither
sources → failure result, cancellation via `cancelTranslation`, usage
recorded, cache functions NEVER called (spy).

## 4. Rendering region results

Reuse `OverlayManager` wholesale — it does not care whether the scanner
registered a candidate:

- On send, synthesize a one-off `Candidate` (`id: "region-<uuid>"`, `el` = the
  target element, `url` = its source or `"region:"` marker), call
  `overlay.setPending(candidate)`, and on the result `render`/`setError`
  exactly like the viewport queue does (including the `aborted` → silent-clear
  convention and the 120 s timeout guard — copy the small pattern, or extract
  it if trivial).
- Position sync, resize re-paint, watermark/SFX filters, textFit, teardown on
  `!el.isConnected` all come for free. `onImageGone` firing `scanner.scan()`
  with an unknown id is harmless (the registry reconcile no-ops).
- A repeated selection on the same image creates a SECOND overlay entry
  stacked on the first — accepted for v1 (regions only collide if the user
  re-selects the same area); note it in PROGRESS.md. If the image already has
  a full-page translation, the region entry simply layers on top — do not try
  to merge into the cached page (render-time-only data, same principle as the
  watermark filter never mutating the cache).

🧪 *Tests:* none new beyond item 1's pure math — this item is thin composition.
If you extract the shared send-with-timeout pattern, its tests move/extend, not
duplicate.

## 5. Peek-original (F14)

Two peek surfaces, both driven by the same overlay repaint:

- **Hover peek**: one document-level passive `mousemove` listener (only while
  the gate is active AND at least one `done` overlay exists), rAF-coalesced
  like the position sync. Hit-test the pointer against the painted bubble
  rects; the hovered bubble re-renders showing `region.original` (plus a
  subtle visual cue — e.g. a dashed outline — so users know it's the source
  text); leaving restores. **No `pointer-events` changes anywhere** — manga
  readers page-forward on image clicks, and a bubble that eats clicks breaks
  them (§7.2). Geometric hit-testing is the whole point. // WHY-note.
- **Toggle-all peek**: new manifest command `peek-original` (suggested
  `Alt+Shift+O`) → background `commands.onCommand` → `sendToTab` a new
  `togglePeekOriginal: { request: void; response: void }` message (flag it) →
  OverlayManager flips a `peekAll` flag and repaints every `done` entry.
  Toggling off restores; `deactivate()` resets the flag.

Implementation shape: thread a per-entry peek state (`peekAll ||
hoveredRegionIndex`) into `paint`/`renderBubbleBox` so the label text is
`original` instead of `translated` — a repaint re-runs textFit, which is
REQUIRED (the original is often CJK and fits differently; a text swap without
re-fit overflows). // WHY repaint, not textContent swap.

Pure core (suggested `overlay/peek.ts`):
- `hitTestRegion(pointPx, paintedRects[])` → region index or null; when rects
  nest/overlap, smallest area containing the point wins (the tighter bubble is
  the intended one).
- The peek-state reducer: (peekAll, hoveredIndex, event) → which entries need
  repaint — so "no repaint when nothing changed" is a tested property, not a
  hope (mousemove fires constantly; repaint only on enter/leave transitions).

🧪 *Tests:* hit-test in/out/edge/nested-smallest-wins; reducer — hover
enter/leave repaint exactly the affected entry, mousemove within one bubble
repaints nothing, peekAll on/off repaints all `done` entries, deactivate
resets. Keyboard/mouse listeners stay shell.

## 6. Error toasts (auth / rate-limit)

Badges (Phase 5) mark the failed image; toasts make the two *actionable*
failures visible without hunting for a badge:

- One toast host per page (own shadow root, `position: fixed`, bottom corner,
  `pointer-events: none` EXCEPT the toast card itself — its ✕ and its action
  button are the interactive bits §7.2 allows). Auto-dismiss ~8 s + manual ✕.
- **Pure toast policy** (tested): given an `errorKind` and the set of kinds
  already toasted this activation → `show | skip`. Only `auth` and
  `rate-limit` toast; everything else stays badge-only; each kind toasts at
  most ONCE per activation (10 images failing auth must not stack 10 toasts —
  the set resets on gate re-activate, so fixing the key and re-enabling gives
  fresh signal). Reuse `errorKindToMessage` for the body text.
- The `auth` toast carries an "Open settings" action. Content scripts cannot
  call `runtime.openOptionsPage()` — add message `openOptionsPage: { request:
  void; response: void }` (flag it) with a one-line background handler.
- Wire-in point: the viewport queue's existing `setError` path (and item 4's
  region errors) additionally consults the toast policy — keep the overlay
  badge exactly as is.

🧪 *Tests:* policy — auth shows once then skips, rate-limit independent of
auth, network/malformed/refusal/unknown never toast, reset-on-reactivate.
Handler wiring: `openOptionsPage` calls the browser API (fake-browser spy).

## 7. Commands + popup entry point

- `src/manifest.ts` gains two commands: `select-region` (suggested
  `Alt+Shift+S`) and `peek-original` (`Alt+Shift+O`), descriptions via i18n
  (item 8). Firefox has no 4-command ceiling; 3 total is fine.
- `background/settingsHandlers.ts` already owns the `commands.onCommand`
  listener (kept out of index.ts because fake-browser lacks
  `browser.commands`) — extend it: the two new commands
  `tabs.query({ active: true, currentWindow: true })` → `sendToTab` the new
  `startRegionSelect` / `togglePeekOriginal` messages. // WHY no "tabs"
  permission needed: querying and messaging by tabId are permission-free;
  only reading `tab.url` needs activeTab/tabs, and we don't here.
- New message `startRegionSelect: { request: void; response: { started:
  boolean } }` (flag it). Content router (registered at bootstrap next to
  `translateAll`, same inert-safety argument): while inert → `{ started:
  false }` and nothing happens; while active → enter selection mode. A
  send to a tab with no content script (about:, AMO pages) rejects — the
  background command handler swallows that (fail soft).
- Popup: a "Select region" row/button — discoverability for the shortcut. It
  sends `startRegionSelect` to the active tab, then `window.close()` so the
  popup isn't covering the page during the drag. When the response is
  `{ started: false }` (site disabled / extension off), show the existing
  status-line hint instead of closing. Pure popup logic goes in
  `popupLogic.ts` like everything else there.

🧪 *Tests:* content router responds `{started:false}` while inert /
`{started:true}` + mode entered while active (jsdom or seam); popupLogic
decision for the button state (disabled while `!effectiveEnabled`).

## 8. i18n scaffolding

Scaffolding — the mechanism plus the strings this phase touches, NOT a full
retro-migration:

- `public/_locales/en/messages.json` (vite copies `public/` verbatim into the
  build; verify the plugin includes it — adjust if it needs to live elsewhere)
  with the manifest strings, command descriptions, error messages, toast
  strings, and the new Phase 7 UI strings.
- `src/manifest.ts`: `default_locale: "en"`; `name` →
  `"__MSG_extensionName__"`, `description` → `"__MSG_extensionDescription__"`,
  command descriptions likewise.
- `shared/i18n.ts`: `t(key, substitutions?, fallback?)` wrapping
  `browser.i18n.getMessage`, returning `fallback ?? key` when the API is
  unavailable (node tests) or returns empty (missing key). Same defensive
  pattern as `localeTargetLang` in settings.ts. // WHY fallback-first: pure
  logic modules (errorMessages.ts) call `t()` and their existing tests keep
  asserting real English text, not key soup.
- Convert `overlay/errorMessages.ts` to `t(key, undefined, englishFallback)` —
  its totality test keeps passing untouched because the fallback IS today's
  string.
- **Explicitly deferred to Phase 8** (note in PROGRESS.md): migrating the
  existing popup/options static HTML strings (needs a `data-i18n` walker pass
  — mechanical, better batched with the Phase 8 AMO-listing prep).

🧪 *Tests:* `t()` — returns the message when the API provides one, fallback on
empty/missing, key when no fallback, substitution passthrough (fake-browser
stubs `i18n.getMessage`; guard like settings.ts if it doesn't).

## Manual verification (append results to PROGRESS.md; needs a real browser + key)

1. Build, load, grant image access, set a key (or use the Phase 6 options UI),
   enable on `tests/fixtures/testpage.html` (served over http).
2. `Alt+Shift+S` (and the popup button): crosshair overlay appears; Esc exits;
   a tiny click-drag exits without a request; a real drag over a manga page
   shows the pending skeleton then bubbles ONLY inside the drawn rect, aligned
   to the full image (remap correct). Scroll mid-drag — the anchored corner
   stays glued to the page content.
3. Drag-select on the `<canvas>`/`blob:` fixture (add one to the test page if
   needed) — translation works without the background ever fetching (network
   panel), proving the bytes path.
4. Hover a translated bubble — original text appears, leaves on mouse-out;
   clicks still reach the page underneath. `Alt+Shift+O` flips every bubble;
   again restores.
5. Break the API key → exactly ONE "check your API key" toast per activation
   (many images can fail); its button opens options; badges still per-image.
   Fix the key → the Phase 5.1 gate re-request recovers the page.
6. Toggle MangaLens off mid-selection — the crosshair overlay, toasts, and
   peek state all vanish; the page is untouched.
7. `about:addons` → Manage Extension Shortcuts shows all three commands with
   localized descriptions; extension name/description render (not `__MSG_…__`).

## Explicitly out of scope (do NOT build)

- Screenshot-capture fallback (`tabs.captureVisibleTab`) for tainted
  canvases/auth-walled images — P2, noted in §7.3; the toast copy covers it.
- Auto-translate (scanner acceptance) of `blob:`/`<canvas>` sources — the
  fallback is drag-select only.
- Prefetch tuning, multi-page batching (F12), priority re-prioritization,
  scroll-away cancel, endpoint-mode persistence, popup/options string
  migration, `data_collection_permissions` — **Phase 8**.
- Export/import (F16), reading-direction bubble ordering (F18), local pipeline
  (F20), inpainting — stretch.
- Any change to the caching of full-page translations.

## Definition of done

- `npm run check` green — all 354 existing tests stay green untouched (except
  where an item explicitly extends a module's behavior).
- `npm run build` clean; `npm run lint:ext` 0 errors / 0 warnings (the
  `data_collection_permissions` notice remains, Phase-8-deferred).
- Contract changes flagged in the PROGRESS.md paragraph: `shared/types.ts`
  `TranslateJob.isRegion` (the ONE pre-authorized rule-4 exception),
  `shared/messages.ts` `translateRegion` / `startRegionSelect` /
  `togglePeekOriginal` / `openOptionsPage`, manifest commands +
  `default_locale`. Anything beyond these: stop and flag before building.
- `PROMPT_VERSION` is untouched (item 3's stability test pins it).
- PROGRESS.md gets the Phase 7 summary paragraph in the existing house style:
  what was built, design choices flagged (no region caching, stacked region
  overlays, hover-peek via geometric hit-test with zero pointer-events
  changes, bytes-over-message Firefox note, i18n deferral), deferrals, test
  counts, and the manual-verify results.
