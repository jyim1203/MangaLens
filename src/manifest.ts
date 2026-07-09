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
  name: "MangaLens",
  version: pkg.version,
  description: pkg.description,
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
  permissions: ["storage"],
  optional_host_permissions: ["<all_urls>"],
  commands: {
    "toggle-mangalens": {
      suggested_key: { default: "Alt+Shift+M" },
      description: "Toggle MangaLens on/off",
    },
  },
  browser_specific_settings: {
    gecko: {
      id: "mangalens@mangalens.dev",
      // WHY 128: `optional_host_permissions` was introduced in Firefox 128
      // (web-ext lint flags anything lower).
      strict_min_version: "128.0",
    },
  },
};

export default manifest;
