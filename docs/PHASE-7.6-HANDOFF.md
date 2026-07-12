# Phase 7.6 — Connected-bubble snap + cache-only hydrate (handoff)

You are implementing **Phase 7.6** of the MangaLens Firefox extension — a
point-phase (precedent: 4.1 / 5.1 / 7.1–7.5) driven by the FIFTH live-browser
verification (2026-07-11, Firefox release build, **Anthropic provider,
`claude-sonnet-5`**). It lands before Phase 8. **No prompt-layer changes**
(`PROMPT_VERSION` stays 2) and **no `CACHE_VERSION` bump** (WHY below); item 1
is geometry inside `bubbleSnap.ts`, item 2 is a small flagged
`shared/messages.ts` contract addition.

## Live evidence (2026-07-11 screenshots, post-7.5 build)

**Item 1 — connected bubbles break the snap.** On a page with two JOINED
speech bubbles (one balloon flowing into the other — a common manga idiom;
the join can be waisted, circular, wavy, irregular), the overlay rendered one
extreme box swallowing the pair with a second box stacked on top of it, text
overlapping text. Root cause, confirmed by reading the code paths:

- Joined bubbles share ONE connected light blob. `snapRegionToBubble`'s flood
  fill from the LARGER bubble's seed fills the whole joined blob; the union is
  typically only ~1.5–2.5× that region's seed-box area — comfortably under the
  `MAX_BLOB_BOX_RATIO = 4` leak cap — so it is *accepted*, and the region snaps
  to the union bounding box of BOTH bubbles.
- The SMALLER bubble's seed fills the same blob, but the union usually DOES
  exceed 4× its smaller seed box → leak reject → `null` → it keeps the loose
  provider box. Hence one huge box + one small box, overlapping.
- `overlapTrim.ts`'s containment guard then sees one box containing the other
  and deliberately skips the pair (it was built for duplicate detections), so
  they render stacked. Nothing violates its own spec — "same blob claimed by
  multiple regions" was never a modeled case.
- Because snap results are CACHED (7.5 memoization decision), the bad union
  geometry replays on every revisit until the entry is cleared or evicted.

**Item 2 — no way to surface cached translations without re-requesting.** A
cache hit only surfaces when some translate request runs (the cache key is a
content hash — the background must fetch + hash bytes before it can even look
up). On an auto site that happens on scroll; on a manual site the user must
re-click Translate all after every reload, and an incompletely-cached chapter
makes that click cost real provider calls. User asked for a way to load
existing cached translations with zero provider spend.

**Decision (user-approved):** (1) make multi-region shared-blob claims a
modeled case in `bubbleSnap.ts` — detect them, SPLIT the shared blob between
its claimants with axis-aligned cuts and per-lobe windowed re-fills, and back
everything with a conservative "a snap that swallows a neighbour is reverted"
guard, so the worst case is exactly the pre-7.5 loose provider boxes (rule 4).
Do NOT attempt shaped/non-rectangular fitting — the overlay only renders
rectangles; the problem is "give each region its own lobe", not "fit the
weird union shape". (2) Add a `cacheOnly` translate mode plus an automatic
content-side **hydrate pass** on non-auto sites, gated by a cheap
"does this origin have any cache entries?" count, so previously translated
pages reappear on reload with guaranteed-zero provider calls.

Read first: `src/background/bubbleSnap.ts` (whole module — item 1 lives
here), `src/content/overlay/overlapTrim.ts` (stays untouched; understand its
containment guard), `src/background/translateHandlers.ts` (`translateImage`
lines ~372–479: the fetch → hash → key → lookup block item 2 forks from),
`src/content/viewportQueue.ts` (`sendTranslate`/`register`/bookkeeping — the
hydrate pass lives here), `src/shared/messages.ts` (`TranslatePageRequest`,
`TranslatePageResult`), `src/background/cache.ts` (the `origin` index item 2's
gate counts). Baseline is green: 524 unit tests, typecheck, ESLint,
`vite build`, `web-ext lint` (0 errors / 0 warnings / the known
`data_collection_permissions` notice — Phase 8).

