# MangaLens — Vision Prompt Specification (PROMPTS.md)

This document fully specifies the prompt layer (`src/background/providers/prompt.ts`). It is the quality-critical core of the extension: everything downstream (overlay accuracy, cost, reliability) depends on it. The coding model should implement this verbatim, treating prompt text as configuration constants with template slots.

---

## 1. Design Principles

1. **One canonical prompt, provider-specific delivery.** The instructions are identical everywhere; only the *enforcement mechanism* differs (Gemini `responseSchema` vs OpenAI `json_schema` vs Anthropic forced tool-use).
2. **Schema-first, prose-second.** Native structured outputs eliminate ~95% of parse failures. The prose rules exist to shape *content quality* (translation tone, bbox tightness, SFX handling), not format.
3. **Normalized coordinates only.** All bboxes are fractions (0–1) of the sent image's width/height. The extension remaps to original-image space (accounting for downscale/tiling) — the model never needs to know pixel dimensions.
4. **Deterministic knobs.** Temperature 0.2–0.3. Low temperature improves bbox consistency; slight nonzero helps translation fluency.
5. **Every template slot is explicit.** Slots use `{{double_braces}}` and are listed in §7.

---

## 2. Canonical JSON Schema

This is the single source of truth. Store as a typed constant; derive each provider's schema format from it programmatically where possible.

```json
{
  "type": "object",
  "required": ["source_lang", "regions"],
  "additionalProperties": false,
  "properties": {
    "source_lang": {
      "type": "string",
      "description": "ISO 639-1 code of the dominant text language in the image, e.g. 'ja', 'ko', 'zh', 'en'. Use 'und' if no text found."
    },
    "regions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["bbox", "original", "translated", "is_sfx"],
        "additionalProperties": false,
        "properties": {
          "bbox": {
            "type": "array",
            "items": { "type": "number", "minimum": 0, "maximum": 1 },
            "minItems": 4,
            "maxItems": 4,
            "description": "[x, y, width, height] as fractions of image dimensions. (x,y) is the TOP-LEFT corner of the text region."
          },
          "original": { "type": "string", "description": "Transcribed source text, exactly as written (keep original script)." },
          "translated": { "type": "string", "description": "Translation into the target language." },
          "is_sfx": { "type": "boolean", "description": "true for onomatopoeia / sound effects drawn as art rather than bubble dialogue." },
          "kind": {
            "type": "string",
            "enum": ["bubble", "caption", "sfx", "sign", "thought"],
            "description": "Region type. Optional but preferred."
          }
        }
      }
    }
  }
}
```

**Notes for implementation:**
- `kind` is optional in validation but requested in the prompt; overlay styles can differ per kind later (thought bubbles italic, signs boxed, etc.).
- Some providers reject `additionalProperties` or `minimum/maximum` in their schema dialects — the per-provider adapters (§5) note what to strip.

---

## 3. System Prompt (canonical text)

Store as `SYSTEM_PROMPT`. Do not reflow or "improve" the wording without re-running the golden tests — phrasing here is load-bearing.

```
You are a professional manga and comic translation engine. You receive one or more comic/manga page images. For each image you must:

1. Find EVERY distinct text region: speech bubbles, thought bubbles, narration captions, signs/labels inside the artwork, and sound effects (onomatopoeia).
2. Transcribe the text exactly as written in its original script.
3. Translate it into {{target_lang_name}} ({{target_lang_code}}).
4. Report a bounding box for each region.

BOUNDING BOX RULES:
- Coordinates are FRACTIONS of the image dimensions, between 0 and 1.
- Format: [x, y, width, height] where (x, y) is the top-left corner.
- The box must tightly enclose the TEXT itself, not the entire bubble outline. If unsure, err slightly larger, never smaller.
- Never let boxes extend past the image edges.
- Two different bubbles must never share one box. One bubble split across two lines is still ONE region.

TRANSCRIPTION RULES:
- Preserve the original script exactly (kanji/kana/hangul/etc.). Do not romanize.
- Vertical Japanese text reads top-to-bottom, columns right-to-left. Transcribe it in natural reading order as a single string.
- Join multi-line bubble text with a single space (or no space for Japanese/Chinese).
- If text is partially cut off or illegible, transcribe what is legible and translate best-effort.

TRANSLATION RULES:
- Translate meaning and tone, not words. Dialogue must sound like natural spoken {{target_lang_name}}.
- Match register: casual speech stays casual, formal stays formal, shouting stays punchy.
- {{honorifics_rule}}
- Keep character names romanized consistently; do not translate names.
- Sound effects: give a short natural equivalent (e.g. ドドド → "RUMBLE"), set is_sfx to true.
- Numbers, ellipses, and interrobangs carry over naturally ("!?", "...").
- Never add translator notes, explanations, or content not present in the source.

ORDERING:
- List regions in natural reading order: {{reading_order_rule}}

OUTPUT:
- Return ONLY the JSON described by the schema. No markdown fences, no commentary, no keys beyond the schema.
- If the image contains no text at all, return {"source_lang": "und", "regions": []}.
```

