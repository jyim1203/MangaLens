/**
 * Anthropic Claude provider (PROMPTS.md §5.3).
 *
 * Enforcement via FORCED TOOL USE: a single tool `emit_translation` whose
 * `input_schema` is the canonical schema, with
 * `tool_choice: { type: "tool", name: "emit_translation" }`. The model's answer
 * arrives as a `tool_use` block whose `input` is already a parsed object — no
 * JSON string parsing, the single most reliable delivery path.
 *
 * WHY the `anthropic-dangerous-direct-browser-access` header: Anthropic blocks
 * browser-origin calls by default; this opt-in header is required for a BYOK
 * extension that calls the API directly (§7.6). Keys stay local.
 */
import {
  ProviderBase,
  tokenCount,
  type BuildContext,
  type ProviderOutput,
  type ProviderRequest,
} from "./ProviderBase";
import { toAnthropicToolSchema } from "./prompt";

/** Messages API endpoint. */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Pinned API version (Anthropic requires the header). */
const ANTHROPIC_VERSION = "2023-06-01";

/** The forced tool's name — must match on the way out. */
const TOOL_NAME = "emit_translation";

/** Generous output cap for dense pages (within every current model's limit). */
const MAX_TOKENS = 8192;

/**
 * Models observed to reject sampling parameters. Claude 4.6+ models (Opus
 * 4.7/4.8, Sonnet 5, Fable 5) removed `temperature`/`top_p`/`top_k` and return
 * 400 if any is sent; older models (e.g. Haiku 4.5) still accept them. WHY
 * learn-on-400 instead of a hardcoded model list: BYOK users type arbitrary
 * model ids and the list will grow — remembering the rejection costs one 400
 * per model per event-page lifetime and never goes stale.
 */
const MODELS_REJECTING_SAMPLING = new Set<string>();

/** Test seam: forget which models rejected sampling params. */
export function resetSamplingMemo(): void {
  MODELS_REJECTING_SAMPLING.clear();
}

/** Anthropic provider. */
export class AnthropicProvider extends ProviderBase {
  protected readonly defaultModel = "claude-haiku-4-5";

  protected override buildRequest(ctx: BuildContext): ProviderRequest {
    const temperature = MODELS_REJECTING_SAMPLING.has(ctx.model)
      ? undefined
      : ctx.temperature;
    const body = {
      model: ctx.model,
      max_tokens: MAX_TOKENS,
      ...(temperature !== undefined && { temperature }),
      system: ctx.systemPrompt,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Emit the detected text regions with transcription and translation.",
          input_schema: toAnthropicToolSchema(),
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: ctx.mime,
                data: ctx.imageBase64,
              },
            },
            { type: "text", text: ctx.userText },
          ],
        },
      ],
    };

    return {
      url: ANTHROPIC_URL,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ctx.settings.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
    };
  }

  protected override extractOutput(responseJson: unknown): ProviderOutput {
    const root = responseJson as {
      stop_reason?: unknown;
      content?: { type?: unknown; name?: unknown; input?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };

    // Anthropic's dedicated refusal stop reason (safety decline).
    if (root.stop_reason === "refusal") {
      return { kind: "refusal", message: "Claude declined this image" };
    }

    const usage = {
      tokensIn: tokenCount(root.usage?.input_tokens),
      tokensOut: tokenCount(root.usage?.output_tokens),
    };

    const toolBlock = (root.content ?? []).find(
      (block) => block.type === "tool_use" && block.name === TOOL_NAME,
    );
    if (toolBlock && toolBlock.input !== undefined) {
      // input is already a parsed object — hand it straight to the pipeline.
      return { kind: "json", value: toolBlock.input, usage };
    }

    // No tool call and not a flagged refusal: forced tool-use should make this
    // unreachable, but treat it as malformed so the repair retry can fire.
    return { kind: "text", value: "", usage };
  }

  protected override downgrade(
    ctx: BuildContext,
    bodyText: string,
  ): BuildContext | null {
    // A 400 blaming a sampling param means this model rejects them (Claude
    // 4.6+): remember the model and retry once with temperature omitted.
    if (ctx.temperature === undefined || MODELS_REJECTING_SAMPLING.has(ctx.model)) {
      return null;
    }
    if (!/temperature|top_p|top_k|sampling/i.test(bodyText)) return null;
    MODELS_REJECTING_SAMPLING.add(ctx.model);
    return { ...ctx, temperature: undefined };
  }
}