**Already shipped — do NOT rebuild:** the 7.5 snap core (seeds, flood fill,
min-area + leak guards, kind gating, `computeSnapSize`, `clampBoxToRect`) and
its wiring at `translateHandlers.ts:340` / `regionHandlers.ts:131` — both call
sites keep their exact signatures, so item 1 changes NOTHING outside
`bubbleSnap.ts`; the 7.4 corner schema + joint clamp + `trimOverlaps` + pause;
the 7.3 object-fit geometry.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event
   pages.
2. Pure-core / thin-shell split: every *decision* (group detection, cut
   placement, swallow guard, hydrate bookkeeping transitions) is a pure,
   browser-free, Vitest-covered function; the untested surfaces stay the
   existing thin shells (OffscreenCanvas decode, IndexedDB, observers).
3. Contract scope — **flagged (rule 4):** `shared/messages.ts` gains exactly
   (a) `TranslatePageRequest.cacheOnly?: boolean`, (b) a third
   `TranslatePageResult` arm for "not cached", (c) one new message
   `countCachedForSite`. **NO `shared/types.ts` or `shared/settings.ts`
   change** — in particular do NOT add "not-cached" to `ProviderErrorKind`
   (that taxonomy drives negative-cache policy and provider error mapping;
   "not cached" is not an error). No new settings.
4. **`PROMPT_VERSION` stays 2. `CACHE_VERSION` stays 2.** WHY no cache bump
   even though cached union-snap geometry is wrong: a bump retires the WHOLE
   store and re-pays provider $ for every previously translated page (the user
   is cost-sensitive); the damage is limited to pages with connected bubbles,
   the fix applies to all new translations immediately, and the user can
   per-site clear (F15, options page) the affected reader. Note this in
   PROGRESS.md.
5. Fail soft everywhere: any ambiguity in item 1 resolves to the provider box;
   any failure in item 2 resolves to "not hydrated" (silent) — never an error
   badge from a probe, never a thrown handler.
6. `// WHY:` comments on non-obvious decisions; PROGRESS.md summary in house
   style when done.

## Files

```
touched: src/background/bubbleSnap.ts        # item 1 (all of it)
         tests/unit/bubbleSnap.test.ts       # item 1 coverage
         src/shared/messages.ts              # item 2 contract (flagged)
         src/background/translateHandlers.ts # item 2 cacheOnly fork
         src/background/cache.ts             # item 2 origin count (read-only)
         src/content/viewportQueue.ts        # item 2 hydrate pass
         src/content/index.ts                # item 2 option wiring (1 line)
         tests/unit/viewportQueue.test.ts    # item 2 coverage
         tests/unit/translateHandlers*.ts    # item 2 coverage
         PROGRESS.md
```

No new modules expected; if the item-1 group logic makes `bubbleSnap.ts`
unwieldy, splitting the group/slab helpers into `bubbleSnapGroups.ts` is the
implementer's call (flag it).

---

## 1. Connected bubbles — shared-blob split + swallow guard (`bubbleSnap.ts`)

Restructure so the per-region loop is PURE: extract the shell's region loop
into an exported, tested orchestrator

```ts
snapAllRegions(img: SnapBitmap, regions: readonly { bbox: BBox; kind?: RegionKind }[],
               opts?: SnapOptions) → (BBox | null)[]
```

(`null` = keep the provider box, exactly as today). `snapPageRegions` becomes
an even thinner shell: decode → `snapAllRegions` → apply results (+ the
existing `clampRect` intersection on the region path). The orchestrator runs
four stages:

**Stage 1 — independent snaps (existing).** `snapRegionToBubble` per eligible
region (`shouldSnapKind` unchanged) → `snaps[i]: BBox | null`.

**Stage 2 — shared-blob group detection (new pure helper).** Two triggers,
both over normalized boxes:
- *Twin snaps:* regions whose ACCEPTED snaps are near-identical — pairwise IoU
  ≥ `SHARED_BLOB_IOU` (default **0.8**) — filled the same blob. Union them
  into one group; the group's blob box is the union of the members' snapped
  boxes.
