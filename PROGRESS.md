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

## Phase 3 summary (provider layer)

Landed the whole `providers/` layer plus the end-to-end translate path that
Phase 2 deferred. **One flagged contract change** (handoff rule 4): added
`readingDirection` to `ProviderSettings` (mirrors `Settings.readingDirection`)
and to `deriveProviderSettings`, because the prompt needs the reading-order slot
and `derive` is the only bridge — no other `shared/types.ts` shape moved.
`providers/prompt.ts` is the pure prompt layer (PROMPTS.md): the canonical JSON
schema as a typed constant with three dialect converters derived from it —
`toGeminiSchema` (strips `additionalProperties`), `toOpenAiStrictSchema` (adds
`kind` to `required` + a `"none"` enum member, strips `minimum`/`maximum`/
`minItems`/`maxItems` that strict mode rejects), `toAnthropicToolSchema`
(canonical as-is) — plus the verbatim §3 `SYSTEM_PROMPT_TEMPLATE` with
`{{slot}}` filling (`buildSystemPrompt`/`buildUserText`/`buildPromptContext`),
`languageName` (curated map → `Intl.DisplayNames` → raw code; region tags like
`zh-TW` kept in parens), and the honorifics/reading-order slot text. Change any
of these strings ⇒ bump `PROMPT_VERSION`. `providers/ProviderBase.ts` holds (a)
the typed `ProviderError` (`kind` from the §6 taxonomy: `auth`/`rate-limit`/
`malformed`/`network`/`aborted`/`refusal`/`unknown`, carrying `status` +
`retryAfterMs`) with `mapHttpError`/`parseRetryAfter`; (b) the **pure, exported
response pipeline** (`extractJsonObject` → outermost-brace trim that also drops
```json fences/commentary, `parseModelJson`, `validatePageShape`, `sanitizePage`
= clamp bboxes to [0,1] + drop degenerate (`w*h<0.0001`)/whole-page (`>0.9`)/
empty-original regions + dedupe IoU>0.85 identical-original + `>30%`
missing-translation ⇒ throw `malformed`, `normalizeSourceLang` (jpn→ja, ja-JP→ja,
und kept), `normalizeKind` (5 spec kinds + `other`; `none`/unknown → undefined/
`other`), `parseBbox` (array or object form)); and (c) the abstract
`ProviderBase implements Translator` engine — base64-encode the tile, HTTP with
**rate-limit backoff** (2s/8s/30s ladder, honours `retry-after`), a **one-shot
malformed→repair retry** (re-runs with a "return only JSON" nudge), a **400
`downgrade` hook**, refusal short-circuit, abort guards, and tile→full-image
bbox remap via `remapBboxFromTile` when `job.tileOffset` is set. All timing/HTTP
seams (`fetchFn`/`sleep`/`backoffMs`) are constructor-injected so backoff is
tested without real waits. Four adapters implement only request-shape +
envelope-extraction: `gemini.ts` (default; `responseSchema` +
`systemInstruction`, `x-goog-api-key` header, `finishReason`/`blockReason` →
refusal), `openai.ts` (also the base for custom + OpenRouter; `json_schema`
strict, `message.refusal`/`content_filter` → refusal, and the `json_schema`→
`json_object` **downgrade ladder** on a 400 mentioning `response_format`, pasting
the schema into the system prompt), `openrouter.ts` (OpenAI base URL + `HTTP-
Referer`/`X-Title`), `anthropic.ts` (forced `emit_translation` tool-use →
`tool_use.input` parsed directly, `anthropic-dangerous-direct-browser-access`
header, `stop_reason:"refusal"`). `providers/factory.ts` `createProvider` maps a
`ProviderId` to the class (custom → OpenAI wire format at the user's endpoint;
throws if custom has no endpoint). `background/translateHandlers.ts` wires the
`translatePage` message end-to-end (fetch → `prepareImage` → per-tile hash +
`translatePage` → `mergeTilePages`) and is now live in the router; split like
imagePrep into a **pure, tested `mergeTilePages`** (concat + `dedupeRegions`
across tile overlap zones, first non-`und` source lang wins, token sums) and a
**thin untested `translateImage`** driver (needs `OffscreenCanvas`, same env
reason `prepareImage` is untested). **Design choices flagged:** (1) the §6.4
repair uses the provider-agnostic "re-run at temperature-0 with a nudge" variant,
not the "text-only cheap fix call" — structured-output providers rarely emit
malformed JSON, so the simpler general path is preferred; the fix-call variant is
a noted later refinement. (2) The §9 watermark post-filter (drop edge `sign`
regions matching a domain regex) is deferred to the overlay layer (Phase 5),
where image-edge proximity is unambiguous (a middle tile's edge isn't the page
edge). (3) Multi-page batch (PROMPTS §4.2) stays deferred with F12 — the
`Translator` interface is one-image-per-call, so batching is a queue concern
(Phase 8); batch golden fixtures deferred with it. **Deferred to Phase 4:** the
IndexedDB cache (cache-first + negative cache on failure) and the priority/
concurrency queue — `translateHandlers` currently runs each request immediately
and ignores `priority`; the merged page's `imageHash` is the original bytes'
digest (composed with targetLang/model/`PROMPT_VERSION` later). `testApiKey` stays
deferred to the options UI (Phase 6). The background bundle grew to ~25 kB as the
provider + Phase-2 pipeline modules are now reachable from the live handler
(previously tree-shaken). Tests: 67 new across 5 files (pipeline/golden 9 fixture
files incl. fenced/trailing/out-of-range/whole-page/duplicate/empty; ProviderBase
engine: happy path, tile remap, auth/abort guards, HTTP error mapping, refusal,
rate-limit ladder + `retry-after` + give-up, malformed repair + propagation;
per-provider request shape + extraction + refusal + downgrade; factory;
prompt slots/dialects/lang-names; mergeTilePages), 145 total green; typecheck +
eslint + build + `web-ext lint` (0 errors / 0 warnings; the lone
`data_collection_permissions` notice stays Phase-8-deferred) all clean.

## Phase 3.1 summary (review fixes)

A review of Phase 3 against Architecture/PROMPTS plus current provider API
behavior caught two would-be-broken-in-production bugs, several spec
deviations, and cleanups; all fixed. (1) **Anthropic on current models was
dead**: the adapter sent `temperature` unconditionally, but Claude 4.6+ models
(Opus 4.7/4.8, Sonnet 5, Fable 5) removed sampling params and 400 on them —
only older models like the default `claude-haiku-4-5` still accept them. Fix:
a provider-specific `downgrade` pass (the hook was generalized from
OpenAI-only) strips `temperature` on a 400 naming a sampling param and
memoizes the model in a module-level set (learn-on-400 beats a hardcoded list
that goes stale; one wasted 400 per model per event-page lifetime). (2)
**Error kinds died at the message boundary**: `runtime.sendMessage` serializes
a rejected `ProviderError` down to its message string, so the §6 taxonomy
(auth/rate-limit/refusal/… → UI messaging) could never reach the Phase 5
content script. **Flagged contract change** (messages.ts, zero consumers yet):
`translatePage` now resolves with a `TranslatePageResult` union — `{ok:true,
page}` | `{ok:false, errorKind, message}` — and the handler never rejects
(fail-soft, rule 6); pure `errorToTranslateResult` maps ProviderError kinds
1:1 and ImageFetchError reasons to `aborted`/`network`. (3) **tokensIn/Out
were never populated** (F17 cost tracker starved; mergeTilePages summed
always-undefined): `ProviderOutput` gained an optional `usage`, all three
envelope extractors now pull provider token counts (OpenAI `usage.*_tokens`,
Anthropic `usage.input/output_tokens`, Gemini `usageMetadata.*TokenCount`),
and `finish` stamps them on the PageTranslation. (4) **Repair retry now runs
at temperature 0** per PROMPTS §6.4 (was: user's temperature) — `BuildContext`
carries a per-request `temperature`, `undefined` meaning "omit the field". (5)
**529 (overloaded) joins the 429 backoff ladder** instead of failing instantly
as `network` — it's the canonical retry-with-backoff status. (6) **retry-after
is capped at 60s** (`MAX_RETRY_AFTER_MS`) so a hostile/buggy header can't
stall a job for an hour. (7) **Webtoon tiles now translate in parallel**
(`Promise.all`; §7.5 — a 10-tile strip was paying 10× serial latency; 429/529
backoff self-limits until the Phase 4 queue adds the global concurrency cap).
(8) **OpenAI downgrade mode is remembered per endpoint** (PROMPTS §5.2) in a
module-level map — the §5.2 "persist in settings" part needs the options
surface and is deferred to Phase 6; both memos expose `reset*` test seams. (9)
`TranslatePageRequest.priority` now flows through to the jobs (was hardcoded
0). (10) Reuse/dead code: new dependency-free `shared/guards.ts` owns
`isPlainObject`/`isAbortError` (previously triplicated across settings.ts /
imageFetcher.ts / ProviderBase.ts — importing from settings.ts would have
dragged the polyfill into provider tests, hence the new module);
`normalizeKind`'s redundant branches and `languageName`'s unreachable ternary
arm collapsed; stale "fast path" comment fixed. Also verified against current
API docs: `claude-haiku-4-5` is a valid model alias, `anthropic-version:
2023-06-01` is current, and first-party Anthropic does NOT need
thinking-disabled for forced tool_choice (that's Bedrock-only) — no changes
needed there. Tests: 12 new (usage passthrough + per-provider extraction;
temperature on primary/0-on-repair; 529 retry; retry-after cap; anthropic
sampling-400 strip + memo; openai endpoint-mode memo; errorToTranslateResult
kind mapping ×3), 157 total green; typecheck + eslint + build + `web-ext lint`
(0/0) all clean.

## Phase 4 summary (cache + queue + cost tracker)

Landed the three background infrastructure modules and wired them into the
translate path. **No `shared/types.ts` change** (handoff rule 4) — cache/queue/
cost types are module-local, since nothing across a context boundary needs them
yet (the popup/options read them in Phase 6). One new dependency (`idb@8`,
Architecture §4's named IndexedDB wrapper) and one additive constant
(`shared/constants.ts` `CACHE_VERSION`). Each module follows the repo's
pure-core-plus-thin-shell split. `background/cache.ts` (F13, §7.3): the tested
pure core is `buildCacheKey` (composite `imageHash|targetLang|model|p<PROMPT_
VERSION>` so the same bytes under a different language/model/prompt never
collide), `estimatePageBytes` (UTF-8 byte length of the serialized page +
fixed record overhead — the size cap is a soft budget), `classifyCacheLookup`
(`miss|hit|negative|expired`), `shouldNegativeCache` (**only** `malformed`/
`refusal` are cached — PROMPTS §6.5; transient `auth`/`rate-limit`/`network`/
`aborted` stay retryable), and `planEviction` (drop expired negatives first,
then evict least-recently-accessed until under the byte cap). The **thin,
untested `idb` shell** (`cacheLookup`/`cacheStorePage`/`cacheStoreNegative`/
`evictToCap`/`clearCacheForSite`/`clearAllCache`) opens a `CACHE_VERSION`-named
DB (a value-shape change retires the whole store at once, distinct from
`PROMPT_VERSION` which is folded into each key), indexes `origin` for O(site)
per-site clear (F15) and `lastAccess` for eviction scans, and wraps **every**
operation so an IndexedDB fault degrades to "no caching", never a failed
translation (rule 6); negative entries carry a 10-min TTL (`NEGATIVE_TTL_MS`).
Untested for the same env reason as `prepareImage` — IndexedDB doesn't exist in
the Node test runtime. `background/queue.ts` is fully browser-free and tested:
`PriorityQueue` runs lowest-priority-number first (0 = visible, §7.5), FIFO
within a priority (insertion-seq tiebreak), caps in-flight jobs at a runtime-
adjustable `concurrency`, and propagates abort two ways — a queue-wide signal
rejects all queued + in-flight jobs, a per-job signal rejects just that job, and
every task is invoked with a *merged* signal so running work (e.g. `fetch`) can
cancel itself. Opt-in retry-with-backoff exists (`maxRetries`, injectable
`sleep`/`backoffMs` seams) but **defaults to 0 in the translate path** — the
provider layer already owns the 429/529 backoff ladder, and retrying here would
double it (WHY noted in-source). `background/costTracker.ts` (F17): pure
`estimateRequestCost` (from a **ballpark** `PRICING` table, VERIFY-AT-BUILD-TIME
per §3), pure immutable `addUsage` accumulator, `usageFromPage`,
`emptyCostStats`; persistence over `storage.local` (never `sync`, §7.6) via
`getCostStats`/`recordUsage`/`resetCostStats`, fail-soft and healing corrupt
stored values to zero. **Wiring** (`translateHandlers.ts`, now cache-first +
queued): `translateImage` fetches (HTTP-cache-reused) → hashes the original
bytes → `buildCacheKey` → `cacheLookup`; a **hit returns instantly** (§7.5
"<50 ms", never enters the queue), a **live negative re-throws the cached
`ProviderError`** so the UI messaging path is identical, and a miss enqueues the
extracted `translatePrepared` (prep → per-tile provider calls → `mergeTilePages`)
through the single module-level `PriorityQueue` at the request's priority. On
success the page is cached (`cacheStorePage`, which then evicts to the cap) and
its tokens recorded (`recordUsage`); a `malformed`/`refusal` failure is
negatively cached. The image `origin` (for per-site clear) is derived from the
message `sender.url`. **Design choices flagged:** (1) the concurrency cap bounds
*images* in flight; tiles within one strip still fan out in parallel (§7.5,
bounded by tile count) rather than sharing the global cap — a later refinement if
strip fan-out proves too aggressive. (2) Per-site clear stores a single `origin`
per content-hash entry (an image reused across sites keeps its first origin) —
acceptable because caching is content-hash-keyed and images are effectively
site-specific; noted in-source. **Deferred:** `translateImage`/`translatePrepared`
stay untested (browser-only: OffscreenCanvas + IndexedDB) with all their
decisions delegated to tested pure helpers; `clearCacheForSite`/`clearAllCache`/
`getCostStats`/`resetCostStats` are exported and ready but only wired into the
options UI in Phase 6 (cache management + cost display); `testApiKey` stays
Phase 6; prefetch tuning and multi-page batching (F12) stay Phase 8. Manual
verify: load in Firefox, translate a page twice — the second render is instant
(cache hit, no provider call in the network panel); the popup cost figure only
moves on the first. Tests: 43 new (cache 18: key composition/isolation, UTF-8
size estimate, lookup classifier, negative-cache policy, LRU+TTL eviction;
queue 13: concurrency cap, priority+FIFO ordering, per-job/queue-wide/running
abort, add-after-abort, retry ladder + give-up + no-retry-on-abort, bookkeeping;
costTracker 12: pricing/accumulate/immutability/usageFromPage + storage round-
trip/reset/corrupt-heal), 200 total green; typecheck + eslint + build +
`web-ext lint` (0 errors / 0 warnings; the lone `data_collection_permissions`
notice stays Phase-8-deferred) all clean.

## Phase 4.1 summary (review fixes)

A review of Phase 4 against Architecture §7.3–§7.6 caught four correctness bugs,
four robustness gaps, and three cleanups; all fixed. **P1 (correctness):** (1)
**Cost lost-update race** — `recordUsage` did an unserialized read-modify-write,
so at the default concurrency 6 two near-simultaneous finishes both read the same
totals and one page's tokens vanished; all cost writes now serialize through a
module-level promise chain (`enqueueWrite`; `recordUsage` + `resetCostStats` each
append and await their own link, and a failed link can't poison the chain — the
per-link try/catch keeps it fail-soft). (2) **Tiled pages under-reported images**
— `translatePrepared` now returns `{ page, providerCalls }` (the tile count = the
number of provider image requests) and the driver passes it to
`usageFromPage(merged, providerCalls)`, so a webtoon strip's `images` count is
finally accurate; `ProviderCostStats` JSDoc clarified (`calls` = pages/events,
`images` = provider requests, the figure that tracks cost for strips). (3)
**Cache key built from the raw (often empty) model string** — the provider
actually runs `settings.model || defaultModel`, so factory-default settings keyed
under `""` while the request used e.g. `gemini-2.0-flash` (stale hits after a
default bump; needless re-translation when a user picks the model that *is* the
default). Introduced one source of truth — `DEFAULT_MODELS` in `ProviderBase.ts`,
consumed by all four adapters *and* a new pure `resolveEffectiveModel`
(`factory.ts`) — and the cache key now uses the resolved model. (4)
**Prompt-shaping settings missing from the key** — `buildCacheKey` now composes
`{provider}|{imageHash}|{targetLang}|{model}|h{0|1}|d{rtl|ltr|auto}|s{hint|-}|p{ver}`,
folding in the provider id (also kills same-model cross-provider collisions) and
the honorifics / reading-direction / source-lang-hint slots that change the
prompt (PROMPTS §3/§4/§7); free-text segments are `encodeURIComponent`-ed so a
model id containing `|` can't collide; `temperature` is deliberately excluded
(continuous knob, WHY-noted). **Flagged (rule 4):** this goes beyond the
Architecture F13 key spec, but it's the same staleness bug `PROMPT_VERSION`
exists to prevent; still background-module-local, no `shared/types.ts` change.
**P2 (robustness):** (5) `getDb` now clears the memo on a *rejected* open, so one
transient IndexedDB fault no longer disables caching for the whole event-page
lifetime. (6) **Eviction no longer deserializes the whole store on every write**
— a new tiny `meta` object store holds a running `totalBytes`, maintained
transactionally on every put/delete/clear (pure `totalAfterPut`), so `evictToCap`
is O(1) when under cap and only walks the `lastAccess` index with a cursor
(oldest-first, pure `planLruEviction`) when over; the old `planEviction`/getAll
pass is retired, and the "expired first" sweep is dropped (expired negatives are
tiny and collected by the LRU walk + item 9, with `classifyCacheLookup`'s TTL
check remaining the correctness guard). This is a store-layout change, so
`CACHE_VERSION` is bumped **1 → 2**. (7) **In-flight coalescing** — a new pure
`coalesce(map, key, fn)` helper plus a module-level map keyed by cache key means
concurrent `translatePage`s for the same image (scanner + prefetch overlap,
duplicate scrolls, two tabs) share one provider run (F13); the abort-refcount
caveat for Phase 5's real cancellation is left as an in-source note, not built.
(8) On first open a fire-and-forget sweep deletes stale `mangalens-cache-v*`
databases (via `indexedDB.databases()`, FF126+; we require 128) so a
`CACHE_VERSION` bump doesn't strand the old (up-to-cap-sized) DB forever.
**P3 (cleanups):** (9) an `expired` `cacheLookup` fire-and-forgets a delete of the
dead negative entry (decrementing the total in the same tx); (10) `estimatePageBytes`
now uses `TextEncoder` instead of hand-rolled surrogate arithmetic; (11)
`cacheCapBytes` clamps to a 1 MB floor so a corrupt `cacheCapMb ≤ 0` can't make
every store evict the whole cache. **Left alone per the handoff:** queue retry
stays 0 in the translate path; fetch+hash stay outside the queue; the
negative-cache policy and `PRICING` ballpark are unchanged; the handler's unwired
`AbortController` and per-entry single `origin` remain Phase-5/accepted. **No
`shared/types.ts` change** (rule 4); the only `shared/*` change is
`CACHE_VERSION`'s value. Tests: 15 new/changed (coalesce 4: share/cleanup-on-
reject/independent-keys/sync-throw; resolveEffectiveModel 4: explicit/default/
custom-empty/key-equivalence; buildCacheKey rewritten to the 8-part format +
honorifics/hint encoding + per-field change detection + delimiter-proofing;
`totalAfterPut` 3 + `planLruEviction` 4 replacing `planEviction`; costTracker 3:
multi-tile `images` accumulation + concurrent-recordUsage serialization +
chain-not-poisoned), 215 total green; typecheck + eslint + build + `web-ext lint`
(0 errors / 0 warnings; the lone `data_collection_permissions` notice stays
Phase-8-deferred) all clean. *(Post-review tweak: `evictToCap` now re-reads the
running byte total inside its readwrite transaction — the read-only pre-check
stays for the O(1) under-cap fast path — so a concurrent put/delete landing
between the pre-check and the cursor walk can no longer be clobbered by the
absolute total written back; re-verified green.)*