### Slot values

- `{{honorifics_rule}}` — from user setting (F5 options page, "Honorifics" select):
  - keep: `Preserve Japanese/Korean honorifics as-is (-san, -kun, -nim, etc.).`
  - localize: `Convert honorifics into natural target-language equivalents or drop them when no equivalent exists.`
- `{{reading_order_rule}}` — from settings F18:
  - rtl (manga default): `right-to-left, top-to-bottom (Japanese manga order).`
  - ltr: `left-to-right, top-to-bottom.`
  - auto: `infer from the artwork's panel layout; Japanese manga is right-to-left, webtoons and western comics are left-to-right, top-to-bottom.`
- `{{target_lang_name}}` / `{{target_lang_code}}` — e.g. `English` / `en`. Always send both; the name drives quality, the code disambiguates (e.g. `zh-TW` vs `zh-CN` → "Traditional Chinese (zh-TW)").

---

## 4. User Message Variants

### 4.1 Single page (default)

```
[image attachment]
Translate this page to {{target_lang_name}}. {{source_hint}}
```

- `{{source_hint}}` is empty when source is auto-detect, else: `The source language is {{source_lang_name}}.` (Pinning the source language measurably reduces mis-OCR on stylized fonts.)

### 4.2 Multi-page batch (F12, "pages per request" = 2–4)

Attach images in order, then:

```
[image 1] [image 2] ... [image N]
Translate these {{n}} pages to {{target_lang_name}}. {{source_hint}}
Return one JSON object with a top-level "pages" array of length {{n}}; pages[i] corresponds to image i (0-indexed) and follows the single-page schema (source_lang + regions). Bboxes are relative to that page's own dimensions.
```

Batch schema wraps the canonical one:

```json
{
  "type": "object",
  "required": ["pages"],
  "properties": { "pages": { "type": "array", "items": { "$ref": "#/single_page_schema" } } }
}
```

**Batch guardrails (implement in code, not prompt):**
- Reject a batch response whose `pages.length !== n` → split the batch and retry pages individually (never retry the whole batch more than once).
- Batching amortizes the ~600-token system prompt across pages but increases blast radius of a bad response; default batch size 1, "Translate all" mode uses 2–3.

### 4.3 Drag-select region (F10 fallback)

The crop is sent as its own image; coordinates come back relative to the crop, and `regionSelect.ts` remaps using the crop's offset. Prompt suffix:

```
This is a cropped region of a comic page selected by the user. It may contain one or several text regions, or text that is not inside a bubble. Transcribe and translate everything legible.
```

### 4.4 Webtoon tile (§7.4 of the plan)

