import pkg from "../package.json";

/**
 * WebExtension manifest (Manifest V3, Firefox flavor).
 *
 * WHY MV3-Firefox specifics:
 * - Firefox does NOT support background service workers; it uses event pages
 *   declared via `background.scripts`. Never switch this to `service_worker`
 *   without a Chrome-specific build step.
 * - `browser_specific_settings.gecko.id` is required for signing and for
 *   `storage` to persist across dev reloads with web-ext.
 *
 * WHY `<all_urls>` content script but optional host permissions:
 * - The content script must exist on arbitrary reader sites to scan for manga
 *   images, but it stays fully inert until the user enables the extension
 *   (globally or per-site). Actually FETCHING image bytes cross-origin is
 *   gated behind `optional_host_permissions`, requested on first use.
 */
const manifest: Record<string, unknown> = {
  manifest_version: 3,
  // WHY __MSG_*__ + default_locale (Phase 7 i18n scaffolding): the store name and
  // description are localized from public/_locales/<lang>/messages.json. `en` is
  // the only bundled locale for now; the existing popup/options static strings
  // stay literal (their data-i18n migration is Phase-8 deferred).
  default_locale: "en",
  name: "__MSG_extensionName__",
  version: pkg.version,
  description: "__MSG_extensionDescription__",
  background: {
    scripts: ["src/background/index.ts"],
  },
  action: {
    default_title: "MangaLens",
    default_popup: "src/popup/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  // WHY activeTab (Phase 6): the popup's per-site toggle and "translate all"
  // need the ACTIVE tab's URL/hostname, which is hidden without a tabs-ish
  // permission. activeTab is granted on user interaction with the extension
  // (opening the popup counts) and carries NO install-time warning, unlike the
  // scary "tabs" permission.
  permissions: ["storage", "activeTab"],
  optional_host_permissions: ["<all_urls>"],
  // WHY only 3 commands: Firefox has no 4-command ceiling (Chrome does), but we
  // stay lean. Descriptions are localized (__MSG_*__). Command ids mirror the
  // CMD_* constants in shared/constants.ts (constants.test.ts guards the drift).
  commands: {
    "toggle-mangalens": {
      suggested_key: { default: "Alt+Shift+M" },
      description: "__MSG_commandToggleDescription__",
    },
    "select-region": {
      suggested_key: { default: "Alt+Shift+S" },
      description: "__MSG_commandSelectRegionDescription__",
    },
    "peek-original": {
      suggested_key: { default: "Alt+Shift+O" },
      description: "__MSG_commandPeekOriginalDescription__",
    },
  },
  browser_specific_settings: {
    gecko: {
      id: "mangalens@mangalens.dev",
      // WHY 128: `optional_host_permissions` was introduced in Firefox 128
      // (web-ext lint flags anything lower).
      strict_min_version: "128.0",
      // Data-collection disclosure (Phase 8 §8, deferred since Phase 0 — clears
      // the standing web-ext `data_collection_permissions` notice). The HONEST
      // declaration for MangaLens: it transmits page images to the USER'S CHOSEN
      // provider only (that's "website content"), and collects nothing else —
      // no analytics, no telemetry, no first-party server. API keys stay in
      // `storage.local` and are never transmitted anywhere but that provider.
      // Older Firefox ignores this key (forward-compatible AMO metadata), so it
      // needs NO strict_min_version bump.
      data_collection_permissions: {
        required: ["websiteContent"],
      },
    },
  },
};

export default manifest;
