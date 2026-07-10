# Test fixture images

This folder is for **real, public-domain** manga / webtoon images used by the
manual Phase 5 end-to-end test (`tests/fixtures/testpage.html`) when you want an
actual provider round-trip (OCR + translation), rather than the self-contained
SVG placeholders the page ships with.

The Phase 5 handoff calls for 2–3 small public-domain images:

- one **normal manga page** (roughly portrait, ≥ 800 px tall),
- one **extreme-aspect webtoon strip** (height/width > 3, to exercise tiling),
- optionally one **edge case** (icon/avatar) — but the SVG placeholders already
  cover the "must be ignored" case.

## Where to get public-domain manga art

Suitable sources (verify the individual work's license before use):

- **Wikimedia Commons** — search for public-domain / CC0 manga and yon-koma;
  pre-1930 Japanese comics (e.g. early _Shōnen_ magazine scans) are public domain.
- **The Digital Comic Museum** — public-domain Golden Age comics (good for the
  "normal page" case with real speech bubbles).
- Any CC0 webtoon panel for the long-strip case.

## Wiring them in

Once you drop e.g. `page.jpg` and `strip.jpg` here, point the test page's
`<img>` srcs at them instead of the generated SVG data URIs — replace the
`svgDataUri(...)` assignments near the bottom of `testpage.html` with
`"images/page.jpg"` / `"images/strip.jpg"`.

**Do not commit copyrighted images.** Only genuinely public-domain / CC0 assets
belong here; note each file's source and license below when you add one.

| file | source URL | license |
| ---- | ---------- | ------- |
|      |            |         |
