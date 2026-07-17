# MangaLens — AMO Listing Copy (draft)

_Draft listing text for addons.mozilla.org submission. Review before publishing._

## Name

**MangaLens**

## Summary (one line, ≤ 250 chars)

Translate the text in manga, manhwa, and comic pages in place — using your own
LLM API key. Detects speech bubbles, overlays the translation, and caches
results locally so re-reading is instant and free.

## Description

MangaLens reads the text in comic/manga page images and overlays a translation
right on top of each bubble — so you read the page, not a wall of separate text.

**Bring your own key.** MangaLens has no server and no subscription. You plug in
an API key for a provider you already use — Google Gemini, OpenAI, Anthropic,
OpenRouter, or any OpenAI-compatible endpoint — and pay that provider directly
for what you translate. Your key stays on your device and is only ever sent to
that provider.

**How it works**

- Enable MangaLens globally or per-site. It stays completely inert until you do.
- Turn on "Auto-translate" for a reader and pages translate as you scroll, or
  hit "Translate all" to do a whole chapter, or drag-select any region (even on
  `<canvas>`/blob readers) to translate just that.
- Translations are cached locally (IndexedDB), so re-opening a page you've
  already translated is instant and costs nothing. Use "Show cached
  translations" to re-show a chapter you already paid for after a reload.
- Tune it in options: target language, provider/model, honorifics handling,
  reading direction, SFX, font, per-site rules, image quality, and how many
  pages to batch per request (2–3 recommended for "Translate all" to cut cost).

**Privacy**

No analytics. No telemetry. No first-party server. The only network destination
is the provider whose key you entered. See the privacy policy for the full
breakdown.

## Permission-by-permission rationale (for reviewers)

- **`storage`** — settings, API keys (local only, never synced), local
  translation cache, and a local cost tally. No data leaves the device via this.
- **`activeTab`** — the popup reads the active tab's URL to show per-site
  controls and target "Translate all"/"Select region" at the current page.
  Granted on interaction; no install-time warning.
- **`<all_urls>` — OPTIONAL host permission, requested in-flow.** Not granted at
  install. The first time you translate an image, MangaLens asks for it so the
  background page can fetch that image's bytes cross-origin (blob-sourced readers
  ship bytes from the page instead). Revocable anytime in options.
- **Keyboard commands** — `Alt+Shift+M` toggle, `Alt+Shift+S` region-select,
  `Alt+Shift+O` peek-original. Local only.

## Data collection declaration

Required: **website content** (page images are transmitted to the user's chosen
provider to perform translation). Nothing else — no analytics, no telemetry, no
personal information.

## Screenshots checklist (to capture before submission)

1. A manga/manhwa page with translated bubbles overlaid in place.
2. The toolbar popup: global toggle, per-site rule, language/provider quick-pick,
   "Translate all" / "Show cached translations".
3. The options page: provider + key row with a "✓ Key works" test result.
4. Drag-select in progress (crosshair) → the resulting translated region.
5. "Peek original" toggled, showing source text under the cursor.

## Notes

- Firefox event-page MV3, `strict_min_version: 128.0`.
- Source is open; no minified-only or obfuscated code.
- `npm run build:ext` produces the submittable `.zip` artifact from `dist/`.
