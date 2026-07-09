# MangaLens — Firefox Manga/Image Auto-Translator Extension
## Full Project Plan (implementation-ready, designed for handoff to a coding LLM in phases)

---

## 1. Project Overview

A Firefox WebExtension that detects manga/comic images on any webpage, extracts text from speech bubbles, translates it via a user-supplied LLM API key, and overlays translated text directly on the image — in near real time, as cheaply as possible.

**Design pillars:**
1. **Bring-your-own-key (BYOK)** — no server of our own; all API calls go directly from the browser to the user's chosen provider.
2. **One vision call does everything** — bubble detection + OCR + translation in a single LLM request per page (this is the key cost/latency decision, explained in §3).
3. **Aggressive caching** — never translate the same image twice (content-hash keyed IndexedDB cache).
4. **Progressive enhancement** — auto-detection is primary; click-and-drag region selection is the universal fallback.

---

## 2. Feature Requirements (from spec + additions)

| # | Feature | Priority | Notes |
|---|---------|----------|-------|
| F1 | Global on/off toggle | P0 | Toolbar button + keyboard shortcut; per-site enable/disable list |
| F2 | BYOK (own LLM API key) | P0 | Support Anthropic, OpenAI, Google Gemini, OpenRouter, custom OpenAI-compatible endpoint |
| F3 | OCR / text recognition | P0 | Done by the vision LLM itself (see §3); optional local Tesseract.js fallback (P2) |
| F4 | Speech bubble detection + text overlay | P0 | LLM returns normalized bounding boxes; overlay layer renders styled divs |
| F5 | Font / font size controls | P0 | Font family, size mode (auto-fit vs fixed), color, stroke/outline, bubble fill opacity |
| F6 | Horizontal + vertical scrolling support | P0 | IntersectionObserver-driven; handles webtoon long-strips via image tiling (§7.4) |
| F7 | Real-time translation, ~10 pages < 5s | P0 | Parallel requests (concurrency 4–8), viewport-priority queue, prefetch ahead |
| F8 | Pre-translate entire chapter | P1 | "Translate all" action that queues every detected image |
| F9 | Set target language | P0 | Dropdown, default from browser locale |
| F10 | Click-and-drag translation boxes (fallback) | P0 | User draws a rect on any image → crop → translate just that region |
| F11 | Auto-detect source language | P0 | LLM reports detected language in its JSON response; user can also pin it |
| F12 | Cost minimization / batching | P0 | Image downscale + JPEG compression, multi-page batching option, caching, cheap model presets |
| **Added features** | | | |
| F13 | Translation cache (IndexedDB) | P0 | Keyed by SHA-256 of image bytes + target lang + model; instant on revisit |
| F14 | Toggle original/translated view | P1 | Hover or hotkey to peek at original text |
| F15 | Per-site settings & site blocklist | P1 | e.g., always-on for favorite reader sites |
| F16 | Export/import settings | P2 | JSON blob, excluding API key by default |
| F17 | Usage/cost tracker | P1 | Count tokens/images sent per provider, rough $ estimate |
| F18 | Reading direction hint (RTL manga vs LTR) | P2 | Affects bubble ordering if user reads text list |
| F19 | Onomatopoeia/SFX handling toggle | P2 | Skip or translate sound effects (they're noisy and cost tokens) |
| F20 | Local-only mode (P3, stretch) | P3 | transformers.js bubble detector + manga-ocr ONNX + text-only translation |

---

## 3. Core Architecture Decision: Single Vision Call vs. Pipeline

**Option A (recommended): One multimodal LLM call per page.**
Send the (downscaled, compressed) image to a vision model with a strict JSON-output prompt. The model returns: detected source language + an array of `{bbox, original_text, translated_text, is_sfx}` items.

- Pros: one round trip (fast), no local ML models to ship, bubble detection quality from frontier vision models is good, translation has full visual context (tone, speaker gender cues), simplest to implement and test.
- Cons: cost scales with image tokens; detection boxes are approximate (mitigate with padding + auto-fit text).

**Option B: Local pipeline (detector → OCR → text-only translation).**
comic-text-detector / manga-ocr via ONNX in the browser, then batch all text into one cheap text-only LLM call.

- Pros: cheapest per page at scale; text-only calls are tiny.
- Cons: shipping ~50–100 MB of models in an extension, WebGPU/WASM complexity, vertical Japanese OCR quality issues, much larger engineering effort.

**Decision: Build Option A first. Architect the pipeline behind interfaces (`Detector`, `Translator`) so Option B can slot in later (F20).**

**Recommended cheap model presets** (user-selectable, verify current pricing at build time):
- Google Gemini Flash tier — typically the cheapest vision option, images are very cheap per call
- Anthropic Claude Haiku tier — good quality/cost balance
- OpenAI 4o-mini tier
- OpenRouter — lets users pick anything with one key

Ballpark: a downscaled manga page (~1000 px tall, JPEG q70) is roughly 500–1500 image tokens depending on provider. At Flash-tier pricing, a full 200-page volume is typically a few cents. Include the cost tracker (F17) so users see real numbers.

---

## 4. Tech Stack

- **Platform:** Firefox WebExtension, Manifest V3 (Firefox uses event pages, not service workers — note this in code comments; use `browser.*` APIs via `webextension-polyfill`)
- **Language:** TypeScript (strict mode)
- **Build:** Vite + `@samrum/vite-plugin-web-extension` (or plain Vite multi-entry) + `web-ext` for run/lint/sign
- **UI:** Preact (tiny) or vanilla TS + lit-html for popup/options; content-script overlay is vanilla DOM (no framework — must be lightweight and Shadow-DOM isolated)
- **Storage:** `browser.storage.local` (settings + API keys), IndexedDB via `idb` (translation cache)
- **Testing:** Vitest (unit), `@webext-core/fake-browser` or sinon-chrome for API mocks, Playwright + web-ext for a small e2e smoke suite, fixture manga images (public domain) with golden JSON outputs
- **Lint/format:** ESLint + Prettier

---

## 5. Repository / File Structure

```
manga-lens/
├── manifest.json
├── package.json / tsconfig.json / vite.config.ts / .web-ext-config.mjs
├── src/
│   ├── shared/
│   │   ├── types.ts              # All shared interfaces (single source of truth)
│   │   ├── settings.ts           # Settings schema, defaults, load/save, migration
│   │   ├── messages.ts           # Typed runtime message contracts (content ⇄ background)
│   │   ├── constants.ts
│   │   └── log.ts                # Leveled logger, disabled in prod
│   ├── background/
│   │   ├── index.ts              # Event page entry; message router
│   │   ├── imageFetcher.ts       # Fetch image bytes (bypasses canvas CORS taint) §7.3
│   │   ├── imagePrep.ts          # Downscale, tile long strips, JPEG encode (OffscreenCanvas)
│   │   ├── hash.ts               # SHA-256 of image bytes for cache keys
│   │   ├── cache.ts              # IndexedDB translation cache (get/put/evict LRU, size cap)
│   │   ├── queue.ts              # Priority job queue, concurrency limiter, retry w/ backoff
│   │   ├── costTracker.ts        # Token/call accounting (F17)
│   │   └── providers/
│   │       ├── ProviderBase.ts   # Translator interface + shared JSON parsing/repair
│   │       ├── anthropic.ts
│   │       ├── openai.ts         # Also serves "custom OpenAI-compatible endpoint"
│   │       ├── gemini.ts
│   │       ├── openrouter.ts
│   │       └── prompt.ts         # The vision prompt template + JSON schema (§6)
│   ├── content/
│   │   ├── index.ts              # Entry; global toggle gate; observers bootstrap
│   │   ├── scanner.ts            # Find candidate manga images (heuristics §7.1), MutationObserver
│   │   ├── viewportQueue.ts      # IntersectionObserver → prioritize visible/near images
│   │   ├── overlay/
│   │   │   ├── OverlayManager.ts # Shadow-DOM root per image; position sync on resize/scroll
│   │   │   ├── BubbleBox.ts      # One translated region: fill, auto-fit text, hover-original
│   │   │   └── textFit.ts        # Binary-search font sizing to fit bbox
│   │   ├── regionSelect.ts       # Click-and-drag fallback (F10)
│   │   └── styles.css            # Injected into shadow roots only
│   ├── popup/                    # Toolbar popup: toggle, target lang, model, translate-all, cost
│   ├── options/                  # Full settings page: keys, fonts, per-site rules, cache mgmt
│   └── polyfill.ts
├── tests/
│   ├── unit/                     # Mirrors src/ one test file per module
│   ├── fixtures/
│   │   ├── images/               # Public-domain manga pages, webtoon strip, edge cases
│   │   └── golden/               # Expected JSON outputs, mock API responses
│   └── e2e/smoke.spec.ts
└── docs/
    ├── ARCHITECTURE.md
    └── PROMPTS.md
```

---

## 6. Core Data Contracts (define these first — everything depends on them)

```ts
// shared/types.ts

/** Normalized 0–1 coordinates relative to the ORIGINAL image dimensions. */
export interface BBox { x: number; y: number; w: number; h: number }

export interface TranslatedRegion {
  bbox: BBox;
  original: string;
  translated: string;
  isSfx: boolean;              // sound effect / onomatopoeia
  confidence?: number;         // 0–1 if provider reports it
}

export interface PageTranslation {
  imageHash: string;
  sourceLang: string;          // ISO 639-1 detected by model, e.g. "ja"
  targetLang: string;
  regions: TranslatedRegion[];
  model: string;
  provider: ProviderId;
  tokensIn?: number; tokensOut?: number;
  createdAt: number;
}

export interface TranslateJob {
  imageHash: string;
  imageBlob: Blob;             // already downscaled/tiled
  tileOffset?: BBox;           // set when image was tiled (webtoons)
  targetLang: string;
  sourceLangHint?: string;
  priority: number;            // 0 = visible now, 1 = near viewport, 2 = prefetch/all
}

export interface Translator {
  translatePage(job: TranslateJob, settings: ProviderSettings, signal: AbortSignal): Promise<PageTranslation>;
}
```

**The vision prompt (providers/prompt.ts)** — one carefully engineered prompt shared by all providers:

- System: "You are a manga/comic translation engine. Detect every speech bubble, caption, and text region. Return ONLY valid JSON matching this schema — no markdown, no commentary."
- Schema in prompt: `{ "source_lang": "ja", "regions": [{ "bbox": [x, y, w, h], "original": "...", "translated": "...", "is_sfx": false }] }` with bbox as fractions of image width/height.
- Rules embedded: preserve honorifics per user setting; translate to `{targetLang}`; keep line breaks natural for bubbles; mark onomatopoeia `is_sfx: true`; if no text found return empty regions array.
- Use provider-native structured output where available (Gemini `responseSchema`, OpenAI `response_format: json_schema`, Anthropic tool-use forcing) — this is the single biggest reliability win. Fall back to a JSON repair pass (strip fences, retry once with "fix this JSON" using a text-only cheap call).

**Batching (F12):** settings option "pages per request" (1–4). Multi-image requests amortize the prompt tokens across pages; response schema gains a `page_index` per region. Default 1 (lowest latency); "translate all" mode defaults to 2–3.

---

## 7. Hard Problems & Solutions (put these in ARCHITECTURE.md; the coding model must read them)

### 7.1 Finding manga images on arbitrary pages
Heuristics in `scanner.ts`: `<img>`/`<canvas>`/CSS-background elements with rendered area ≥ 180×180 px and natural size ≥ 400 px on a side; aspect ratio filter is loose (webtoon strips are extreme). Score by size + position in main content. Also watch `MutationObserver` for reader apps that swap images dynamically, and re-scan on SPA navigation (`history` events). Everything is lazy: nothing is fetched or translated until the image nears the viewport or user triggers it.

### 7.2 Overlay positioning
Each translated image gets a sibling absolutely-positioned container inside a **Shadow DOM** host (style isolation from hostile page CSS). Position/size synced with `ResizeObserver` + scroll/resize listeners + `getBoundingClientRect`. Bboxes are normalized 0–1, so overlays survive responsive resizing for free. Overlay must set `pointer-events: none` except on interactive bits, so the reader site still works.

### 7.3 CORS / canvas tainting (critical gotcha)
Content scripts often **cannot read pixel data** of cross-origin images (tainted canvas). Solution: content script sends the image **URL** to the background, which fetches the bytes with host permissions (`<all_urls>` optional permission, requested on first use per-site), then does all processing (hashing, downscale via `OffscreenCanvas`, JPEG encode) in the background context. If fetch fails (auth-gated blob URLs), fallback: ask user to use drag-select on a screenshot captured via `tabs.captureVisibleTab` (P2).

### 7.4 Webtoon long strips
Images with height/width ratio > 3 get sliced into overlapping tiles (~1024 px tall, 10% overlap) in `imagePrep.ts`. Each tile is a separate job; results are merged with `tileOffset` remapping bboxes to full-image coordinates, deduping regions in overlap zones (IoU > 0.5 keep higher confidence).

### 7.5 Meeting the "10 pages < 5s" target
- Downscale to max 1200 px on the long side (per-tile for strips), JPEG quality ~70 → small upload, fewer image tokens, faster inference.
- Concurrency-limited parallel queue (default 6 in-flight) with priority: visible page first, then ±2 pages, then rest.
- Prefetch: when page N becomes visible, enqueue N+1..N+3.
- Cache hits render in <50 ms.
- Flash-tier models typically return a page in 1.5–3.5 s → 10 pages in parallel comfortably lands under 5 s. Show per-image spinner/skeleton so perceived latency is low.

### 7.6 API key security
Store in `browser.storage.local` (never `sync`). Options page masks the key, "test key" button does a 1-token ping. Direct-to-provider calls only; document clearly that no third-party server ever sees the key. Note: Anthropic requires the `anthropic-dangerous-direct-browser-access` header for browser-origin calls — handle in `anthropic.ts`.

### 7.7 Text fitting & rendering
`textFit.ts`: binary search font-size so wrapped text fits the bbox (padding 6%), respecting user min/max. Bubble fill: rounded rect, user-set color (default white) + opacity (default 92%) + subtle text stroke for readability over art. Vertical-source text renders horizontal in target language (normal case). "Peek original" on hover/hotkey (F14) swaps content.

---

## 8. Implementation Phases (each phase = one handoff chunk to the coding model)

Every phase must ship with: unit tests for every module touched, JSDoc on every exported symbol, and a short "how to verify manually" note. **Order matters — later phases depend on earlier contracts.**

### Phase 0 — Scaffold (½ day)
Vite + TS + manifest + web-ext dev loop; empty background/content/popup/options entries wired; Vitest running; CI script (`npm run check` = typecheck + lint + test).
✅ *Accept:* extension loads in Firefox, popup opens, `npm test` green.

### Phase 1 — Contracts & Settings (1 day)
`shared/types.ts`, `settings.ts` (schema + defaults + migration), `messages.ts` (typed message bus with request/response helpers).
🧪 *Tests:* settings defaulting/merging/migration; message round-trip with fake-browser.

### Phase 2 — Image acquisition pipeline (1–2 days)
`imageFetcher.ts`, `imagePrep.ts` (downscale, JPEG encode, strip tiling), `hash.ts`.
🧪 *Tests:* tiling math (offsets, overlap), downscale dimension logic, hash stability; fixture images.

### Phase 3 — Provider layer (2 days)
`ProviderBase`, all four providers + custom endpoint, `prompt.ts`, JSON parse/repair, error taxonomy (auth / rate-limit / malformed / network) with typed errors.
🧪 *Tests:* mocked fetch → golden JSON parsing; malformed-JSON repair; bbox normalization/clamping; rate-limit retry/backoff logic. **No real API calls in tests.**

### Phase 4 — Cache + Queue + Cost tracker (1 day)
`cache.ts` (LRU, size cap ~200 MB, per-site clear), `queue.ts` (priority, concurrency, abort), `costTracker.ts`.
🧪 *Tests:* LRU eviction, priority ordering, concurrency limit, abort propagation, cost math.

### Phase 5 — Content script: scan + overlay (2–3 days)
`scanner.ts`, `viewportQueue.ts`, `OverlayManager`, `BubbleBox`, `textFit.ts`. Wire end-to-end: visible image → background → provider → overlay renders.
🧪 *Tests:* scanner heuristics on synthetic DOM (jsdom), textFit binary search, bbox→pixel mapping incl. tiled offsets. Manual test page in `tests/fixtures/testpage.html`.

### Phase 6 — UI: popup + options (1–2 days)
Toggle (F1), target language (F9), model/provider + key entry with test button (F2), font controls (F5), per-site rules (F15), translate-all button (F8), cost display (F17).
🧪 *Tests:* settings round-trips from UI logic (pure functions extracted from components).

### Phase 7 — Drag-select fallback + polish (1–2 days)
`regionSelect.ts` (F10), keyboard shortcuts, peek-original (F14), SFX toggle (F19), error toasts (bad key, rate limited), i18n scaffolding for extension UI.
🧪 *Tests:* rect math for drag selection incl. scrolled/zoomed pages.

### Phase 8 — Perf hardening + e2e (1–2 days)
Prefetch tuning, batching mode (F12 multi-page), Playwright smoke test with a mock provider server, memory audit (overlay teardown on navigation), AMO listing prep (`web-ext lint`).
✅ *Accept:* 10-page fixture chapter translates < 5 s against mock provider with realistic 2 s latency; no leaks after 100 page navigations.

**Stretch (Phase 9+):** local pipeline (F20), export/import (F16), reading-direction ordering (F18), inpainting-style bubble cleanup via canvas blur sampling.

---

## 9. Handoff Instructions for the Coding Model (paste at top of each phase request)

> You are implementing Phase N of the MangaLens Firefox extension. Rules:
> 1. TypeScript strict; `browser.*` via webextension-polyfill; Firefox MV3 event pages (not Chrome service workers).
> 2. Every exported function/class gets JSDoc explaining purpose, params, and edge cases.
> 3. Every module gets a Vitest file with meaningful cases (happy path + at least 2 edge cases). No real network calls — mock fetch.
> 4. Do not change interfaces in `shared/types.ts` without flagging it explicitly.
> 5. All bbox coordinates are normalized 0–1 relative to the original full image; convert only at render time.
> 6. Fail soft: any error must degrade to "no overlay" + a console-grouped warning, never break the host page.
> 7. Comment every non-obvious decision with `// WHY:` prefix.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM bbox accuracy varies | Padding + auto-fit text; drag-select fallback; try structured-output APIs |
| Provider JSON drift / malformed output | Native structured outputs where possible; repair pass; golden tests per provider |
| Reader sites block image fetch | Optional host permissions; screenshot-capture fallback (P2) |
| Cost surprises for users | Cost tracker, cache-first, downscaling defaults, confirm dialog on "translate all" > 30 pages |
| AMO review issues | No remote code, clear privacy doc (keys local-only, images sent only to user's chosen provider) |
| Firefox MV3 quirks | Event-page lifetime: persist queue state, re-hydrate on wake |

---

## 11. Suggested Defaults

Provider: Gemini Flash tier · Target: browser locale · Max image edge: 1200 px · JPEG q70 · Concurrency: 6 · Prefetch: +3 pages · Cache cap: 200 MB · Font: system sans, auto-fit 10–28 px · Bubble fill: white @ 92% · SFX: skip by default.
