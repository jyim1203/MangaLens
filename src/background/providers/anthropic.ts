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
  DEFAULT_MODELS,
  ProviderBase,
  tokenCount,
  type BatchBuildContext,
  type BuildContext,
  type BuildContextBase,
  type ProviderOutput,
  type ProviderRequest,
} from "./ProviderBase";
import { isSamplingRejected, learnSamplingRejected } from "../endpointModes";
import { toAnthropicBatchSchema, toAnthropicToolSchema } from "./prompt";

/** Messages API endpoint. */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Pinned API version (Anthropic requires the header). */
const ANTHROPIC_VERSION = "2023-06-01";

/** The forced tool's name — must match on the way out. */
const TOOL_NAME = "emit_translation";

/** Generous output cap for dense pages (within every current model's limit). */
const MAX_TOKENS = 8192;

/**
 * Ceiling on the scaled batch output cap ({@link MAX_TOKENS} × pages). 32000 is
 * the lowest max-output limit among active Claude models (legacy Opus 4.1);
 * everything current (Haiku 4.5, Sonnet 4.5+/5, Opus 4.5+) allows ≥ 64K, and
 * Anthropic 400s a `max_tokens` above the model's limit, so the ceiling keeps a
 * 4-page batch valid everywhere the single-page 8192 already was.
 */
const MAX_BATCH_TOKENS = 32000;

/**
 * Which models reject sampling parameters lives in the persisted memo
 * (`endpointModes.ts`). Claude 4.6+ models (Opus 4.7/4.8, Sonnet 5, Fable 5)
 * removed `temperature`/`top_p`/`top_k` and return 400 if any is sent; older
 * models (e.g. Haiku 4.5) still accept them. WHY learn-on-400 instead of a
 * hardcoded model list: BYOK users type arbitrary model ids and the list will
 * grow — remembering the rejection costs one 400 per model and never goes
 * stale. WHY persisted (was a module-level set until the Phase 8.1 live pass):
 * the event page unloads after ~30 s idle, so the in-memory memo re-paid that
 * 400 on every wake — a visible red `v1/messages` 400 in the console at the
 * start of every reading session.
 */

/** Test seam: forget which models rejected sampling params (re-export). */
export { resetSamplingMemo } from "../endpointModes";

/** Anthropic provider. */
export class AnthropicProvider extends ProviderBase {
  protected readonly defaultModel = DEFAULT_MODELS.anthropic;

  protected override buildRequest(ctx: BuildContext): ProviderRequest {
    const temperature = isSamplingRejected(ctx.model) ? undefined : ctx.temperature;
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

  protected override buildBatchRequest(ctx: BatchBuildContext): ProviderRequest {
    const temperature = isSamplingRejected(ctx.model) ? undefined : ctx.temperature;
    const body = {
      model: ctx.model,
      // WHY scaled: a batch's output is ~N pages' worth of regions, so the
      // single-page cap truncates dense batches mid-tool-input — which reads as
      // malformed, burns the ONE whole-batch repair on a re-generation that
      // truncates again, then splits to solos (3× the latency before anything
      // renders). Capped at MAX_BATCH_TOKENS so the request stays within every
      // active Claude model's max_tokens validation.
      max_tokens: Math.min(MAX_TOKENS * ctx.images.length, MAX_BATCH_TOKENS),
      ...(temperature !== undefined && { temperature }),
      system: ctx.systemPrompt,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Emit the detected text regions for every page, with transcription and translation.",
          input_schema: toAnthropicBatchSchema(),
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [
        {
          role: "user",
          content: [
            // N image blocks in order, then the batch instruction (PROMPTS §4.2).
            ...ctx.images.map((img) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mime,
                data: img.imageBase64,
              },
            })),
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

  protected override downgrade<C extends BuildContextBase>(
    ctx: C,
    bodyText: string,
  ): C | null {
    // A 400 blaming a sampling param means this model rejects them (Claude
    // 4.6+): remember the model and retry once with temperature omitted. Generic
    // over the context so single-page AND batch requests share this downgrade.
    if (ctx.temperature === undefined || isSamplingRejected(ctx.model)) {
      return null;
    }
    if (!/temperature|top_p|top_k|sampling/i.test(bodyText)) return null;
    learnSamplingRejected(ctx.model);
    return { ...ctx, temperature: undefined };
  }
}
