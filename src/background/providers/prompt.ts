/**
 * The vision prompt layer (PROMPTS.md) — the quality-critical core of the
 * extension. Everything downstream (overlay accuracy, cost, reliability) rides
 * on this. Treat the prompt text below as configuration constants with template
 * slots; do NOT reflow the wording without re-running the golden eval
 * (`npm run eval:live`, PROMPTS.md §8) — the phrasing is load-bearing.
 *
 * One canonical prompt, provider-specific *delivery*: the instructions are
 * identical everywhere, only the enforcement mechanism differs (Gemini
 * `responseSchema` vs OpenAI `json_schema` vs Anthropic forced tool-use). This
 * module owns the shared text, the canonical JSON schema (PROMPTS.md §2), the
 * per-provider schema-dialect converters, and the pure helpers that fill the
 * template slots from {@link ProviderSettings}.
 *
 * Bump {@link import("../../shared/constants").PROMPT_VERSION} whenever any of
 * these strings change in a way that affects output — it is part of the cache
 * key so stale translations are never served after a wording change.
 */
import type { ProviderSettings } from "../../shared/types";
import { languageName } from "../../shared/languages";

// Re-export so existing importers (tests, adapters) keep working after the
// Phase 6 move of the name map into shared/ (the UI dropdowns need it too).
export { languageName };

// --- Canonical JSON schema (PROMPTS.md §2) ---------------------------------

/** A minimal JSON-Schema node, enough to express the canonical schema + convert dialects. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * The single source of truth for the response shape (PROMPTS.md §2). Each
 * provider derives its own dialect from this via the converters below rather
 * than hand-maintaining a second copy.
 */
export const CANONICAL_SCHEMA: JsonSchema = {
  type: "object",
  required: ["source_lang", "regions"],
  additionalProperties: false,
  properties: {
    source_lang: {
      type: "string",
      description:
        "ISO 639-1 code of the dominant text language in the image, e.g. 'ja', 'ko', 'zh', 'en'. Use 'und' if no text found.",
    },
    regions: {
      type: "array",
      items: {
        type: "object",
        required: ["bbox", "original", "translated", "is_sfx"],
        additionalProperties: false,
        properties: {
          bbox: {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 1 },
            minItems: 4,
            maxItems: 4,
            description:
              "[x_min, y_min, x_max, y_max]: the box's top-left and bottom-right corners, as fractions 0-1 of the image dimensions. x is horizontal (0 = left edge), y is vertical (0 = top edge). x_max must be greater than x_min, y_max greater than y_min.",
          },
          original: {
            type: "string",
            description:
              "Transcribed source text, exactly as written (keep original script).",
          },
          translated: {
            type: "string",
            description: "Translation into the target language.",
          },
          is_sfx: {
            type: "boolean",
            description:
              "true for onomatopoeia / sound effects drawn as art rather than bubble dialogue.",
          },
          kind: {
            type: "string",
            enum: ["bubble", "caption", "sfx", "sign", "thought"],
            description: "Region type. Optional but preferred.",
          },
        },
      },
    },
  },
};

/** Deep-clone a schema node (structuredClone would also work; kept dependency-free). */
function cloneSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

/** Recursively delete the named keys from every node of a schema tree. */
function stripKeys(schema: JsonSchema, keys: readonly (keyof JsonSchema)[]): void {
  for (const key of keys) delete schema[key];
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) stripKeys(child, keys);
  }
  if (schema.items) stripKeys(schema.items, keys);
}

/**
 * Gemini `responseSchema` dialect: Gemini rejects `additionalProperties`, so
 * strip it everywhere (PROMPTS.md §5.1). `kind` stays optional.
 */
export function toGeminiSchema(): JsonSchema {
  const schema = cloneSchema(CANONICAL_SCHEMA);
  stripKeys(schema, ["additionalProperties"]);
  return schema;
}

/**
 * OpenAI `json_schema` strict-mode dialect (PROMPTS.md §5.2): strict mode
 * requires EVERY property to appear in `required` and forbids the numeric
 * range / array-length keywords. So we (1) add `kind` to the region's
 * `required` and extend its enum with `"none"` (the parser maps `"none"` →
 * absent), and (2) strip `minimum`/`maximum`/`minItems`/`maxItems`.
 * `additionalProperties: false` (already present everywhere) is kept — strict
 * mode demands it.
 */
export function toOpenAiStrictSchema(): JsonSchema {
  const schema = cloneSchema(CANONICAL_SCHEMA);
  stripKeys(schema, ["minimum", "maximum", "minItems", "maxItems"]);
  const region = schema.properties?.regions?.items;
  if (region?.properties?.kind?.enum) {
    region.properties.kind.enum = [...region.properties.kind.enum, "none"];
    region.required = [...(region.required ?? []), "kind"];
  }
  return schema;
}

