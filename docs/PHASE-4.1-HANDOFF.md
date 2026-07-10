# Phase 4.1 — Review Fixes: Cache + Queue + Cost Tracker (handoff)

You are implementing **Phase 4.1** of the MangaLens Firefox extension: fixes from a
review of the Phase 4 implementation (`background/cache.ts`, `background/queue.ts`,
`background/costTracker.ts`, and their wiring in `background/translateHandlers.ts`).

Read `docs/ARCHITECTURE.md` (esp. §7.3–§7.6, §9 handoff rules) and the Phase 4
summary in `PROGRESS.md` first. Baseline state is verified green: 200 unit tests,
typecheck, ESLint, `vite build`, and `web-ext lint` (0 errors / 0 warnings) all pass.

## Ground rules (Architecture §9, unchanged)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 **event
   pages** (not Chrome service workers).
2. Every exported function/class gets JSDoc (purpose, params, edge cases).
3. Every change gets Vitest coverage (happy path + edge cases). No real network
   or IndexedDB in tests — keep the pure-core / thin-shell split this repo uses
   everywhere: put new logic in pure, browser-free functions and test those.
4. Do not change interfaces in `shared/types.ts` without flagging it explicitly.
5. Fail soft: cache/cost faults must degrade to "no caching" / "no accounting",
   never a failed translation.
6. Comment every non-obvious decision with a `// WHY:` prefix.
7. When done: `npm run check` + `npm run build` + `npm run lint:ext` all clean,
   and append a **Phase 4.1 summary** paragraph to `PROGRESS.md` in the existing
   style (what changed, what was flagged, test counts).

---

## P1 — Correctness fixes (required)

### 1. `recordUsage` loses updates under concurrency (lost-update race)

`src/background/costTracker.ts:180-190` — `recordUsage` does async
read (`getCostStats`) → modify (`addUsage`) → write (`storage.local.set`) with no
serialization. Default concurrency is 6, so two translations routinely finish
near-simultaneously: both read the same stats, both write, and one page's
tokens/cost vanish from the totals. F17's whole point is that users can trust
these numbers before a "translate all".

**Fix:** serialize all cost writes through a module-level promise chain
(`let writeChain: Promise<unknown> = Promise.resolve();` — each `recordUsage`
and `resetCostStats` appends to it and awaits its own link). Keep fail-soft:
a failed link must not poison the chain (catch inside the link).

**Tests:** start two `recordUsage` calls without awaiting the first (inject
latency by spying on `fakeBrowser.storage.local.get` to defer one tick), then
assert `calls === 2` and both entries' costs are summed. Also assert a storage
failure in one call doesn't break the next (chain not poisoned).

### 2. Tiled pages under-report usage (images/calls stuck at 1)

`src/background/translateHandlers.ts:254` — `recordUsage(usageFromPage(merged))`
uses the default `images = 1`, but a tiled webtoon page made N provider requests
(`translatePrepared` fans out per tile). `UsageEntry.images`'s own JSDoc promises
"a tiled webtoon page is > 1" — the value is just never wired. Token counts are
correct (summed by `mergeTilePages`); only request/image counts are wrong.