- *Swallowed neighbour* (the screenshot case — one region snapped the union,
  the other leaked → null): fold region `j` into region `i`'s group when
  `coverage(snapᵢ, boxⱼ) ≥ SWALLOW_COVERAGE` (default **0.65**) AND
  `coverage(origᵢ, origⱼ) < SWALLOW_COVERAGE` — i.e. the coverage is NEW,
  introduced by the snap, not already present in the provider's loose boxes.
  Here `coverage(a, b) = area(a ∩ b) / area(b)`, and `boxⱼ = snapⱼ ?? origⱼ`.
  Only snap-ELIGIBLE regions join groups (a caption can trigger the stage-4
  guard but never gets a slab).

**Stage 3 — slab split with windowed re-fills (new).** For each group with
≥ 2 members:
1. Pick the cut axis: the axis (x or y, in BITMAP px so aspect ratio doesn't
   lie) with the larger spread of member ORIGINAL-box centers. // WHY original
   boxes: the snapped boxes are identical (the union) — only the provider's
   boxes still know which lobe is whose.
2. Sort members by center along that axis; cut at the midpoints between
   consecutive centers. Member k's WINDOW = groupBlobBox ∩ its slab.
3. Re-run the fill per member with the fill CONFINED to its window: add
   `window?: BBox` (normalized) to `SnapOptions`; `floodFill` treats
   out-of-window pixels as walls; seed coordinates are clamped INTO the
   window. // WHY re-fill instead of just intersecting the union box with the
   slab: the windowed fill's bbox hugs the member's actual lobe on BOTH axes
   (a diagonal or wavy join leaves art inside the slab that a plain
   rectangle-intersection would keep). The existing min-area / leak guards
   apply unchanged within the window (the window itself now prevents the
   union leak that killed the smaller member in stage 1).
