# MangaLens — Privacy

_This is the privacy policy for AMO (addons.mozilla.org) review and for users.
It reflects the extension as built (Architecture §7.6 + §10 Risks)._

## Summary

MangaLens is a **bring-your-own-key** (BYOK) tool. It has **no first-party
server**. Nothing you do is reported to the developers. The only network
destination MangaLens ever contacts is **the LLM provider _you_ configured**
(Google Gemini, OpenAI, Anthropic, OpenRouter, or a custom OpenAI-compatible
endpoint you enter yourself).

## What data is handled, and where it goes

| Data | Where it's stored | Where it's sent |
| --- | --- | --- |
| **Your API key(s)** | `browser.storage.local` on your device only | **Only** to the provider it belongs to, as the auth header of a translation request. Never synced, never sent anywhere else. |
| **Page images** (the manga/comic pages you translate) | Not persisted as images. The bytes are fetched/transmitted transiently. | **Only** to your chosen provider, to perform the translation you requested. This is the "website content" the extension declares it collects. |
| **Translations** (bounding boxes + text) | A local **IndexedDB** cache on your device (so re-viewing a page is instant and free) | Nowhere. The cache never leaves your browser. |
| **Settings** (provider, language, per-site rules, etc.) | `browser.storage.local` on your device only | Nowhere. |
| **Usage/cost estimate** (token counts, a rough dollar figure) | `browser.storage.local` on your device only | Nowhere. It is a local convenience tally, not analytics. |

## What MangaLens does NOT do

- **No analytics or telemetry.** No usage pings, no crash reporting, no
  first-party server of any kind.
- **No key sync.** Keys are written to `storage.local`, never `storage.sync`,
  so they never leave the machine they were entered on.
- **No background data collection.** The content script is injected on all
  sites but stays **inert** until you enable MangaLens (globally or per-site),
  and page images are sent to a provider **only** on an explicit action — a
  per-site "Auto-translate on" opt-in, the "Translate all" button, or a
  drag-select. Simply enabling the extension does not send anything anywhere.
- **No third-party sharing.** The only recipient of any data is the provider
  whose key you supplied.

## Permissions rationale

- **`storage`** — to save your settings, API keys, cost tally, and the local
  translation cache on your device.
- **`activeTab`** — so the toolbar popup can read the current tab's address to
  show per-site controls and target "Translate all" at the page you're on.
  Granted when you interact with the extension; carries no scary install
  warning.
- **`<all_urls>` (optional host permission)** — requested **in-flow**, only
  when you first ask MangaLens to translate an image, so the background page can
  fetch that image's bytes. You can revoke it anytime from the options page.
- **Keyboard commands** — local shortcuts only (toggle, region-select, peek).

## Data collection declaration (Firefox)

The manifest declares required collection of **website content** and nothing
else — page images are transmitted to your chosen provider to perform the
translation. No other category (no personal info, no location, no analytics) is
collected.

## Contact

MangaLens is open source. Report privacy concerns via the project's issue
tracker.
