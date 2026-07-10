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