**Fix:** have `translatePrepared` return the tile count alongside the page
(e.g. `{ page, providerCalls }` — it's a private helper, no contract change),
and pass it: `usageFromPage(merged, providerCalls)`. Update
`ProviderCostStats.calls` JSDoc: `calls` counts recorded *pages/events*, `images`
counts provider image requests (the number that actually tracks cost for strips).

**Tests:** `usageFromPage(page, 4)` already covered; add a pure test that
`addUsage` accumulates `images` from a multi-tile entry as expected. (The driver
stays untested — browser-only — so keep the logic in the tested helpers.)

### 3. Cache key built from the raw, possibly-empty model string

`src/background/translateHandlers.ts:217-222` keys the cache with
`providerSettings.model`, but the provider actually runs
`settings.model || this.defaultModel` (`src/background/providers/ProviderBase.ts:541`).
With factory-default settings (`models: {}`), the key's model segment is the
empty string (`…||p1`) while the request really used e.g. `gemini-2.0-flash`.
Two concrete consequences:

- If an adapter's `defaultModel` is ever bumped (e.g. to a newer Flash), stale
  entries produced by the *old* default keep being served under the `""` key —
  violating F13's "keyed by … + model" guarantee.
- A user who explicitly selects the model that *is* the default gets a
  different key and needlessly re-translates everything.
- The stored `PageTranslation.model` (stamped with the resolved model) also
  disagrees with the key it's stored under.

**Fix:** expose a pure `resolveEffectiveModel(settings: ProviderSettings): string`
(natural home: `providers/factory.ts`, next to the provider-id → class map; the
per-provider defaults are `gemini-2.0-flash`, `claude-haiku-4-5`, `gpt-4o-mini`,
`google/gemini-2.0-flash-001`, and `""` for custom). Use it when building the
cache key in `translateImage`. Custom endpoints keep `""` when no model is set —
acceptable, note it with a WHY. Don't duplicate the defaults: refactor the
adapters to consume the same constants the resolver uses (single source of truth).

**Tests:** resolver returns the per-provider default when `model` is empty and
the explicit model otherwise; cache key for default-settings gemini equals the
key for explicitly-selected `gemini-2.0-flash`.

### 4. Prompt-shaping settings are missing from the cache key

`buildCacheKey` (`src/background/cache.ts:90-97`) composes
`imageHash|targetLang|model|p{PROMPT_VERSION}`. But the prompt also varies with
`preserveHonorifics` (honorifics rule slot), `readingDirection` (reading-order
slot), and `sourceLangHint` (user-text source pin) — see PROMPTS.md §3/§4/§7.
Flip any of them and cached results from the old setting are silently served.
`PROMPT_VERSION` only covers prompt *text* changes, not slot values. (This goes
beyond the Architecture F13 key spec — flagging per rule 4 — but it's the same
staleness bug PROMPT_VERSION exists to prevent.)

**Fix:** extend `buildCacheKey`'s parts with the provider id and a compact,
canonical options fingerprint, e.g.
`{provider}|{imageHash}|{targetLang}|{model}|h{0|1}|d{rtl|ltr|auto}|s{hint|-}|p{version}`.
Always encode every field (no omit-when-default, or old keys silently match).
Deliberately **exclude** `temperature` (continuous knob, minor output effect;
excluding it keeps the cache useful — WHY-comment this). Including the provider
id also removes cross-provider collisions (same model name reachable via
`openai` and `custom`, which have different downgrade behavior). While here:
delimiter-proof the key by `encodeURIComponent`-ing the free-text segments
(model strings can legally contain `|`).

**Tests:** flipping each of provider / honorifics / readingDirection /
sourceLangHint changes the key; temperature does not; a model containing `|`
cannot collide with a crafted neighbor.

---

## P2 — Robustness / performance (required unless noted)

### 5. A single failed IndexedDB open disables caching forever

`src/background/cache.ts:226-241` — `getDb` memoizes `dbPromise` even when the
open **rejects**; every later cache call re-awaits the same rejected promise, so
one transient fault (quota pressure, private-browsing edge case) turns caching
off for the rest of the event-page lifetime.

**Fix:** on rejection, reset `dbPromise = undefined` so the next operation
retries the open (attach the reset via `.catch` at creation; be careful not to
create an unhandled-rejection — the callers already catch).

### 6. `evictToCap` deserializes the whole store on every write

`src/background/cache.ts:352-364` runs `db.getAll(CACHE_STORE)` after **every**
`cacheStorePage`. At the default 200 MB cap that's potentially hundreds of MB of
records parsed per stored page — the cache would get slower the fuller it gets.

**Fix (recommended shape):** track a running total instead of recounting.
- Add a singleton meta record (separate tiny object store, e.g. `meta`, key
  `"totalBytes"`), updated transactionally on every put/delete/clear using the
  `bytes` field already stored per record.
- `evictToCap` reads the total; if under cap, done (the common case becomes
  O(1)). If over, open a cursor on the existing `lastAccess` index and delete
  oldest-first until under, decrementing the total. Expired negatives are tiny;
  it's fine to drop the "expired first" pass and let the LRU walk collect them —
  keep `cacheLookup`'s TTL classification as the correctness guard (WHY-comment
  this simplification, and see item 8).
- Keep a pure planner for anything decision-shaped so it stays unit-tested;
  `planEviction` can remain for reference or be retired if nothing calls it —
  don't leave dead exports.

