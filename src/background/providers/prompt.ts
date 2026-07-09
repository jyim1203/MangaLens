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
              "[x, y, width, height] as fractions of image dimensions. (x,y) is the TOP-LEFT corner of the text region.",
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

// --- Language names ---------------------------------------------------------

/**
 * Curated code → English name map for the languages users actually target/read.
 * Region-tagged keys (`zh-tw`) get their tag appended for disambiguation
 * (PROMPTS.md §7: `zh-TW` → "Traditional Chinese (zh-TW)"). Anything not here
 * falls back to `Intl.DisplayNames`, then to the raw code.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-tw": "Traditional Chinese",
  "zh-cn": "Simplified Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  ru: "Russian",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
  nl: "Dutch",
};

/**
 * Human-readable language name for a code, for the prompt. The name drives
 * translation quality; region tags (`zh-TW`) are preserved in parentheses so
 * the model disambiguates variants.
 *
 * @param code an ISO 639-1 code, optionally region-tagged (e.g. "en", "zh-TW").
 * @returns e.g. "English", "Traditional Chinese (zh-TW)".
 */
export function languageName(code: string): string {
  const key = code.toLowerCase();
  const exact = LANGUAGE_NAMES[key];
  if (exact) return key.includes("-") ? `${exact} (${code})` : exact;

  // Only reachable for region-tagged keys the exact lookup missed (a bare key
  // would have hit above), so the tag is always appended for disambiguation.
  const primary = key.split("-")[0] ?? key;
  const primaryName = LANGUAGE_NAMES[primary];
  if (primaryName) return `${primaryName} (${code})`;

  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== key) return name;
  } catch {
    // Intl.DisplayNames unavailable in some contexts — fall through.
  }
  return code;
}

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

/** Options for {@link buildUserText}. */
export interface UserTextOptions {
  /**
   * The repair retry (PROMPTS.md §6.4): appends a line telling the model its
   * previous output was invalid JSON. Used after a parse/validate failure.
   */
  repair?: boolean;
}

/**
 * Build the single-page user message (PROMPTS.md §4.1). A `{{source_hint}}` is
 * added only when the source language is pinned; the repair suffix is added on
 * the retry pass.
 *
 * NOTE: multi-page batch (§4.2) and drag-select (§4.3) variants are deferred
 * with their features (F12 / F10) — the {@link import("../../shared/types").Translator}
 * interface is one-image-per-call, so batching is a queue-layer concern.
 */
export function buildUserText(
  ctx: PromptContext,
  options: UserTextOptions = {},
): string {
  const sourceHint = ctx.sourceLangName
    ? `The source language is ${ctx.sourceLangName}.`
    : "";
  let text = `Translate this page to ${ctx.targetLangName}. ${sourceHint}`.trim();
  if (options.repair) {
    text +=
      "\nYour previous output was not valid JSON. Return only the JSON object.";
  }
  return text;
}
