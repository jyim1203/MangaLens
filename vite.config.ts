import { defineConfig } from "vite";
import webExtension from "@samrum/vite-plugin-web-extension";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [
    webExtension({
      // Cast: the plugin's manifest type targets Chrome's MV3 shape
      // (background.service_worker); Firefox MV3 uses background.scripts,
      // which the plugin supports at runtime but not in its types.
      manifest: manifest as never,
      // WHY: Firefox MV3 does not support `use_dynamic_url` on
      // web_accessible_resources (plugin README, "Firefox Experimental MV3").
      useDynamicUrlWebAccessibleResources: false,
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