/**
 * Anthropic tool `input_schema` (PROMPTS.md §5.3): a standard JSON schema — the
 * canonical form works as-is, `kind` stays optional. Provided as a function for
 * symmetry with the other dialects (and so a future tweak has one home).
 */
export function toAnthropicToolSchema(): JsonSchema {
  return cloneSchema(CANONICAL_SCHEMA);
}

// --- Multi-page batch schema (PROMPTS.md §4.2, F12) ------------------------

/**
 * Wrap a single-page schema in the batch envelope (PROMPTS §4.2): a required
 * top-level `pages` array whose items are the given single-page schema. WHY
 * derive from the passed dialect rather than a second literal: each provider's
 * batch schema then inherits its own stripping rules for free (Gemini
 * no-`additionalProperties`, OpenAI strict, Anthropic as-is), and a single-page
 * schema edit propagates to batch automatically.
 *
 * @param singlePageSchema the already-dialect-converted single-page schema.
 * @param includeAdditionalProperties add `additionalProperties: false` on the
 *   wrapper (OpenAI strict + Anthropic keep it; Gemini rejects it → omit).
 */
export function toBatchSchema(
  singlePageSchema: JsonSchema,
  includeAdditionalProperties: boolean,
): JsonSchema {
  const wrapper: JsonSchema = {
    type: "object",
    required: ["pages"],
    properties: { pages: { type: "array", items: singlePageSchema } },
  };
  if (includeAdditionalProperties) wrapper.additionalProperties = false;
  return wrapper;
}

/** Gemini batch `responseSchema`: wrap the Gemini single-page dialect (no
 *  `additionalProperties` anywhere). */
export function toGeminiBatchSchema(): JsonSchema {
  return toBatchSchema(toGeminiSchema(), false);
}

/** OpenAI strict batch `json_schema`: wrap the strict single-page dialect and
 *  keep `additionalProperties: false` on the wrapper (strict mode requires it;
 *  `pages` is the only property and is already in `required`). */
export function toOpenAiBatchSchema(): JsonSchema {
  return toBatchSchema(toOpenAiStrictSchema(), true);
}

/** Anthropic batch tool `input_schema`: wrap the canonical single-page schema. */
export function toAnthropicBatchSchema(): JsonSchema {
  return toBatchSchema(toAnthropicToolSchema(), true);
}

// --- System prompt (PROMPTS.md §3) -----------------------------------------

/**
 * The canonical system prompt with `{{slots}}`. Verbatim from PROMPTS.md §3 —
 * do not edit wording without re-running the golden eval and bumping
 * PROMPT_VERSION.
 */
export const SYSTEM_PROMPT_TEMPLATE = `You are a professional manga and comic translation engine. You receive one or more comic/manga page images. For each image you must:

1. Find EVERY distinct text region: speech bubbles, thought bubbles, narration captions, signs/labels inside the artwork, and sound effects (onomatopoeia).
2. Transcribe the text exactly as written in its original script.
3. Translate it into {{target_lang_name}} ({{target_lang_code}}).
4. Report a bounding box for each region.

BOUNDING BOX RULES:
- Coordinates are FRACTIONS of the image dimensions, between 0 and 1.
- Format: [x_min, y_min, x_max, y_max] — the top-left and bottom-right corners. x_max must be greater than x_min, and y_max greater than y_min.
- The box must tightly enclose the TEXT itself, not the entire bubble outline. If unsure, err slightly larger, never smaller.
- Never let boxes extend past the image edges.
- Two different bubbles must never share one box. One bubble split across two lines is still ONE region.
- Boxes for different regions should not overlap.

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
- If the image contains no text at all, return {"source_lang": "und", "regions": []}.`;

/** Slot text for `{{honorifics_rule}}` (PROMPTS.md §3 slot values). */
const HONORIFICS_RULE: Record<"keep" | "localize", string> = {
  keep: "Preserve Japanese/Korean honorifics as-is (-san, -kun, -nim, etc.).",
  localize:
    "Convert honorifics into natural target-language equivalents or drop them when no equivalent exists.",
};

/** Slot text for `{{reading_order_rule}}` (PROMPTS.md §3 slot values). */
const READING_ORDER_RULE: Record<"rtl" | "ltr" | "auto", string> = {
  rtl: "right-to-left, top-to-bottom (Japanese manga order).",
  ltr: "left-to-right, top-to-bottom.",
  auto: "infer from the artwork's panel layout; Japanese manga is right-to-left, webtoons and western comics are left-to-right, top-to-bottom.",
};

// --- Slot filling -----------------------------------------------------------

/** Everything the prompt template needs, distilled from {@link ProviderSettings}. */
export interface PromptContext {
  targetLangCode: string;
  targetLangName: string;
  /** Undefined = auto-detect (no source hint sent). */
  sourceLangName?: string;
  preserveHonorifics: boolean;
  readingDirection: "rtl" | "ltr" | "auto";
}

