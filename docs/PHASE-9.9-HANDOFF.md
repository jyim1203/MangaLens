# Phase 9.9 — Chapter-scoped translate-all intent: survive reader URL drift (handoff)

You are implementing **Phase 9.9** of the MangaLens Firefox extension: a single
surgical fix from the **fifteenth live-pass evidence** (2026-07-23 HAR
`devtools_Archive [26-07-23 01-28-59].har`, MangaDex, OpenAI `gpt-5.6-luna`, on
the **Phase 9.7** build — captured BEFORE Phase 9.8 landed). The user clicked
**Translate all** shortly after opening a chapter and later-loading pages were
never translated.

**Evidence established (do NOT re-litigate):**

- 5 provider calls, all dispatched together at t=22.4 s, **all HTTP 200**
  (14.8–28.4 s each). `temperature` was **absent from the very first request**
  (the 9.7 memo-hydrate fix is confirmed working live) and there are **zero
  status-0 ghosts and zero 4xx/5xx** (the 9.6 dead-signal guards are confirmed
  working live). The failure is not request-shaped, not a race, not provider-side.
- The capture starts on the TITLE page (cover-thumbnail fetches at t=0), the
  chapter opens ~t=20, the click lands t=22.4 with only the first few pages
  loaded/registered (5 cache misses paid; blob-page cache hits are invisible in a
  background-toolbox HAR). The user then read on.
- At **t=70.9 s** the background fetched `https://mangadex.org/img/miku.jpg` —
  MangaDex's placeholder graphic that sits in not-yet-loaded page slots — with
  **no provider call**. That is a fresh candidate REGISTERING ~48 s after the
  click and producing only an invisible cache probe: the register-time
  translate-all auto-send (9.6 §2) did NOT fire for it, and no provider traffic
  of any kind appears after t=50.8 s despite the session continuing.
- The only condition that kills the armed intent without a pause/teardown is the
  **exact-href scope**: `classifyRegisterIntent` disarms on ANY
  `location.href` change. MangaDex's long-strip reader **rewrites the page-number
  segment of the URL as the user scrolls** (`/chapter/<uuid>/<n>` via
  `history.replaceState`, no navigation, same document). One page boundary
  crossed → permanent disarm → every later-registering page stays blank. The e2e
  fixtures never rewrite their URL, which is why A–E never caught it.
- On the Phase **9.8** build (now on disk, review-verified) the same hole is
  **worse**: `pumpTranslateAllWindow` ALSO checks `intent.href !== getHref()`,
  so the first pump after a URL rewrite disarms the staged window and only the
  initial ~12-page wave ever dispatches.
- Incidental observation, **do NOT fix** (record in PROGRESS as observed): the
  scanner registers the `miku.jpg` placeholder itself as a candidate (http URL,
  large enough). Cost is bounded (one cached/paid mascot translation ever) and
  the src-swap re-registration path already handles the real page arriving.

**The fix in one line:** the intent's scope becomes "same chapter", not "same
URL string" — tolerate the *page-number drift* readers perform while scrolling,
still disarm on a real chapter/site change.

Read first: `docs/PHASE-9.8-HANDOFF.md` (the staged-dispatch design you are
extending), `src/content/viewportQueue.ts` (`classifyRegisterIntent`,
`maybeAutoSendForIntent`, `pumpTranslateAllWindow`, `disarmTranslateAll`,
`TranslateAllIntent`), the Phase 9.6 §2 + 9.8 summaries in `PROGRESS.md`,
`tests/e2e/chapter-long.html` + Scenario E in `smoke.spec.mjs`.

**Verified-green baseline (2026-07-23, this machine, do NOT rebuild/re-verify):
`npm run check` 858 unit tests, `npm run build` clean, `npm run lint:ext`
0/0/0, `npm run test:e2e` 5/5 (A–D unmodified + Scenario E).** Everything since
Phase 7.6 is uncommitted on `master` — expected; do not commit.

## Ground rules (Architecture §9, plus repo conventions)

