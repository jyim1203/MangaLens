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