/**
 * Distil the prompt-relevant fields out of provider settings, resolving
 * language codes to names and the `auto` source sentinel to "no hint".
 */
export function buildPromptContext(settings: ProviderSettings): PromptContext {
  return {
    targetLangCode: settings.targetLang,
    targetLangName: languageName(settings.targetLang),
    sourceLangName: settings.sourceLangHint
      ? languageName(settings.sourceLangHint)
      : undefined,
    preserveHonorifics: settings.preserveHonorifics,
    readingDirection: settings.readingDirection,
  };
}

/** Replace every `{{slot}}` occurrence from a values map. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in values ? (values[name] as string) : whole,
  );
}

/** Fill {@link SYSTEM_PROMPT_TEMPLATE} for a request. */
export function buildSystemPrompt(ctx: PromptContext): string {
  return fillTemplate(SYSTEM_PROMPT_TEMPLATE, {
    target_lang_name: ctx.targetLangName,
    target_lang_code: ctx.targetLangCode,
    honorifics_rule: HONORIFICS_RULE[ctx.preserveHonorifics ? "keep" : "localize"],
    reading_order_rule: READING_ORDER_RULE[ctx.readingDirection],
  });
}

/**
 * The drag-select region suffix (PROMPTS.md §4.3), appended verbatim to the
 * user message when a job is a user-drawn crop (F10). Do not reflow — like the
 * rest of the prompt it is load-bearing. WHY it need NOT bump PROMPT_VERSION:
 * it only ever appears on region jobs, which are never cached, so no stored page
 * translation's cache key is affected (see {@link import("../../shared/types").TranslateJob.isRegion}).
 */
export const REGION_SUFFIX =
  "This is a cropped region of a comic page selected by the user. It may contain one or several text regions, or text that is not inside a bubble. Transcribe and translate everything legible.";

/** Options for {@link buildUserText}. */
export interface UserTextOptions {
  /**
   * The repair retry (PROMPTS.md §6.4): appends a line telling the model its
   * previous output was invalid JSON. Used after a parse/validate failure.
   */
  repair?: boolean;
  /**
   * Drag-select crop (F10): appends the PROMPTS.md §4.3 {@link REGION_SUFFIX}.
   * When false/absent the output is byte-identical to the pre-Phase-7 single-page
   * message (the PROMPT_VERSION-stability guarantee — pinned in tests).
   */
  region?: boolean;
}

/**
 * Build the single-page user message (PROMPTS.md §4.1). A `{{source_hint}}` is
 * added only when the source language is pinned; the region suffix (§4.3) is
 * added for drag-select crops; the repair suffix is added on the retry pass.
 *
 * The multi-page batch variant is {@link buildBatchUserText} (§4.2). Batching is
 * a background/queue concern (the shared
 * {@link import("../../shared/types").Translator} interface stays
 * one-image-per-call); `ProviderBase.translateBatch` is background-local.
 */
export function buildUserText(
  ctx: PromptContext,
  options: UserTextOptions = {},
): string {
  const sourceHint = ctx.sourceLangName
    ? `The source language is ${ctx.sourceLangName}.`
    : "";
  let text = `Translate this page to ${ctx.targetLangName}. ${sourceHint}`.trim();
  if (options.region) {
    text += `\n${REGION_SUFFIX}`;
  }
  if (options.repair) {
    text +=
      "\nYour previous output was not valid JSON. Return only the JSON object.";
  }
  return text;
}

/**
 * Build the multi-page batch user message (PROMPTS.md §4.2, F12) — verbatim from
 * the spec. Attach the N images in order, then this text. WHY the single-page
 * strings are untouched: batching is additive; `buildUserText`'s output (and thus
 * `PROMPT_VERSION`) is unchanged, so cached single-page translations stay valid
 * and a batch result caches under the SAME key as the single result (batch is a
 * delivery mechanism, not a quality-affecting setting).
 *
 * @param ctx the resolved prompt context.
 * @param n the number of page images attached (2–4 in practice).
 * @param options `repair` appends the same "return only JSON" nudge as the
 *   single-page repair retry (the ONE whole-batch retry, §4.2 guardrail).
 */
export function buildBatchUserText(
  ctx: PromptContext,
  n: number,
  options: UserTextOptions = {},
): string {
  const sourceHint = ctx.sourceLangName
    ? `The source language is ${ctx.sourceLangName}.`
    : "";
  const first = `Translate these ${n} pages to ${ctx.targetLangName}. ${sourceHint}`.trim();
  let text =
    `${first}\n` +
    `Return one JSON object with a top-level "pages" array of length ${n}; ` +
    `pages[i] corresponds to image i (0-indexed) and follows the single-page schema ` +
    `(source_lang + regions). Bboxes are relative to that page's own dimensions.`;
  if (options.repair) {
    text +=
      "\nYour previous output was not valid JSON. Return only the JSON object.";
  }
  return text;
}
