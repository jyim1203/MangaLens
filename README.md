# MangaLens

Firefox extension that detects manga/comic images on any page, translates the
text with your own LLM API key (BYOK), and overlays the translation in place.

Planning docs live in `docs/ARCHITECTURE.md` (project plan) and
`docs/PROMPTS.md` (vision prompt spec). Build progress is tracked in
`PROGRESS.md`, one entry per phase.

## Development

```sh
npm install
npm run check        # typecheck + lint + unit tests
npm run build        # production build → dist/
npm run lint:ext     # AMO-style lint of the built extension
npm run start:firefox  # launch Firefox with the extension loaded (needs a build first)
npm run dev          # vite dev server with HMR
```

Requires Node 20+ and, for `start:firefox`, a local Firefox ≥ 128.

## Manual verification (Phase 0)

1. `npm run build`
2. Open Firefox → `about:debugging` → "This Firefox" → "Load Temporary Add-on"
   → pick `dist/manifest.json`.
3. Click the MangaLens toolbar button. The popup should read
   "Background connected. Scaffold OK (Phase 0)."
4. Open any webpage, then the Browser Console (Ctrl+Shift+J): you should see
   `[MangaLens:content] background reachable:` (dev builds only; prod builds
   log at warn level and above).

## Project structure

See `docs/ARCHITECTURE.md` §5 — the `src/` layout follows it exactly. Modules
that don't exist yet arrive in later phases.
