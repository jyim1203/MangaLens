# MangaLens — Build Progress

One paragraph per completed phase: what got built, what interfaces changed,
what's deferred.

## Phase 0 summary

Scaffolded the full dev loop: Vite + `@samrum/vite-plugin-web-extension`
building a Firefox MV3 extension (event page via `background.scripts` — the
plugin emits `background.html`; never switch to `service_worker`), strict
TypeScript, ESLint (flat config) + Prettier, Vitest with 6 passing unit tests,
and `web-ext lint` at 0 errors / 0 warnings. All four entry points are wired
and verified end-to-end: content script and popup both ping the background over
`runtime.sendMessage`. First shared modules landed: `shared/constants.ts`
(including `PROMPT_VERSION`, reserved for the cache key per gap resolution #4)
and `shared/log.ts` (scoped leveled logger, warn-threshold in prod builds).
Interface notes for later phases: `strict_min_version` had to be bumped to
**128.0** because `optional_host_permissions` requires it; the content script
is injected on `<all_urls>` but inert-by-default (gap resolution #7); in-flight
jobs will deliberately not persist across event-page unloads (gap resolution
#8). Deferred: everything functional — Phase 1 starts with drafting the full
`Settings` interface and typed message contracts (gap resolutions #5/#6),
adding `kind?: RegionKind` to `TranslatedRegion` (gap #2). Also deferred to
Phase 8: web-ext's informational notice recommending the (Nightly-only)
`data_collection_permissions` manifest key.

## Phase 1 summary

Landed the three contract modules. `shared/types.ts` is the single source of
truth for cross-boundary data: `BBox`, `TranslatedRegion` (now with
`kind?: RegionKind`, gap #2), `PageTranslation`, `TranslateJob`, the
`Translator` interface, `ProviderId`/`ProviderSettings`, and a
`ProviderErrorKind` taxonomy stub for Phase 3. `shared/settings.ts` defines the
full `Settings` schema (gap #5) with `DEFAULT_SETTINGS` (Architecture §11),
plus pure, browser-free helpers that carry all the logic — `mergeSettings`
(one-level deep merge so partial `font`/`apiKeys` blobs don't clobber
siblings), `migrateSettings` (versioned ladder; v0→v1 just stamps the version),
`getEffectiveEnabled` (global flag vs. per-site override, gap #7),
`deriveProviderSettings` — and thin `loadSettings`/`saveSettings` storage
wrappers (single `storage.local` key, never `sync`; target lang seeded from
locale on first run). Added a `DeepPartial<T>` so update patches can be
partial-nested. `shared/messages.ts` is the typed bus (gap #6): a central
`MessageMap` pairs each `type` with request/response shapes, and
`sendToBackground`/`sendToTab`/`createMessageRouter` are generic over it, so
senders and handlers can't drift. Router returns `undefined` for unhandled
types (lets co-existing listeners reply). Background and content entry points
were refactored off the ad-hoc `{type:"ping"}` onto the typed bus. Tests: 20
new (settings merge/migrate/effective-enabled/derive/round-trip;
message routing/payload/error-propagation/guards) via `@webext-core/fake-browser`
(new dev dep), 26 total green; typecheck + eslint + build + `web-ext lint`
(0/0) all clean.

**Reconstructed, not authoritative — revisit if the original gap resolutions
resurface:** the previous design conversation (the claude.ai share link) could
not be read back, so gap resolutions #2/#5/#6 were rebuilt from the summaries
above + Architecture/PROMPTS docs. Specifically unverified against the
original: the exact `RegionKind` members (`bubble | caption | sfx | other`) and
the precise `Settings` field set/shape. Both are easy to extend; flag on any
mismatch. Deferred to later phases: `translatePage`/`testApiKey` message
handlers (need the provider + pipeline layers), and wiring the enable-gate into
the content script (Phase 5). *(The `RegionKind` mismatch was real — resolved
in Phase 1.1 below.)*

## Phase 1.1 summary (contract fixes)

A review pass against the in-repo spec docs caught drift that the Phase 1
"reconstructed" warning anticipated; all fixed. (1) `RegionKind` now matches
the canonical prompt schema (PROMPTS.md §2) exactly — `bubble | caption | sfx
| sign | thought` — plus code-side `other`, the catch-all the Phase 3
sanitizer maps unknown provider values to (`sign` is load-bearing for the §9
watermark filter). (2) `ProviderErrorKind` gained `refusal` (PROMPTS.md §6
`ContentRefusalError`: "provider declined this image", never retried). (3) The
settings message handlers Phase 1 accidentally left unwired are live: new
`background/settingsHandlers.ts` implements `getSettings`/`setSettings`/
`toggleEnabled` plus a `settingsChanged` broadcast to all tabs
(`Promise.allSettled` — a dead tab never fails a save), and the Alt+Shift+M
command now really toggles. Kept separate from index.ts because fake-browser
doesn't stub `browser.commands`; the background is now the single settings
write path (also serializes popup/options writes). (4) New deletion
convention: `SettingsPatch` (now the `setSettings` payload type) allows `null`
entries in the open-keyed records (`perSiteOverrides`/`apiKeys`/`models`)
meaning "delete this entry" — previously the one-level merge could only
add/overwrite, so per-site overrides and stored API keys were undeletable.
`null` in fixed-shape objects (`font`) heals to the base value; top-level
`null` is ignored; nulls are never persisted. (5) Content script is now fully
inert — the Phase 0 liveness ping woke the background event page on every page
visited; removed. Phase 5 note recorded in content/index.ts: gate via direct
`storage.local` read + `storage.onChanged` (doesn't wake the event page), not
messaging. Tests: 6 new (null-delete merge/persist; handler round-trips;
toggle; broadcast fan-out with a rejecting tab — fake-browser's
`tabs.sendMessage` is a throw-stub, mocked via spy), 32 total green; typecheck
+ eslint + build + `web-ext lint` (0/0) clean.

## Phase 2 summary (image acquisition pipeline)

Landed the three background pipeline modules — all bytes work happens in the
event page, never the content script (§7.3 CORS-taint bypass). No changes to
`shared/types.ts` (handoff rule 4); tile geometry reuses the existing `BBox`.
`background/hash.ts` is `sha256Hex(Blob | ArrayBuffer | ArrayBufferView)` over
WebCrypto (`globalThis.crypto.subtle`, present in both the event page and the
Node test runtime) → the 64-char hex `imageHash` that keys the cache; it hashes
a typed-array view's own window (respects `byteOffset`/`byteLength`), and the
*composite* key (hash + targetLang + model + `PROMPT_VERSION`) is deliberately
left to Phase 4 `cache.ts`. `background/imageFetcher.ts` fetches image bytes by
URL with `credentials: "include"` + `cache: "force-cache"` (mirror how the page
loaded the image; reuse the HTTP-cached bytes), gated to http/https/data/blob
schemes, capped at `MAX_IMAGE_BYTES` (40 MB), and surfaces a typed
`ImageFetchError` with an `ImageFetchReason` taxonomy (`bad-url` /
`unsupported-scheme` / `http-error` (carries `status`) / `empty` / `too-large` /
`not-image` / `network` / `aborted`) so callers fail soft (rule 6); HTML/JSON
bodies (auth walls, soft-404s) are rejected as `not-image`, and a missing
content-type falls back to the sniffed `blob.type`. `background/imagePrep.ts` is
split into a **pure, exhaustively-tested math layer** and a **thin browser
canvas driver**: `computeDownscaledSize` (long-edge cap, never upscales, integer
px, §7.5), `isLongStrip` (h/w > `LONG_STRIP_RATIO` = 3, §7.4), `computeTiles`
(uniform tile-height windows — first flush at y=0, last **pinned to the image
bottom** so there's no wasted sliver, adjacent overlap ≥ nominal `overlap ×
tileHeightPx` so coverage has no gaps; emits a normalized `offset` BBox per
tile), `remapBboxFromTile` (lift a provider's tile-local bbox back into
full-image space, the inverse of tiling, §7.4), `iou`, and `dedupeRegions`
(drop tile-overlap duplicates, keep higher confidence). Defaults live as
exported constants (`DEFAULT_TILE_HEIGHT_PX` 1024, `DEFAULT_TILE_OVERLAP` 0.1,
`LONG_STRIP_RATIO` 3, `TILE_DEDUPE_IOU` 0.5, `OUTPUT_MIME` `image/jpeg`). The
browser-only `prepareImage(blob, opts)` is the small untested shell:
`createImageBitmap` → `computeDownscaledSize` → `computeTiles` → per-tile
`OffscreenCanvas` (draw the whole scaled bitmap shifted up by `yStartPx` so the
canvas clips the band, avoiding source-rect rounding drift) → `convertToBlob`
JPEG at `jpegQuality`, closing the bitmap in a `finally`; a normal page yields
one full-image tile, a webtoon strip yields several overlapping ones. **Design
choices flagged:** (1) dedupe uses the Architecture §7.4 rule (IoU > 0.5, keep
higher confidence) rather than the PROMPTS §4.4 "farther from the cut edge"
heuristic — simpler, operates on already-remapped tile-agnostic regions, noted
in-source as a possible later refinement; (2) `prepareImage` is not unit-tested
because `OffscreenCanvas`/`createImageBitmap` don't exist in the Node/jsdom test
env — the untested surface is kept minimal and all its logic is in the tested
pure helpers. Deferred: the `translatePage` handler that wires fetch→prep→hash
→provider stays unbuilt (Phase 3 needs the provider layer), so nothing imports
these three modules yet and they tree-shake out of the current build — expected;
composite/negative cache keying lands in Phase 4. Tests: 39 new (hash 6:
known-answer vectors + cross-representation stability + view-window; imageFetcher
10: happy path + every reason branch + sniff fallback, global `fetch` stubbed;
imagePrep 23: downscale/strip/tiling geometry, remap, IoU, dedupe), 71 total
green; typecheck + eslint + build + `web-ext lint` (0 errors / 0 warnings; the
lone `data_collection_permissions` notice stays Phase-8-deferred) all clean.

## Phase 2.1 summary (review fixes)

A review of Phase 2 against Architecture §7.4/§7.5 caught one critical bug and
three hardening gaps; all fixed. (1) **Strip-crush bug**: `prepareImage` applied
the long-edge cap to the whole image before tiling, so an 800×20000 webtoon
(long edge = height) would have been shrunk to 48×1200 — §7.5's "max 1200 px on
the long side" is *per tile* for strips. The fix extracts a new pure planner,
`planPrep(naturalW, naturalH, opts) → PrepPlan` (strip flag, scale, scaled dims,
tile layout): normal pages keep the long-edge cap, strips are **width-capped
only** and tiled, with tile height clamped to `maxEdgePx` so every emitted tile
honours the per-tile cap even when the user's cap is below the 1024 default.
`prepareImage` is now an even thinner shell (decode → `planPrep` → render), and
all scaling/tiling decisions are unit-testable — the regression case is pinned
in a test. (2) JPEG has no alpha, so transparent PNG pixels encoded as black;
`renderTile` now fills white before drawing. (3) `imageFetcher` rejects an
oversized `content-length` header *before* buffering the body (the authoritative
`blob.size` check stays as the backstop for lying/absent headers). (4)
`jpegQuality` is clamped to [0, 1] — out-of-range is "unspecified" per the
canvas spec and would silently fall back to the encoder default. Also noted
in-source: `blob:` URLs stay fetch-allowed but page-created ones will fail
cross-context as a plain `network` error (fail-soft; §7.3 screenshot capture is
the eventual fallback). Tests: 7 new (planPrep 6: normal-page cap, strip
regression, wide-strip width cap, tile-height clamp, non-strip tall page,
degenerate guard; imageFetcher 1: content-length pre-check ordered before the
body read), 78 total green; typecheck + eslint + build + `web-ext lint` (0/0)
all clean.
