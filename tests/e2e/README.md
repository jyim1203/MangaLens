# e2e smoke suite (Phase 8 §5/§6)

The two Architecture acceptance criteria (10-page chapter < 5 s; no leak after
100 navigations) plus the batching scenario, run against a **real Firefox** with
the built extension temporarily installed and a **dependency-free mock provider**.

## Files

- **`mockProvider.mjs`** — a dev-only, dependency-free Node HTTP server. An
  OpenAI-compatible `POST /v1/chat/completions` (counts image blocks: 1 → single
  page, N → a `pages` array of N), `GET /v1/models` (the options "Test" path),
  `GET /stats` + `POST /reset` (the test harness's request log), and a static host
  for the fixture chapter + its page images (served as **separate http URLs**, not
  data URIs, so the perf run exercises the real §7.3 background-fetch path).
  Runnable standalone: `node tests/e2e/mockProvider.mjs 8785`.
- **`chapter.html`** — the 10-page fixture chapter (raster **PNG** pages — Firefox's
  `createImageBitmap` rejects SVG blobs, Phase 8.1 §1; each page's bytes differ so
  its content-hash identity is distinct; page 3 is a `blob:` URL so the Phase 7.2
  bytes path rides along).
- **`chapter-long.html`** — the 30-page fixture (Phase 9.8 §3, Scenario E — the
  staged translate-all window). Same shape as `chapter.html`, reusing the same
  server-generated `/pages/N.png` images, but long enough that a translate-all's
  initial 12-page wave is a strict subset of the chapter. All-plain http pages (no
  blob) — the blob path is already covered by A/B, and a scroll-heavy 30-page run
  drops a blob-revocation-timing flake source. **Phase 9.9:** an inline script
  mimics MangaDex's long-strip reader — on load and on scroll it rewrites the
  page-number path segment via `history.replaceState`
  (`/chapter-long.html/<n>`, same document, no navigation, never hitting the mock
  server; `/pages/N.png` assets stay absolute so image loading is unaffected).
  That drift is exactly what the translate-all intent's chapter scope
  (`sameChapterHref`) must tolerate, so with the rewriting fixture **Scenario E is
  the 9.9 regression test**: on the pre-9.9 exact-href scope the first rewrite
  permanently disarms the intent and the chapter tail never paints; with the fix
  all 30 pages still paint.
- **`smoke.spec.mjs`** — the selenium-webdriver + geckodriver spec (node's
  built-in `node:test` runner). Scenarios A (perf, cold < 5 s + warm cache hits),
  B (translate-all batching → ceil-batched request counts), C (100 SPA swaps →
  overlay-host-count stability, the leak proxy — Firefox exposes no
  `performance.memory`), D (auto-visibility budget — no whole-chapter burst),
  E (staged translate-all — a 30-page chapter dispatches an initial window, then
  fills as the reader scrolls, with all 30 painted and no runaway duplicates).

## Running

The e2e suite is **excluded from `npm run check`** (the unit vitest config only
globs `tests/unit`). It needs the browser drivers installed:

```sh
npm install                         # includes selenium-webdriver + geckodriver
npm run test:e2e                    # vite build → web-ext build → node --test smoke.spec.mjs
```

Environment knobs:

- `MOCK_LATENCY_MS` (default `2000`) — the Architecture acceptance latency.
- `E2E_PERF_BUDGET_MS` (default `5000`) — Scenario A's threshold (raise on slow CI).
- `E2E_HEADLESS=0` — watch the browser instead of running headless.
- `E2E_FIREFOX_BIN` — path to a specific Firefox binary.

The extension's internal UUID is pinned via the `extensions.webextensions.uuids`
pref set **before** install, so `moz-extension://<uuid>/…` page URLs are known to
the test. Settings are seeded through the extension's own `storage.local` from an
extension-page context (a permitted driver-capability seed — never a prod message
path); the optional `<all_urls>` grant is a real driver click on the options
"Grant" button (a Marionette click is the trusted user gesture
`permissions.request` needs).