4. **All-or-nothing per group:** if EVERY member's windowed fill accepts, each
   member gets its lobe box; if ANY member's fill fails (dark slab, min-area,
   degenerate window), the WHOLE group reverts to provider boxes. // WHY:
   a member whose slab contains only art is evidence the group was a false
   positive (e.g. a loose provider box that merely strayed onto a big
   bubble's blob) — cutting a real bubble in half on bad evidence is exactly
   the "wrong snap is worse than a loose box" trap; provider boxes are the
   safe status quo.

**Stage 4 — swallow guard (new pure helper; the final safety net over ALL
results).** After stages 1–3, for every region i whose result is an accepted
snap: if there exists ANY j ≠ i (eligible or not) with
`coverage(resultᵢ, resultⱼ ?? origⱼ) ≥ SWALLOW_COVERAGE` and
`coverage(origᵢ, origⱼ) < SWALLOW_COVERAGE`, revert `resultᵢ` to null. // WHY
a second pass when stage 3 exists: stage 3 only handles groups it could split;
this catches everything else — a split member that still swallows a caption, a
group revert that left the twin snap in place, future drift. A false revert
costs the status quo; a false accept costs the screenshot.

Constants exported (tests tune them, defaults above are starting points).
`shouldSnapKind`, `computeSnapSize`, `clampBoxToRect`, the wiring call sites,
and `overlapTrim.ts` are all UNTOUCHED.

🧪 *Tests* (extend `bubbleSnap.test.ts`; the existing fixture helper draws
rects/ellipses — add a "peanut": two ellipses joined by a light neck on gray):
vertically-joined pair with a loose provider box per lobe → each result hugs
its own lobe, neither covers the other's; the same rotated (horizontal join);
the SCREENSHOT case — larger box's independent snap accepts the union while
the smaller leaks to null → group forms via the swallow trigger and both get
lobes; a 3-lobe chain splits into 3; a group member whose slab is all-dark →
WHOLE group reverts to provider boxes; twin near-identical snaps (IoU ≥ 0.8)
group without a swallow trigger; stage-4 guard: a snap newly covering ≥ 65% of
a non-eligible (caption) region's box reverts to null, while pre-existing
provider-box overlap (`coverage(origᵢ, origⱼ)` already high) does NOT revert;
windowed fill: seeds clamped into the window, fill cannot cross the cut;
single isolated bubble is byte-identical to the 7.5 result (no regression);
determinism; input regions never mutated.

## 2. Cache-only hydrate — cached pages render on reload, zero provider spend

### Contract (`shared/messages.ts` — flagged, rule 3)

- `TranslatePageRequest.cacheOnly?: boolean` — "answer from cache or say
  not-cached; NEVER enqueue, coalesce, or call the provider."
- `TranslatePageResult` gains a third arm, e.g.
  `| { ok: false; errorKind: "not-cached" }` — the literal lives ONLY in this
  union, NOT in `ProviderErrorKind` (rule 3). It is unreachable for
  non-`cacheOnly` requests; the hydrate sender handles it explicitly before
  the generic error branch so `setError`/`errorKindToMessage` never see it.
- New message `countCachedForSite: { request: void; response: { count:
  number } }` (content → background; origin derived from `sender.url` via the
  existing `originFromSender`). Background counts entries on `cache.ts`'s
  existing `origin` index (`IDBIndex.count(origin)` — O(log n), no getAll; add
  a read-only `countCacheForOrigin(origin)` to cache.ts, fail-soft to 0).

### Background (`translateHandlers.ts`)

In `translateImage`, after the `cacheLookup`: `hit` returns the page exactly
as today; `negative` throws the cached ProviderError exactly as today (// WHY:
a live negative IS a cached result — within its 10-min TTL the honest answer
is the same error badge a real request would show); `miss`/`expired` with
`cacheOnly` set returns the not-cached signal WITHOUT touching the coalesce
map, SharedAbort registry, or queue. Since `translateImage` returns
`PageTranslation`, signal it with a module-local sentinel error class (e.g.
`NotCachedError`) mapped by `errorToTranslateResult` to the new arm — or fork
before the coalesce block; implementer's call, but the fetch → hash →
`buildCacheKey` block must stay SINGLE-SOURCE (extract a small helper if
forking would duplicate it). The handler passes `req.cacheOnly` through.
Probes are registered in `requestControllers` like any request (cancellable
on teardown) but never call `onStarted` (they never enter the queue — pause
correctly treats them as not-started; an in-flight probe aborted by pause is
an accepted, silent non-event).

### Content (`viewportQueue.ts` + one line in `index.ts`)

`createViewportQueue` gains `hydrate: boolean`; the composition root passes
`!getAutoTranslate(settings, hostname)` — // WHY only non-auto sites: an auto
site already self-hydrates (visibility fires real requests whose cache hits
render in <50 ms), and doubling sends there buys nothing.

Behavior when `hydrate` is true:
- **Origin gate, once per queue lifetime:** lazily (before the first probe,
  memoized promise) send `countCachedForSite`; if the count is 0 or the
  message fails, ALL probes no-op. // WHY: without it every image on every
  active page on every site pays fetch+hash per pageload; with it, sites the
  user never translated on stay effectively inert — one indexed count per
  activation.
- **Probe on register:** each registered candidate is scheduled for one
  cache-only probe through a small concurrency gate (`HYDRATE_CONCURRENCY =
  3`). // WHY bounded: blob-sourced candidates (MangaDex) must ship their
  bytes with the probe via the existing `acquireBytes` path, and a 200-page
  chapter acquiring 200 buffers at once is the exact memory bomb the 7.2
  lazy-acquisition note forbids. Probing on register (not one batch at
  activation) covers lazily-added images for free.
- **Bookkeeping (the decisions — keep them in small pure helpers or pin them
  in shell tests):** a probe never calls `setPending` (no skeleton flash on
  every page), stamps `rec.requestId` (so unregister/stop cancel it) but
  leaves `requested === false` while in flight; on `ok` → `overlay.render` +
  `requested = true` (done — a later Translate all skips it); on
  `not-cached` → leave the record untouched, render nothing; on
  `aborted`/error/timeout → leave untouched, render NOTHING (no badge, no
  toast — a probe must be invisible when it fails). Probes ignore `paused`
  (pause gates provider spend; a probe spends none) and are skipped for
  candidates already `requested`. Accepted race (note in-source): Translate
  all clicked while probes are in flight can double-send an image — the real
  request just hits the cache the probe was reading; worst case one redundant
  fetch+hash.

`requestAll`, `translateAll` routing, drag-select, and the popup are all
UNTOUCHED — automatic hydrate supersedes the "Show cached" button idea.

🧪 *Tests:* translateHandlers — `cacheOnly` + miss returns the not-cached arm
and never enqueues/coalesces (mock `./cache` lookup to miss; assert the queue
seam and inflight map stay empty); `cacheOnly` + hit returns the page;
`cacheOnly` + live negative returns the mapped provider error;
`errorToTranslateResult(NotCachedError)` → the new arm; `countCachedForSite`
handler → count from the (mocked) cache helper, 0 on throw. viewportQueue —
hit renders + flips `requested` + no skeleton; not-cached leaves the candidate
unrequested and badge-free, and a later `requestAll` still sends the real
request; probe failure/timeout renders nothing; gate: count 0 → zero probes
sent; count > 0 → probes flow; concurrency ≤ 3 in flight; blob candidate's
probe ships bytes; unregister cancels an in-flight probe; `hydrate: false`
(auto site) sends zero probes; probes ignore paused. contentRouter — none
(no new content-side messages).

## Manual verification (REQUIRED — append results to PROGRESS.md)

1. Build, temporary add-on, Anthropic key, **`claude-sonnet-5`**. FIRST clear
   the test site's cache from options (F15) — cached union-snap entries from
   7.5 would otherwise mask the item-1 fix.
2. The Eminence-in-Shadow page with the JOINED bubbles from the 2026-07-11
   screenshot: translate → each connected bubble gets its OWN box hugging its
   lobe (or, at worst, the loose provider boxes — never one box swallowing the
   pair with stacked text).
3. Ordinary separated bubbles on the same chapter → still snap tight
   (no regression from the guard).
4. Drag-select across the joined pair → same per-lobe result, clamped to the
   selection.
5. Hydrate, http site: on a NON-auto site, Translate all a chapter, then
   reload → overlays reappear with NO click and the network panel shows ZERO
   `v1/messages`; the popup cost line does not move.
6. Hydrate, blob site: repeat on MangaDex → same (bytes-path probes).
7. Gate: a never-translated site with large images (any news site) →
   background console shows the count-0 short-circuit and no probe traffic.
8. Auto site: opted-in reader unregressed — scroll-translate works, no double
   renders.
9. If a specific joined pair still splits WRONG (cut through a bubble, wrong
   lobe): screenshot + note the page; tune `SHARED_BLOB_IOU` /
   `SWALLOW_COVERAGE` before adding mechanism.

## Explicitly out of scope (do NOT build)

- **Non-rectangular overlays / blob-mask-shaped boxes** — the windowed fill's
  per-lobe blob remains the natural input for this later; note it, don't
  build it.
- **Watershed / distance-transform blob splitting** — the axis-aligned cut +
  all-or-nothing revert covers the manga cases; revisit only with live
  evidence of joins it mishandles.
- **`CACHE_VERSION` bump** (rule 4 above) and any cache-key composition
  change; **prompt/schema changes** (`PROMPT_VERSION` stays 2).
- **Hydrate on auto sites**, a popup "Show cached" button, hydrating
  drag-select regions (region results are uncached by design).
- Local ML detection/OCR; Gemini `box_2d` dialect; prompt caching for the
  static prefix (its own phase).
- Everything in PHASE-8-HANDOFF.md.

## Definition of done

- `npm run check` green (524 existing + new item-1/item-2 coverage);
  `npm run build` clean; `web-ext lint` 0 errors / 0 warnings (the
  `data_collection_permissions` notice remains — Phase 8).
- `shared/types.ts` / `shared/settings.ts` untouched; `shared/messages.ts`
  changed by exactly the three flagged entries; cache-key composition,
  `PROMPT_VERSION`, `CACHE_VERSION` untouched.
- The manual pass above EXECUTED and recorded honestly in PROGRESS.md.
- PROGRESS.md gets a Phase 7.6 summary flagging: the connected-bubble failure
  mode and why the leak cap missed it; the group/slab/all-or-nothing design
  and its thresholds; the stage-4 swallow guard; the no-CACHE_VERSION-bump
  decision and the per-site-clear workaround; the not-cached result arm
  living outside `ProviderErrorKind`; the origin-count gate and the
  bounded-concurrency probe design; the accepted races (Translate-all vs
  probe, pause vs probe).