Identical to single page — tiles are just images. The 10% overlap means the same bubble can appear in two tiles; dedupe happens in code (IoU > 0.5 → keep the region whose bbox center is farther from its tile's cut edge, which is the less-truncated read).

---

## 5. Per-Provider Delivery

All providers share `SYSTEM_PROMPT` + user message. Differences:

### 5.1 Gemini (`gemini.ts`) — default provider
- Endpoint: `generateContent` with the Flash-tier model from settings.
- Enforcement: `generationConfig.responseMimeType: "application/json"` + `responseSchema` (convert canonical schema; Gemini's dialect ignores `additionalProperties` — strip it).
- `temperature: 0.25`, `maxOutputTokens` generous (dense pages: ~40 regions × ~60 tokens; set 8192).
- System prompt goes in `systemInstruction`.

### 5.2 OpenAI + OpenAI-compatible (`openai.ts`)
- `response_format: { type: "json_schema", json_schema: { name: "manga_translation", strict: true, schema: ... } }`.
- Strict mode requires `additionalProperties: false` everywhere and all fields in `required` — the canonical schema already complies except optional `kind`: for strict mode, move `kind` into `required` and add `"none"` to its enum, mapping `"none"` → undefined in the parser.
- For unknown custom endpoints, first try `json_schema`; on a 400 mentioning response_format, downgrade to `response_format: {type:"json_object"}` + schema pasted into the system prompt; remember the working mode per endpoint in settings.

### 5.3 Anthropic (`anthropic.ts`)
- Enforcement via forced tool use: define one tool `emit_translation` whose `input_schema` is the canonical schema; set `tool_choice: {type: "tool", name: "emit_translation"}`. Parse `tool_use.input` — no JSON string parsing needed at all.
- Include header `anthropic-dangerous-direct-browser-access: true` (required for browser-origin calls).
- System prompt in `system`; image as base64 content block before the user text.

### 5.4 OpenRouter (`openrouter.ts`)
- OpenAI-compatible surface; reuse `openai.ts` with base URL + `HTTP-Referer`/`X-Title` headers. Structured-output support varies by underlying model → always use the downgrade ladder from 5.2.

---

## 6. Validation, Repair, and Retry (code-side, `ProviderBase.ts`)

Run every response through this pipeline regardless of provider:

```
parse → schema-validate → sanitize → accept | repair → retry-once | fail-soft
```

1. **Parse.** If the provider returned a string: strip markdown fences, trim to outermost `{...}` (first `{` to last `}`), `JSON.parse`.
2. **Schema-validate** against the canonical schema (lightweight hand-rolled validator; don't ship ajv).
3. **Sanitize** (always, even on valid responses):
   - Clamp each bbox to [0,1]; drop regions with `w*h < 0.0001` (degenerate) or `w*h > 0.9` (model boxed the whole page — almost always an error).
   - Drop regions where `original` is empty/whitespace.
   - Dedupe: if two regions have IoU > 0.85 and identical `original`, keep the first.
   - If `translated` is empty but `original` isn't → mark region `needsRetry`; if >30% of regions need retry, treat as malformed.
   - Normalize `source_lang` to lowercase 2-letter (map `jpn`→`ja` etc. with a tiny table).
4. **Repair path** (parse or validation failed): ONE retry. If the raw text looks like near-JSON (>50% of expected keys present), send it to a *text-only* cheap call: system `Fix this into valid JSON matching this schema. Output only JSON.` + schema + raw text. Otherwise re-run the original request with `temperature: 0` and appended user line: `Your previous output was not valid JSON. Return only the JSON object.`
5. **Fail-soft.** After the retry fails: cache a negative entry (TTL 10 min, so a stuck page doesn't loop), surface a small ⚠ badge on that image's overlay with a "retry" click action, log the raw response at debug level.

**Error taxonomy** (typed, drives UI messaging): `AuthError` (401/403 → "check your API key" toast), `RateLimitError` (429 → exponential backoff 2s/8s/30s, honor `retry-after`), `MalformedResponseError`, `NetworkError`, `ContentRefusalError` (provider safety refusal → show "provider declined this image", no retry).

---

## 7. Template Slot Reference

| Slot | Source | Example |
|---|---|---|
| `{{target_lang_name}}` / `{{target_lang_code}}` | settings.targetLang | `English` / `en` |
| `{{source_hint}}` / `{{source_lang_name}}` | settings.sourceLang (`auto` → empty) | `Japanese` |
| `{{honorifics_rule}}` | settings.honorifics | keep \| localize |
| `{{reading_order_rule}}` | settings.readingOrder | rtl \| ltr \| auto |
| `{{n}}` | batch size | `3` |

Token budget: system ≈ 550–650 tokens. At batch size 1 this is usually smaller than the image itself; not worth compressing further at the cost of quality.

---

## 8. Golden Test Plan (`tests/fixtures/golden/`)

Unit tests never hit real APIs — they validate the parse/sanitize pipeline against stored responses:

| Fixture | Purpose |
|---|---|
| `clean_single_page.json` | Happy path, 8 regions |
| `fenced_json.json` | Response wrapped in ```json fences → parser strips |
| `trailing_commentary.json` | JSON followed by "I hope this helps!" → outermost-brace trim |
| `out_of_range_bbox.json` | bbox values 1.05 / −0.02 → clamped |
| `whole_page_bbox.json` | w*h = 0.95 region → dropped |
| `duplicate_regions.json` | IoU 0.9 duplicates → deduped |
| `empty_page.json` | `{"source_lang":"und","regions":[]}` → no overlay, cached |
| `batch_3_pages.json` | pages array remap |
| `batch_wrong_length.json` | pages.length ≠ n → split-and-retry path triggered |
| `iso639_variants.json` | `jpn`, `JA`, `ja-JP` → all normalize to `ja` |
| `refusal.json` | Provider safety refusal text → ContentRefusalError |

Plus one *manual* eval script (`npm run eval:live`, excluded from CI) that runs 5 public-domain fixture pages against a real key and prints bbox overlays to an HTML report — use this when tuning prompt wording, and re-run before accepting any prompt text change.

---

## 9. Known Failure Modes & Prompt-Level Mitigations

| Failure | Mitigation |
|---|---|
| Boxes cover bubble outline, not text (too big) | "tightly enclose the TEXT itself" rule + auto-fit text absorbs slack |
| Two bubbles merged into one region | Explicit "must never share one box" rule; code-side: if a region's aspect ratio is extreme and contains a sentence boundary, still render (don't split heuristically — v1 accepts this) |
| SFX flood on action pages (cost + clutter) | `is_sfx` flag + settings F19 default "skip SFX" → overlay ignores them; they still cost output tokens, acceptable |
| Stylized fonts mis-OCR'd | `{{source_hint}}` pinning; user pins source language in popup |
| Model translates names | "do not translate names" rule; imperfect — acceptable v1 |
| Watermarks/site UI text translated | Post-filter: drop regions within 2% of image edges whose `kind` is `sign` and text matches URL/domain regex |
