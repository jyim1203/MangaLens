import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // tests/e2e/*.mjs are standalone Node + selenium scripts (their own runtime,
  // node/browser globals, driver-injected script strings) — syntax-checked via
  // `node --check`, run by `npm run test:e2e`, and excluded from the unit config.
  { ignores: ["dist/", "node_modules/", "coverage/", "tests/e2e/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test files may use any console/spies freely.
    files: ["tests/**"],
    rules: { "no-console": "off" },
  },
);
