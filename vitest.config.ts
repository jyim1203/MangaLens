import { defineConfig } from "vitest/config";

// WHY a separate config: vite.config.ts loads the web-extension plugin, which
// expects manifest entry points and has no business running during unit tests.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