1. TypeScript strict; JSDoc on every export; `// WHY:` on every non-obvious
   decision; pure-core / thin-shell.
2. **Sanctioned surface changes — flag each in the PROGRESS summary:**
   (a) `content/viewportQueue.ts`: the pure `sameChapterHref` helper, its use at
   BOTH intent href checks (`classifyRegisterIntent`, `pumpTranslateAllWindow`),
   the §2 disarm/drift debug logs, and (if needed) a `driftLogged`-style flag on
   the intent object.
   (b) `tests/unit/viewportQueue.test.ts`: the helper truth table + shell cases.
   (c) `tests/e2e/chapter-long.html` + (only if strictly needed) Scenario E in
   `smoke.spec.mjs`: MangaDex-style URL rewriting on scroll (§3). **Scenarios
   A–D stay byte-identical**; prefer leaving Scenario E's body untouched too —
   the fixture change alone should exercise the fix (E already asserts all 30
   pages paint).
   (d) `tests/e2e/README.md` note.
   **NO `shared/types.ts` change, no message changes, no manifest change, no
   other file.** Anything beyond: stop and flag.
3. **No version bumps** (`PROMPT_VERSION` 3 / `SNAP_VERSION` 4 /
   `CACHE_VERSION` 2). A **free** phase.
4. Fail toward DISARM (the cost direction). Every ambiguous comparison must
   resolve to "different chapter" — a false disarm costs a re-click; a false
   "same chapter" auto-buys pages of a chapter the user never clicked. The ONLY
   tolerated drift is the narrowly-defined numeric page segment below.
5. When done: `npm run check` + `npm run build` + `npm run lint:ext` clean,
   **`npm run test:e2e` green (A–D byte-identical, E green WITH the rewriting
   fixture)**, Phase 9.9 summary appended to `PROGRESS.md` in the house style.

## 1. [Content] `sameChapterHref` — the chapter-identity comparison

Pure, exported from `viewportQueue.ts`, unit-tested truth table. Semantics:

- Exact string equality → `true` (fast path, covers the location-less `""` test
  runtime).
- Parse both with `new URL(...)`; **any parse failure → `false`** (they were not
  string-equal, and unparseable means unjudgeable → disarm, rule 4).
- Different `origin` → `false`.
- **Hashes are ignored entirely** (fragment-based readers track pages as
  `#page-5`; a hash can never change the chapter).
- **`search` must be exactly equal** — query-string page tracking (`?page=5`)
  is NOT tolerated in this phase. // WHY: MangaDex (the evidence) drifts the
  PATH; loosening query comparison multiplies the false-"same" surface for zero
  observed benefit. Record as a known, deliberate limitation.
- Pathname rule (segments = pathname split on `/`, empty segments dropped):
  - equal segment lists → `true`;
  - same length, all segments equal except the LAST, and BOTH last segments are
    all-digits (`/^\d+$/`) → `true` (page 4 → page 9);
  - one list is the other plus exactly ONE extra TRAILING all-digits segment →
    `true` (`/chapter/<uuid>` ↔ `/chapter/<uuid>/4` — the reader adding the
    page segment after the first scroll);
  - anything else → `false`. // WHY digits-only: the chapter's identity on
    every known reader is a slug/uuid segment; the only thing long-strip
    readers rewrite while scrolling is a numeric page counter. A drifted uuid
    IS a chapter change and must disarm.

Wire it at **both** existing checks:

- `classifyRegisterIntent`: replace `intent.href !== currentHref` with
  `!sameChapterHref(intent.href, currentHref)` (signature unchanged).
- `pumpTranslateAllWindow`: same replacement for its
  `translateAllIntent.href !== getHref()` guard.

Do NOT update `intent.href` to the drifted value — the armed href stays the
anchor; drift is tolerated per-comparison. // WHY: re-anchoring on every drift
would let a slow multi-step mutation walk the scope arbitrarily far.

## 2. [Diag] Disarm + drift logging

- On an intent disarm caused by a chapter change (both call sites), one
  `log.debug`: `translate-all disarm: chapter changed <armedHref> -> <current>`.
