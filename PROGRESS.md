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

## Phase 5 summary (content script: scan + overlay — first end-to-end)

Landed the whole content-script pipeline (scan → viewport queue → background →
provider → overlay) plus the real per-request cancellation the Phase 4 in-source
note deferred — the first phase where the extension does anything user-visible.
Every module keeps the repo's pure-core / thin-shell split: observers, Shadow-DOM
manipulation, and layout reads live in untested shells, and every *decision*
(gate classification, candidate scoring, priority tiers, geometry, text fitting,
watermark/SFX filtering, abort refcounting) is a pure, browser-free, unit-tested
function. **One flagged contract change** (handoff rule 4 — `shared/messages.ts`
only, NO `shared/types.ts` change): `TranslatePageRequest` gained optional
`requestId?: string` (content generates `crypto.randomUUID()`), and a new
`cancelTranslation: { requestId } → void` message. **New dev dependency**
`jsdom` (the one DOM-walker test opts in via `// @vitest-environment jsdom`; the
suite default stays `node`).

**Item 1 — enable gate (`content/gate.ts` + `content/index.ts` rewrite):** the
gate is a pure reducer `computeGateAction(prev, settings, hostname) → activate |
deactivate | restyle | re-request | no-op` (+ `activeAfter`), so idempotence
(enable twice = once) and the restyle-vs-re-request classification are testable
without a DOM. `re-request` fires when a *cache-key-affecting* setting changes
(provider/model/customEndpoint/targetLang/sourceLang/readingDirection/honorifics,
compared via `deriveProviderSettings`); `restyle` fires for font + `translateSfx`
(render-time only); it dominates when both change. `index.ts` is a thin
composition root: it reads settings with a raw `storage.local` get healed by the
**pure** `migrateSettings` (NOT `loadSettings` — a content script on every page
must never write storage, and a storage read doesn't wake the event page),
gates on `getEffectiveEnabled`, and watches `storage.onChanged` (area local, key
`SETTINGS_KEY`). It deliberately does NOT register a `settingsChanged` handler
(storage.onChanged is strictly more reliable; both firing would double-handle —
WHY-noted so Phase 6 doesn't "fix" it). Teardown is total (scanner → queue →
overlay, in that order): observers disconnected, overlay hosts removed, every
in-flight request cancelled.

**Item 2 — `scanner.ts`:** pure `isCandidate` (rendered ≥ 180² px, natural ≥ 400
px on one side, aspect unconstrained so webtoon strips pass) + `scoreCandidate`
(rendered area × horizontal-centeredness so a big centered page beats a sidebar
thumbnail) + `classifyImageUrl` (http/https/data accept, **blob skipped** — a
blob URL can't be fetched cross-context, §7.3; Phase 7 covers it) + `parseCssUrl`.
The thin shell walks `<img>` (`currentSrc` → `src`) and CSS `background-image`
hosts, reconciles a registry each scan (dedupe unchanged, re-register on in-place
`src` swap — firing onRemoved+onAdded so the stale overlay is dropped, prune
gone elements), and drives re-scans off a debounced MutationObserver
(childList+subtree, `src`/`srcset`/`style` attrs) + `popstate`. WHY no
`history.pushState` monkey-patch: patching page globals from an isolated world is
the host-page interference rule 6 forbids; the MutationObserver already catches
the soft-nav DOM swap. Metrics read through an injectable seam so the walk is
jsdom-testable (jsdom does no layout). **Scoping flagged:** `<canvas>` and
`blob:` sources are skipped (Phase 7 drag-select/screenshot path); background
hosts use rendered size as a natural-size proxy (no intrinsic size without
loading — safe, only stricter).

**Item 3 — `viewportQueue.ts`:** pure `planEnqueues` — (count, changed index +
tier, already-requested set, prefetchAhead) → the exact `{index, priority}` list
(the changed page at tier 0/1; on *visible*, N+1..N+prefetchAhead at priority 2;
skip requested; never past the end). The shell runs two IntersectionObservers
(rootMargin `0` → priority 0; `100%` → priority 1), sends
`sendToBackground("translatePage", { imageUrl, priority, requestId })`, and wires
the result to the overlay (`ok` → render, `aborted` → silent clear, else error
badge). **No priority upgrade** for an already-sent request (the queue has no
re-prioritize API and a duplicate would coalesce anyway — WHY-noted, revisit
Phase 8). A generous 120 s timeout wraps the await (gap #8 — a dead event page
would otherwise wedge the requested-set entry forever; on timeout it returns to
"unrequested" so a later visibility retries). Doc order is maintained via
`compareDocumentPosition` so prefetch neighbours are correct.

**Item 4 — real cancellation:** `background/sharedAbort.ts` is a pure abort
refcounter — the coalesced run owns one `AbortController`; each waiter registers
its external signal; the underlying aborts only when *every* waiter has aborted
(a no-signal waiter is permanently live; late registration after settle is a
no-op). `translateImage` now creates/reuses one `SharedAbort` per cache key
(leader creates + owns teardown, followers reuse it — leadership decided
synchronously so there's no map desync), passing `shared.signal` to the run
instead of the first caller's signal; `coalesce()` itself is untouched. The
`translatePage` handler registers its `AbortController` under `requestId` in a
module-level map (removed in `finally`); `cancelTranslation` aborts+removes it
(unknown/settled id = silent no-op). Content sends `cancelTranslation` on
teardown/disable (all outstanding) and on element-removed / `src`-swap — **not**
on scroll-away (visible→near→visible thrash would cancel work we're about to
want; prefetched results fill the cache anyway — WHY-noted). Hardening:
`errorToTranslateResult` now maps any raw abort (`isAbortError`) to `aborted`, so
a queue-level pre-run cancel stays silent instead of showing an `unknown` badge.

**Item 5 — overlay (`overlay/OverlayManager.ts` + pure helpers):** one host per
translated image appended to **`document.body`** (WHY not a sibling: inserting
into the reader's tree mutates its layout — rule 6) with an **open** shadow root
(debuggability; closed buys nothing). Styles injected as `<style>` into each
shadow root only (never the page). Position: `absolute`, `getBoundingClientRect`
+ `scrollX/Y`, synced by ONE shared passive scroll/resize listener pair, a
`ResizeObserver` per image, and the image's `load` event; `!img.isConnected`
during sync tears the overlay down and asks the scanner to reconcile (cancels the
request). The **one bbox→px conversion** (rule 5) is pure `regionToPx` (degenerate
0-size rect → all-zero, no NaN). States: pending (shimmer skeleton), done
(BubbleBoxes), error (⚠ badge with a title from the pure, total
`errorKindToMessage`; `aborted` → renders nothing). **Watermark post-filter**
(PROMPTS §9, deferred here from Phase 3) + **SFX filter** (F19) are pure
`filterRegions`, applied at render time and **never mutating the cached page** (a
`sign` within 2% of an edge whose original/translated text matches the page
hostname or a URL/domain regex is dropped; middle signs, edge captions, and
edge signs with non-URL text are kept).

**Item 6 — `overlay/textFit.ts` + `overlay/BubbleBox.ts`:** pure `fitTextSize`
(binary search for the largest integer px whose wrapped text fits, via an
injected measurer) + `resolveFontSize` (fixed mode bypasses; empty text → 0;
never-fits clamps to min and lets `overflow: hidden` crop). BubbleBox is the thin
DOM shell: a positioned box with a separate fill layer (opacity without fading
text, and no CSS-color parsing), centered auto-fitted text, 6% padding, optional
`paint-order: stroke` + `-webkit-text-stroke` (with a text-shadow fallback),
horizontal regardless of source direction. The DOM measurer reads an offscreen
shadow-root element's scroll size.

**Item 7 — test page:** `tests/fixtures/testpage.html` is self-contained — the
images are hand-authored **public-domain SVG data-URI placeholders** (normal
page, background-image page, extreme webtoon strip, ignored icon/avatar, and a
2 s late-`src`-swap to exercise the MutationObserver), so scanning / ignore
heuristics / positioning / tiling / mutation all work with zero binary fixtures.
`tests/fixtures/images/README.md` documents dropping real public-domain manga
JPGs there for a true provider round-trip. **Flagged:** no binary image fixtures
were added (can't fetch/fabricate manga art here); the SVG placeholders cover the
structural end-to-end, real OCR/translation needs the README's manual step.

**Design choices flagged (recap):** body-append open-shadow hosts; no priority
upgrade; no scroll-away cancel; blob/canvas scoping to Phase 7; background-image
natural-size proxy; render-time watermark filter that never rewrites the cache;
leader/follower shared-abort refcount; storage-read (non-waking) gate with no
content-side `settingsChanged` handler. **Deferred:** drag-select / peek-original
/ toasts (Phase 7); popup/options UI, in-flow permission request, cost/cache
surfaces, `testApiKey` (Phase 6); prefetch tuning, priority re-prioritization,
multi-page batching, scroll-away cancel (Phase 8). A mid-session `prefetchAhead`
change is currently a no-op (takes effect on next activate) — accepted, noted.

**Manual verification (not executed here — needs a real browser + API key):** the
handoff's §"Manual verification" steps are ready to run against
`tests/fixtures/testpage.html` served over http (`npx serve tests/fixtures`),
with the optional host permission granted and a key set from the background
console; enable via Alt+Shift+M and check overlays land on the two manga pages +
strip (not the icons), track on resize, render instantly on reload (cache hit,
no provider call), and vanish/return cleanly on toggle. This is the first phase
whose pipeline is browser-runnable; the automated suite covers every pure
decision, but the live provider round-trip is a manual step by nature.

Tests: 69 new across 9 files (sharedAbort 6, gate 13, scanner 12, viewportQueue
6, overlayGeometry 3, overlayFilter 12, overlayMessages 4, textFit 9,
translateHandlers +4: abort mapping + cancel/unknown-id/registry-removal wiring),
**284 total green**; typecheck + eslint + build + `web-ext lint` (0 errors / 0
warnings; the lone `data_collection_permissions` notice stays Phase-8-deferred)
all clean. Content bundle grew from inert to ~14 kB (scanner + queue + overlay +
inlined `styles.css`).

## Phase 5.1 summary (review fixes)

A review of the Phase 5 content-script pipeline against Architecture §7.1/§7.2/
§7.5 and real-page behavior caught two correctness bugs, four robustness/UX gaps,
and two cleanups; all fixed, keeping the pure-core / thin-shell split (every new
*decision* is a tested pure helper; observers/DOM/layout reads stay shell-thin).
**P1 (correctness):** (1) **Overlay bubbles went stale on resize** — `positionEntry`
only moved the host; the BubbleBoxes inside stayed at paint-time pixel offsets, so
a window resize/zoom/re-flow misaligned every overlay. Each `OverlayEntry` now
tracks its last-painted displayed size and a `done` overlay re-paints (re-running
textFit per region — required so `auto` re-fits and `fixed` doesn't visually
scale, WHY a re-paint not a CSS transform-scale) when the size changed beyond an
epsilon; the decision is the pure `displayedSizeChanged` (geometry.ts). While in
there, all position syncs (shared scroll/resize listeners + every per-image
`ResizeObserver` + `load`) now **coalesce through one `requestAnimationFrame`** —
one rect read + style write per entry per frame instead of per event, which also
throttles the ResizeObserver-loop repaint churn during a continuous drag-resize.
(2) **Host mispositioned when `<body>` is a containing block** — `left/top = rect +
scroll` assumed the initial containing block, which breaks under `position:
relative`/transform/filter on body or even the UA-default 8 px body margin.
`positionEntry` now measures the residual error (`host.getBoundingClientRect()` vs
the image rect) and subtracts it — robust to every cause at once and idempotent;
with the rAF batching the extra rect read is once per frame. **P2 (robustness/
UX):** (3) **Unhandled rejection in the coalesce leader's cleanup** — the leader
tore down its `SharedAbort` with `void run.finally(cleanup)`, and `.finally()`
returns a NEW promise that re-rejects; every failed coalesced run fired an
`unhandledrejection` in the event page (console noise + AMO-review flag) even
though `await run` handled the real rejection. Now `run.finally(cleanup).catch(()
=> {})` swallows only the derived promise; cleanup still runs on both paths. (4)
**Scanner re-scan feedback loop + starvation** — the MutationObserver watched
`style` document-wide and the OverlayManager writes overlay-host `style` on every
scroll sync, so scrolling scheduled an endless self-triggered re-scan; the pure
`isOwnOverlayHost` (matches the new `OVERLAY_HOST_ATTR` marker) drops bursts that
are entirely our own hosts. The trailing-edge debounce could also starve forever
on a perpetually-animating inline style, so a **max-wait ceiling** (pure
`computeRescanDelay`: quiet → 250 ms trailing, continuous → forced within ~1 s)
now guarantees late-added images are found. And `defaultCollectElements` reads the
rect and skips sub-`MIN_RENDERED_PX` elements **before** calling `getComputedStyle`
(the expensive pass on a 10k-element DOM). (5) **API-key change must re-request** —
`translationSignature` excluded `apiKey`, correct for cached successes but wrong
for failures: after an `auth` error, entering a correct key was a gate no-op
(nothing recovered until reload). `apiKey` is now in the signature, so a key change
while active classifies as `re-request` — errored pages retry while cached
successes re-render instantly (the key is NOT part of the cache key). This unblocks
the Phase 6 first-run path (auth badges → paste key → recover). (6) **Retry path
never retried a statically-visible image** — on the 120 s timeout (or send-failure)
the entry reset to unrequested, but IntersectionObserver fires only on
*transitions*, so an image sitting still in the viewport was wedged until scrolled
away and back. After the reset it now `unobserve()`+`observe()`s both observers
(observe always delivers an initial entry with the current intersection state),
re-planning/re-sending if still visible; the same treatment covers an `aborted`
result arriving while still registered. The request timeout is now injectable
(`requestTimeoutMs`) so this is testable without a 2-minute fake-timer wait.
**P3 (cleanups):** (7) removed the **dead score sort** in `scan()` (the viewport
queue re-inserts every candidate into document order via `insertInDocOrder`, so
registration order had zero effect); `scoreCandidate` stays exported + tested with
a JSDoc note that it's reserved for the §7.1 main-image ranking (Phase 7). (8)
**Bootstrap race** (`content/index.ts`): a `storage.onChanged` firing while the
initial `readSettings()` was awaiting could be applied then clobbered by the
staler initial read; the newest raw value is now buffered and re-applied after the
initial apply (newest-wins). **Double stroke** (`BubbleBox.ts`): the text-shadow
halo was applied *alongside* `-webkit-text-stroke`, so Firefox (which supports the
prefixed property) rendered stroke + halo, thickening the outline; the shadow is
now gated on `!CSS.supports("-webkit-text-stroke", …)` (memoized). **Flagged/
accepted (item 9, noted in-source, not built):** the ms-wide cache-store race
(re-pays at most one provider call — noted at the `cacheStorePage` site);
offscreen prefetch skeletons; the 120 s timeout vs. Phase-6 "translate all" (revisit
with Phase 8 queue tuning); the standing Phase 5 deferrals (no scroll-away cancel,
no priority upgrade, no blob/canvas sources, no mid-session `prefetchAhead`).
**No `shared/types.ts` or `shared/messages.ts` change** (rule 4); the only
`shared/*` change is the new `OVERLAY_HOST_ATTR` constant (a DOM marker string,
not a data contract). **Manual re-verify (needs a real browser):** resize/zoom the
window — overlays track and re-fit; add `position: relative` + margin to `<body>`
— overlays stay aligned. Tests: 16 new/changed (overlayGeometry +5:
`displayedSizeChanged` beyond/within-epsilon/undefined-prev/zero-size/custom-eps;
scanner +5: `computeRescanDelay` trailing/ceiling/clamp + `isOwnOverlayHost`
host/non-host; gate +3: apiKey re-request while active / no-op while inactive /
non-active-provider-key ignored; viewportQueue +2: timeout re-observes + re-sends,
aborted-while-registered resets; translateHandlers +1: failed coalesced run leaves
no unhandled rejection and still cleans up the shared-abort map), **300 total
green**; typecheck + eslint + build + `web-ext lint` (0 errors / 0 warnings; the
lone `data_collection_permissions` notice stays Phase-8-deferred) all clean.

## Phase 6 summary (UI: popup + options)

Landed the real popup and options pages — F1/F2/F5/F8/F9/F15/F17 all get their
user-facing surface — plus the background/content plumbing the UI needed
(`testApiKey`, cost reset, translate-all, cache stats). **Stack decision:**
vanilla TS + static HTML skeletons, no Preact/lit-html (Architecture §4 offers
either) — the repo is framework-free everywhere else and the surface is small;
instead the house pure-core / thin-shell split carries the weight: every
*decision* lives in browser-free, unit-tested `popupLogic.ts` /
`optionsLogic.ts`, and each `main.ts` only reads state, renders it, and
forwards events.

**Flagged contract changes (handoff rule 4 — `shared/messages.ts` + manifest,
NO `shared/types.ts` change):** (1) `testApiKey`'s request gained
`customEndpoint?` (a custom provider has no fixed URL to ping) and its
`provider` field is now spelled `ProviderId` directly. (2) New `resetCostStats`
message — WHY not a direct `resetCostStats()` import in options: cost WRITES
serialize through costTracker's per-context promise chain, and a second
writing context would reintroduce the Phase 4.1 lost-update race; reads stay
direct. (3) New `translateAll` message (popup → content tab) with a `dryRun`
mode so the popup can count before committing (Risks table: confirm >30
pages). (4) `manifest.permissions` gained **`activeTab`** — the popup's
per-site toggle and translate-all need the active tab's URL/hostname, which is
hidden without it; activeTab is granted by opening the popup and carries no
install-time warning (unlike `tabs`). **Shared-module moves (re-exported, no
caller churn):** `DEFAULT_MODELS` → `shared/constants.ts` (UI placeholders
need it; importing ProviderBase would drag the whole prompt layer into the
popup bundle), the curated language map → new `shared/languages.ts`
(prompt.ts re-exports `languageName`; new `languageOptions(current?)` appends
an uncurated stored value so the dropdown never lies), plus new
`shared/format.ts` (`formatUsd`/`formatBytes`/`formatTokens`) and
`PROVIDER_LABELS` in constants. `shared/settings.ts` gained `peekSettings()` —
the read-that-never-writes (raw get + pure migrate) the popup/options/content
all use so only the background ever persists settings (content/index.ts's
private copy was replaced with it).

**Key test (§7.6, `providers/keyTest.ts`):** cheaper than the architecture's
"1-token ping" — a token-free *authenticated GET* per provider (gemini/openai/
custom: `/models`; anthropic: `/v1/models` with the `anthropic-dangerous-
direct-browser-access` header; openrouter: `/key`, because its `/models` list
is public and would bless any garbage key). Pure `buildKeyTestRequest` +
`classifyKeyTestResponse` (Gemini reports a bad key as **400** `API_KEY_INVALID`,
not 401 — mapped to `auth`; 429/529 report "key authenticated but throttled/
out of quota" rather than pretending the key is bad; 5xx → `network`), thin
`runKeyTest` that NEVER rejects (a rejection would be serialized to a bare
string at the message boundary — same reasoning as `TranslatePageResult`) and
aborts via `AbortSignal.timeout` (15 s). Wired into the background router with
the one-line `resetCostStats` handler; `cache.ts` gained a read-only
`getCacheStats()` (entry count + the running `totalBytes`).

**Translate-all (F8):** `viewportQueue.requestAll(dryRun)` fills in every
registered-but-unrequested candidate at the new `TRANSLATE_ALL_PRIORITY` (2 —
already-visible pages keep their better tier; `sendTranslate` flips
`requested` synchronously, so double-clicks can't double-send), and
content/index.ts registers a `translateAll` router at bootstrap. WHY that
doesn't break inert-by-default: a passive `onMessage` listener touches nothing
on the host page and sends nothing (unlike the removed Phase 0 liveness ping);
while inert there's no queue and the popup just gets `{count: 0}`. It is NOT
the forbidden content-side `settingsChanged` listener — settings still arrive
exclusively via `storage.onChanged`.

**Popup:** global toggle (via `toggleEnabled`), per-site tri-state
(default/on/off; "default" null-deletes the override), target language,
provider + model quick-pick (model placeholder = the provider default; empty
input null-deletes so the default reapplies), translate-all with an **inline**
two-click confirm above 30 pages (WHY not `window.confirm`: modals from a
browser-action popup are unreliable in Firefox — focus loss closes the popup),
a cost line, and two setup banners: missing API key (→ options) and the §7.3
**in-flow `<all_urls>` grant** — `permissions.request` must run in a
user-gesture handler in an extension page, so the popup is where the
architecture's "requested on first use" actually lives. Reads never wake the
event page (`peekSettings` + direct `getCostStats`); all writes go through
`setSettings`/`toggleEnabled` messages; `storage.onChanged` live-refreshes
both settings and the cost line while open.

**Options:** per-provider rows generated from `PROVIDER_IDS` — masked key
inputs that **rest empty with the mask as placeholder** (WHY: the stored key is
never round-tripped into the DOM in full, so it can't be shoulder-surfed or
leak via autofill/session-restore; Clear does the null-delete), per-row Test
buttons (a typed-but-unsaved key wins over the stored one, so users can test
before saving), per-provider model inputs, and the custom row carrying its
endpoint field; translation prefs (honorifics **select** keep/localize mapped
onto the stored boolean, reading direction, SFX toggle, source pin,
temperature); font controls with a live preview that mimics BubbleBox's
separate fill layer (opacity never fades the text); per-site rules table with
per-row **Clear cache** (direct `clearCacheForSite` — extension pages share
the background's origin so it's the same IndexedDB, and cache ops are
transactional) and Remove; numeric fields bound generically via `data-num`
attributes to a `NUMERIC_FIELDS` bounds table (WHY explicit clamps: a typo'd
`jpegQuality: 70` or `concurrency: 600` must not wreck uploads/perf;
`numericFieldPatch` is an exhaustive switch because four fields live under
`font` and a computed key wouldn't typecheck), with the min ≤ max auto-fit
guard (`sanitizeFontBounds` — the edited bound drags the other); the F17 usage
table + reset (via the message); cache panel + clear-all; and a permissions
panel with grant/revoke. Garbage numeric input reverts to the stored value;
re-renders skip the focused control so `storage.onChanged` can't clobber
mid-typing.

**Design choices flagged:** (1) UI pages read storage/IndexedDB directly
(never write) — reads don't wake the event page and don't race the write
chains; every write crosses the message bus. (2) PROMPTS §5.2's "persist the
endpoint downgrade mode in settings" is **re-deferred to Phase 8**: the
in-memory memo already saves all but one 400 per event-page lifetime, and
persistence would couple the provider layer to storage (or need a
learn-callback seam) for marginal value — noted in openai.ts. (3) `activeTab`
over `tabs` (no permission warning). (4) The `pagesPerRequest` field ships
with a "takes effect when batching ships (Phase 8)" hint rather than being
hidden. **Deferred:** drag-select, peek-original, error toasts, UI i18n
(Phase 7); batching, prefetch tuning, endpoint-mode persistence (Phase 8).

**Manual verification (needs a real browser):** load the build, open the
popup on `tests/fixtures/testpage.html` — flip the toggle, set a site rule,
watch the status line; grant image access from the banner; paste a key in
options and Test it (wrong key → auth message; right key → "✓ Key works");
translate-all queues the fixture pages and the popup cost line moves;
usage/cache panels fill in and their reset/clear buttons zero them; resize
the options window with a rule list present — nothing clobbers a focused
input.

*(The always-visible setup banners this list would have caught were found in
the Phase 6.1 review below — the popup banner logic was correct but the CSS
made `hidden` inert.)*

Tests: 54 new (keyTest 17: per-provider request shape, custom endpoint
normalization/missing, classifier incl. the Gemini 400 quirk + 429 wording +
snippet, shell happy/empty-key/bad-endpoint/network/body-read, handler wiring;
popupLogic 9: site tri-state round-trip incl. null-delete, hostnameFromUrl
web/non-web, statusLine, needsApiKey active-provider-only, cost summary,
confirm threshold; optionsLogic 17: numeric parse/clamp/round/garbage,
value↔patch round-trip for every field, font-bounds guard, key mask/patches,
hostname normalization, site rules, honorifics mapping, costRows; format 9:
usd/bytes/tokens incl. healing + languageOptions curated/appended;
viewportQueue +2: requestAll dry-run counts without sending, real run sends
the remainder at priority 2 and is idempotent), **354 total green**; typecheck
+ eslint + build + `web-ext lint` (0 errors / 0 warnings; the lone
`data_collection_permissions` notice stays Phase-8-deferred) all clean. Popup
bundle ~5 kB + shared chunks; options ~13 kB; background grew ~1 kB (keyTest).

## Phase 6.1 summary (review fixes)

A user-reported review of the Phase 6 UI caught one rendering bug with two
victims, plus one UX addition; the pure logic layer needed no changes. **The
bug — `hidden` was inert wherever author CSS set `display`:** the HTML `hidden`
attribute is implemented by the UA stylesheet as `display: none`, and ANY
author `display` rule on the same element overrides a UA rule regardless of
specificity. (1) The popup's `.banner { display: flex }` made BOTH setup
banners permanently visible — "No API key for this provider." showed even with
a valid, tested key stored for the active provider (the reported symptom), and
"Image access not granted." showed even after the grant — `els.bannerKey.hidden
= !needsApiKey(settings)` was computing the right value into a dead property.
(2) The options page's `.field { display: grid }` did the same to the
fixed-size / auto-fit font rows: both were always visible instead of swapping
with the size-mode select. Fix: a `[hidden] { display: none !important; }`
reset in both pages' stylesheets (WHY-noted in each), which is the standard
defense and future-proofs any later `display`-styled element. The other
`hidden` consumers (grant/revoke/clear buttons, the empty-state `.hint`
paragraphs) carried no author `display` rule and were already working —
verified by grep, not assumption. **UX addition (user request):** both popup
banners now carry a ✕ dismiss button; dismissal is popup-instance-scoped (a
module-level `dismissed` flag checked by `render`/`renderPermissionBanner`,
never persisted — the banners are state-driven and should return on the next
open while their condition holds). **Verified clean in the same pass:** the
options key save path (change-commit → `apiKeyPatch` → single-write-path
`setSettings`; Clear's null-delete), the typed-but-unsaved-key-wins test flow,
`keyTest` request shapes + classifier, `needsApiKey`/`deriveProviderSettings`,
the `translateAll` popup↔content round trip and `requestAll` idempotence, and
the fresh `loadSettings()` per translate request (no stale-settings path to
the ProviderBase "No API key configured" throw). Tests: none new — the fix is
CSS plus two lines in the untested thin shell, with nothing decidable to
extract; **354 total green**; typecheck + eslint + build + `web-ext lint`
(0 errors / 0 warnings; the lone `data_collection_permissions` notice stays
Phase-8-deferred) all clean. **Manual re-verify (needs a real browser):** with
a valid key stored, the popup shows no key banner; remove the key → banner
returns and ✕ dismisses it for that popup instance; in options, switching Font
sizing between auto/fixed swaps the two rows.

## Phase 7 summary (drag-select fallback + peek + toasts + i18n)

Landed the "universal fallback" phase: click-and-drag region translation (F10),
peek-original (F14), the two actionable error toasts, the new keyboard shortcuts,
and i18n scaffolding for the extension chrome. After this a user can translate
text on ANY image — including the `blob:`/`<canvas>` sources the scanner
deliberately skips — and gets an actionable nudge when a key is bad or a provider
throttles. Every module keeps the pure-core / thin-shell split.

**Flagged contract changes.** (1) `shared/types.ts`: `TranslateJob` gained
optional `isRegion?: boolean` — the ONE pre-authorized handoff-rule-4 exception.
ProviderBase threads it into `buildUserText({ region })`, which appends the
PROMPTS §4.3 suffix verbatim (new exported `REGION_SUFFIX`); `region:false` is
byte-identical to the pre-Phase-7 message, so **`PROMPT_VERSION` is untouched**
(pinned by a test) and cached page translations stay valid — the suffix only
exists on never-cached region jobs. (2) `shared/messages.ts`: four new messages
— `translateRegion` (crop → provider, reuses `TranslatePageResult`),
`startRegionSelect` (`void → {started}`), `togglePeekOriginal`, `openOptionsPage`.
(3) `src/manifest.ts`: two commands (`select-region` Alt+Shift+S, `peek-original`
Alt+Shift+O), `default_locale: "en"`, and `name`/`description`/command
descriptions switched to `__MSG_*__`. **No other `shared/types.ts` change.**

**Item 1/2 — `content/regionSelect.ts` (F10).** Pure, tested rect math:
`normalizeDragRect` (any drag direction), `selectionToImageBbox` (page-space
selection → normalized crop clipped to the image; browser zoom cancels because
both rects are CSS px), `isClickNotDrag`/`MIN_DRAG_PX` (a sub-8-px drag is an
escape), `pickTargetImage` (largest intersection wins), plus the byte-acquisition
*decision* `sourceKindForUrl` + `acquisitionPlan` (`http`/`data` → send URL;
`blob`/`canvas` → send bytes; else unsupported). The thin shell is a full-viewport
`position:fixed` **open-shadow** crosshair host (the FIRST deliberately-interactive
surface on a host page — the §7.2 exception), `setPointerCapture` so a drag
leaving the window still finishes, Esc-to-cancel, one-shot teardown, and — the
load-bearing detail — the drag anchor stored in **page coordinates** so a mid-drag
scroll doesn't shift the selection (the §8 "scrolled pages" case; the marquee
redraws from `lastClient + scroll` on scroll). Byte acquisition (shell) reads a
`blob:` via `fetch(currentSrc)` and a `<canvas>` via `toBlob()` (a tainted canvas
throws `SecurityError` → "can't access this image" notice), shipping an
`ArrayBuffer` over `runtime.sendMessage`. // WHY Firefox-only-safe: structured
clone carries the ArrayBuffer intact; a future Chrome port (JSON messaging) would
need base64. The scanner does NOT start accepting blob/canvas — the fallback is
drag-select only.

**Item 3 — `background/regionHandlers.ts`.** `translateRegion` resolves bytes
(URL → `fetchImageBytes`; bytes → a `Blob`; both/neither → a `network`-kind
failure), crops via the new pure `planRegionCrop` (integer source rect clamped to
the image, long-edge-capped, no upscale, rejects < 16 px → "selection too small"
`malformed`) + the browser shell `prepareRegionCrop` (one `OffscreenCanvas`
source-rect draw, white underlay), and builds a job with `tileOffset: crop` +
`isRegion: true` so ProviderBase's existing `remapBboxFromTile` lifts crop-local
bboxes to full-image space with **zero new remap code**. Runs through the SAME
shared `PriorityQueue` (exported from translateHandlers) at **priority 0** (a user
gesture is the most urgent work), registers its `AbortController` in the SAME
`requestControllers` map (exported register/unregister helpers) so the existing
`cancelTranslation` covers regions, and records usage (F17, one image per crop).
**No caching / no coalescing** — two hand-drawn rects are never pixel-identical,
so a cache entry would never be hit again; cache functions are never imported into
the region path (proven by a spy test).

**Item 4/5 — overlay reuse + peek (F14).** Region results render through the same
`OverlayManager` via a synthesized one-off `Candidate` (`region-<uuid>`), so
position sync, resize re-paint, filters, textFit, and teardown come for free; a
repeated selection stacks a SECOND overlay entry (accepted for v1). Peek adds a
pure `overlay/peek.ts` — `hitTestRegion` (smallest-area containing rect wins on
nesting) and `peekRepaintTargets` (repaint ONLY on an enter/leave transition, so
constant mousemove is a tested no-op). The OverlayManager grew a document-level
passive `mousemove` (rAF-coalesced like the position sync), a `peekAll` flag
(`togglePeekOriginal` message), and per-entry `paintedRects` for hit-testing;
`BubbleBox` takes a `peek` flag that swaps to `region.original` with a dashed
outline. // WHY repaint (not a `textContent` swap): the original is often CJK and
fits differently, so textFit must re-run. **Zero `pointer-events` changes
anywhere** — page-forward-on-image-click still reaches the reader (§7.2); peek is
purely geometric.

**Item 6 — error toasts.** `content/toast.ts`: pure `toastPolicy` (only
`auth`/`rate-limit` toast, each at most once per activation — 10 images failing
auth ⇒ one toast; the set resets because a fresh `ToastManager` is built per
activate), and a thin shell (one bottom-corner shadow host, `pointer-events:none`
except the card's ✕ / action). The auth toast carries an "Open settings" action
→ the new `openOptionsPage` message (content can't call `openOptionsPage()`
itself). Wired into the viewport queue's `setError` path via a new
`onProviderError` hook and into the region controller's error path; per-image
badges are unchanged.

**Item 7/8 — commands, popup, i18n.** The `commands.onCommand` listener stays in
`background/index.ts` (where the toggle command already lived — the handoff's
"settingsHandlers owns it" was inaccurate about the current tree); its fan-out
helper `sendCommandToActiveTab` is extracted to `settingsHandlers.ts` so it's
testable without `browser.commands` (fake-browser lacks it). // WHY no `tabs`
permission: querying + messaging by tabId are permission-free. The content
bootstrap router (registered even while inert, same inert-safety as `translateAll`)
answers `startRegionSelect`/`togglePeekOriginal`; the popup gained a "Select
region…" button that sends `startRegionSelect` then `window.close()` (or shows a
hint if `{started:false}`), gated by the pure `regionSelectEnabled`.
`shared/i18n.ts` `t(key, subs?, fallback?)` reads `globalThis.browser?.i18n`
(NOT importing the polyfill — so pure modules calling `t()` need no test mock and
node tests get the English fallback); `overlay/errorMessages.ts` now routes
through `t(...)` with today's strings as fallbacks (its totality/wording tests
pass untouched). `public/_locales/en/messages.json` holds the manifest, command,
error, region, and toast strings (Vite copies `public/` → `dist/_locales`; verified
in the build, `web-ext lint` resolves every `__MSG_`).

**Design choices flagged:** (1) no region caching/coalescing (identity would be
the crop hash, never re-hit). (2) Stacked region overlays on repeat selection
(accepted v1). (3) Hover-peek via geometric hit-test with zero pointer-events
changes. (4) Bytes-over-message is Firefox-structured-clone-only (Chrome-port
note in-source). (5) `pickTargetImage` tie-breaks on plain rect area, NOT the
scanner's `scoreCandidate` (a bare `Rect` carries no viewport/centered metrics,
and the tie is a near-impossible edge) — `scoreCandidate`'s "reserved" JSDoc was
updated per the handoff's permission rather than forcing the scorer in. (6) A
too-small crop surfaces as a `malformed`-kind result (badge text is generic; the
carried message says "selection too small"). (7) The peek `mousemove` is attached
unconditionally in `overlay.start()` and early-returns when no `done` overlay has
painted bubbles (cheaper than add/remove churn per transition). (8) `withTimeout`
was extracted to `content/withTimeout.ts` (shared by the viewport queue and the
region controller). **Deferred (Phase 8, per the handoff):** screenshot-capture
fallback for tainted-canvas/auth-walled images (P2), auto-translate of
blob/canvas (fallback stays drag-select only), the popup/options static-string
i18n migration (needs a `data-i18n` walker), endpoint-mode persistence, prefetch
tuning/batching/scroll-away cancel, `data_collection_permissions`. The
`startRegionSelect`/`togglePeekOriginal` content-router wiring in `index.ts` stays
untested composition (like `translateAll`); the region selector + popup decision
+ command fan-out are all tested at their unit boundaries instead.

**Manual verification (NOT executed here — needs a real browser + key):** the
handoff's 7 steps are ready against `tests/fixtures/testpage.html` (served over
http), which now includes a same-origin (untainted) `<canvas>` fixture for the
bytes path: Alt+Shift+S / the popup button raises the crosshair; Esc and tiny
click-drags cancel without a request; a real drag over a page shows the skeleton
then bubbles ONLY inside the rect, aligned to the full image; scrolling mid-drag
keeps the anchor glued to the artwork; a drag over the `<canvas>` translates with
no background fetch (bytes path); hovering a bubble reveals the original and
clicks still reach the page; Alt+Shift+O flips every bubble; a bad key raises
exactly ONE toast whose button opens options; toggling off mid-selection clears
the crosshair, toasts, and peek; `about:addons` shows all three localized
shortcuts and the localized name/description.

Tests: **59 new** (i18n 7; regionSelect 15 — rect math incl. inverted-drag,
zoom-invariance, page-anchor-survives-scroll, target picking, source
classification + acquisition plan; peek 12 — hit-test in/out/edge/nested +
repaint-transition reducer; toast 4 — policy once-per-activation + independence +
non-actionable skip; regionHandlers 6 — url/bytes happy paths, both/neither
failure, too-small, cancellation via the shared registry, usage recorded, cache
never called; imagePrep +5 `planRegionCrop`; prompt +2 region-suffix +
byte-identical stability; providerBase +1 isRegion threading; viewportQueue +2
onProviderError hook; settingsHandlers +2 command fan-out + openOptionsPage;
popupLogic +2 regionSelectEnabled; constants +1 default_locale + command-drift),
**413 total green**; typecheck + eslint + build + `web-ext lint` (0 errors /
0 warnings; the lone `data_collection_permissions` notice stays Phase-8-deferred)
all clean. Content bundle grew ~14 kB → ~28 kB (region select + peek + toast +
i18n); background grew ~1 kB (regionHandlers).

## Phase 7.1 summary (review fixes)

A review of the Phase 7 drag-select / peek / toast implementation against
`docs/PHASE-7-HANDOFF.md`, Architecture §7.2/§7.3, and real-input behavior found
**no P1s** (the geometry, remap, caching-bypass, cancellation, and
prompt-stability cores are all correct) — five follow-ups, all fixed, keeping the
pure-core / thin-shell split. **No `shared/types.ts` or `shared/messages.ts`
change** (both untouched, as the DoD expected); `PROMPT_VERSION` untouched.

**(1) Region-select pointer state machine — cancel + identity guards
(`content/regionSelect.ts`, P2).** Three "weird but real input" gaps in the
marquee shell. (a) **No `pointercancel` handler → phantom selection**: if the
browser cancelled the pointer mid-drag (touch scroll/pinch takeover, the OS
stealing the pointer, capture loss), `pointerup` never arrived, `anchor` stayed
set, the marquee then followed a button-less mouse, and the NEXT plain click
finalized a selection the user thought was dead — an unintended paid request. Now
handled exactly like Esc (full `teardown()`; the mode is one-shot anyway),
WHY-noted because it is invisible in mouse-only testing. (b) **No primary/left
check**: `onPointerDown` anchored on ANY button, so a right-button drag started a
marquee under the native context menu — now `if (!e.isPrimary || e.button !== 0)
return;`. (c) **No pointerId identity on move/up**: with multi-touch a second
finger's `pointerup` (different `pointerId`) would finalize the FIRST finger's drag
at the wrong coordinates — move/up now ignore events whose `pointerId` doesn't
match the anchored one (reusing the id already stored for capture). The pure rect
math is untouched.

**(2) Stale hover-peek after toggling peek-all off
(`content/overlay/OverlayManager.ts`, P3).** While `peekAll` is on, `processPeek`
early-returns, so `peekHover` freezes at whatever bubble the pointer was over when
peek-all engaged; toggling peek-all OFF then repainted every done entry consulting
that frozen hover, leaving a bubble the pointer left long ago stuck on its original
for a keyboard-only user until the next mousemove re-ran the hit-test.
`togglePeekAll()` now resets `this.peekHover = null` (both directions, simplest),
so the next real mousemove re-establishes a live hover; WHY-noted that hover state
is unmaintained while peekAll is on.

**(3) Region request timeout abandoned the background job
(`content/regionSelect.ts`, P3).** On the 120 s `withTimeout` reject in
`translateCrop`, the catch deleted the `requestId` and cleared the overlay but
never cancelled — so a slow-but-alive event page kept running the provider call,
and because a region result is NEVER cached that orphan run was pure wasted spend
for a result nobody will render. The catch now fire-and-forgets
`cancelTranslation({ requestId })` (same pattern as `stop()`; a truly-dead event
page makes the unknown id a silent no-op per the existing contract).

**(4) Overlay host created for an already-removed image
(`content/overlay/OverlayManager.ts`, P3).** `ensure()` happily built a host for a
candidate whose element had left the DOM — the realistic path being a region result
rendering after the reader swapped/removed the image during the multi-second round
trip, appending an invisible zero-size host to `<body>` that only the next
scroll/resize sync reaps (never, if the page doesn't scroll). Guarded with
`if (!candidate.el.isConnected) return null;` (all callers already tolerate null);
matches `syncPositions`' disconnected⇒no-overlay convention and hardens the page
path's render-vs-removal race for free.

**(5) The handoff's item-7 router seam is now tested (tests).** The Phase 7 content
router shipped as untested composition (PROGRESS self-flagged it). The handler-map
construction is extracted from `content/index.ts` into a browser-free
`content/contentRouter.ts` — `buildContentRouterHandlers({ getQueue,
getRegionSelector, getOverlay })` — which now OWNS the inert-gate (the former
standalone `startRegionSelection`, which had no other caller, is folded in) so its
behavior is unit-testable without booting the whole content script (importing
`index.ts` runs `bootstrap()` + drags in the polyfill). `index.ts` stays a
composition root, passing getters over its module state. **Toast-reset pin — chose
the test, not the comment fallback**: a jsdom `toastManager.test.ts` proves a FRESH
`ToastManager` shows an auth toast again after a prior instance already did (the
per-activation reset that the pure `toastPolicy` test only implied), plus
dedupe-within-instance and `stop()` clearing the set.

**Reviewed and accepted as-is (noted, not built):** region prep running outside the
shared queue (human-paced drag gestures can't overwhelm decode); stacked-overlay
hover precedence breaking at the first containing entry (cross-entry precedence
accepted alongside v1 overlay stacking; smallest-wins still holds within an entry);
`object-fit: contain/cover` divergence (a shared pre-Phase-5 limitation of the
overlay renderer, not a Phase 7 regression); inner-container scroll mid-drag (WINDOW
scroll is handled — the §8 case); notice toasts not policy-deduped (immediate
per-gesture feedback by design, auto-dismiss 8 s); `defaultCollectTargets` dropping
the scanner's natural-size floor (deliberate — canvas/blob targets can lack an
intrinsic size, and a user-drawn rect is its own relevance signal); one
`getBoundingClientRect` per done entry per mousemove frame (rAF-coalesced, no
interleaved writes); and hover-peek repainting every region of the affected entry
(transitions are rare relative to mousemove and the repaint is rAF-driven).

**Manual verification — still outstanding (human step, NOT executed here).** The
Phase 7 DoD's 7 manual-verification steps (PHASE-7-HANDOFF.md §"Manual
verification") need a real Firefox, the built extension, and a live API key; they
should run AFTER this phase lands (item 1 changes drag behavior) against
`tests/fixtures/testpage.html` served over http, and the results recorded here when
done. Not faked or skipped — status left accurate.

Tests: **7 new** (contentRouter 4 — inert⇒`{started:false}`+selector-untouched,
active⇒`{started:true}`+`start()`-called, togglePeekOriginal no-op-while-inert vs
flip-while-active, translateAll count-0-while-inert vs forwarded-while-active;
toastManager 3 — fresh-instance re-shows / within-instance dedupe / `stop()` reset),
**420 total green**; the existing 413 stay green untouched; typecheck + eslint +
`vite build` clean; `web-ext lint` 0 errors / 0 warnings (the lone
`data_collection_permissions` notice stays Phase-8-deferred). No shell pointer/DOM
harness was added for items 1–4 (house style: those surfaces stay untested behind
WHY comments; a jsdom PointerEvent harness for item 1 would be contrived) — the
suite staying green plus the WHY notes is the house-style bar there. Content bundle
unchanged at ~28 kB (the factory extraction is size-neutral).

## Phase 7.2 summary (live-site fixes: blob pages, rate-limit cooldown, auto-translate opt-in)

The first live-browser verification (2026-07-10, Firefox release build, real
Gemini key, mangadex.org) produced three findings; this point-phase fixes all
three. **Two flagged contract changes** (handoff rule 3, both anticipated by the
handoff): `shared/messages.ts` `TranslatePageRequest` gained
`imageBytes?: ArrayBuffer` / `imageMime?: string` (mirroring
`TranslateRegionRequest` verbatim), and `shared/settings.ts` gained the pure
`getAutoTranslate`. **NO `shared/types.ts` change; `PROMPT_VERSION` and the
`buildCacheKey` composition untouched** (pinned by the existing tests, which stay
green). Every module keeps the pure-core / thin-shell split.

**Item 1 — blob-sourced pages auto-translate (the MangaDex blocker; REVERSES the
Phase 5 scanner decision).** MangaDex (and other large readers) download page
images over XHR and assign them `blob:` object URLs; Phase 5's `classifyImageUrl`
deliberately skipped `blob:` because the background can't fetch a document-scoped
blob URL (§7.3), so the scanner detected **zero** pages there. The Phase 7
drag-select path already solved the hard part (content-side bytes over
structured-clone messaging); this extends it to the auto pipeline. (a)
`classifyImageUrl` is now three-way — `accept` (http/https/data, background
fetches by URL) / `accept-bytes` (blob, content ships bytes) / `skip` — and the
scanner registers both accept kinds; `Candidate` is unchanged (its `url` still
carries the blob URL as identity/log label). (b) New `content/imageSource.ts` —
`sourceKindForUrl` / `acquisitionPlan` (pure) and `acquireBlobBytes` /
`acquireCanvasBytes` (thin `fetch`/`toBlob` shells) were **moved** out of
`regionSelect.ts` (drag-select stays byte-identical, now a thin dispatcher over
the shared primitives), so both the auto pipeline and drag-select share one
acquisition module. (c) `viewportQueue.sendTranslate` acquires the bytes
content-side lazily *at dispatch* when the URL is `accept-bytes` and adds them to
the payload — **never at registration**: a chapter can register 200 candidates,
and holding 200 × ~1–3 MB ArrayBuffers would be a content-side memory bomb, so
only jobs actually sent pay. Acquisition failure (revoked object URL) →
`overlay.setError("network")` and **`requested` is NOT reset** — a revoked blob
never heals by retry; the reader swapping the `<img>` src produces a fresh
candidate via the scanner reconcile, and that is the retry path (the `requestId`
is stamped only right before the send, so a teardown mid-acquisition fires no
phantom cancel). (d) `translatePage` builds a `Blob` from the shipped bytes
(mime defaulting like regionHandlers) and passes it into `translateImage`, which
uses it in place of the `fetchImageBytes` result; when bytes are present the URL
is **never fetched**. **WHY the cache/coalesce layers needed no change:** page
identity is the CONTENT HASH, not the URL — `sha256Hex(blob)` → composite cache
key → coalesce/SharedAbort all key on that hash, so two tabs showing the same
page under different ephemeral blob URLs coalesce onto one provider run, and a
revisit next session cache-hits even though every blob URL is new (pinned by a
test: two concurrent identical-byte requests under different blob URLs → ONE
provider call).

**Item 2 — global rate-limit cooldown (the 429-storm brake; TWO-LAYER design,
both layers intentional).** `ProviderBase`'s per-job ladder (2s/8s/30s,
`retry-after`-aware) is correct in isolation but every queued job burned it
independently — at concurrency 6 the export logged 40+ consecutive 429s with no
cross-job brake. New `background/rateGate.ts` adds ONE shared cooldown ABOVE the
per-job ladder (the ladder is untouched — it still handles transient per-request
limits and honours `retry-after` on retries; the gate stops NEW cross-job
requests when the key is *globally* exhausted). Pure core: `reportRateLimit` →
cooldown `min(60s, max(retryAfter ?? 0, 8s·2^strikes))` (8→16→32→60s cap;
exponent clamped so a long strike run can't wrap the 32-bit shift negative),
`clearRateLimit`, `waitMsFor`. Thin wrapper `createRateGate(sleep?, now?)` with
an abortable `waitUntilClear` that re-checks after each sleep (a report landing
mid-wait extends it). Wired at the single choke point per HTTP request via the
tested `callWithRateGate(gate, signal, call)` helper — the per-tile fan-out in
`translateHandlers` AND the region path in `regionHandlers` (a drag-select during
a storm queues behind the cooldown, not hammers). On a `rate-limit`
ProviderError → `report(retryAfterMs)`; on success → `clear()`. **WHY the waits
live inside the queue slots:** sleeping occupies a concurrency lane, so during a
cooldown at most `concurrency` jobs idle and ZERO new HTTP fires — the queue
self-paces to the provider's rate. No new UI: the existing once-per-activation
rate-limit toast is still the surface (the gate rethrows the error so content
still badges/toasts).

**Item 3 — auto-translate becomes per-site opt-in — FLAGGED F1/F15 SEMANTICS
CHANGE.** The global toggle auto-translated junk on every enabled site — the
export showed real Gemini calls billed to the user's key for YouTube thumbnails
(`i.ytimg.com/vi/…`) and the MangaDex mascot (`mangadex.org/img/miku.jpg`), a
cost AND privacy bug. **New semantics:** visibility-driven auto-translate runs
ONLY on sites the user explicitly opted in (`perSiteOverrides[hostname] === true`
— the popup's per-site "Auto-translate on"). The global toggle alone still
ACTIVATES the content script everywhere (overlays, drag-select, and the popup
"Translate all" button all work), **but nothing is sent to a provider without a
user action**. This **deviates from the shipped F1/F15 "global enable = full
pipeline everywhere"** — existing behaviour for a user who already site-enabled a
reader (override `true`) is unchanged (still active AND auto). Implementation:
pure `getAutoTranslate(settings, hostname)`; the gate emits `re-request` when
`getAutoTranslate` flips while active in EITHER direction (effective-enabled
doesn't change on a global-on override add/remove, so without this it would
misclassify as a lesser action); `createViewportQueue` gained a required
`autoEnqueue: boolean` — when false, candidates are still registered,
doc-ordered, and overlay-managed (Translate all + drag-select need the registry)
but the IntersectionObservers **never observe** them (no tier events, no auto
sends) and `reobserve()` no-ops (accepted consequence: a timed-out translate-all
page won't visibility-retry on a non-auto site — the user re-clicks Translate
all). `content/index.ts` passes `getAutoTranslate(settings, hostname)`. Popup
copy communicates the split: the site-rule "On" option is now "Auto-translate
on", and `statusLine` distinguishes "Auto-translating …" (opted in) from "On
here — use Translate all or Select region (auto-translate is off for this site)"
(global-on, not opted in — the finding-2 regression messaging).

**Decided-against (recorded per the handoff):** **canvas auto-translate** —
drag-select already covers `<canvas>` readers, and auto-canvas has
taint/redraw-churn problems; not built. Screenshot-capture fallback
(`tabs.captureVisibleTab`) stays P2. `concurrency` default stays 6 (§11 — the
gate self-paces under limits). Everything in PHASE-8-HANDOFF.md (batching,
re-prioritization, e2e, AMO prep, the `data_collection_permissions` notice) stays
Phase 8.

**Manual verification — STATUS: NOT executed in this implementation session (no
live Firefox + real Gemini key + network access to MangaDex/YouTube from the
coding environment). Recorded honestly rather than faked.** This is the one
outstanding DoD item and it is a human/live step by nature (as every prior
phase's manual pass was). The handoff's 6 steps are ready to run against the
built `dist/`: (1) load as temporary add-on, grant image access, set a real key;
(2) a MangaDex chapter with the site opted in → pages overlay as you scroll and
the Translate-all dry-run counts > 0 (was "No manga images detected"); (3)
drag-select a bubble on a blob page → skeleton then overlay, a `translateRegion`
round-trip in the background console; (4) **YouTube with global on but NO site
override → ZERO provider requests** (finding-2 regression test); (5)
`tests/fixtures/testpage.html` with the host opted in → pre-7.2 pipeline
unregressed; (6) on a real 429, requests visibly pace out (gate logs), one toast,
no 40-request storm. Free-tier note: set `concurrency` 2–3 (or use a
billing-enabled key), and don't misread daily-quota exhaustion (instant 429s) as
a code bug.

Tests: **31 net new** (imageSource 5: scheme classification + acquisition-plan
matrix + blob-shell happy/mime-default/throw — moved from regionSelect, not
duplicated; rateGate 10: ladder escalation/retry-after/60s-cap/no-shift-wrap/
success-reset/waitMsFor + wrapper immediate/wait-and-release/report-extends/
typed-abort; translateBytes 3: bytes path skips fetch + builds the mime'd Blob,
http path still fetches, identical-bytes-different-URL coalesce onto one run;
scanner +1: registers a blob-URL `accept-bytes` candidate, existing blob test
updated to `accept-bytes`; viewportQueue +6: blob dispatch ships bytes / http
dispatch ships none / acquisition-failure setError-no-send-not-wedged +
autoEnqueue=false never-observes / requestAll-still-sends / reobserve-no-op; gate
+2: getAutoTranslate flip → re-request both directions; settings +3:
getAutoTranslate matrix incl. the global-on-not-auto guard and override-true
active-AND-auto; popupLogic +1: statusLine auto-vs-active-not-auto;
translateHandlers +3: callWithRateGate waits-then-clears / reports-rate-limit /
ignores-non-rate-limit), **451 total green**; the existing 420 stay green
untouched; typecheck + eslint + `vite build` clean; `web-ext lint` 0 errors /
0 warnings (the lone `data_collection_permissions` notice stays Phase-8-deferred).
Content bundle unchanged at ~28 kB; background grew ~1 kB (rateGate).

## Phase 7.3 summary (live-site fixes round 2: object-fit-aware overlay geometry)

The SECOND live-browser verification (2026-07-10, Firefox release build, real
Gemini key, a keyoapp-style reader in "Fit Both" mode) root-caused ONE finding:
**overlay bubbles landed far off the artwork and spilled past the drawn page's
right edge into the black letterbox bars.** Region bboxes are clamped to [0,1] by
`sanitizePage`, so under a correct mapping a bubble physically can't escape the
bitmap — the mapping itself was wrong. Every overlay geometry consumer treated
the `<img>` **element box** (`getBoundingClientRect`) as the drawn bitmap, an
equality that holds only under the default `object-fit: fill`. "Fit Both" is
`object-fit: contain`: the element spans the whole reader column while the bitmap
is letterboxed inside it, so every normalized bbox was stretched across the
element box. **This REVERSES the Phase 7.1 "object-fit: contain/cover divergence —
accepted" note** — a mainstream reader mode triggers it, so accepted no longer.
This is a content-script-only point-phase (precedent 4.1/5.1/7.1/7.2): **NO
`shared/types.ts` / `shared/messages.ts` / `shared/settings.ts` change,
cache-key composition and `PROMPT_VERSION` untouched**; the pure-core / thin-shell
split holds.

**New module — `content/overlay/contentBox.ts` (object-fit math + one DOM
shell).** The PURE, exhaustively-tested core is `computeContentBox(boxW, boxH,
naturalW, naturalH, fit, posX, posY)` — the CSS spec's replaced-element draw rect:
`fill` → the content box; `contain`/`cover` → `min`/`max(boxW/naturalW,
boxH/naturalH)` scale; `none` → 1; `scale-down` → `min(1, containScale)`; then the
`object-position` offset per axis is `fraction × free` (free = boxSize − drawnSize,
NEGATIVE under cover/none-overflow — the formula handles it, no special-case) or a
verbatim `px`. `parseObjectPosition` parses a COMPUTED `object-position` (`"50%
50%"` / `"0px 12px"` / mixed; missing 2nd → 50%; `calc()`/exotic → center — WHY
parse the computed value: getComputedStyle already resolved `left`/`top` keywords
to %, so keyword handling would be dead code). `insetContentBox` turns the
border-box rect into the content box (a 1 px border shifting every bubble is
exactly the off-by-a-little this phase kills). **Degenerate inputs (natural/box
≤ 0, non-finite) return the fill result** = the pre-7.3 element-box behavior, so a
broken/undecoded image can never render WORSE than the status quo (rule 4). The
thin, untested shell `readContentBox(el)` is the ONE DOM read: `<img>`
(`naturalWidth/Height`, 0-while-undecoded falls through to the fill fallback) and
`<canvas>` (`width/height` — object-fit applies to canvas too, and drag-select
accepts canvas) get `getBoundingClientRect` + ONE `getComputedStyle` (objectFit,
objectPosition, border + padding) → inset → `computeContentBox` → the bitmap's
CLIENT rect; every other element (background-image hosts have no readable
intrinsic size) returns the plain element rect; the whole body is try/catch →
element rect on any throw (**the fail-soft path IS the status quo**).

**OverlayManager — host covers the DRAWN-BITMAP rect (items 1–3; DESIGN CHOICE
(a)).** The host is sized/positioned to the content-box rect, NOT the element box
with bubbles offset inside (option (b), rejected). WHY (a): it keeps `regionToPx`
the untouched ONE bbox→px conversion (handoff rule), makes the skeleton + error
badge sit on the artwork for free, and keeps peek hit-testing a simple host-local
containment test. `positionEntry` now targets `readContentBox(el)` and **RETURNS
that content rect** so `paint`/`syncEntry` reuse it (the content-box read's one
extra `getComputedStyle` per entry per rAF flush REPLACES, not stacks on, today's
second rect read — the one-read-per-frame budget holds); the Phase 5.1 residual-
error correction below it is byte-identical (it just compares against the content
rect now). `paint` feeds the content size to `regionToPx` + textFit and stores it
as `lastPaintedSize`; `syncEntry`'s `displayedSizeChanged` keys on the content
size (a Fit Both → Fit Width flip changes the DRAWN size even when the element box
is stable — the repaint must key on what we painted with); `processPeek`
bounds-checks against the content rect so hovering a letterbox bar no longer
hit-tests as inside the image. **Accepted caveat (WHY-noted, not engineered
around):** a pure-CSS fit-mode flip that keeps the element box byte-identical AND
fires zero scroll/resize/ResizeObserver activity won't re-sync until the next sync
trigger — real reader mode switches always reflow the element, so no
style-attribute observer.

**regionSelect — drag-select crops normalize against the drawn bitmap (item 4;
the silent WRONG-CROP fix).** `defaultCollectTargets` builds `RegionTarget.rect`
from `readContentBox(el)` for `<img>`/`<canvas>` (background hosts keep the
element rect — `readContentBox` returns it unchanged for them). This fixes BOTH
downstream consumers with ZERO pure-math change: `pickTargetImage` ranks by
intersection with actual artwork, and `selectionToImageBbox` normalizes the crop
against the bitmap, so on a letterboxed reader the background's `planRegionCrop`
cuts the pixels the user actually selected (before 7.3 the crop was off by the
letterbox offset — the provider translated a different area than was selected).
The `MIN_RENDERED_PX` floor deliberately stays on the ELEMENT rect (WHY-noted: the
floor is about click-target size — a letterboxed-but-large image must stay
selectable — not bitmap size).

**Test-page fixtures (item 5).** `tests/fixtures/testpage.html` gains two
below-the-fold variants of the manga-page SVG placeholder (existing ids/fixtures
untouched): (f) a portrait bitmap in a WIDE `object-fit: contain` box (the "Fit
Both" case — bubbles must letterbox-align, centered) and (g) the same with
`object-position: left top` (pins the position math), each on a dark background so
the letterbox bars are visible. Makes the fix manually verifiable without the live
site.

**Tests — item-3 seam choice flagged:** I took the house-style route (pure item-1
coverage + WHY comments), NOT a contrived `readContentBox` seam injected into the
OverlayManager — consistent with OverlayManager being an untested thin shell (no
`OverlayManager.test.ts` exists; every *decision* it makes already lives in a
tested pure helper). 24 new `contentBox` tests carry the math (fill identity;
contain wide-box-portrait — THE reader case, asserting the horizontal letterbox
offsets AND that the bitmap can't reach the element's right edge; contain
tall-box-landscape; cover negative-offsets both axes; none larger/smaller than
box; scale-down both branches; object-position 0/50/100%/px/mixed/negative-free-
space-cover; parse matrix incl. single-component + garbage→50% + negative px;
degenerate natural-0/box-0/NaN fallbacks; border/padding inset), and 2 new
`regionSelect` cases pin the item-4 end-to-end contract (a selection over the
letterbox bar → `pickTargetImage`/`selectionToImageBbox` null → no request; a
selection over the bitmap → bbox normalized to the BITMAP rect, not the element
box). **477 total green**; the existing 451 stay green untouched; typecheck +
eslint + `vite build` clean; `web-ext lint` 0 errors / 0 warnings (the lone
`data_collection_permissions` notice stays Phase-8-deferred). Content bundle
~28 kB → ~30.6 kB (the contentBox module); background unchanged.

**Manual verification — STATUS: NOT executed in this implementation session (no
live Firefox + real Gemini key + a letterboxed reader from the coding
environment). Recorded honestly rather than faked** — the one outstanding DoD item,
a human/live step by nature as every prior phase's manual pass was. The handoff's
8 steps are ready against the built `dist/` + the new fixtures (f)/(g): (2) the
2026-07-10 letterboxed reader → bubbles on the balloons, nothing past the drawn
edges, the skeleton on the artwork not the bars; (3) switch Fit Both → Fit Width →
Long Strip → overlays re-align after each reflow; (4) drag-select a single bubble
while letterboxed → the translation matches the selected balloon (the wrong-crop
regression test); (5) peek → hovering a bubble shows the original, the letterbox
bar does nothing; (6) fixtures (f)/(g) overlay correctly + the `fill` fixtures are
unregressed; (7) MangaDex spot-check unregressed. **Step 8 is evidence-only** — if
bubbles still look sloppy relative to balloons AFTER all the above, that residual
is provider bbox quality (capture one raw Gemini response and file it), NOT overlay
geometry; do NOT start prompt tuning here (`PROMPT_VERSION` is frozen).

## Phase 7.4 summary (live-site fixes round 3: corner-format bboxes, joint edge clamp, overlap trim, pause queue)

Driven by the THIRD live-browser verification (2026-07-11, Anthropic
`claude-haiku-4-5`) and a full network capture of one chapter's run (22
`v1/messages` calls). The raw `tool_use` inputs settled the "sloppy boxes"
question: **the model returns CORNER-format boxes.** The schema asked for
`bbox: [x, y, width, height]`, but roughly half the returned regions are
unmistakably `[x_min, y_min, x_max, y_max]` (call 0's top-right bubble column:
`[0.550,0.320,0.950,0.420]` is a plausible bubble read as corners but 95%-of-page
wide read as w/h; calls 5/10/13–15 are entirely corner-format, 3/11/16 entirely
w/h, 17 mixes them row by row). Read as w/h a corner box renders ~twice as
wide/tall, spilling right+down over its neighbours — exactly the overlapping,
edge-spilling boxes in the screenshots, on BOTH the auto page path and
drag-select.

**Item 1 — canonical format REVERSED to corners, `PROMPT_VERSION` → 2.** Rather
than fight the model's training with w/h, the canonical schema's `bbox` now asks
for `[x_min, y_min, x_max, y_max]` (fractions 0–1, x-first) — schema-follows-model,
not model-follows-schema; asking for corners turns Haiku's failure mode into
compliance. `CANONICAL_SCHEMA`'s bbox description and `SYSTEM_PROMPT_TEMPLATE`'s
BOUNDING BOX RULES were rewritten to match (plus one new line, "Boxes for
different regions should not overlap." — cheap, targets the duplicate-detection
damage). `type`/`minimum`/`maximum`/`minItems`/`maxItems` are unchanged, so all
three dialect converters (Gemini strip-additionalProperties, OpenAI strict
strip-ranges, Anthropic as-is) carry the new description through untouched.
`PROMPT_VERSION` bumped 1 → 2 (it lives inside each cache KEY, so old-format-era
entries go stale naturally); `docs/PROMPTS.md` §2/§3/§6 updated to stay a
byte-mirror of the module. WHY x-first fractions and not Gemini's native y-first
0–1000 `box_2d`: the live provider is Anthropic and the HAR shows x-first
fractions are Haiku's natural emission; a Gemini-specific dialect needs its own
live evidence (out of scope).

**Item 2 — `parseBbox` is now corners-first with a JOINT edge clamp
(`ProviderBase.ts`).** An array `[a,b,c,d]` is read as corners (`w=c−a, h=d−b`);
if EITHER extent is non-positive the row can't be corners, so it falls back to the
legacy w/h reading (`w=c, h=d`) for any third-party endpoint still emitting w/h.
The `{x,y,w,h}` object form is unchanged. Then, on ALL paths, a joint clamp: `x,y`
into [0,1], then `w = min(w, 1−x)`, `h = min(h, 1−y)`; a box degenerate after
clamping (`w≤0` or `h≤0`) is dropped. **This corrects a FALSE claim carried in the
7.3 handoff and PROGRESS.md** — that "bboxes are clamped to [0,1] so a bubble
physically cannot escape the bitmap." The old clamp pinned each component
INDEPENDENTLY, so `x + w` could reach 2.0 and a box could legally render past the
drawn bitmap's right/bottom edge. Only now, with the joint clamp, is that claim
TRUE. Everything downstream is untouched: conversion happens in `parseBbox` BEFORE
`remapBboxFromTile`, so tiles and drag-select crops inherit the fix for free, and
`sanitizePage`'s area/dedupe rules and the cached `BBox` shape are unchanged.

**Item 3 — render-time overlap trim (`overlay/overlapTrim.ts`, new pure module).**
Even under the corner reading, adjacent boxes overlap — the model estimates
coordinates on a coarse ~0.05 grid, and call 12 held true duplicate detections at
different positions (identical-dedupe can't catch them; IoU < 0.85). `trimOverlaps`
is a deterministic, PURE post-step: for each intersecting reading-order pair it
shrinks BOTH boxes along the axis with the SMALLER overlap extent, each giving up
half the overlap so their shared edge meets in the middle. It caps each box's
cumulative shrink at 30% of its original per-axis size, and leaves a pair alone if
the cap would be exceeded or if one box CONTAINS the other (a contained duplicate
is a detection error trimming would mangle; draw order already stacks them
readably). Same principle as `filterRegions` — a VIEW fix on copies; the cache
keeps the provider's honest boxes. `OverlayManager.paint` chains it after
`filterRegions` (regions → filter → trim → `regionToPx`); `paintedRects`/peek
indexing needs no change (both functions are pure, so paint re-derives the same
order). WHY trim, not merge: merging two different-text regions would invent a
bubble that doesn't exist.

**Item 4 — pause the translate queue (user feature: "stop translating more pages
than already started").** Semantics: pausing lets every already-STARTED provider
call finish and render, aborts every queued-but-not-started page job, and stops
new sends (visibility, prefetch, translate-all) until resumed. Pause is per-tab
RUNTIME state — it dies with the content script on navigation (a persisted pause
that silently disabled translation across sessions would be a support trap).
Background: a `startedRequests` Set parallel to `requestControllers`, fed by an
`onStarted` callback threaded from the `translatePage` handler → `translateImage` →
`runTranslateMiss`, invoked as the FIRST statement inside the queue task closure —
the precise moment `PriorityQueue` pulls a job off the wait list. A new
`cancelQueuedTranslations` message aborts each id that is registered AND not
started, and counts them; started/unknown ids are silently skipped — that IS the
feature. **Coalesced-follower caveat (accepted):** a follower never reaches
`queue.add`, so it is never marked started; pausing aborts the follower's waiter
while the leader's run completes and caches, and the paused page then renders from
cache on resume — correct and free. Content: `ViewportQueue` gained `setPaused`
(collect tracked requestIds, send ONE `cancelQueuedTranslations`, resolve with the
cancelled count; on resume, reobserve unrequested candidates so auto sites re-plan)
and `isPaused`; `sendTranslate` gates before flipping `requested`/`setPending` and
re-checks after the `acquireBytes` gap; `requestAll` no-ops to 0 while paused. The
aborted page jobs flow through viewportQueue's EXISTING aborted branch (reset +
clear + reobserve), exactly as its comment anticipated. Messages/router/popup:
`setTranslationsPaused`/`getTranslationsPaused` (popup → content), inert tabs reply
with defaults; a "Pause queue" ↔ "Resume queue" toggle next to Translate all,
hidden while inert, disabling Translate all while paused, reflecting state on open;
the label/disabled decisions live in a pure, tested `queueControls`.
`shared/types.ts` and `shared/settings.ts` untouched; `shared/messages.ts` gained
exactly three entries.

**Tests — 504 total green** (was 477; +27). New: `overlapTrim.test.ts` (8 —
disjoint/x-split/y-split/axis-choice/cap/containment/no-mutation/deterministic);
`translateHandlersPause.test.ts` (2 — `cancelQueuedTranslations` aborts a
registered-not-started id + skips unknown/counts, and skips an already-started id,
driving `onStarted` through the real pipeline with a hanging mocked `prepareImage`
and polling a `startedRequestsHasForTest` seam). Extended: `providerPipeline`
parseBbox suite rewritten for corners-first + joint clamp (HAR literals as
fixtures; the `out_of_range_bbox` golden now asserts the joint-clamp behaviour —
row 1 clamps to zero width and drops, row 2's width is capped at 1−x); `prompt`
(corner description carried through all three dialects, the new no-overlap line);
`constants` (pins `PROMPT_VERSION === 2`); `contentRouter` (both new inert-safe
handlers); `popupLogic` (`queueControls`/`pauseButtonLabel`); `viewportQueue` (6
pause cases: blocks a visibility send, requestAll→0, an in-flight request rendering
during pause, a pause-aborted request reset+clear+reobserve, resume reobserves
unrequested candidates, the acquireBytes-gap re-check). The existing golden
fixtures are w/h-format and now double as w/h-fallback coverage (most rows have a
degenerate corners reading, so they exercise the fallback path — semantics
unchanged). Typecheck + eslint clean; `vite build` clean; `web-ext lint` 0 errors /
0 warnings (the lone `data_collection_permissions` notice stays Phase-8-deferred).
Content bundle ~30.6 kB → ~32 kB; background ~35.6 kB.

**`npm run eval:live` — NOT re-run this session** (needs a real key; not available
from the coding environment). Outstanding DoD item, recorded honestly per the 7.3
precedent — re-run it before accepting the prompt wording change, and if bbox
quality is still poor AFTER the format fix, capture one raw response and compare
against the corner reading (garbage in BOTH readings ⇒ model quality; try
`claude-sonnet-5`/Gemini before any further prompt surgery).

**Manual verification — STATUS: NOT executed in this implementation session** (no
live Firefox + real Anthropic key + the Eminence-in-Shadow reader from the coding
environment). Recorded honestly rather than faked — the outstanding human/live DoD
item, as every prior phase's manual pass was. The handoff's steps are ready against
the built `dist/`: (2) the 2026-07-11 auto page → boxes sit ON their bubbles, the
top-right column no longer spans half the page, nothing past the drawn edges, no
gross overlap; (3) drag-select the two right-side bubbles → boxes land on their own
bubbles; (4) letterboxed "Fit Both"/"Fit Width" re-align + peek over a bar does
nothing (doubles as the never-fully-run 7.3 manual pass); (5) MangaDex blob
spot-check unregressed; (6) Translate all on a 10+ page chapter → Pause → in-flight
pages finish and render, other skeletons clear, network shows no new `v1/messages`;
Resume → auto site re-queues scrolled-to pages, manual site re-clicks Translate all;
(7) cost counter increments only for calls that actually ran.

## Phase 7.5 summary (bubble snap: pixel-refined bboxes + pause-log cleanup)

Driven by the FOURTH live verification (2026-07-11, Firefox release, **Anthropic
`claude-sonnet-5`** — the user moved off `claude-haiku-4-5` mid-session; Haiku
4.5 confirmed unusable for manga: its returned boxes are a formulaic column-grid
guess — call 1 nearly every box `x 0.05–0.45`/`0.55–0.95` width 0.40, call 3 all
width 0.36, call 8 all width 0.30 — and its vertical-CJK transcription scrambles,
so this is model capability, not geometry/prompt). Two HAR captures settled it:
Sonnet 5's boxes land on the RIGHT bubbles (user-confirmed) at ≈$0.017/page but
still sit on a coarse grid — correct-but-loose. The wasted 400 in capture 2
(`"temperature is deprecated for this model"`) is the **Phase 3.1 learn-on-400
sampling-param downgrade firing exactly as designed** (call 1 retried without
`temperature` and succeeded; one wasted 400 per model per event-page lifetime,
no code change). This phase fixes the residual looseness deterministically and
for free — **no prompt-layer changes; `PROMPT_VERSION` stays 2**, this is
geometry via local pixels, not prompt surgery. A point-phase (precedent 4.1/5.1/
7.1–7.4).

**New module — `background/bubbleSnap.ts` (pure core + thin decode shell).**
"Bubble snap" treats the provider's box as a *seed* and snaps it to the actual
speech-bubble blob via flood fill on the decoded bitmap; every failure path falls
back to the provider's box, so the worst case is exactly the pre-7.5 behaviour
(rule 4). **WHY background, not content:** a content script can't read pixels of
a cross-origin `<img>` (canvas taint, §7.3); the background already holds the
clean bytes on both paths. **WHY snapped boxes are CACHED** (unlike the
render-time `trimOverlaps`, which stays a view-fix on copies): snap is a
deterministic function of (image bytes, provider box) — same inputs → same
output — so caching it is memoization, not a lie about what the provider said;
no `CACHE_VERSION` bump (pre-7.5 entries render with unsnapped geometry until
they age out). **Full local ML detection (onnxruntime-web etc.) was REJECTED**
for now (tens of MB of weights, WASM seconds/page, AMO weight) — revisit only if
VLM boxes stay bad across providers.

The PURE, exhaustively-tested core: `snapRegionToBubble(img, bbox, opts?) → BBox
| null` on a minimal `SnapBitmap = {data, width, height}` (RGBA, as `getImageData`
returns, so tests build fixtures with typed arrays and no DOM). Algorithm — try
the box **center then 8 quarter-point seeds** (center first); a seed must be
LIGHT (luminance `0.299R+0.587G+0.114B` ≥ `LIGHT_FLOOR` 160; a dark seed on a
stroke/art skips); **flood fill** (iterative, 4-connected, `visited` bitmap — no
recursion) over pixels with luminance ≥ `max(LIGHT_FLOOR, seedLum −
SEED_TOLERANCE 24)` (relative tolerance so off-white paper / mild screentone
still fills); then the two guards that make snap safe — **min-area reject** (blob
< `MIN_BLOB_FRACTION` 0.25 × seed-box area ⇒ the fill found a glyph counter
(口/O) or a speck → try the next seed) and **leak reject** (blob > `MAX_BLOB_BOX_
RATIO` 4 × seed-box area OR > `MAX_BLOB_IMAGE_FRACTION` 0.35 of the bitmap ⇒ the
fill escaped through an outline gap / open tail into the page background →
**abandon ALL seeds and return null**, because a leak from one seed leaks from
every seed in that blob); on acceptance the blob's bounding box, padded 1 snap-px,
back in fractional space. The 4× ratio also bounds how far snap may **GROW** a
too-small seed box — snap is bidirectional (shrinks an oversized box, grows a
small one, up to 4× area). `shouldSnapKind(kind)` snaps **only `bubble` and
`thought`** (white-interior shapes); `caption`/`sfx`/`sign`/`other`/undefined sit
on art where a fill leaks or lands dark and keep the provider box (**WHY
conservative:** a wrong snap is worse than a loose box). `computeSnapSize` and
`clampBoxToRect` are pure too (below). Constants exported for the tests to tune.

The thin, untested `snapPageRegions(blob, page, clampRect?)` shell (same env
reason `prepareImage`/`cacheStorePage` are untested — no `createImageBitmap`/
`OffscreenCanvas` in Node): early-returns the page UNCHANGED when no region is
snap-eligible (a caption/SFX-only page pays ZERO snap cost, no decode), else
`createImageBitmap` → draw onto an OffscreenCanvas at **`computeSnapSize`** with a
white underlay (a transparent PNG would decode black = all-dark = every seed
fails) → `getImageData` → run the core per eligible region → return a NEW page
(never mutates the input; unchanged regions reused by reference in a fresh array).
Closes the bitmap in `finally`; the whole body is try/catch → **returns `page`
unchanged on any throw** (rule 4). **`SNAP_MAX_EDGE` = 512** because downsampling
is load-bearing, not just cheap: at ≤512 px a 1–2 px outline gap closes by itself
and glyph strokes blur toward gray (fewer false-light seeds) while bubbles stay
hundreds of px². **Long strips (flagged implementer's call):** `computeSnapSize`
**raises the cap so the SHORT edge holds a `SNAP_MIN_SHORT_EDGE` = 256 floor**
(512-on-a-20000-px long edge would crush an 800-wide strip to ~20 px and destroy
every blob) — chosen over per-tile snapping as simpler; a 256×N bitmap is cheap
enough to fill whole.

**Wiring (both provider paths; snap composes AFTER parseBbox-normalize →
merge/remap, BEFORE cache/paint).** Page path — `translateHandlers.translate-
Prepared`: after `mergeTilePages`, `merged = await snapPageRegions(blob, merged)`
using the ORIGINAL full-image `blob` already in scope, INSIDE the queue slot
(decode+fill at ≤512 px is ms-scale next to a provider round trip) and BEFORE
`cacheStorePage`, so hits replay the tight geometry for free. Region path —
`regionHandlers.translateRegionImage`: the provider's boxes are already in
full-image space (crop-as-tile remap), so snap against the FULL image, then pass
the selection `crop` as `clampRect` — a snapped box that GROWS past the user's
selection is clamped back to it (a drag-select must never paint outside what was
selected); a snapped box that clamps to nothing keeps the provider box. Content
paint order is unchanged (`filterRegions → trimOverlaps → regionToPx`); snapped
boxes rarely overlap, and `trimOverlaps` still guards true duplicate detections.
**No `shared/*` change; cache-key composition and `PROMPT_VERSION` untouched.**

**Item 2 — pause/console-noise cleanup (user's 2026-07-11 console export).** (a)
`translateHandlers`' `translatePage` catch logged `log.warn("translatePage failed
…")` for EVERY aborted job — a 15-page pause flooded the console with "All waiters
aborted" warnings that read as failures. Now gated to `log.debug` for aborts,
`log.warn` for real failures. **Gate on the MAPPED `errorKind`, not bare
`isAbortError`** (a deliberate improvement over the handoff's literal suggestion):
an abort surfaces variously as a raw `AbortError` (queue / SharedAbort's "All
waiters aborted"), an `ImageFetchError('aborted')` (mid-fetch — whose `.name` is
NOT "AbortError", so `isAbortError` misses it, and pause aborts plenty of
still-fetching jobs), or a `ProviderError('aborted')`; `errorToTranslateResult`
already collapses all three to `aborted`, so gating on it silences every abort
variant. The returned result mapping is unchanged. (b) Popup: the on-open
`getTranslationsPaused` query (and the defensive `setTranslationsPaused` write)
rejected with "Could not establish connection" on inert tabs (about:, addons.
mozilla.org, never-injected) and logged at warn; both now log at `debug` and
default to not-paused (the toggle is hidden while inactive anyway), mirroring how
translateAll's dry-run treats inert tabs. Popup stays a thin shell — no pure
helper fell out, so WHY comments are the house-style bar (per the handoff).

**Design choices flagged (recap):** background-not-content (canvas taint);
snapped boxes cached as deterministic memoization vs. the render-time trim's
view-fix-on-copies; the two safety guards (min-area glyph-counter reject,
open-outline leak cap → null) and their conservative kind gating (bubble/thought
only); the short-edge-floor strip handling (raise-the-cap over per-tile); the
abort-log gate keyed on the mapped kind. **Out of scope (not built, per the
handoff):** local ML text detection/OCR; non-rectangular overlays (the snap
core's blob is the natural later input — noted, not built); any prompt/schema
change; a Gemini `box_2d` dialect; prompt caching for the static prefix (the real
input-cost saver — its own phase with cache-hit verification); snapping caption/
sfx/sign kinds.

**Tests — 524 total green** (was 504; +20). New `bubbleSnap.test.ts` (19,
synthetic-`SnapBitmap` fixtures — a small helper fills rects/ellipses into typed
arrays): loose box over a white ellipse on gray → tightens to the ellipse bounds;
oversized box → SHRINKS to the bubble; too-small box → GROWS to the bubble;
large connected white region → leak cap → null; glyph-counter center seed →
min-area reject, offset seed recovers the real bubble; all-dark → null; off-white
(lum ~230) interior still fills under the relative tolerance; degenerate bbox
(w/h ≤ 0, NaN) → null; input bbox not mutated; deterministic; zero-size bitmap
guard; `shouldSnapKind` matrix; `computeSnapSize` (unscaled-within-cap, long-edge
cap, strip short-edge floor, no-upscale + degenerate); `clampBoxToRect`
(contained / clipped-to-intersection / disjoint → null). Extended
`translateHandlersPause.test.ts` (+1: an aborted job produces no warn-level
"translatePage failed" log — spies `console.warn`, drives the real abort
pipeline). The existing 504 stay green untouched (the wiring is inert in Node:
`snapPageRegions` early-returns for kind-less mocked regions, and the one test
that reaches it with a valid image throws at `prepareImage` before the snap).
Typecheck + eslint clean; `vite build` clean; `web-ext lint` 0 errors / 0
warnings (the lone `data_collection_permissions` notice stays Phase-8-deferred).
Background bundle ~35.6 kB → ~38.4 kB (bubbleSnap); content unchanged at ~32 kB
(snap is background-only).

**Manual verification — STATUS: NOT executed in this implementation session** (no
live Firefox + real Anthropic key + the Eminence-in-Shadow reader from the coding
environment). Recorded honestly rather than faked — the outstanding human/live DoD
item, as every prior phase's manual pass was, and **steps 2–6 double as the
outstanding 7.4 manual items** (corner boxes + pause were already user-verified
live on 2026-07-11; the Haiku grid-guess finding, the Sonnet-5 switch, and the
temperature-400 downgrade firing as designed are the recorded evidence). The
handoff's steps are ready against the built `dist/` with `claude-sonnet-5` and a
site opted in: (2) auto-translate the chapter → boxes hug the bubble outlines
(visibly tighter than capture 2), text size varies less across bubbles, nothing
paints over adjacent art; (3) drag-select the two right-side bubbles → boxes land
ON the bubbles AND inside the selection; (4) a captions/SFX page → those render at
the provider box (unsnapped, unregressed); (5) MangaDex blob page → snap runs on
content-shipped bytes too; (6) reload the chapter → instant render with the SAME
tight boxes (snap was cached, no re-decode); (7) pause mid-chapter → console shows
NO warn-level "translatePage failed … All waiters aborted" spam, and the popup on
a fresh about:blank tab shows no `getTranslationsPaused` error. If a specific
bubble snaps WRONG (box jumps to the wrong blob): screenshot + note the page, and
tune the constants before adding mechanism.

## Phase 7.6 summary

Two fixes driven by the fifth live pass (2026-07-11, Anthropic `claude-sonnet-5`):
connected speech bubbles snapping into one swallowing box, and no way to re-show
a cached chapter on reload without re-spending. No prompt-layer change
(`PROMPT_VERSION` stays 2) and — deliberately — **no `CACHE_VERSION` bump**
(WHY below); `shared/types.ts`/`shared/settings.ts` untouched; `shared/messages.ts`
gained exactly three flagged entries.

**Item 1 — connected bubbles (`bubbleSnap.ts` only; the two call sites at
`translateHandlers.ts:340` / `regionHandlers.ts:131` keep their exact
signatures).** Two speech bubbles joined by a light neck (a common manga idiom)
are ONE connected blob, so both bubbles' seeds flood-fill it identically. The 7.5
per-region core then either snapped BOTH to the union bounding box (the union is
only ~1.5–2.5× the larger seed box — comfortably under the `MAX_BLOB_BOX_RATIO=4`
leak cap, so it was *accepted*) or leaked the smaller box to null (its union fill
> 4× ITS box); `overlapTrim`'s containment guard, built for duplicate detections,
then deliberately left the huge box + small box stacked. "One blob claimed by
multiple regions" was simply never a modeled case. The fix makes it one: the
shell's region loop is now the exported, pure, tested **`snapAllRegions`
orchestrator** (`snapPageRegions` is an even thinner decode→orchestrate→apply
shell). Four stages: (1) independent 7.5 snaps; (2) **shared-blob group
detection** — twin snaps (pairwise IoU ≥ `SHARED_BLOB_IOU=0.8`) OR a *swallowed
neighbour* (`coverage(snapᵢ, boxⱼ) ≥ SWALLOW_COVERAGE=0.65` while
`coverage(origᵢ, origⱼ) <` it, i.e. the coverage is NEW, introduced by the snap —
this is the screenshot case, where the larger box snapped the union and the
smaller leaked to null); (3) **slab split with windowed re-fills** — cut along the
axis with the larger spread of member ORIGINAL-box centers (only the provider
boxes still know which lobe is whose — the snaps are the identical union), at the
midpoints between centers; each member re-fills confined to its slab via a new
`SnapOptions.window` (out-of-window pixels are walls, seeds clamp in), so the
per-lobe box hugs its actual lobe on BOTH axes even for a diagonal/wavy join;
(4) a final **swallow guard** reverting any accepted snap that still NEWLY
swallows a neighbour (eligible or not — catches a lobe over a caption, a group
revert that left a twin in place, future drift). **All-or-nothing per group:** if
ANY member's windowed fill fails (dark slab, min-area, degenerate window) the
WHOLE group reverts to provider boxes — cutting a real bubble in half on bad
evidence is exactly the "a wrong snap is worse than a loose box" trap, so the
worst case is precisely the pre-7.5 loose provider boxes (rule 4). A single
isolated bubble is byte-identical to 7.5 (regression-tested). Note the observed
degradation edge: if a joined lobe's provider box is much smaller than its own
lobe (fill > 4× that box), its windowed re-fill leaks and the group reverts to
provider boxes — the safe fallback, not a swallow. `shouldSnapKind`,
`computeSnapSize`, `clampBoxToRect`, and `overlapTrim.ts` are all untouched;
constants are exported and tunable via `SnapOptions` so tests (and live tuning)
adjust thresholds before adding mechanism. Kept in `bubbleSnap.ts` (no
`bubbleSnapGroups.ts` split — the group/slab/guard helpers read cleanly inline).

**Item 2 — cache-only hydrate (zero-spend reload).** A cache hit only ever
surfaced when some translate request ran (the key is a content hash — the
background must fetch+hash bytes to even look up), so on a non-auto site the user
re-clicked Translate all after every reload, paying real provider calls for any
gaps. Contract (`shared/messages.ts`, flagged): `TranslatePageRequest.cacheOnly?:
boolean` ("answer from cache or say not-cached; NEVER enqueue/coalesce/call the
provider"); a third `TranslatePageResult` arm `{ ok:false; errorKind:"not-cached" }`
— **the literal lives ONLY in this union, NOT in `ProviderErrorKind`** (not-cached
is not a provider error; it drives no negative-cache policy and no error badge),
and it's unreachable for a non-`cacheOnly` request, so the hydrate probe handles
it before the generic branch while `setError`/`errorKindToMessage` never see it
(the two other call sites, `viewportQueue` and `regionSelect`, carry a defensive
narrowing branch); and `countCachedForSite: void → { count }` (origin from
`sender.url`, counted on cache.ts's existing `origin` index via the new
fail-soft-to-0 `countCacheForOrigin` = `IDBIndex.count`, O(log n), no getAll).
Background: `translateImage` gains a `cacheOnly` flag — after the cache lookup a
hit returns the page and a live negative throws its cached error exactly as today
(both are genuine cached results), but a miss/expired throws a module-local
`NotCachedError` sentinel (mapped by `errorToTranslateResult` to the new arm)
BEFORE touching the coalesce map, SharedAbort registry, or queue; the
fetch→hash→`buildCacheKey` block stays single-source. Probes register a
controller (cancellable on teardown) but never reach `onStarted` (pause correctly
treats them as not-started). Content (`viewportQueue.ts` + one line in
`index.ts`): `createViewportQueue` gains `hydrate: boolean`, wired to
`!getAutoTranslate(...)` — an auto site already self-hydrates via visibility, so
this is its complement. When hydrating: a **once-per-lifetime origin gate**
(memoized `countCachedForSite`; count 0 or a failed message → every probe
no-ops, so sites the user never translated stay inert — one indexed count per
activation), then **probe-on-register** through a **bounded concurrency gate**
(`HYDRATE_CONCURRENCY=3` — blob candidates ship their bytes via `acquireBytes`,
and a 200-page chapter acquiring 200 buffers at once is the exact memory bomb the
7.2 lazy-acquisition note forbids; probing on register, not one activation batch,
covers lazily-added images for free). A probe never `setPending` (no skeleton
flash), stamps `requestId` but leaves `requested === false` in flight; a hit →
render + `requested = true` (a later Translate all skips it); not-cached / abort /
error / timeout → record untouched, render NOTHING (invisible on failure). Probes
ignore `paused` (they spend no provider budget) and skip already-requested
candidates. `requestAll`, drag-select, and the popup are untouched — automatic
hydrate supersedes the "Show cached" button idea. **Accepted races (in-source):**
Translate-all clicked during in-flight probes can double-send an image (the real
request just hits the cache the probe read — worst case one redundant
fetch+hash); an in-flight probe aborted by pause is a silent non-event.

**WHY no `CACHE_VERSION` bump** even though 7.5 cached the wrong union-snap
geometry: a bump retires the WHOLE store and re-pays provider $ for every
previously-translated page (the user is cost-sensitive); the damage is limited to
pages with connected bubbles, the fix applies to all NEW translations
immediately, and the affected reader can be per-site cleared (F15, options page).

**Tests — 549 total green** (was 524; +25). `bubbleSnap.test.ts` (+11): a
"peanut" fixture (two ellipses + a light neck) — vertically-joined pair (twin
trigger) → each result hugs its lobe, neither covers the other; the same rotated
(horizontal join); the screenshot case (large snaps the union, small leaks →
swallow trigger) → both get lobes; a 3-lobe chain → 3 boxes; a member whose slab
is all-dark → WHOLE group reverts (box-area tuned so the full fill clears min-area
but each half doesn't); stage-4 guard reverts a snap newly covering a caption's
box while pre-existing provider overlap does NOT; windowed fill can't cross the
cut (seed clamps in); single isolated bubble byte-identical to the 7.5 snap;
determinism + inputs never mutated. `viewportQueue.test.ts` (+9): zero-count gate
sends no probes; a hit renders + flips requested + NO skeleton; not-cached leaves
it unrequested + badge-free and a later requestAll still sends the real request; a
probe timeout renders nothing and stays retryable; concurrency ≤ 3; a blob
candidate ships bytes with `cacheOnly:true`; unregister cancels an in-flight
probe; `hydrate:false` sends zero probes and never counts; probes ignore pause.
New `translateHandlersCacheOnly.test.ts` (5, mocks `./cache`): cacheOnly+miss →
the not-cached arm and the SharedAbort registry stays empty (never
coalesced/enqueued); cacheOnly+hit → the page; cacheOnly+live-negative → the
mapped provider error; `countCachedForSite` → the mocked count, and 0 without an
origin. Typecheck + eslint clean; `vite build` clean (background ~38.4 kB →
~41.3 kB, content ~32 kB → ~33.2 kB); `web-ext lint` 0 errors / 0 warnings (the
lone `data_collection_permissions` notice stays Phase-8-deferred).

**Manual verification — STATUS: NOT executed in this implementation session** (no
live Firefox + real Anthropic key + the Eminence-in-Shadow reader from the coding
environment). Recorded honestly rather than faked — the outstanding human/live DoD
item, as every prior phase's was. The handoff's steps are ready against the built
`dist/` with `claude-sonnet-5`, after FIRST clearing the test site's cache (F15 —
7.5 union-snap entries would mask the item-1 fix): (2) the joined-bubble
Eminence page → each connected bubble gets its OWN lobe box (or, at worst, the
loose provider boxes — never one box swallowing the pair with stacked text);
(3) ordinary separated bubbles on the same chapter → still snap tight (no guard
regression); (4) drag-select across the joined pair → same per-lobe result,
clamped to the selection; (5) non-auto http site: Translate all a chapter, reload
→ overlays reappear with NO click and ZERO `v1/messages` in the network panel, the
popup cost line unmoved; (6) MangaDex blob site → same (bytes-path probes);
(7) a never-translated news site with large images → background console shows the
count-0 short-circuit, no probe traffic; (8) an opted-in auto reader → unregressed,
no double renders. If a joined pair still splits WRONG (cut through a bubble,
wrong lobe): screenshot + note the page and tune `SHARED_BLOB_IOU` /
`SWALLOW_COVERAGE` before adding mechanism.

## Phase 8 summary (perf hardening + e2e infra + AMO prep — store-submittable)

The last planned phase before store submission: multi-page batching, priority
re-prioritization, queue/prefetch tuning, endpoint-mode persistence, the "Show
cached" button, the mock-provider e2e harness with the two Architecture
acceptance criteria, a memory audit, and AMO listing prep. It adds **no new
translation capability** — the pipeline has been end-to-end since Phase 5; this
makes it faster, cheaper, verified, and shippable. Every module keeps the
pure-core / thin-shell split. **Contract changes (flagged, all as the DoD
allows):** `shared/messages.ts` gained exactly **two** messages —
`hydrateCached` (§0) and `reprioritizeTranslation` (§2); the manifest gained
`data_collection_permissions` (§8); `package.json` gained e2e devDeps + scripts.
**NO `shared/types.ts` change; `PROMPT_VERSION` stays 2** (single-page bytes
byte-identical, pinned) and **no `CACHE_VERSION` bump** (batch results cache
under the SAME key as single results). `factory.ts` `createProvider` now returns
`ProviderBase` (was `Translator`) — a background-local widening so the batch
collector can reach `translateBatch`; every `Translator` caller still compiles.

**§0 — "Show cached translations" popup button (DELIBERATE REVERSAL of the 7.6
call).** The 7.6 handoff declared automatic hydrate "supersedes the button"; the
user re-requested the explicit button (2026-07-12), so **both now coexist** and
are complementary: the 7.6 auto path runs only on non-auto sites and only on
register; the button is the on-demand, works-**everywhere** complement (auto
sites included) that hydrates ALL registered candidates on a click. Reuses the
7.6 probe path wholesale — one new message (`hydrateCached: void → {count}`, a
distinct spend-nothing message so an inert tab/mis-click can never start real
requests), one new content entry point (`ViewportQueue.hydrateAll()` — iterates
every unrequested candidate onto the SAME `HYDRATE_CONCURRENCY=3` probe gate,
**bypassing the per-lifetime origin gate** since the click IS the intent signal),
one content-router handler (inert → `{count:0}`), and one popup control (gated by
the pure `canShowCached` = active http/https, auto or not). `probe()` is reused
verbatim.

**§1 — multi-page batching (F12, the core).** `pagesPerRequest ≥ 2` groups
priority-2 (prefetch/translate-all) single-tile cache-miss jobs into ONE provider
request, amortizing the ~600-token system prompt. **Prompt layer (additive):**
`buildBatchUserText` (§4.2 verbatim) + `toGeminiBatchSchema`/`toOpenAiBatchSchema`/
`toAnthropicBatchSchema` (wrap each dialect's single-page schema in a required
top-level `pages` array via `toBatchSchema`, inheriting each dialect's stripping
rules) — the single-page strings are untouched. **Provider layer:** `ProviderBase`
gained `translateBatch(jobs, settings, signal): Promise<PageTranslation[]>`
(background-local, NOT on `Translator`) reusing the existing backoff/downgrade
HTTP machinery (refactored generic over a `BuildContextBase` + request-builder so
single and batch share one path; `downgrade` is now generic so it applies to
both); each adapter gained a `buildBatchRequest` (N image blocks + batch text +
batch schema). Failure ladder is a pure classifier `classifyBatchFailure`:
wrong-`pages.length` (`BatchLengthError`, no repair) / post-repair-malformed /
refusal → **split** (retry each member solo, never re-batch); auth/rate-limit/
network/abort → **fail-all**. Batch usage tokens split evenly (remainder on the
first, so the per-member split sums EXACTLY to the provider total — no double
count, no loss). **Collector (`background/batch.ts`):** pure `batchEligible`
(priority ≥ 2 AND `pagesPerRequest` ≥ 2), `batchSignature` (provider + resolved
model + endpoint + targetLang + hint + honorifics + readingDirection + maxEdgePx
+ jpegQuality — members with different signatures never mix), `planFlush`, and a
thin timer-driven `createBatchCollector` (injected `runGroup` executor, so
batch.ts stays free of the browser-only prep/provider path). Wiring in
`runTranslateMiss`: eligible misses `submit()` to the collector instead of
`queue.add`; a flushed group = ONE priority-2 queue slot = ONE `translateBatch`
call, records ONE usage event (`images = n`), snaps + caches each member under
its own key; a member that unexpectedly preps multi-tile is diverted to the
per-tile path in the same slot; the batch aborts only when EVERY member's signal
has (SharedAbort refcount). **DELIBERATE DEVIATION (flagged):** Architecture §6
says "'translate all' defaults to 2–3", but there is one `pagesPerRequest` knob
and no way to tell an explicit user 1 from the default — we honor the setting
everywhere and do NOT silently override it for translate-all (batching increases
blast radius; opt-in beats surprise). The options hint is now the recommendation
("2–3 recommended for Translate all").

**§2 — priority re-prioritization (closes the Phase 5 "no priority upgrade"
deferral).** `queue.ts` gained `addJob(...) → { promise, setPriority(p) }` (`add`
is now a thin wrapper); `setPriority` re-inserts a still-queued entry at a better
priority (fresh seq, **upgrade-only via `min` — never worsens**) and returns
false once started/settled. New `reprioritizeTranslation: { requestId, priority }`
message (fire-and-forget; unknown/settled id is a silent no-op). Background:
`translateImage` gained a `requestId?` param registering `requestId → cacheKey`
(cleaned in `finally`); `runTranslateMiss` + `executeBatchGroup` register the
queue handle under the cacheKey. The handler resolves requestId → cacheKey →
(a) a member still buffered in the collector: **pulled out and run SOLO** at the
new priority (don't drag batch-mates); (b) a queued job / flushed batch:
`setPriority` (lifting a whole batch because one member is visible is accepted).
Content: `viewportQueue` tracks the sent priority per candidate; `planEnqueues`
now emits an `upgrade` instruction (instead of skipping) when a requested
candidate's tier strictly improves, and the shell sends the message. **Scroll-away
cancel/downgrade — DECIDED AGAINST** (the symmetric visible→gone thrash was why
Phase 5 skipped scroll-away cancel; prefetched work fills the cache anyway),
closing the Phase 5 "revisit" thread.

**§3 — queue/prefetch tuning.** Pure `requestAllTimeoutMs(count, concurrency,
baseMs)` = `min(baseMs + ceil(count/concurrency)·30 s, 15 min)`; `requestAll`
supplies this backlog-scaled budget per send (visibility sends keep the flat
120 s) — a 200-page translate-all no longer churns 120 s timeout resets; the
background finishes + caches, so late pages render as instant cache hits on
scroll. Mid-session `prefetchAhead` is now live (`ViewportQueue.setPrefetchAhead`,
applied on every settings apply in `content/index.ts`) — closes the Phase 5
accepted no-op. `concurrency` was already live per-request via
`getTranslationQueue`; pinned with a test (same instance, re-tuned each call), not
rebuilt.

**§4 — endpoint-mode persistence (PROMPTS §5.2, deferred from Phase 6).** The
OpenAI-compatible `json_schema`→`json_object` downgrade memo now PERSISTS across
event-page lifetimes via new `background/endpointModes.ts` owning a **separate
`storage.local` key** (NOT `Settings` — a settings write broadcasts to every tab
and re-runs the content gate; this is background-internal state with no UI
surface). Load-once-per-lifetime into the sync in-memory memo (hydrated at
background startup), write-through on learn (hydrate-before-persist so a fresh
learn never clobbers a previous lifetime's other endpoints), fail-soft on any
storage fault (a lost memo re-pays one 400). `openai.ts` reads `getEndpointMode`/
`learnEndpointMode` and re-exports `resetEndpointModes` so the test seam keeps
working.

**§5/§6 — e2e infrastructure + acceptance criteria.** `tests/e2e/mockProvider.mjs`
is a dependency-free Node server: OpenAI-compatible `POST /v1/chat/completions`
(counts image blocks — 1 → single-page JSON, N → a `pages` array of N, so
batching is e2e-exercisable; 2 s default latency), `GET /v1/models` (the options
Test path), `GET /stats` + `POST /reset` (the harness request log), and a static
host for `chapter.html` + its page images served as SEPARATE http URLs (not data
URIs, so the perf run exercises the real §7.3 background-fetch path; page 3 is a
`blob:` URL for the 7.2 bytes path). `tests/e2e/smoke.spec.mjs` (selenium-webdriver
+ geckodriver, node's built-in `node:test`; the UUID is pinned via the
`extensions.webextensions.uuids` pref BEFORE `installAddon(zip, temporary=true)`)
carries Scenario A (10-page chapter < 5 s cold + warm cache hits with ZERO new
provider requests), B (translate-all @ `pagesPerRequest=3` → 4 ceil-batched
requests = 3+3+3+1, 10 images), and C (100 SPA swaps → overlay-host-count
stability, the leak proxy — Firefox exposes no `performance.memory`). Assertions
are on observable behavior only (DOM `OVERLAY_HOST_ATTR` hosts + `.mangalens-bubble`
paint state; the mock's `/stats`). e2e is **excluded from `npm run check`** (the
unit vitest config globs `tests/unit` only). **DRIVER: selenium-webdriver +
geckodriver** (chosen over Playwright, whose Firefox build doesn't reliably
support extensions — the handoff's stated fallback, and the more robust addon-
install path). **STATUS: the mock provider is self-verified end-to-end via Node
(single→3 regions, 3-image batch→3 pages, token scaling, /stats, chapter + SVGs);
the full browser run (`npm run test:e2e`) was NOT executed in this implementation
session — no geckodriver installed and no headless display in the coding
environment. Recorded honestly, exactly as every prior phase's manual/live pass
was. The `.mjs` (not `.spec.ts`) extension is a deliberate call: it runs under
`node --test` with zero TS-build step for e2e (documented in `tests/e2e/README.md`).**

**§7 — memory audit (findings; no fixes required).** Existing teardown verified
sound: `OverlayManager.stop()` cancels both rAF handles, tears down every entry
(per-image `ResizeObserver.disconnect`, `load` listener removed, host removed,
entry + its `paintedRects` dropped with the map), and removes all three shared
window listeners; `content/index.ts` `deactivate()` drops scanner → queue →
region selector → overlay → toast in order; the `!el.isConnected` guard in
`ensure()` (Phase 7.1) still covers the render-after-removal race, no sibling
case remains. NEW Phase 8 background registries all have guaranteed removal on
success, error, AND abort: `requestIdToCacheKey` (translateImage `finally`),
`queuedHandles` (solo path `finally`, `executeBatchGroup`/`runPulledMemberSolo`
`.finally()` delete-if-still-ours), the batch collector groups (flush/remove
delete the group + cancel its linger timer), and the batch SharedAbort waiters
(`stops` cleaned in `finally`). The leak criterion itself is Scenario C above
(DOM-count stability).

**§8 — AMO listing prep (the deferral thread closes).** Added
`browser_specific_settings.gecko.data_collection_permissions: { required:
["websiteContent"] }` — the honest declaration (page images → the user's chosen
provider only; no analytics/telemetry/first-party server); older Firefox ignores
the key so NO `strict_min_version` bump was needed. **`web-ext lint` now ends
0 errors / 0 warnings / 0 NOTICES** — the `data_collection_permissions` notice
every prior phase summary carried is gone. The popup/options static-string i18n
migration landed: a pure `resolveI18n` core (`shared/i18nDom.ts`, over `t()`) +
a `data-i18n` walker in each page's `main.ts` (the DOM walk is shell), with
strings in `public/_locales/en/messages.json` and each element's English text as
the fallback (a missing key keeps the English wording — never `__MSG_` soup, never
an empty node). The `pagesPerRequest` options hint is now the batching
recommendation. `docs/PRIVACY.md` (keys local-only, images → chosen provider
only, local IndexedDB cache, no first-party server) and `docs/AMO-LISTING.md`
(name/summary/description + permission-by-permission rationale + screenshots
checklist) added. `npm run build:ext` (`web-ext build`) produces the submittable
`mangalens-0.1.0.zip` — verified.

**Design choices flagged (recap):** §0 button as a deliberate reversal of the 7.6
"auto supersedes the button" call (both coexist); batching opt-in vs Architecture
§6's "2–3 default"; batch results under the unchanged cache key; upgrade-only
re-prioritization with scroll-away cancel/downgrade decided-against; endpoint
modes in a separate storage key; `createProvider` widened to `ProviderBase`;
selenium+geckodriver over Playwright. **Out of scope (unchanged):** screenshot
capture fallback, canvas auto-translate, export/import (F16), reading-direction
bubble ordering (F18), local pipeline (F20), inpainting, `npm run eval:live`,
signing/submission automation, Chrome port.

**Tests — 627 total green** (was 549; +78). New: `batch.test.ts` (eligibility ×
signature × planFlush × classifier × collector grouping/linger/remove);
`endpointModes.test.ts` (learn→persist, rehydrate, no-clobber merge, corrupt-heal,
storage-reject, hydrate-once); `i18nDom.test.ts` (walker mapping + missing-key
fallback); `manifest.test.ts` (data-collection shape pin);
`translateHandlersBatch.test.ts` (collector wiring — members resolve/cache
individually, usage once, split-retry solo, fail-all, priority-0/1 stay solo,
pagesPerRequest=1 off; reprioritize pull-out solo / setPriority / no-op /
cleanup). Extended: `providerBase` (translateBatch golden 3-page parse + order +
wrong-length + usage split + repair + refusal + auth/empty); `providers`
(per-adapter batch request shape); `prompt` (batch user text + batch schema
dialects + corner-desc carry-through); `queue` (addJob/setPriority reorder,
min-never-worsens, false-after-start, add-wrapper); `viewportQueue` (planEnqueues
upgrades, hydrateAll, requestAllTimeoutMs, budget/setPrefetchAhead shell, upgrade
shell); `contentRouter`/`popupLogic` (hydrateCached / canShowCached);
`translateHandlers` (getTranslationQueue live concurrency). Two new golden
fixtures (`batch_3_pages.json`, `batch_wrong_length.json`). Typecheck + eslint
clean; `vite build` clean (background ~41.3 → ~50.8 kB with batch + endpointModes;
content ~33.2 → ~34 kB); `web-ext lint` **0 errors / 0 warnings / 0 notices**.

**Manual + live verification — STATUS: NOT executed in this implementation
session** (no live Firefox + real key + a driver/display in the coding
environment). Recorded honestly, as every prior phase's was. The handoff's manual
steps are ready against the built `dist/` (load, grant, real key,
`pagesPerRequest = 3`): (2) translate-all shows multi-image batched requests, all
pages render, the cost line moves once with sane totals; (3) scroll far ahead
during a translate-all → the under-viewport page jumps the queue; (4) change
`prefetchAhead` mid-session → takes effect without a toggle; (5) break the key
mid-batch → one auth toast, no unhandled-rejection noise; (6) `about:addons`
shows the data-collection disclosure, popup/options render localized; (7) the §0
Show-cached button on an auto reader after toggle-off/on → cached pages re-render
with ZERO `v1/messages` and no cost movement; a never-translated tab reports "No
cached translations here". **The still-outstanding Phase 7 manual pass** (and its
predecessors) remains a human/live step by nature — the e2e mock harness covers
the pipeline structurally; the live-key round trip is recorded as outstanding, not
faked.

## Phase 8.1 summary (Phase 8 review verdict: turn the e2e green + close the surfaced bugs)

Phase 8 was statically green (typecheck, ESLint, unit, `web-ext lint` 0/0/0) but
its e2e suite — run for the first time on the target Windows machine with a real
headless Firefox — **failed 2 of 3 scenarios**, and the failure analysis surfaced
one real product bug plus a set of §2/§5 races. Phase 8's DoD line "`npm run
test:e2e` green" was therefore not met. Phase 8.1 closes it. **`npm run test:e2e`
now runs all three scenarios GREEN on this machine** (verified repeatedly:
Scenario A cold+warm, B 4-ceil-batched requests / 10 images, C non-vacuous
leak-stability); `npm run check` **632 tests** (was 627, +5), `npm run build`
clean, `npm run lint:ext` still **0/0/0**. No new messages, no manifest change, no
`shared/types.ts` change, `PROMPT_VERSION` untouched.

**Four e2e root causes fixed (mock/spec-side, no product decode hack).**
- **§1 [BLOCKER] SVG pages can't be decoded.** `mockProvider.mjs` served pages as
  **SVG**, and Firefox's `createImageBitmap` REJECTS SVG blobs, so every job died
  at `prepareImage` before any provider call (Scenario C's prior ✔ was vacuous —
  zero overlays ever painted). Fix: the mock now serves **hand-rolled raster PNGs**
  (a ~40-line `node:zlib` encoder — CRC32 table + IHDR/IDAT/IEND chunks over
  filter-0 scanlines; no image dependency). Each page's bytes differ (per-index
  background + moving stripe) so page identity (content hash) stays distinct — else
  all 10 would collapse to one cache entry. Did NOT teach `prepareImage` to decode
  SVG (manga pages are never SVG; that would be product code for a test's
  convenience). A standalone self-check (`node tests/e2e/mockProvider.mjs`) asserts
  the fixtures are valid, distinct PNGs.
- **§2 [BLOCKER] The grant click hit a button that never appears.** A temporary
  install auto-grants `<all_urls>`, so the options page correctly keeps `#grant-perm`
  hidden — the old unconditional click died `ElementNotInteractableError`. Fix
  (spec-side): ask `browser.permissions.contains({origins:["<all_urls>"]})` and skip
  the click when already granted; the click path is kept for non-auto-granting
  install modes and now waits for `elementIsVisible` (the button is revealed async),
  not mere presence. The options page was correct and untouched.
- **§3 [BLOCKER] Scenario B destroyed the chapter tab before messaging it.**
  `driver.get(options)` navigated the SAME tab that held `chapter.html`, so
  `tabs.query` found no chapter tab and the async script hung to timeout. Fix
  (spec-side): a shared `translateAllOnChapter()` helper opens the privileged
  extension page in a SECOND tab (`switchTo().newWindow`), keeps the chapter tab
  alive, sends `translateAll`, and switches back — with an explicit `done('NO TAB')`
  fail-fast path so a miss fails with a message instead of hanging.
- **§4 [PRODUCT BUG] A lone linger-flushed member went out as a batch-of-1.** 10
  pages at `pagesPerRequest=3` size-flush three groups of 3, then the 10th
  linger-flushes as a group of **1** — which `runBatchGroupTask` sent through
  `translateBatch` as a one-image batch-shaped request. Against a provider that
  returns a single-page body for one image (the mock, and the real single-page
  contract), that response has no `pages` array → malformed → one whole-batch repair
  retry → still single-page → split → solo retry: **6 requests / 12 images where 4/10
  was asserted**, and in production it's strictly worse than solo (the batch envelope
  amortizes nothing over one page and swaps the proven single-page prompt for the
  batch one). Fix (product-side, in the collector executor only): when exactly ONE
  single-tile member remains, route it through the existing `translateSoloAndSettle`
  (single-page path, records its own usage) instead of `translateBatch`.
  `translateBatch` itself stays able to take 1 job (unit-tested, harmless); the
  collector just never sends it one. With this, Scenario B measures a true 3+3+3+1 =
  **4 requests / 10 images**. 🧪 `translateHandlersBatch.test.ts`: a lone
  linger-flushed member never calls `translateBatch` (solo path, one usage event);
  10 @ batch 3 → exactly three `translateBatch(3)` + one solo = 4 provider calls.

**§5 — pre-registration reprioritize race: FIXED (not accepted).** `translateImage`
registers `requestId → cacheKey` only AFTER the image fetch + hash + cache lookup;
for a prefetched page that fetch can take seconds, and a `reprioritizeTranslation`
landing in that window found no mapping → silent no-op. Because the content side had
already optimistically stamped the better `sentPriority` and IntersectionObserver
fires on transitions only, the upgrade was never re-sent — the page stalled at
priority 2 behind the whole backlog, i.e. the exact §2 symptom recurring in a timing
window. Fix (background-side, smallest): a bounded `pendingReprioritize: Map<requestId,
priority>` buffers an upgrade that arrives before registration; the miss drains it in
the SAME synchronous turn it registers the mapping (no await between, so a later
reprioritize instead finds the mapping and applies directly — neither path drops the
upgrade), and the `finally` that clears `requestIdToCacheKey` also clears it. The §2
apply logic (collector pull-out-and-run-solo, else `setPriority`) is now a shared
`applyReprioritize`. The **content side is untouched**: the sibling blob sub-race
(`sendUpgrade` returns early while `acquireBytes` is in flight, before `requestId` is
stamped) is left **accepted** — `sendUpgrade` needs a stamped `requestId` to send at
all, and a revoked blob heals via a fresh scanner candidate, not a re-send. 🧪 buffer
before registration → applied on the miss's registration + drained (not leaked); the
buffer is bounded (oldest evicted past 500).

**§6 — Scenario A acceptance mechanics: translate-all (measured, not guessed).**
With the decode fixed, Scenario A still timed out — and instrumentation showed only
**4 of 10 pages were ever requested** even at 30 s budget and `prefetchAhead=10`: in
a headless ~1366×768 viewport over 800×1200 pages, pages register progressively, so
page 1's first tier-0 fires before pages 5–10 exist in the ordered list and prefetch
clamps to the ones present; the below-fold pages then get no visibility event without
scrolling. So a large `prefetchAhead` alone is insufficient (coverage, not timing).
Chosen mechanic (the handoff's sanctioned option 3): **assert the acceptance on
translate-all** — it enqueues all 10 at once → the intended ~two concurrency-6 waves
at 2 s latency, which paints all 10 well under the 5 s budget (measured cold ≈ 3–4 s,
warm cache-hit paint < 2 s with ZERO new provider requests). Scenario A stays an auto
site; the cold and warm passes both trigger `translateAllOnChapter()`. Scenario C now
asserts a real cycle-1 paint (>0) so its host-count stability is a genuine leak check,
not vacuously true.

**§7 — smaller findings.**
- **endpointModes clobber window: FIXED.** `loadEndpointModes` latched on a boolean
  that flipped synchronously before the startup `storage.get` resolved, so a
  `learnEndpointMode` racing the hydrate persisted a memo missing the previous
  lifetime's entries (storage stayed clobbered until the next learn). Now it latches
  on the hydrate **PROMISE** (`let hydrating: Promise<void> | undefined`), so the
  write-through awaits the merge and persists the union. 🧪 a learn racing an
  in-flight (gated) startup hydrate no longer clobbers `{old}` with `{new}`.
- **`requestAll` timeout budget uses construction-time concurrency: ACCEPTED.** A
  mid-session concurrency change doesn't update the estimate, but it is only a
  timeout heuristic (the background finishes + caches regardless), so wiring a live
  setter would add surface for no correctness gain — recorded as accepted.
- **i18n scope — Phase 8's summary OVERSTATED it (correction).** The accurate scope:
  the **popup** HTML is fully `data-i18n`-covered (15 keys) and its title/hint
  strings are localized; the **options** page has only two `data-i18n` attributes
  (title + the `pagesPerRequest` hint), and the popup's TS-built feedback strings
  (Show-cached tooltips, action-status text) remain English literals rather than
  `t()` keys. This is harmless while `en` is the only locale — the fallback is the
  literal English wording, never `__MSG_` soup or an empty node — so the remaining
  options/TS sweep is deliberately deferred rather than done in this fixes phase.

**Unchanged / out of scope (recap):** everything Phase 8 already excluded
(screenshot fallback, F16/F18/F20, inpainting, `eval:live`, signing, Chrome port);
the selenium+geckodriver driver (proven working on this machine — kept); and the
live-key manual pass, which remains a human step (the e2e mock harness covers the
pipeline structurally). **Tests — 632 green** (+5: the §4 batch-of-1 pair, the §5
buffer + cap pair, the §7 latch regression). Typecheck + ESLint clean; `vite build`
clean; `web-ext lint` 0/0/0; `npm run test:e2e` **3/3 green on this machine**.

## Phase 8.2 summary (live-pass findings: recurring temperature-400 + batch output cap)

The first live-key pass over the Phase 8 build (Anthropic `claude-sonnet-5`,
2026-07-16) surfaced one recurring waste, one real batch defect, and two
symptoms that turned out to be working-as-designed; the two code issues are
fixed, everything stays green.

**§1 — the recurring `v1/messages` 400 (fixed).** The captured HAR showed every
fresh session opening with `POST /v1/messages → 400 "temperature is deprecated
for this model"` before the Phase 3.1 learn-on-400 strip retried successfully.
Root cause: the sampling-rejection memo was a module-level `Set`, so the
event page unloading (~30 s idle) forgot it and re-paid the 400 on every wake —
and at concurrency 6 a fresh page can fire several temperature-carrying requests
in parallel before the first 400 lands. Fix: `endpointModes.ts` was generalized
into a `createPersistedMemo` factory (the §4 hydrate-latch + merge semantics,
now shared) with TWO instances — the existing per-endpoint OpenAI mode memo
(public API unchanged) and a new persisted `mangalens:sampling-reject` memo
that `anthropic.ts` reads/learns and `background/index.ts` hydrates at startup.
One 400 per model EVER, not per lifetime. 🧪 sampling memo: sync learn +
own-key persist, fresh-lifetime rehydrate, corrupt-value skip; providers: a
rejection persisted by a previous lifetime → ONE request, temperature omitted.

**§2 — batch `max_tokens` never scaled (fixed).** Phase 8's
`buildBatchRequest` (Anthropic) kept the single-page `max_tokens: 8192` for up
to 4 pages, so a dense batch truncates mid-tool-input → reads as malformed →
burns the ONE whole-batch repair on a re-generation that truncates again →
splits to solos: ~3× the latency (and token spend) before anything renders —
a plausible contributor to the observed "30+ s and nothing paints" with
`pagesPerRequest ≥ 2`. Fix: `max_tokens = min(8192 × pages, 32000)` (32000 =
the lowest max-output limit among active Claude models, legacy Opus 4.1).
Gemini's batch cap is deliberately NOT scaled — the default `gemini-2.0-flash`
hard-caps output at 8192 and Gemini 400s an over-limit `maxOutputTokens`, so
scaling would break batching on the shipped default; WHY-noted in-source.
🧪 batch body: `max_tokens` 2×8192 at n=2, capped 32000 at n=4.

**§3 — revoked object URLs killed every blob-sourced page (fixed).** The second
live pass (same evening) hit it head-on: on a MangaDex chapter, translate-all
INSTANTLY error-badged every panel and drag-select was dead, with ZERO
background network traffic — while a plain-https image on the same site
translated fine. Root cause: real readers call `URL.revokeObjectURL` as soon
as the `<img>` paints, so the Phase 7.2 bytes path (`fetch(blobUrl)`
content-side) throws for anything not acquired within ms of page load; the
badge was `sendTranslate`'s instant fail-soft on acquisition. The Phase 8 e2e
blob page never revoked its URL, which is why the harness stayed green. Fix
(`imageSource.ts`): `acquireBlobBytes(url, el?)` — on a failed fetch, read the
still-displayed decoded bitmap back out of the live `<img>`
(`createImageBitmap(el)` → `OffscreenCanvas` → PNG; PNG not JPEG so the
pipeline keeps a single lossy generation — prep's JPEG re-encode). The
`acquireBytes` seam now carries the candidate element (send + hydrate-probe
call sites in `viewportQueue.ts`, `defaultAcquireSource` in `regionSelect.ts` —
drag-select heals via the same two lines). Fallback bytes hash under their own
cache key (re-encode ≠ original file bytes) — accepted, deterministic per
browser, and a revoked URL never heals so a page consistently takes one path.
The e2e chapter's blob page now REVOKES its URL on load, turning Scenarios A/B
into the regression test (they assert all 10 pages paint, so a broken fallback
fails the suite). 🧪 imageSource: fallback on revoked fetch (bitmap read,
released), original error rethrown for non-`<img>` hosts, element untouched on
a healthy fetch; viewportQueue assertions extended to the 2-arg seam.

**Diagnosed, not bugs:** (a) a page whose only detected region is SFX renders
an empty overlay under the default `translateSfx: false` (the live test image
was artwork with one ㋡ mark — regionFilter dropped it correctly); (b) long
quiet stalls under skeletons are the Phase 7.2 rate gate pacing out 429s from
a tier-1 key (8 s → 16 s → 32 s global cooldown) — lower `concurrency` (or keep
`pagesPerRequest` at 1–2) on low-tier keys; the gate currently has no UI
surface, noted as a possible later refinement (a "rate-limited, waiting" toast).

**Tests — 640 green** (+8: 3 sampling-memo, 1 previous-lifetime provider, 1
batch max_tokens pair, 3 revoked-blob fallback). Typecheck + ESLint clean;
`vite build` clean; `web-ext lint` 0/0/0; `npm run test:e2e` 3/3 green on this
machine — now including the revoked-blob regression.

## Phase 9 summary (reading-window prefetch budget + shaped bubble fills)

Driven by the sixth live pass (2026-07-17, Anthropic `claude-sonnet-5`): the HAR
showed **14 `v1/messages` POSTs in one 25-second burst** on opening a chapter at
the top of an auto-opted reader — the whole chapter went out where ~5–6 pages
were expected. Two root-cause layers: (a) structurally, `planEnqueues` bounded
only the *extra prefetch per event* — every candidate the browser reported as
intersecting was sent at its own tier, with no global budget; (b) manga readers
generate **false tier events during load** (lazy-load accordion parking image N
at the fold; stacked pages hidden via `opacity`/`visibility`, which still
"intersect" to an IntersectionObserver), so "reported as intersecting" vastly
overstates "being read". Item A makes `prefetchAhead` a hard invariant; item B
(the user's bubble-taxonomy request) keeps the contour the `bubbleSnap` flood
fill already computed and threw away, so fills hug the drawn bubble instead of
covering art with a rounded rectangle.

**§1 — the reading-window budget (viewportQueue).** No auto-send (visibility
tier OR prefetch) may target a candidate more than `prefetchAhead` positions
past the furthest page the user has *confirmed* visible. The cursor is DERIVED
per plan (`deriveCursor` over element-keyed `confirmedVisible` flags in doc
order — a stored number would go stale on lazy registration/unregistration;
unregistering the cursor holder falls back to the next confirmed index). The
gate lives in the pure planner (`PlanInput.cursor`; fresh sends beyond
`cursor + prefetchAhead` become `suppressed` instructions; `cursor: undefined`
suppresses every fresh send), NOT in `sendTranslate` — so `requestAll`
(translate-all), drag-select, hydrate probes, and priority UPGRADES of
already-paid jobs all bypass the window untouched. Suppressed candidates are
re-observed when the window slides over them (the existing transition-only-IO
`reobserve()` workaround), and raising `prefetchAhead` live also widens + slides
(implementer's call — without it a suppressed page would ignore the new setting
until the next cursor advance). The options `prefetchAhead` hint now states the
guarantee (options HTML + `_locales`).

**§2 — tier-0 confirmation (what makes the cursor trustworthy).** A tier-0 IO
event no longer advances the cursor directly: after `CONFIRM_DELAY_MS` (300 ms,
injectable) the layout is re-read and must show a meaningful overlap
(`classifyConfirm`: at least min(48 px, half the candidate's height), pure) and
pass `checkVisibility({opacityProperty, visibilityProperty})` (feature-detected,
fail-open — the window still bounds the damage). Confirm-then-plan applies ONLY
to cursor advancement: an unconfirmed tier-0 *within* the current window sends
immediately (inside the accepted budget → zero added latency while reading
normally); a mid-chapter jump pays one ~300 ms confirm before the window
recenters. Tier-1 (near) events are never confirmed — they can't advance the
cursor and the window already bounds them.

**The §2 flaw the new e2e caught (design deviation, deliberate).** The handoff
specified "on reject: drop silently; the observer pair will fire again on the
next real transition". Scenario D proved that assumption wrong for the NORMAL
reading path: a page's only tier-0 transition fires when it first pokes into the
viewport with a few-px sliver, the 300 ms re-read still sees a sub-48 px
overlap → reject — and scrolling *deeper into* the page never fires another
IntersectionObserver event, so the cursor wedged at the fold and everything
beyond stayed suppressed (8/10 pages painted; an instrumented headless run
showed "overlap 42 px < 48" rejects for every page past the fifth — note the
real headless viewport is 682 px, not the 768 window height). Fix: a rejected
confirm now RETRIES on a capped exponential backoff (600 → 1200 → 2400 ms,
reset by any fresh transition) *while the element still overlaps the viewport
at all* (`classifyConfirm` verdict `retry`); a fully-departed streaker is a
`drop` and stays transition-driven. `checkVisibility` rejects also retry —
which incidentally makes opacity-stacked readers advance the cursor within
~2.4 s of a page flip (an opacity change fires no IO event either). Polling
cost is bounded: only unconfirmed candidates physically overlapping the
viewport, at 2.4 s intervals once backed off.

**§3 — contour capture (bubbleSnap).** `floodFill` now records a `filled` mask
(separate from `visited`, which includes dark boundary rejects) plus running RGB
sums. On an ACCEPTED fill only: dilate 1 px (3×3 — replaces the scalar bbox pad
for the shape; the bbox pad itself is unchanged), trace the outer boundary with
marching squares (outer contour only — glyph holes are covered automatically;
saddles disambiguated by walk direction; any non-boundary state or step-cap
overrun aborts the trace and keeps the bbox), simplify with Douglas-Peucker at
epsilon = 1 snap-px (doubled once, then uniform subsample if still over the
64-point cap), convert to full-image fractions clamped [0, 1] and rounded to 4
decimals (~1 KB/region worst case in the cache's JSON sizing).
`snapRegionToBubble` now returns `{ bbox, shape?, fillColor? }` (`SnapResult`,
module-local API); `snapAllRegions`/`splitGroup`/`applySwallowGuard` updated
mechanically — the 7.6 windowed per-lobe re-fills produce per-lobe contours
with zero extra mechanism. Shapes are CACHED exactly as snapped boxes are
(deterministic memoization, the 7.5 precedent), so reloads replay shaped fills
with zero spend. **NO `CACHE_VERSION` bump** — the fields are additive;
pre-Phase-9 entries render rectangles until they age out (retiring the store
would re-pay provider $ for every cached page, the cost the 7.6 precedent
refused). Drag-select clamps only the bbox; out-of-selection shape points are
cropped at render by the box's `overflow: hidden` (no polygon-clipping code).

**§4/§5 — shaped fill render (`overlay/shapePath.ts` + BubbleBox).** New pure
module: `shapeToBoxPath` (image-normalized points → box-local px via
`(s − bbox) × rect/bbox.w`, Catmull-Rom → cubic Bézier, closed SVG path at
0.1 px — correct even for a `trimOverlaps`-trimmed or drag-clamped bbox copy
because the trimmed bbox and box rect describe the same displayed
sub-rectangle, so out-of-box points just land outside [0, rectW] where
`overflow: hidden` crops), and `inscribedInnerRect` (largest centered scale of
the padded inner box whose corners lie inside the polygon, binary search,
floored at 0.6×). BubbleBox applies the path as `clip-path` on the FILL LAYER
ONLY (text is never clipped), box radius drops to 0 with a shape (rounded
corners would crop a near-rectangular traced bubble), text fits + centers in
the inscribed rect, peek keeps the shape with the dashed cue on the box. Resize
repaints re-run the whole function — no new listeners, no cached px.
`PADDING_RATIO` moved to shapePath (pure module), re-exported from BubbleBox.
§5 fallback: an UNSHAPED bubble/thought with aspect w/h in [0.4, 2.5] renders
`border-radius: 50%` with the text box at 1/√2 of the inner rect
(`fallbackRadius`, a single independent pure decision so a bad live pass can
revert §5 alone). **Flagged risk, accepted:** an ellipse inscribed in a *tight*
provider box can leave glyph corners uncovered; 7.5 evidence says provider
boxes are loose.

**§7 — sampled fill color + dark polarity.** The fill's mean RGB accumulates
during the fill (three sums + count, no second pass) → `region.fillColor` hex.
Render: a sampled color wins over `font.bubbleFillColor` — **deliberate call,
flagged**: the sampled color IS the bubble's actual paper color (visually
identical for the common white bubble); settings-gate later if contested. Pure
`pickTextStyle` flips to light text + dark stroke when fill luma < 128. Dark
polarity: when ALL nine seeds are dark (≤ `DARK_CEILING` = 80), the seed loop
re-runs inverted (fill luminance ≤ min(darkCeiling, seedLum + tolerance) —
mirroring the light path's max()), same min-area/leak guards, same kind gate —
flash/inverted-flash bubbles get a dark shaped fill with light text instead of
a white rectangle punched into black art. Mixed light/dark seeds keep the light
path only.

**Contract change (the ONE sanctioned `shared/types.ts` change, rule 4):**
`TranslatedRegion` gains `shape?: Array<[number, number]>` and
`fillColor?: string` — both optional, both additive; absent fields render
exactly the pre-Phase-9 rounded rect. NO new `messages.ts` entries (shape/fill
ride inside `PageTranslation`), no manifest change, `PROMPT_VERSION` = 2 and
`CACHE_VERSION` = 2 untouched.

**§6 — e2e Scenario D.** The 2026-07-17 failure as a permanent assertion: fresh
cache, auto site, chapter opened at the top, NO translate-all, ~8 s wait →
`1 ≤ chatRequests ≤ 6` (1366×768 over 800×1200 pages: 1–2 visible + 1–2 near +
3 prefetch; observed: exactly 4), then stepped scroll to the bottom → all 10
pages paint (the window slides; nothing wedges — this assertion is what caught
the §2 sliver-wedge). Scenarios A–C pass UNMODIFIED (A/B use translate-all,
which is itself the §1 bypass test; C's auto path re-confirms per swap cycle).

**Tests — 694 green** (+54: window-gate/cursor/confirm planners + shell
scenarios in `viewportWindow.test.ts` incl. the sliver-retry and hidden-stack
heals, contour capture + dark polarity + sampled color in `bubbleSnap.test.ts`,
`shapePath.test.ts` for path mapping/inscribed rect/fallback table/text flip;
existing viewportQueue + bubbleSnap suites updated mechanically — generous
cursor, confirm seams, `.bbox` accessors). Typecheck + ESLint clean; `vite
build` clean; `web-ext lint` 0/0/0; **`npm run test:e2e` 4/4 green on this
machine** (A 7.8 s, B 7.6 s, C 3.7 s, D 18.5 s).

**Manual verification: NOT run** (needs a live key + real reader). The
handoff's manual list is outstanding — in particular: confirm which reader the
2026-07-17 HAR came from, the ≤ ~6-requests-in-minute-one check on that reader,
shaped fills on oval/cloud/wavy/thought + the 7.6 Eminence joined-bubble page,
cached-shape replay on reload, drag-select clamp, a dark/inverted-flash page,
peek, and pre-Phase-9 cache-entry compatibility (do NOT clear the cache first).

## Phase 9.1 summary (fill fidelity, placement rescue, cost hardening)

Driven by the **seventh live pass** (2026-07-18, MangaDex confirmed via the HAR's
`mangadex.org` entry, Anthropic `claude-sonnet-5`) — the first live pass over the
Phase 9 shaped fills + reading-window budget. What it ESTABLISHED (not
re-litigated): the Phase 9 budget **held at chapter open** — 1 request at t=0 vs
14 the day before on the same chapter — and the later 21-request sequence was
fully explained (cache cleared, auto toggled ON mid-chapter, whole chapter
skimmed → scroll-driven purchases at `prefetchAhead: 3`). What it exposed
(screenshot-verified defects): a 1–3 display-px rim of original ink around many
shaped fills; a grey patch on white bubbles (the sampled MEAN reads `#e6e6e6`);
offset provider boxes that escape the snap and paint a loose white ellipse over a
neighbour beside still-visible original text; a neighbour's opaque fill painting
over an earlier bubble's text; and two cheap holes in the reading window
(unloaded placeholders can confirm; backward scrolling buys instantly). Nine
fronts, all tuning/hardening the Phase 9 machinery — nothing rebuilt.

**§1 — close the ink rim (bubbleSnap).** Root-cause arithmetic (in the WHY
comments): the snap bitmap's long edge is capped at 512, so 1 snap-px ≈ 2–2.5
display px; the fill stops ~1–1.5 snap-px inside the ink, the ε-doubling shaved
convex edge, and Catmull-Rom undershot arcs → the fill edge landed ~4–6 display px
inside the true boundary. Fix: new pure `offsetPolygonOutward(points, offsetPx)`
pushes each vertex out along its vertex normal (average of adjacent edge normals;
orientation from the ring's SIGNED AREA, not a centroid — a concave contour has
vertices on the far side of any centroid), applied AFTER simplification in snap-px
BEFORE normalization (rule 5). `SHAPE_OUTWARD_OFFSET_PX = 1` (dilation 1 + offset 1
≈ 2 snap-px ≈ 4–5 display px, covers the AA halo and *kisses* the ink line — the
tuning knob, raise to 1.5 if rims persist). Dropped the ε-doubling escape in
`traceBlobShape`: simplify ONCE at ε=1, then straight to uniform subsampling
(keeps vertices ON the boundary). Self-intersection at 1 px is negligible and
accepted (a degenerate ring still renders inside the `overflow: hidden` box).

**§2 — median fill color + paper snap (bubbleSnap).** Replaced the running RGB
mean (`sumR/G/B` + `blobMeanHex`) with three 256-bin per-channel histograms
accumulated during the fill (memory ≈ 3 KB, still one pass) → per-channel MEDIAN
at accept (`blobFillHex`), immune to the AA fringe that dragged the mean grey.
**Paper snap:** median luma ≥ `PAPER_WHITE_LUMA` (245) → `#ffffff`, ≤
`PAPER_BLACK_LUMA` (12) → `#000000`; a genuine mid-grey screentone stays its
median grey. The existing uniform-230 fixture still samples `#e6e6e6` (below the
snap); the dark ellipse still `#1e1e1e`.

**§3 — raw regions in cache + `SNAP_VERSION` local re-snap (the user's testing
workflow).** The user clears the cache between fill tests to see snap changes,
**re-paying the provider for translations that did not change**. Fix: cache the
provider's RAW regions alongside the snapped result and re-snap LOCALLY when the
snap-logic version changes. `SNAP_VERSION = 1` in bubbleSnap (bump on any future
snap-output change; **NEVER in `buildCacheKey`**, ground rule 8 — a key change
would re-pay the provider for every page, the exact cost this eliminates).
Threaded the pre-snap `rawPage` through the solo + batch paths (new internal
`SnapPair`/`TranslateOutcome` types; the batch collector's result generic is now
`SnapPair`). Cache-hit path: `classifyResnap(record, SNAP_VERSION, hasBytes)` (pure,
unit-tested decision table) gates a one-time re-snap on a positive hit whose stored
`snapVersion` lags + retained `rawPage` + the request carries bytes; it re-runs
`snapPageRegions(blob, record.rawPage)`, serves + writes back the re-snapped page
with the bumped version (so it runs once per page per version), and any failure
serves the cached page as-is (rule 6). Full-page entries only (a drag-select crop's
recovery was not worth the extra plumbing — WHY-noted). After this ships, §1/§2-style
tuning costs **zero provider dollars** on already-paid pages.

**§4 — seed rescue for offset provider boxes (bubbleSnap).** After the light +
dark seed loops both fail, a rescue pass samples a fixed 5×5 grid over the provider
box expanded 25 % per side (clamped to image/window) and runs the LIGHT-path fill
from each qualifying seed (dark path stays flash-only — rare and rarely offset).
**Acceptance guard:** the accepted blob's bbox must cover ≥
`RESCUE_MIN_PROVIDER_OVERLAP` (0.4) of the ORIGINAL provider box, else the rescue
wandered to a neighbour → null (today's loose box, rule 6). A leak/min-area on a
grid point `continue`s (unlike the main loops' abandon) — the box is offset, so one
background seed leaking says nothing about the target bubble. Rescued results flow
through the existing accept path unchanged.

**§5 — centroid-centered inscribed text rect (shapePath + BubbleBox).**
`inscribedInnerRect` now centers the binary search on the polygon's AREA centroid
(pure `polygonCentroid`, exported + tested) instead of the box center, and returns
the rect at that centroid clamped inside the box — an asymmetric shape no longer
shrinks to the 0.6× floor and spills text outside itself. A symmetric shape's
centroid IS the box center, so it reduces to the Phase 9 result (the slab/circle
regressions hold within FP epsilon). BubbleBox positions the shaped label
EXPLICITLY (a wrapper at the inscribed rect that flex-centers it) rather than
relying on box flex centering; the no-shape paths (padded rect, ellipse) keep flex
centering.

**§6 — fills paint under ALL labels (BubbleBox).** `z-index: 1` on every fill
layer, `z-index: 2` on every label. WHY it works across boxes: the box divs stay
`position: absolute; z-index: auto` with no transform/filter, so they do NOT form
stacking contexts — every label interleaves above every fill in the one overlay
root context. A WHY comment on the box style guards the invariant ("adding
z-index/transform/filter to the box breaks §6 layering").

**§7 — gate the §5 ellipse to snapped regions (BubbleBox).** The ellipse fallback
now fires only when `region.fillColor !== undefined` — the snap sets `fillColor`
exactly when a blob was accepted, so it is a reliable "this bbox is tight" proxy
with no new contract field. An UNSNAPPED (loose) bubble/thought keeps the pre-Phase-9
8 px rounded rect (small spill, soft corners — strictly less harm than a white oval
on a loose box). The pure `fallbackRadius` table is unchanged; the proxy lives at
its call site (kind×aspect stays the table's only inputs).

**§8 — anchored reading window (viewportQueue).** Generalized the single Phase 9
cursor to ANCHORS: a fresh send at index `i` is allowed iff some CONFIRMED index
`j` satisfies `i − prefetchAhead ≤ j ≤ i` — the reading window is the UNION of each
anchor's forward `[j, j + prefetchAhead]` range (pure `anchoredWindowAllows`,
O(prefetchAhead) backward scan, replaces `PlanInput.cursor` with `confirmed:
boolean[]`; `deriveCursor` deleted). Contiguous forward reading stays byte-identical
to Phase 9; a backward/jumped page only buys near a page the user actually
confirmed — a fast reverse skim buys nothing, a backward jump confirms once (~300 ms)
then reads forward with the normal tail. Shell: `onTier0Event` now schedules a
confirmation for EVERY unconfirmed tier-0 (any page can become an anchor, forward or
backward), keeping the immediate within-window plan; `runConfirm` sets the flag,
re-plans tier 0, and slides over the NEW anchor's forward range only (`slideWindow`
generalized); `setPrefetchAhead` re-scans suppressed candidates the widened window
now allows. Cost contract WHY-noted at the module head: "auto-translate spends only
within `prefetchAhead` of a page the user has confirmably looked at."

**§9 — loaded-image confirm guard (viewportQueue).** `classifyConfirm` gains a
`loaded: boolean` parameter (default true, so every prior expectation is unchanged):
`!loaded` with any overlap → `"retry"` (never `"confirm"`; no-overlap `"drop"`
unchanged), so a not-yet-loaded MangaDex placeholder can't confirm as "being read"
while still a mid-height skeleton. The shell passes `!(el instanceof
HTMLImageElement) || (el.complete && el.naturalWidth > 0)` (non-image candidates and
a runtime without `HTMLImageElement` fail OPEN); the retry rides the existing capped
backoff, so a slow page confirms within ~2.4 s of its image arriving (an image load
fires no IntersectionObserver event).

**Contract changes (flagged, all internal — NO `shared/types.ts`, no new messages,
no manifest, `PROMPT_VERSION` = 2, `CACHE_VERSION` = 2):** (a, rule-4 sanctioned)
`CacheRecord` gains `rawPage?: PageTranslation` and `snapVersion?: number` (both
optional/additive; `estimatePageBytes` sizes `rawPage` in); (b, rule-4 sanctioned)
`PlanInput` swaps `cursor` for `confirmed: readonly boolean[]`. **Beyond the
sanctioned list (flagged):** the module-local `CacheLookup` `hit` variant now carries
the whole `record`, so `classifyResnap` receives it without a second IndexedDB read
— a cache.ts-internal type only. `SNAP_VERSION` introduced at 1 and NOT in the cache
key.

**Deliberate calls:** offset = 1 snap-px (dilation + offset ≈ 2 snap-px, the tuning
knob); median + paper snap at luma 245/12; re-snap write-back once per page per
version, full-page entries only; rescue light-path-only with a ≥ 40 % provider-box
overlap guard; `fillColor` as the "snapped/tight" proxy for the ellipse gate;
anchored-window union semantics (backward never buys); `loaded` fail-open for
non-image/absent-`HTMLImageElement`.

**Tests — 734 green** (+40: `offsetPolygonOutward` + median/paper-snap + seed-rescue
in `bubbleSnap.test.ts`; `polygonCentroid` + centroid-rect in `shapePath.test.ts`;
new `BubbleBox.test.ts` jsdom §6/§7 layering + ellipse-gate DOM assertions;
`classifyResnap` + `estimatePageBytes` rawPage + `CacheLookup.record` in
`cache.test.ts`; `anchoredWindowAllows` + §8 anchored-window planner + §9
`classifyConfirm`/shell in `viewportWindow.test.ts`; existing suites updated
mechanically — bbox+offset containment tolerance, `confirmed` flags for `cursor`,
per-field FP compares for the centroid rect, `SNAP_VERSION`/`classifyResnap` mock
exports). Typecheck + ESLint clean; `vite build` clean; `web-ext lint` 0/0/0;
**`npm run test:e2e` 4/4 green on this machine** (A 8.2 s, B 7.6 s, C 3.7 s, D
18.6 s) — Scenarios A–D UNMODIFIED, D's budget arithmetic holding under §8 without
edits.

**Manual verification: NOT run** (needs a live key + MangaDex). The handoff's
manual list is outstanding — in particular, WITHOUT clearing the cache except where
noted: re-visit the 2026-07-18 screenshot pages (ink rim gone/≤ ~1 px; no grey patch
on white bubbles); the offset-box page now snapped (fill covers the original text, no
oval over the neighbour); the clipped-"Ev" page (earlier bubble's text above the
neighbour's fill); peek still shows the dashed cue above neighbouring fills; the §3
workflow check (bump `SNAP_VERSION` locally, reload → new snap output, ZERO provider
calls); the §8 budget/skim checks (≤ ~6 at open, forward reading tracks ~3 ahead, a
mid-chapter jump pauses once, a **fast reverse skim buys at most 1–2, not one per
page**); the §9 slow-load check (placeholders don't confirm until the image appears);
translate-all still fills the whole chapter.

## Phase 9.2 summary (fill-edge tuning, sprawl guard, narrow-rect text rescue)

Driven by the **ninth live-pass evidence** (2026-07-19 screenshots, MangaDex,
vertical-CJK series, on the Phase 9.1 build): the user asked whether the fill/text
spill defects trace to "downgrading the panels" — triaged into three distinct
causes, only one of them resolution-related, and all three addressed in-session
(no handoff doc, per the user's direct request). SNAP-side changes are FREE on
already-paid pages via the 9.1 §3 machinery (`SNAP_VERSION` bump → local re-snap;
do NOT clear the cache to see them).

**§1 — outward offset 1 → 0.5 (`bubbleSnap.ts`).** The 9.1 §1 stack (dilation 1 +
offset 1 ≈ 2 snap-px ≈ 4–6 display px) OVERSHOT on these pages: fills visibly
painted over the drawn ink line — the exact failure mode the 9.1 WHY flagged.
`SHAPE_OUTWARD_OFFSET_PX = 0.5` (float vertex math, sub-px is fine) lands ≈ 1.5
snap-px ≈ 3–4 display px: still covers the flood fill's AA halo, kisses the ink
from inside. Remains the documented tuning knob in both directions.

**§2 — sprawl guard (`bubbleSnap.ts`).** The weird-shaped white spills were
PARTIAL leaks: a fill escaping through an open/spiky outline into a bounded
background pocket that stays UNDER both Phase 7.5 leak caps (4× box / 35 % image),
then gets traced as a "bubble" shape painted over art. New `MIN_BLOB_BBOX_FILL =
0.3` (+ `SnapOptions.minBlobBboxFill` override): a blob filling < 0.3 of its own
pixel bounds is rejected at `accept()` time, BEFORE the trace — real interiors are
bbox-compact (clean ellipse π/4 ≈ 0.79, glyph holes ~0.6, tails/spiky bursts
~0.4), a sprawl is mostly not-blob. Rejection fails soft exactly like the other
guards (next seed/grid point → eventually null → provider box, rule 4); the
rescue path's coverage check sits after it, so a sprawling rescue also rejects.
**`SNAP_VERSION` → 2** (both §1 and §2 change snap output; NEVER in the cache key,
ground rule 8 — cached pages re-snap locally, zero provider spend).

**§3 — narrow-rect text rescue (`textFit.ts` + `shapePath.ts` + `BubbleBox.ts`).**
The character-shredded columns ("is imp ress ive", "Yuanx i Qingli u") are a
LAYOUT defect, not resolution: a tall vertical-CJK bubble's inscribed rect (often
the 0.6× floor) is narrower than any horizontal English word, and `word-break:
break-word` fragments per-letter. New pure `longestWord(text)` (char-count proxy;
whitespace split) and `widenLabelRect(inner, rectW, rectH)` (full padded-box
width, vertical placement kept; returns the SAME reference on no-op so the shell
detects it cheaply). BubbleBox: after the normal fit, probe the longest word's
UNBROKEN extent at `WORD_PROBE_WIDTH` (100 000 — the shadow measurer breaks words
at whatever width it's given, so only an effectively-infinite width reveals the
true extent); if it exceeds the rect, widen + refit. Whole words reaching past the
shape's edge (still box-clipped) beat fragments inside it. Applies to shaped AND
ellipse-shrunk rects; the plain padded path is a structural no-op. Deliberate
call: peek-mode CJK (no whitespace) probes as one long "word" and may widen — 
harmless (CJK wraps at any width) and WHY-noted on `longestWord`.

**Out of scope (unchanged from 9.1):** true provider bubble-detection misses and
offset boxes beyond the §4 rescue's reach (untranslated CJK beside a translation
in the screenshots — provider-side, a future prompt phase); `SNAP_MAX_EDGE` stays
512 (raising it is the finer-quantization lever, but the ≤512 blur is load-bearing
for gap-self-closing — revisit only if 0.5 still overshoots); hyphenation.

**Contracts: NONE changed.** No `shared/types.ts`/messages/manifest change;
`PROMPT_VERSION` 2, `CACHE_VERSION` 2, `SNAP_VERSION` 2 (not in the key).

**Tests: 747 unit (+13)** — sprawl cross fixtures (main + rescue paths, each
pinned to the guard via `minBlobBboxFill: 0` control runs, π/4-threshold
regression, determinism) in `bubbleSnap.test.ts`; `widenLabelRect` exact/no-op in
`shapePath.test.ts`; `longestWord` table in `textFit.test.ts`; widen-vs-keep DOM
wiring in `BubbleBox.test.ts`. Existing suites pass UNTOUCHED (the offset tests
pass explicit offsets; the contour test derives its pad from the constant).
Typecheck + ESLint clean; `vite build` clean; `web-ext lint` 0/0/0; **`npm run
test:e2e` 4/4 green on this machine, Scenarios A–D UNMODIFIED** (A 7.9 s, B 7.6 s,
C 3.7 s, D 18.6 s).

**Manual verification: NOT run** (needs a live key + MangaDex). WITHOUT clearing
the cache: re-visit the 2026-07-19 screenshot pages — (1) fills no longer paint
over bubble outlines (ink line visible around shaped fills; if a thin rim of ink
returns instead, raise `SHAPE_OUTWARD_OFFSET_PX` toward 0.75); (2) the weird
sprawl-shaped white blobs are gone (those bubbles fall back to plain provider-box
fills — less pretty, never wrong-shaped); (3) narrow vertical bubbles show whole
words (possibly overhanging the bubble's sides) instead of letter columns; (4) the
re-snap is free — network panel shows ZERO provider calls while previously-paid
pages visibly change shape output on reload.

## Phase 9.3 summary (leak confinement, word-integrity text fit, sharper snap)

Driven by the **tenth live-pass evidence** (2026-07-19 screenshots, MangaDex,
vertical-CJK series, Anthropic `claude-sonnet-5`, on the Phase 9.2 build) and its
handoff (`docs/PHASE-9.3-HANDOFF.md`). Three fronts; SNAP-side changes are FREE on
already-paid pages via the 9.1 §3 re-snap machinery (`SNAP_VERSION` → 3; do NOT
clear the cache to see them).

**§1 — confine the flood fill; reject wall-slams (`bubbleSnap.ts`).** The worst
remaining fill defect: a bubble fill escapes through the WHITE page margin/gutter
(thin panel borders alias away at snap resolution) into a NEIGHBOURING panel,
connects to other white, and paints a giant cross-panel blob whose OUTER contour
swallows enclosed art (white over dark hair). Every 9.2 guard is blind to it — the
escaped margin is SOLID white (compactness guard passes) and its area stays under
the 4×-box / 35 %-image caps. Fix structurally: hard-wall the fill to the provider
box expanded `SNAP_CONFINE_EXPAND = 0.5` per side (⇒ a 2×-per-axis window,
intersected with any 7.6 `opts.window` slab), and reject a fill that slams a HARD
wall. New pure `confineWindow(...)` computes the effective window + which edges are
hard: an edge is hard iff confinement binds it STRICTLY tighter than the slab (a
slab edge — a lobe's group cut — is never hard, so 7.6 lobes may touch it) — which
also implies "strictly inside the bitmap", so a page-edge bubble is safe. `floodFill`
now records per-side whether a FILLABLE pixel just beyond a window edge blocked it
(“the fill wanted to keep going”); `accept` rejects when such a hit lands on a hard
wall, BEFORE the trace, failing soft to the provider box (rule 4). The rescue path
derives its confinement from the RESCUE-expanded box (the offset bubble it reaches
for would be walled off by the raw box); the ≥40 % overlap guard still anchors it.
`SnapOptions.confineExpand` (module-local; `Infinity` disables). `MAX_BLOB_BOX_RATIO`
/ `MAX_BLOB_IMAGE_FRACTION` / `MIN_BLOB_BBOX_FILL` kept as backstops.

**§1 — three deliberate deviations from the handoff's literal text, all flagged:**
(a) **Wall-slam is “a fillable pixel BEYOND a hard wall”, not the handoff's bare
`blob.maxX === winMaxX` touch.** A real bubble whose ink ends exactly at 2× the box
(the existing glyph-counter fixture: bubble right edge = the wall) touches the wall
but has NOTHING fillable beyond it — the bare-touch rule wrongly rejected it. The
“fillable-beyond” refinement is the correct realization of the handoff's own WHY
(“a fill pressed against the wall wanted to keep going”) and keeps that fixture
green. (b) **Confinement rounds OUTWARD** (floor min, ceil max — dropped the
half-open `−1` the `opts.window` slab uses), so a bubble filling up to exactly 2×
its box is never falsely clipped one pixel short. (c) **`snapAllRegions` is now a
DUAL pass** (stage 1a un-confined DETECTION → group detect → stage 1b confined
FINAL results / confined split). WHY: a connected multi-bubble blob (7.6 peanut) is
filled identically by every member's seed, but that union spans more than 2× either
member's box — a confined stage-1 would wall each member and reject the slam, so the
shared blob would never be DETECTED. Detection therefore runs un-confined; the
FINAL result of a LONE region is the confined snap (where a single-bubble margin
leak is rejected), and a group is split with confined windowed re-fills (the slab
binds tighter than the wall, so the lobe touches only the slab — not a hard wall —
and is accepted). A lone region is byte-identical to a direct `snapRegionToBubble`.

**§2 — word-integrity font cap (`textFit.ts` + `BubbleBox.ts`).** “Pleas e!” /
“Besi des” / “Yuanx i Qingli u” at LARGE sizes. Root cause: the shadow measurer has
`word-break: break-word`, so a fragmented word still “fits” — `fitTextSize`
maximizes px and shreds the longest word, and the 9.2 widen reused that same blind
predicate. Fix at the root: new pure `maxWordFitPx(word, widthPx, minPx, maxPx,
probeMeasure)` — the largest integer px at which the longest word renders UNBROKEN,
or `null` when even `minPx` overflows (binary search, same skeleton as
`fitTextSize`; empty word → no cap). `resolveFontSize` gains an optional
`wordCapPx` (content-internal): AUTO mode's effective max becomes
`min(maxSizePx, wordCapPx)`; FIXED mode IGNORES it (the user chose that size).
BubbleBox is restructured **cap-then-widen** (was 9.2's widen-eagerly): cap the fit
at the word-fit px; only when the cap is `null` (the word can't fit the rect at ANY
legal size) widen to the padded box (9.2's `widenLabelRect`, demoted to fallback)
and recompute the cap; a still-null cap after widening accepts today's
floor-and-crop. A word that fits the narrow rect at a smaller size now renders SMALL
AND WHOLE inside the bubble instead of large and overhanging. `longestWord` /
`widenLabelRect` / `WORD_PROBE_WIDTH` unchanged.

**§3 — `SNAP_MAX_EDGE` 512 → 768 (`bubbleSnap.ts`).** The ≤512 downsample
self-closed 1–2 px outline gaps but eroded THIN PANEL BORDERS (the §1 escape route)
and coarsened edge quantization (1 snap-px ≈ 2–2.5 display px). At 768 borders
survive (fewer margin escapes at the source) and quantization drops to ≈ 1.5–1.7
display px; safe NOW because §1's wall bounds any new outline-gap leak the weaker
blur no longer self-closes. Note the interaction: `SHAPE_OUTWARD_OFFSET_PX` + the
1-px dilation are in SNAP-px, so the outward reach SHRINKS in display px at 768 —
the desired direction after the 9.2 overshoot fix; it stays the rim knob. Snap cost
grows ≈ 2.25× in pixels, still one trivial per-region pass. `SNAP_MIN_SHORT_EDGE`
(256) unchanged.

**Sanctioned test edits (flagged):** (1) the 9.2 sprawl-guard **rescue** control
(`minBlobBboxFill: 0`) now also passes `confineExpand: Infinity` — the cross slams
the §1 wall before the ratio is consulted, so isolating the sprawl guard needs
confinement off; both variants asserted. (The two MAIN sprawl controls pass
UNCHANGED — that box's 3×-rescue window clamps to the whole bitmap, so its rescue
still accepts with the guard off.) (2) The “rescues an OFFSET provider box” fixture
was **replaced**: the old one relied on a lucky MAIN-loop seed (its title's “nine
seeds all miss” was inaccurate) and its bubble overflowed 2× the box while covering
it only ~32 %, so §1 walls the main fill and the ≥40 % rescue can't anchor it — a
genuine §1 behaviour change (that offset box now shows a loose provider box, rule
4). It is split into a POSITIVE test (an offset bubble whose ellipse FITS the
rescue's expanded window and covers ≥40 % — still recovered by the rescue under
confinement) and a NEGATIVE test pinning the new fall-back-to-provider-box behaviour
(with `confineExpand: Infinity` proving the wall, not another guard, rejects it).
The 9.2 “Extraordinary” BubbleBox fixture passes UNCHANGED (it still widens; its
font size is now additionally capped but was never asserted).

**Contracts (flagged, all internal — NO `shared/types.ts`, no new messages, no
manifest change):** `SnapOptions.confineExpand?: number` (module-local),
`resolveFontSize`'s optional `wordCapPx` (content-internal). `SNAP_VERSION` → 3
(covers §1 + §3; NEVER in `buildCacheKey`, ground rule 8). `PROMPT_VERSION` = 2,
`CACHE_VERSION` = 2 untouched.

**Deliberate calls:** confinement 0.5 (2× box, matching the pre-existing 4×-area
growth bound); wall-slam via fillable-beyond a hard wall, in `accept`;
outward-rounded confinement window; dual-pass detection (un-confined) vs. final
(confined); rescue confinement from the expanded box; cap-then-widen (small-and-whole
over large-and-overhanging); 512 → 768 (borders over gap-self-closing, quantization
tightens, §1 bounds the blast radius); offset boxes beyond 2× now fail soft to the
provider box.

**Tests: 763 unit (+16)** — §1 confinement (margin-leak reject + Infinity-accept
control, byte-identical-in-window, page-edge-not-hard, determinism, redesigned
offset-rescue positive/negative, sprawl-rescue control) in `bubbleSnap.test.ts`;
`maxWordFitPx` table + `resolveFontSize` cap (auto honours, fixed ignores, min
order) in `textFit.test.ts`; cap-then-widen DOM wiring (caps-not-widens vs
widens-and-caps) in `BubbleBox.test.ts`; `computeSnapSize` derives its expectation
from `SNAP_MAX_EDGE` (no hard-coded 512). All other suites pass UNCHANGED (the 7.6
peanut/group + rescue-miss + swallow-guard fixtures hold under the dual pass).
Typecheck + ESLint clean; `vite build` clean; `web-ext lint` 0/0/0; **`npm run
test:e2e` 4/4 green on this machine, Scenarios A–D UNMODIFIED** (A 9.0 s, B 7.6 s,
C 3.6 s, D 18.5 s).

**Manual verification: NOT run** (needs a live key + MangaDex). WITHOUT clearing
the cache (§1/§3 arrive via re-snap): (1) background console shows `re-snapped
cache hit … (snapVersion → 3)` on previously-paid pages, ZERO provider calls; (2)
the cross-panel blob pages — no fill crosses a panel border/gutter (worst case a
plain loose box); (3) the “Pleas e!”/“Besi des” pages — whole words at a smaller
size (or, where impossible, the widened rect), NO letter columns; (4) fill edges
tighter to the ink at 768, no ink rims (if rims return, the knob is
`SHAPE_OUTWARD_OFFSET_PX`, not a §3 revert); (5) spend unchanged (§8/§9 untouched).
Watch for offset boxes that used to snap now showing a loose box — the §1 tradeoff.

## Phase 9.4 summary (graceful fill fallback, confinement cascade, contained-fill suppression)

Driven by the **eleventh live-pass evidence** (2026-07-20 screenshots, MangaDex,
vertical-CJK series, Anthropic `claude-sonnet-5`, on the Phase 9.3 build) and its
handoff (`docs/PHASE-9.4-HANDOFF.md`). Phase 9.3 did its job — the cross-panel
white-fill leaks are gone; the symptom shifted to the *failure path* (text floats
over an unpainted bubble, the source Chinese leaking through). This phase makes
that path graceful and recovers more real bubbles before we reach it. Every
change is client-side — **zero provider cost, no cache clear, no re-pay.** §1/§3
are pure render changes (reach cached pages on the next repaint); §2 arrives via
the existing `SNAP_VERSION` re-snap machinery (`SNAP_VERSION` → 4).

**Evidence established (not re-litigated):** the **provider-resolution ceiling is
real and binding** — bumping `maxImageEdgePx` 1200 → 1600 → 1800 (with a cache
clear + full re-translate) made detection SIGNIFICANTLY WORSE (Anthropic caps
effective input at ~1.15 MP / 1568 px and downsamples larger images a SECOND time
on top of our JPEG-0.8, smearing thin CJK strokes and bubble outlines). 1200 sits
just under the ceiling and is seen essentially as-sent. `maxImageEdgePx` is NOT a
quality lever — reverted/left at 1200; resolution is closed as an option. And
**fill opacity < 1 is a direct bleed-through cause** — the default 0.92 lets ~8 %
of source ink show wherever a fill sits over ink. No image-prep changes this phase.

**§1 — graceful snap-failure fallback: opaque cover (`BubbleBox.ts` + a pure
helper).** When the snap accepts no blob on a speech bubble (`region.fillColor`
undefined), BubbleBox drew the raw provider box filled at the user's
`bubbleFillOpacity` (0.92) — translucent, so the source bleeds through, and on an
offset/tight box the English floats over near-unpainted paper. New pure,
unit-tested `effectiveFillOpacity(kind, fillColor, userOpacity)`: a snap-eligible
bubble kind (`bubble`/`thought`) with `fillColor === undefined` → **opacity 1**
(we could not find the paper, so cover the source completely); everything else —
a successfully-snapped bubble (honors the user's art-peek translucency) and every
non-bubble kind (SFX/narration art must stay visible) — keeps `userOpacity`. Wired
at the fill layer only; the successful-snap path (shaped fill, ellipse gate,
inscribed rect) is untouched. This is the single biggest visible win and reaches
cached pages on the next repaint with NO re-snap. **The optional outward
cover-pad (handoff §1 bullet 3) was DELIBERATELY DEFERRED** — the handoff scoped
it "ship the opacity fix first, decide from the live pass," and padding risks
nudging a fallback box over a neighbour; no constant was added (reserved for a
future pass if a tight box still shows a CJK rim after the opacity fix).

**§2 — bounded confinement cascade (`bubbleSnap.ts`, `snapAllRegions` Stage 1b).**
New module-local `SNAP_CONFINE_EXPAND_LOOSE = 1.0` (3× per axis). The lone-region
final snap becomes a cascade: try `snapRegionToBubble` at the default 0.5 wall; if
it returns `null`, retry once at 1.0 through the EXISTING `confineExpand` option;
first non-null wins, still-null keeps the provider box (→ §1 fallback). The
detection pass (Stage 1a, `confineExpand: Infinity`) and grouped/lobe fills are
UNCHANGED — only the lone-region result cascades, and a first-pass accept never
runs pass 2 (a fully-inside bubble is byte-identical to pre-9.4). WHY 1.0 not
`Infinity`: keep a hard wall so a cross-panel margin leak stays bounded — 1.0
doubles the 0.5 reach while staying inside the 4×-box area cap; the leak defense
shifts onto the UNCHANGED `MIN_BLOB_BBOX_FILL` compactness guard (a real undersized
bubble is COMPACT and merely runs past 2× the box → the guard passes and the wall
was all that rejected it; a margin leak is SPINDLY → the guard rejects it at 1.0
exactly as at 0.5). **Flagged nuance for the reviewer:** the Phase-9.3 seed-rescue
already reaches ~3× the box (its rescue-window at `confineExpand 0.5` equals the
main window at 1.0), so the cascade's genuinely NEW recovery is the case where the
rescue's ≥40 %-provider-overlap guard rejects (an offset box whose blob covers the
box only ~25 %) while the main path at 1.0 — which has no overlap guard — accepts.
The §2 fixture (`undersizedOffset`, a compact 13×13 bubble under an offset box) is
built on exactly that mechanism: `null` at 0.5, snaps at 1.0.

**§3 — contained-fill suppression (`overlapTrim.ts` + a threading seam).**
`trimOverlaps` deliberately leaves CONTAINMENT pairs alone (one box fully inside
another — a duplicate detection it won't distort) and relies on draw order;
pre-Phase-9 that stacked readably, but now each region also paints a FILL, so two
stacked fills double-paint / patch-fight and read as a smeared overlap. New pure,
unit-tested `computeContainedFillSuppression(regions)` returns a `suppressFill[]`
boolean PARALLEL to the trimmed regions: true iff another region's draw box fully
`contains` this one (exact-equal boxes = mutual containment → suppress the LATER
one in reading order only, never both). BubbleBox skips appending the fill node
when `suppressFill` is set (paint the label only) — the outer fill already covers
that area, so the inner fill can only ever double-cover it; the LABEL is untouched
(the two detections may carry different text — a model split or a double-OCR — so
dropping the region would lose a translation; suppressing only the redundant paint
is the minimal always-safe fix; merging would invent a bubble).

**Surface changes (flagged, all internal — NO `shared/types.ts`, no new messages,
no manifest change):** (a) new shared `src/shared/regionKind.ts` with
`isBubbleKind(kind)` — factored out of `bubbleSnap`'s old `SNAP_KINDS` set so the
snap-eligibility check (`shouldSnapKind` now delegates to it) and §1's
opaque-fallback decision key off ONE source and can't drift; no cross-layer import
(background ⇸ content avoided). (b) `SNAP_CONFINE_EXPAND_LOOSE` + the Stage-1b
cascade (passes the EXISTING `confineExpand` option — no new `SnapOptions` field).
(c) `effectiveFillOpacity` (content-internal, exported for its own test) and the
`RenderBubbleOptions.suppressFill` render-local option. (d) the `suppressFill[]`
threading seam: a **parallel array** computed in `OverlayManager.paint` (indexed
by the raw region index) rather than a `TranslatedRegion` field — the contract
stays untouched. `SNAP_VERSION` → 4 (§2; NEVER in `buildCacheKey`, ground rule 8).
`PROMPT_VERSION` = 2, `CACHE_VERSION` = 2 untouched.

**Deliberate calls:** opaque fallback SCOPED to bubble kinds with no snapped
fillColor (SFX art stays visible, snapped bubbles keep the user's translucency);
the bounded 1.0 cascade (hard wall retained, leak defense on the compactness
guard); the optional cover-pad DEFERRED (opacity fix first); fill-suppression, not
region-drop, for contained pairs; the shared `isBubbleKind` factor-out; the
`suppressFill` parallel-array seam over a contract field.

**Tests: 786 unit (+23)** — §1 `effectiveFillOpacity` table (bubble/thought +
undefined → 1; snapped bubble + non-bubble kinds → user opacity; determinism) and
render assertions (fallback fill node `opacity: "1"`, snapped honors 0.92, SFX not
whited out) in `BubbleBox.test.ts`; §3 `computeContainedFillSuppression`
(inner-not-outer, equal→later-only, disjoint/partial→neither, three-region nest,
purity) in `overlapTrim.test.ts` plus the suppressFill render wiring (no fill node,
label present) in `BubbleBox.test.ts`; §2 the cascade recovery (null at 0.5, snaps
at 1.0, end-to-end via `snapAllRegions`), the margin leak STILL null at 1.0 (leak
defense held), fully-inside byte-identical at 0.5/1.0, `SNAP_VERSION === 4`,
determinism in `bubbleSnap.test.ts`. All other suites pass UNCHANGED. Typecheck +
ESLint clean; `vite build` clean; `web-ext lint` 0/0/0; **`npm run test:e2e` 4/4
green on this machine, Scenarios A–D UNMODIFIED** (A 9.6 s, B 7.6 s, C 3.6 s,
D 18.5 s).

**Manual verification: NOT run** (needs a live key + MangaDex). WITHOUT clearing
the cache (§1/§3 arrive on the next repaint, §2 via re-snap): (1) background
console shows `re-snapped cache hit … (snapVersion → 4)` on previously-paid pages,
ZERO provider calls; (2) snap-failure bubbles (captions, textured-background
panels, the offset boxes from the 2026-07-20 screenshots) now render an OPAQUE
fill — no Chinese bleeding under the English (worst case a clean opaque box); (3)
some previously-fallback bubbles now snap tight (the §2 cascade), no NEW
cross-panel fills (leak defense held at 1.0); (4) the "weird overlap" pages —
stacked/duplicate bubbles no longer show a smeared double-fill (one fill per
contained pair, both labels present); (5) spend unchanged. Immediate no-code
levers for the user, independent of this phase: revert `maxImageEdgePx` to 1200 in
Options (undo the 1600/1800 test); set bubble fill opacity to 100 % (kills
source bleed-through on GOOD hits today — §1 makes the FALLBACK opaque regardless).

## Phase 9.5 summary (whole-balloon boxes, duplicate-region cleanup, fallback cover-pad)

Driven by the **twelfth live-pass evidence** (2026-07-20 HAR + screenshots,
MangaDex, vertical-CJK series, Anthropic `claude-sonnet-5`, on the Phase 9.4
build) and its handoff (`docs/PHASE-9.5-HANDOFF.md`). This phase attacks the
chronic "text floats out of the bubble" defect at its **root — a prompt
instruction** — instead of a sixth round of downstream snap recovery (the 9.4
handoff flagged this as the deferred "future, paid iteration"; this is it).

**Evidence established (not re-litigated):** the floating symptom's ROOT is the
old prompt line *"The box must tightly enclose the TEXT itself, not the entire
bubble outline"* — for vertical-CJK dialogue that box is a narrow glyph strip,
offset from the round balloon and barely overlapping its white interior, so every
9.0–9.4 mechanism was reverse-engineering the balloon from a box we told the model
NOT to draw around it; on a snap failure the fallback IS that strip, so the patch +
English land off the bubble. Fix the box at the source and the whole failure class
shrinks (seeds land dead-centre → snap succeeds far more, and a residual failure
boxes the *balloon*). Also from the HAR's Call 11: the model emitted the SAME
bubble two/three times (`與此類似` ×3, `讓其結合並提高密度的話` ×2) at IoU ≤ 0.32 (some
disjoint) — far under the strict `IoU>0.85` dedupe — plus a **negative-height**
corner box (r12 `[0.480,0.650,0.650,0.620]`) that `parseBbox` reinterpreted as a
quarter-page `w/h` rectangle. And the **provider-resolution ceiling stays binding**
(1200 is at Anthropic's ~1.15 MP cap; 1600/1800 tested WORSE) — no image-prep
changes; the 4 HAR aborts are benign fast-scroll cancels (diagnosed, deferred).

**§1 — whole-balloon bounding boxes (the PAID root fix — `prompt.ts` +
`shared/constants.ts`).** Rewrote the `BOUNDING BOX RULES` block into a
**kind-conditional** rule: `bubble`/`thought` kinds are boxed as the **ENTIRE
balloon** (the whole drawn white/solid shape, blank margin included), while on-art
text (`caption`/`sfx`/`sign`/`other`) keeps the tight-text rule; added "one box per
balloon" with a lobe-split clause (a line spanning joined balloons → one region per
lobe). Dropped the now-counterproductive "Boxes for different regions should not
overlap" line — balloon boxes legitimately overlap neighbours more than tight
strips did (expected; `trimOverlaps` + the 9.4 contained-fill suppression absorb
it, and snap should now SUCCEED on most, yielding tight shaped fills). `PROMPT_VERSION`
2 → 3 — the bbox instruction is part of the cache-key prompt identity, so every
cached `p2` page re-translates once on next view (**the accepted paid cost, the
ONLY spend in this phase**). The `bbox` schema `description` was left unchanged: it
is already format-only (corner sentence, no "tight to text" implication), so it does
NOT contradict the new per-kind rule — no edit needed. No JSON-schema-shape,
dialect, honorifics, or reading-order changes.

**§2 — duplicate + degenerate region cleanup (P1, free — `ProviderBase.ts`,
sanitizer-local).** Two small fixes, both upstream of the snap, reaching cached
pages via the §1 re-translate (no `SNAP_VERSION`/`CACHE_VERSION` bump).
(a) **`parseBbox` plausibility guard** (`PLAUSIBLE_WH_EPS = 0.02`): when the corners
reading is degenerate and the code falls to the legacy `[x,y,w,h]` reading, accept
that reading ONLY if it plausibly fits the image (`c>0 && d>0 && x+c ≤ 1+ε &&
y+d ≤ 1+ε`); else return `null` (drop). WHY: a real third-party w/h box fits the
frame; a noisy CORNER box (r12: `w=0.65` from `x=0.48` → `x+w=1.13`) does not, and
that heavy overflow is the tell it was corners-with-noise, not w/h — dropping beats
clamping a quarter-page rectangle. Preserves w/h back-compat for the
half-of-Haiku-emits-w/h case (a fitting w/h box still parses). (b) **Overlap-gated
identical-text collapse** in `dedupeIdentical` (`IDENTICAL_OVERLAP_IOU = 0.3`,
`OVERLAP_DEDUPE_KINDS = {bubble,thought,caption}`): for a pair whose NORMALIZED
`original` (trim + collapse whitespace, so newline-wrapped OCR matches) is
identical, whose kind is in that set, and whose `IoU > 0.3`, keep the **larger-area**
region and drop the other; the existing `IoU>0.85` exact-original rule stays as the
general path for all kinds. WHY overlap-gated + kind-scoped (the user's explicit
steer): repeated dialogue across a real conversation lives in SEPARATE,
non-overlapping balloons (`IoU ≈ 0`) — never collapse those; two detections of the
SAME balloon overlap. `sfx` legitimately repeats verbatim (パチ/ドズ) at disjoint
spots, so it stays on the strict path only. WHY keep-larger: the bigger box is
likelier the real balloon, the smaller the spurious echo. A disjoint third copy
(r18) intentionally SURVIVES — one stray copy is far less harm than risking a
genuinely repeated line.

**§3 — snap-failure fallback cover-pad (render safety net, free — a new pure
module + a threading seam).** For the residual pages where the model still boxes
tight despite §1, the opaque 9.4 fallback is smaller than the balloon (English
cramped, source rim showing). New pure, unit-tested
`computeFallbackCoverRects(regions, rects, opts)` returns a `PxRect[]` **parallel**
to `rects` (same seam as 9.4's `suppressFill`): for a snap-FAILURE bubble
(`isBubbleKind(kind) && fillColor === undefined`) it grows the rect outward by
`FALLBACK_COVER_PAD = 0.12` of the box extent per side, then CLAMPS each edge so it
neither leaves the image bounds nor crosses INTO another region's draw rect lying
in that direction (per-edge min against the nearest neighbour, sharing the
perpendicular span); every other region returns its rect UNCHANGED. `OverlayManager.paint`
computes it once (it already holds all regions + rects) and threads each region's
cover rect into `renderBubbleBox` via a new render-local `RenderBubbleOptions.drawRect`;
BubbleBox lays the box out at that rect, so the fill AND the derived inner text rect
both grow toward balloon size. The successful-snap path (shape/ellipse/inscribed
rect) is untouched (`drawRect === rect` for every snapped/non-bubble region). WHY a
neighbour clamp, not a flat pad: an isolated tight box grows to cover its balloon; a
crowded one grows only into empty space, never over a neighbour — removing exactly
the spill risk the 9.4 handoff deferred the cover-pad over. WHY 0.12: covers a
typical text-strip→balloon margin without being reckless; it is THE tuning knob.
Pure render change — reaches cached pages on the next repaint, no re-snap.

**Cover-pad module choice (flagged):** a NEW sibling pure module
`src/content/overlay/coverPad.ts`, not an extension of `overlapTrim.ts` — the
cover-pad works in overlay-local PIXELS (`PxRect`) at paint time while `overlapTrim`
works in normalized 0–1 bbox space on the cached page, and mixing the two coordinate
systems in one file invites confusion; the cover-pad also needs the `isBubbleKind`
predicate `overlapTrim` does not.

**§4 (snap-outcome instrumentation): SKIPPED.** It was OPTIONAL/not-in-DoD and
would require editing `bubbleSnap.ts`'s `snapAllRegions` — OUTSIDE the sanctioned
surface list for this phase — so per the "stop and flag, don't expand scope" rule it
was not built. The next live pass can add it under its own scope.

**Surface changes (flagged, all within the sanctioned list — NO `shared/types.ts`,
no new messages, no manifest change):** (a) `PROMPT_VERSION` 2 → 3 + the
`SYSTEM_PROMPT_TEMPLATE` bbox rule in `prompt.ts` (schema description untouched).
(b) sanitizer-local `parseBbox` plausibility guard (`PLAUSIBLE_WH_EPS`) +
`dedupeIdentical` overlap-gate (`IDENTICAL_OVERLAP_IOU`, `OVERLAP_DEDUPE_KINDS`) in
`ProviderBase.ts`. (c) the new pure `coverPad.ts` (`computeFallbackCoverRects`,
`FALLBACK_COVER_PAD`) + `OverlayManager.paint` computing the parallel cover-rect
array once + the render-local `RenderBubbleOptions.drawRect` thread through
`BubbleBox`. `SNAP_VERSION` = 4 and `CACHE_VERSION` = 2 **untouched**: §2 is upstream
of the snap and reaches pages via the §1 re-translate (the cached `rawPage` is
post-sanitize), §3 is a pure repaint; old `p2` entries age out via the existing LRU.

**Deliberate calls:** whole-balloon boxes as the paid root fix (over another
downstream recovery layer); the overlap-gated + kind-scoped dedupe that PRESERVES
repeated dialogue in separate balloons; keep-larger within a cluster; the r12
plausibility DROP over a clamp (and the deliberate consequence — the pre-existing
`out_of_range_bbox` fixture's two overflowing legacy-w/h rows are now BOTH dropped as
noisy corners, updated to expect 0 regions; the joint clamp still applies to
overflowing CORNER boxes); the neighbour-clamped cover-pad and its 0.12 knob; §4
skipped as out-of-surface; the cover-pad as a new PxRect-space sibling module.

**Tests: 805 unit (+19 net over the 786 baseline).** §1: the built system prompt
CONTAINS the new per-kind language ("enclose the ENTIRE balloon", "box the TEXT
tightly", "One box per balloon.") and no longer the old tight-text line, corner
format retained (`prompt.test.ts`); `PROMPT_VERSION === 3` (`constants.test.ts`).
§2 (`providerPipeline.test.ts`): `parseBbox` — the r12 vector `[0.48,0.65,0.65,0.62]`
→ `null`, the genuine w/h box `[0.1,0.2,0.3,0.15]` → still `{0.1,0.2,0.3,0.15}`
(back-compat pinned), a valid corner box unaffected; `dedupeIdentical` via the
pipeline — three identical `bubble` regions (two overlapping + one disjoint) → the
two collapse to the LARGER + the disjoint survives, two overlapping `sfx` → BOTH kept
(kind exemption), different-text overlapping → both kept, a whitespace/newline-only
difference treated as identical; the `out_of_range_bbox` update; and a 24-region
Call-11 golden fixture (`call11_duplicates.json` → r12 dropped, each duplicate
cluster collapsed by one, 22 out). §3: `computeFallbackCoverRects` (isolated
4-side expand, right-neighbour clamp with full pad elsewhere, snapped/non-bubble
pass-through, image-bounds clamp both edges, pad override, purity/determinism) in
`coverPad.test.ts` + a `drawRect` render assertion (fallback box uses the padded
rect → wider fill + larger text rect; snapped unchanged) in `BubbleBox.test.ts`.
Typecheck + ESLint clean; `vite build` clean; `web-ext lint` **0/0/0**.

**`npm run test:e2e` 4/4 green on this machine, Scenarios A–D UNMODIFIED** (A
9.3 s, B 7.7 s, C 4.6 s, D 18.6 s) — after diagnosing an ENVIRONMENTAL break
unrelated to Phase 9.5: Selenium Manager's "latest browser" TTL expired and
silently moved the suite from Firefox 152.0.6 (the 9.4 baseline browser) to
153.0, whose Marionette adds a new `navigateTo` guard (`driver.sys.mjs` ~L2378,
verified by extracting both versions' omni.ja) refusing WebDriver navigation to
non-"safe" URLs — including the `moz-extension://` options page `seedSettings`
drives — unless `RemoteAgent.allowSystemAccess` is set. All four scenarios
failed identically in that setup step BEFORE any Phase 9.5 code ran. Fix (the
one infra change outside the 9.5 surfaces, harness `before()` only, scenarios
untouched): launch Firefox with `--remote-allow-system-access` (exists since
~Firefox 138, inert on older versions). Verified 4/4 BOTH ways: pinned to the
152.0.6 baseline via `E2E_FIREFOX_BIN` (no harness change needed), and on
default-resolved 153.0 with the flag.

**Manual verification (live key + MangaDex): NOT run.** §1 re-translates on view
(the network panel showing provider calls the first time a previously-cached page is
re-opened is EXPECTED — the `p2 → p3` re-key). Expected: (1) bubbles now box the
balloon — fills snap tight to the drawn outline, English sits centred INSIDE, no
source bleeding around a floating strip; connected/spanning bubbles get one fill per
lobe; (2) the "magic power" ad page (Call 11) — the tripled *"it's similar to magic
power too."* and the panel-covering *"…bond and increase the density,"* box are GONE
(at most one stray copy, no quarter-page rectangle); (3) a page where the model still
boxes tight — the §3 cover-pad grows the opaque fallback toward balloon size without
spilling onto neighbours; (4) spend — after the one-time re-translate, re-opening a
page is free; (5) no regressions on good 9.4 hits. Immediate no-code levers for the
user (independent of this phase): keep `maxImageEdgePx` at 1200 (do not re-test
higher); set bubble fill opacity to 100 % in Options (kills source bleed on good hits
today); expect a one-time spend bump as cached chapters re-translate to `p3`, free
thereafter.

## Phase 9.6 summary (translate-all tail resilience: soft-cancel, dead-signal guards, recycle-persistent sends)

Driven by the **thirteenth live-pass evidence** (2026-07-21 HAR
`devtools_Archive [26-07-21 23-46-44].har`, MangaDex, OpenAI `gpt-5.6-luna`, on the
Phase 9.5 build) and its handoff (`docs/PHASE-9.6-HANDOFF.md`). The user clicked
**Translate all** at the top of a chapter, scrolled at reading pace, and the **tail
pages were never translated** — paying the P3 deferral the 9.5 handoff recorded
("retry-on-recycle for cancelled pages … a future queue refinement"). The HAR showed
the class at scale — **6 of 19 pages lost** — so it is no longer benign.

**Evidence established (not re-litigated):** 19 solo `translatePage` jobs went out
(`pagesPerRequest` 1 → `batchEligible` false). Requests **0–12 succeeded** (HTTP 200,
`finish=stop`, ~22 s/page) at exactly **concurrency 6** — textbook dispatch. Requests
**13–18 died client-side**: HAR `status 0`, `time 0–1 ms`, every timing field zero,
yet each carried a **fully serialized body** (195–257 KB with the image data URL) —
the signature of a `fetch` launched with an **already-/immediately-aborted
AbortSignal**. Zero 429s, zero 4xx/5xx, no network faults: **NOT a provider, auth,
rate-limit, or network problem.** Each dead request's start paired with a *successful*
response's end to ~0.1 s — the queue dequeued the next job the instant a slot freed and
that job's signal was dead within the dequeue→fetch window. The only production writers
of those aborts are content-initiated cancels on **DOM reconcile**: MangaDex
detaches/replaces `<img>` elements while the user scrolls (lazy-load hydration + node
recycling), the overlay notices `!el.isConnected`, the scanner unregisters the
candidate, and `unregister → cancel → cancelTranslation` aborted the per-request
controller **unconditionally**. Tail pages whose jobs sat behind the ~90 s backlog
(19 ÷ 6 × ~22 s) had their elements churned before their jobs ran; each reconcile
cancelled a still-pending job, and nothing re-sent the recycled element (translate-all
already ran; a non-auto site never sends on visibility). The **no-refund economics**
(not re-litigated): aborting an already-SENT provider call refunds nothing (the provider
bills regardless of client disconnect), so cancelling a STARTED call destroys the cache
value for ~zero saving — the "stop paying" rationale is only true for jobs still QUEUED.
Model latency (~22 s/page) is an aggravator, not the cause; the fix is provider-agnostic.

**§3 — dead-signal guards (belt-and-braces; landed first, `queue.ts` +
`translateTiles` + `ProviderBase.callOnce`).** Closes the status-0 ghost-request class
structurally instead of chasing the interleaving: (a) `queue.ts` `runWithRetry` throws
`abortReason(signal)` at the **top of each attempt** before invoking the task — covers a
merged signal aborted in the dequeue→start window, for every current + future task type;
(b) `translateTiles` throws `ProviderError("aborted")` **once after prep**, before any
`sha256Hex`/provider call — prep is the longest in-slot window (~100–500 ms), where a
cancel used to sail on to base64+`fetch`; (c) `ProviderBase.callOnce` calls
`throwIfAborted(signal)` **immediately before `this.fetchFn(...)`** — the hard guarantee
(an aborted signal ⇒ `fetchFn` never invoked), covering the repair-retry and 400-downgrade
re-entries for free. All three surface as the existing `aborted` kind, so negative-cache
exclusion (`shouldNegativeCache("aborted")` is false) and silent content handling behave
exactly as today.

**§1 — soft-cancel: unregister spares started jobs (the spend-preserving fix,
`messages.ts` + `translateHandlers.ts` + `viewportQueue.ts`).** `cancelTranslation`'s
request gains `mode?: "hard" | "queued-only"` (absent ⇒ `"hard"`, so every pre-9.6 caller
is **byte-compatible**). The handler routes through a pure, unit-tested decision table
`classifyCancel(mode, hasController, started)` → `hard-aborted` / `queued-aborted` /
`started-spared` / `unknown-noop`, drawing the **same started boundary** the pause feature
already uses (`startedRequests`): a `"queued-only"` cancel of a STARTED request is a no-op
(spared) — the run finishes, caches, and its own `finally` cleans both registries exactly
as a normal completion; everything else aborts. The content DOM-reconcile `unregister`
path sends `"queued-only"`; teardown `stop()` keeps `"hard"` (the user is leaving); the
region-select cancel path is untouched (absent mode ⇒ hard). **SharedAbort verified, not
guessed:** a spared run never aborts its caller's controller, its waiter stays live, and
the caller-side `stopWaiting()` still detaches on normal settle — no refcount change, no
listener leak.

**§2 — translate-all persistence across element recycling (the blank-page fix,
`viewportQueue.ts`).** A real `requestAll` arms a queue-lifetime intent
`translateAllIntent = { href: getHref(), budgetMs }` (the same backlog-scaled
`requestAllTimeoutMs` budget the burst used). `register` runs a pure, unit-tested
predicate `classifyRegisterIntent(intent, currentHref, paused)` → `send` / `disarm` /
`ignore`: while armed on the **same page URL** and not paused, a candidate **registered
later** — a recycled `<img>`'s fresh candidate OR a late lazy-loaded page — auto-sends at
`TRANSLATE_ALL_PRIORITY`; combined with §1 the background coalesces onto the still-running
spared job by cacheKey (or cache-hits the finished one) and renders. Disarmed on
`setPaused(true)` (user revoked), `stop()` (teardown), and lazily on an **href mismatch**
at register time (an SPA chapter change must not inherit spend the user never clicked
for — the URL is the cheapest precise "this chapter" scope). NOT gated on the anchored
reading window — translate-all is explicit intent and bypasses the window by existing
doctrine. The `requested` re-check inside `sendTranslate` dedupes against anything in
flight, so a double registration can't double-send.

**§4 — cancel disposition logging (`translateHandlers.ts`).** One `log.debug` per id in
both cancel handlers — short id + mode + disposition (`started-spared` / `queued-aborted`
/ `hard-aborted` / `unknown-noop`, reusing `classifyCancel`) — so the next live pass reads
attribution off the console instead of burning a session on a HAR. No new flags, no UI.

**Surface changes (flagged, all within the sanctioned list — NO version bumps, no
manifest change, no new message types):** (a) `messages.ts`: the `cancelTranslation`
`mode?` field only (default-hard, byte-compatible). (b) `translateHandlers.ts`: the pure
`classifyCancel` decision table (+ `CancelMode`/`CancelDisposition` types,
`shouldAbort`/`shortId` helpers), the handler's started-boundary check, and the §4 logging
in both cancel handlers; plus a `requestControllerHasForTest` seam mirroring the existing
`startedRequestsHasForTest`. (c) `queue.ts` + `ProviderBase.ts` + `translateTiles`: the
three §3 guards (a few lines each). (d) `viewportQueue.ts`: the §2 intent state,
`classifyRegisterIntent` predicate (+ `TranslateAllIntent`/`RegisterIntentAction` types),
`maybeAutoSendForIntent`, a `safeBool` helper, the `"queued-only"` unregister cancel, and a
new **injectable `getHref` seam** (defaulted to `location.href`, fail-soft to `""` in a
location-less runtime — the same feature-detect pattern as `isImageLoaded`) so the
persistence shell is testable. `PROMPT_VERSION` 3 / `SNAP_VERSION` 4 / `CACHE_VERSION` 2
**untouched** — nothing here changes prompts, the cache key, or cached shapes (a **free**
phase, no forced re-translation).

**Deliberate calls:** the no-refund economics behind soft-cancel (finish a started call →
convert sunk cost into a cache entry §2 will hit, rather than kill it for ~zero saving);
the href-scoped intent (cheapest precise "this chapter" scope for an SPA); the three-seam
§3 placement (queue start / post-prep / pre-fetch) as defense-in-depth so the ghost class
is structurally impossible; the §2 micro-cleanup (skip a hydrate probe for a candidate the
intent is about to real-send — the invisible probe only loses the race). **Considered and
rejected** (per the handoff's out-of-scope list): overlay/`Tracked`-record migration across
recycled elements (the cacheKey coalesce/cache-hit path achieves the same render for less
machinery); debouncing the `isConnected` reconcile in `OverlayManager.syncPositions` (with
§1+§2 the reconcile's cancel is harmless, and timing heuristics there risk real teardown
bugs); model/latency/concurrency changes; batch-path abort rework (batching was OFF in this
evidence — the §3 queue/provider guards cover its fetches incidentally).

**Tests: 826 unit (+21 net over the 805 baseline).** §1: `classifyCancel` truth table
(unknown→noop; hard→abort started-or-queued; queued-only spares started, aborts queued) in
`translateHandlers.test.ts`; handler behaviour (queued-only aborts a not-started job +
deregisters; queued-only SPARES a started job — controller + started mark retained; hard
aborts a started job; mode-absent defaults to hard; unknown id silent in both modes) via
the started-poll seam in `translateHandlersPause.test.ts`. §2:
`classifyRegisterIntent` truth table + a five-case shell suite (real requestAll arms →
later registration auto-sends at priority 2; dry-run does NOT arm; `setPaused(true)`
disarms; `stop()` disarms; an href mismatch disarms permanently) on a non-auto queue with
an injected `getHref`, in `viewportQueue.test.ts`; the existing unregister-cancels-probe
assertion updated to expect `mode: "queued-only"`. §3: the queue guard (task NEVER invoked
when the merged signal is aborted at start, via a no-op-`addEventListener` fake signal that
survives to `start()`) in `queue.test.ts`; the `callOnce` guard (`fetchFn` spy not called
when the signal aborts between entry and callOnce — both the **primary** and **repair**
re-entries, via a `buildRequest`-time abort) in `providerBase.test.ts`; the post-prep tiles
guard (a cancel landing mid-prep fires **no** provider `fetch`) via a controllable
`prepareImage` mock in the new `translateHandlersDeadSignal.test.ts`. Typecheck + ESLint
clean; `vite build` clean; `web-ext lint` **0/0/0**.

**`npm run test:e2e` 4/4 green on this machine, Scenarios A–D UNMODIFIED** (A 9.0 s,
B 7.7 s, C 3.7 s, D 18.5 s) on default-resolved Firefox 153 with the 9.5 harness flag
`--remote-allow-system-access` (the only e2e-harness change, `before()` only, carried over
from 9.5; the scenario bodies were not touched this phase).

**Manual verification (live key + MangaDex): NOT run.** Expected on a fresh ≥15-page
translate-all scrolled at reading pace: every page ends translated; the network panel shows
**zero `status 0`** provider entries; tail pages may re-send and must coalesce/cache-hit (no
duplicate paid call for the same page bytes); a mid-burst fast scroll to the end and back
re-renders recycled pages from cache/coalesce (no permanently blank page); pause mid-burst
lets started calls finish + render and stops the queued ones (unchanged); toggling the
extension off mid-burst hard-aborts in-flight calls (unchanged); with debug on, every cancel
logs a disposition line. **Immediate no-code levers for the user** (independent of this
phase): at ~22 s/page and concurrency 6 a 19-page translate-all needs ~90 s before the tail
lands — end-of-chapter skeletons during that window are expected and now RESOLVE instead of
dying; if the OpenAI tier allows it, raising `concurrency` in Options shrinks the tail
window linearly, and a faster model shrinks it more.

## Phase 9.7 summary (temperature-400 downgrade race: the FIRST-wave blank pages)

Driven by the **fourteenth live-pass evidence** (2026-07-22 HAR `devtools_Archive
[26-07-22 01-50-37].har`, MangaDex, OpenAI `gpt-5.6-luna`) — the user switched from
`claude-sonnet-5` to `gpt-5.6-luna` and reported the OPPOSITE end of the chapter from
9.6: the **earliest pages** of a translate-all now left blank. This is a distinct bug
from the 9.6 tail-cancel class, and the HAR proves it cold. **Evidence (not
re-litigated):** 22 `/v1/chat/completions` requests. The first **concurrency-6 wave**
(all dispatched at t≈0) each sent `temperature: 0.25` and got **HTTP 400** —
`"'temperature' does not support 0.25 with this model. Only the default (1) value is
supported."` Every request *after* that wave omitted temperature and returned 200. Of
the six 400'd images, **one** was retried (temperature dropped) and rendered; the other
**five never made a second request and stayed blank**. Zero status-0 ghosts, zero 4xx
besides the temperature 400s, zero 429/5xx: **NOT the 9.6 recycle-cancel class, NOT a
network/auth/rate problem** — a request-shape 400 whose recovery was being dropped for
five of six siblings.

**Root cause (the shared-memo concurrency race).** `gpt-5.x`/`o-series` reasoning models
reject any non-default `temperature` — the same class Phase 3.1 first hit on Claude 4.6+,
handled by the persisted `samplingReject` memo (`endpointModes.ts`) that the provider
`buildRequest` reads to omit temperature once a model is known to reject it. But the
`downgrade` (400-recovery) path in **both** `openai.ts` and `anthropic.ts` gated the
temperature RETRY on that same memo (`!isSamplingRejected(model)` / `|| isSamplingRejected
(model)`). The memo is shared and set **synchronously** by the first sibling to process
its 400. So at concurrency 6 the whole first wave builds with temperature (memo empty) and
all 400 together; the first to recover flips the memo; the other five then hit a downgrade
that sees `isSamplingRejected === true`, **skips the temperature branch, falls through to a
null downgrade, and lets the raw 400 propagate as a hard error** — a permanent blank page
(only the learn-race winner recovered, exactly the 1-of-6 in the HAR). A second-order
aggravator: the startup memo hydrate (`index.ts`) is fire-and-forget, so even a returning
user whose prior session already learned `gpt-5.6-luna` re-sent temperature because the
translate-all burst out-raced the async `storage.get`.

**Fix (correctness — the blank pages).** In both providers the temperature-retry decision
now keys **only on what THIS request sent** (`ctx.temperature !== undefined`) plus the
error regex — never the shared memo. The `ctx.temperature !== undefined` guard already
excludes the already-learned case (buildRequest omits temperature once the memo is set, so
a later request never sends it and can't 400 on it), and the retry re-enters `callOnce`
with `allowDowngrade=false` which already prevents any loop — so the memo check in
`downgrade` was pure harm. `learnSamplingRejected` stays (idempotent); every concurrent
temperature-400 now strips and retries, so the whole first wave recovers.

**Fix (cost/latency — the re-paid 400 wave).** The `translatePage` handler now awaits
`loadEndpointModes()` + `loadSamplingMemo()` **in parallel with `loadSettings()`** before
building any request, so a model already known (from a persisted past session) to reject
temperature omits it from the very first call instead of re-paying six 400s + doubled
first-wave latency every time the event page wakes — fulfilling the Phase 8 §4 persistence
intent the fire-and-forget hydrate was defeating. Memoized promises → effectively free
after the first await; fail-soft (a storage fault just re-pays one recoverable 400 per
model). **Considered and rejected:** seeding the memo from a hardcoded `gpt-5|o-series`
model regex — the codebase philosophy (endpointModes.ts, anthropic.ts) is explicit that
learn-on-400 + persist beats a model list that goes stale as BYOK users type arbitrary ids;
the two fixes above make the learned path both correct under concurrency and durable across
sessions, which is the same outcome without the stale-list liability.

**Surface changes (all internal — NO shared-contract, message, manifest, or version
change):** (a) `openai.ts` `downgrade`: drop the `!isSamplingRejected` guard from the
temperature branch (+ WHY note on the race). (b) `anthropic.ts` `downgrade`: drop the
`|| isSamplingRejected` guard from the sampling branch (+ WHY note). (c)
`translateHandlers.ts`: import `loadEndpointModes`/`loadSamplingMemo` and fold them into the
handler's opening `Promise.all` with `loadSettings`. `PROMPT_VERSION` 3 / `SNAP_VERSION` 4 /
`CACHE_VERSION` 2 untouched — no prompt, cache-key, or cached-shape change (a **free** fix,
no forced re-translation), and no touch to the 9.x render/snap/prompt pipeline or the 9.6
cancel machinery.

**Tests: 828 unit (+2 over the 826 baseline).** A concurrency-race regression per provider
(`providers.test.ts`): two `translatePage` calls fired together against a body-keyed fetch
mock (any request carrying `temperature` 400s; the temperature-dropped retry succeeds) —
**both** pages must resolve with regions (before the fix the second rejected with the raw
400) and exactly four fetches fire (two initial + two retries). The existing single-request
downgrade + per-model/per-endpoint memoization tests are unchanged and still green.
`npm run check` green (typecheck + ESLint + 828 tests); `vite build` clean (background
58.85 kB). **`npm run test:e2e` not re-run this fix** — no content/overlay/e2e-path change
(background provider + handler only); the 9.6 baseline (4/4 A–D on Firefox 153 with
`--remote-allow-system-access`) stands.

**Manual verification (live key + MangaDex): NOT run.** Expected on a fresh translate-all
after switching to a temperature-rejecting model (`gpt-5.x`/`o-series`, or Claude 4.6+):
the **first** wave may show a brief burst of `temperature` 400s in the network panel on the
very first ever use of that model, but **every** one now retries and renders (no permanently
blank early pages); on the **next** session the memo is hydrated before the first call, so
that model sends **zero** temperature 400s. With debug on, a `sampling-reject` learn is
logged once per new model. **No-code lever for the user (independent of this fix):** the
400s never billed and are harmless once recovered, but a user who wants a clean first wave
can leave `temperature` at the default the model accepts — the extension now handles the
mismatch either way.