Bumping the store layout requires bumping `CACHE_VERSION` in
`src/shared/constants.ts` (the DB name) — that's exactly what it's for; note it
in the summary.

**Tests:** pure planner tests for the new decision logic (when to evict, how
much); the IDB shell stays untested per repo convention.

### 7. Concurrent duplicate requests both pay the provider

`translateImage` has no in-flight coalescing: two `translatePage` requests for
the same image arriving before the first finishes (scanner + prefetch overlap,
duplicate scroll events, two tabs on the same chapter) both miss the cache and
both call the provider. F13's goal is "never translate the same image twice".

**Fix:** module-level `Map<string, Promise<PageTranslation>>` keyed by the cache
key. On miss, store the queued work's promise before awaiting; remove it in a
`finally`; followers await the same promise. WHY-note the abort caveat: today the
handler's `AbortController` is never aborted, so sharing is safe; when Phase 5
adds real cancellation this needs a refcount (leave the note, don't build it).

**Tests:** none required (browser-only driver); if you extract the coalescing
into a tiny pure/generic helper (`coalesce(map, key, fn)`), test that instead —
two concurrent calls, one `fn` invocation, map cleaned up on success **and** on
rejection.

### 8. Old cache databases are stranded on `CACHE_VERSION` bumps

The DB *name* embeds `CACHE_VERSION` (`mangalens-cache-v1`), so bumping the
version (as item 6 will) leaves the previous database — up to the full cap in
size — on disk forever.

**Fix:** on first open, fire-and-forget a sweep: `indexedDB.databases()`
(Firefox 126+; our `strict_min_version` is 128) → delete every
`mangalens-cache-v*` whose name isn't current. Fail-soft, `log.debug` on
success, never block or fail the open.

---

## P3 — Minor cleanups (do if cheap, skip if they fight the P2 refactor)

9. **Expired negative entries linger after lookup** — `cacheLookup` classifies
   `expired` but leaves the record until an eviction pass. Fire-and-forget a
   delete when classification is `expired`.
10. **`utf8ByteLength` reinvents `TextEncoder`** — `src/background/cache.ts:100-113`
    can be `new TextEncoder().encode(s).length` (available in the event page and
    the Node test runtime). Delete the hand-rolled surrogate arithmetic; existing
    tests should pass unchanged.
11. **Cap guard** — a corrupt stored `cacheCapMb ≤ 0` makes every store evict the
    entire cache (`planEviction` treats `cap ≤ 0` as "evict all"). Clamp in
    `cacheCapBytes` (`translateHandlers.ts:131-133`) to a sane floor (e.g. 1 MB).

---

## Explicitly reviewed and left alone (do NOT "fix")

- **Queue retry stays 0 in the translate path** — the provider layer owns the
  429/529 backoff ladder; retrying in the queue would double it (WHY already
  in-source).
- **Fetch + hash run *outside* the queue** — deliberate, so cache hits never
  wait behind a full queue (§7.5 "<50 ms"). The costs (unbounded fetch
  concurrency; queued jobs holding original image blobs in memory) are accepted
  for now — revisit in Phase 8 perf hardening (option then: drop the blob and
  re-fetch inside the task; `force-cache` makes it nearly free).
- **Negative-cache policy** (`malformed`/`refusal` only, 10-min TTL) matches
  PROMPTS §6.5 exactly.
- **The handler's unwired `AbortController`** — the message bus has no cancel
  path yet; Phase 5 should add one (port-based, or a `cancelTranslation`
  message + request id). Out of scope here.
- **`PRICING` is ballpark by design** — verify real numbers in Phase 6 when the
  popup/options actually display them (Architecture §3 "verify at build time").
- **Per-entry single `origin`** (image reused across sites keeps first origin) —
  accepted, noted in-source.

## Definition of done

- [ ] All P1 + P2 items implemented with tests; P3 at your discretion.
- [ ] `npm run check` (typecheck + eslint + 200+ tests) green.
- [ ] `npm run build` + `npm run lint:ext` clean (0 errors / 0 warnings; the
      `data_collection_permissions` notice stays Phase-8-deferred).
- [ ] Any `shared/*` contract change explicitly flagged (rule 4). Expected:
      **none** — everything here is background-module-local plus
      `CACHE_VERSION`'s value.
- [ ] `PROGRESS.md` gains a Phase 4.1 summary paragraph in the house style.