- On the FIRST tolerated drift per armed intent, one `log.debug`:
  `translate-all href drift tolerated: <armedHref> -> <current>` (a boolean on
  the intent object; per-scroll logging would spam). // WHY: this phase's root
  cause hid for three phases because nothing logged the disarm; the next live
  pass must show the intent's lifecycle in the console.

## 3. [e2e] MangaDex-style URL drift in the long-chapter fixture

`tests/e2e/chapter-long.html` gains a small inline script that mimics the
MangaDex reader: on load, `history.replaceState(null, "", "/chapter-long.html/1")`,
and on scroll (rAF-throttled is fine), `replaceState` to
`/chapter-long.html/<n>` where `<n>` is the 1-based index of the topmost
visible page. // WHY this exact shape: the trailing all-digits segment is the
drift `sameChapterHref` tolerates, and `/chapter-long.html` remains a substring
of the URL so the Scenario E helper needle (`translateAllOnChapter("/chapter-long.html")`)
still matches. Asset URLs in the fixture are already absolute (`/pages/N.png`),
so the path rewrite cannot break image loading; `replaceState` never hits the
mock server, so no new route is needed.

With the fixture rewriting, **Scenario E as it stands is the regression test**:
on the unfixed build the first pump/registration after a rewrite disarms the
intent, the staged window freezes at the initial wave, and E's "all 30 pages
paint" assertion fails; with §1 it passes. Run E once against the unfixed
comparison mentally (or locally stash §1) if cheap, but do not commit any
red-run artifacts; the DoD is the green run.

**Tests (unit):** `sameChapterHref` truth table — identical strings (incl. two
empty strings); hash-only drift; numeric last-segment drift; appended trailing
numeric segment (both directions); non-numeric last-segment change → false;
uuid/slug segment change → false; origin change → false; search change →
false; length differing by ≥2 → false; unparseable inputs → equality only.
Shell (existing fake seams): armed intent + `getHref` drifting
`/chapter-long.html` → `/chapter-long.html/7` → a later registration still
sends AND the pump still refills after a confirm; `getHref` flipping to a
different chapter path → register disarms, pump disarms, and (non-auto) the
staged observers detach (`disarmTranslateAll` path — reuse the 9.8 assertions).

## Explicitly out of scope

- Query-string page-drift tolerance (`?page=N`) — deliberate limitation, above.
- Re-arming a disarmed intent when the URL returns to the armed chapter.
- Anything about the `miku.jpg` placeholder registration (observed, bounded,
  recorded — not built on).
- Any change to the staged-window math, spinner, budgets, or observers beyond
  the two guard call sites.

## Manual verification (live key + MangaDex; record honestly if not run)

1. Long chapter, Translate all near the top, scroll the WHOLE chapter at
   reading pace: the URL's page number visibly climbs; with debug on, exactly
   one `href drift tolerated` line and ZERO `disarm` lines; the staged window
   keeps refilling past every URL rewrite; no blank tail.
2. Navigate to a DIFFERENT chapter (SPA nav) mid-burst: one `disarm: chapter
   changed` line; the new chapter buys nothing until Translate all is clicked
   there.
3. The wolf badge appears on pending pages throughout (unchanged 9.8 behavior).

## Definition of done

- `npm run check` green (858 + new tests), `npm run build` clean,
  `npm run lint:ext` 0/0/0, **`npm run test:e2e` 5/5 with A–D byte-identical
  and Scenario E green over the now-rewriting fixture**.
- Only sanctioned surfaces (ground rule 2); no version bumps; no new messages.
- `PROGRESS.md` Phase 9.9 summary in the house style: the fifteenth-live-pass
  evidence chain (the t=70.9 s registration with zero provider traffic; 9.6/9.7
  fixes confirmed working live; the replaceState root cause and why e2e never
  caught it), the digits-only drift rule + fail-toward-disarm call, the
  query-string limitation, the no-re-anchor call, the miku observation, and
  honest manual-verification status.
