/**
 * OpenAI Chat Completions provider — also the base for OpenRouter and any
 * custom OpenAI-compatible endpoint (PROMPTS.md §5.2/§5.4).
 *
 * Enforcement: `response_format: { type: "json_schema", strict: true }` with the
 * strict-mode schema dialect. Because structured-output support varies across
 * OpenAI-compatible servers (custom endpoints, OpenRouter models), a 400 that
 * mentions `response_format` downgrades once to `json_object` mode with the
 * schema pasted into the system prompt (the {@link downgrade} hook, §5.2).
 */
import {
  DEFAULT_MODELS,
  ProviderBase,
  tokenCount,
  type BatchBuildContext,
  type BuildContext,
  type BuildContextBase,
  type ProviderBaseOptions,
  type ProviderOutput,
  type ProviderRequest,
} from "./ProviderBase";
import { toOpenAiBatchSchema, toOpenAiStrictSchema } from "./prompt";
import {
  getEndpointMode,
  isSamplingRejected,
  learnEndpointMode,
  learnSamplingRejected,
  resetEndpointModes,
} from "../endpointModes";
import type { ProviderId } from "../../shared/types";

/** Canonical OpenAI API base. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** JSON name the schema is registered under (OpenAI requires one). */
const SCHEMA_NAME = "manga_translation";

// The per-endpoint structured-output mode memo now PERSISTS across event-page
// lifetimes (Phase 8 §4) — its storage-backed home is `background/endpointModes.ts`.
// Re-exported so the existing `resetEndpointModes` test seam keeps working.
export { resetEndpointModes };

/**
 * Provider for OpenAI and every OpenAI-compatible surface. `openrouter` and
 * `custom` are the same wire format with a different base URL / extra headers.
 */
export class OpenAiProvider extends ProviderBase {
  protected readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(
    providerId: ProviderId,
    config: {
      baseUrl: string;
      defaultModel: string;
      extraHeaders?: Record<string, string>;
    },
    options: ProviderBaseOptions = {},
  ) {
    super(providerId, options);
    // Trim a trailing slash so `${base}/chat/completions` never doubles up.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.defaultModel = config.defaultModel;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  protected override buildRequest(ctx: BuildContext): ProviderRequest {
    const schema = toOpenAiStrictSchema();
    // A remembered downgrade for this endpoint overrides the requested mode.
    const mode = getEndpointMode(this.baseUrl) ?? ctx.mode;
    // json_object downgrade: no native schema enforcement, so paste it into the
    // system prompt as a best-effort instruction (§5.2).
    const system =
      mode === "json_object"
        ? `${ctx.systemPrompt}\n\nReturn a JSON object matching this schema exactly:\n${JSON.stringify(schema)}`
        : ctx.systemPrompt;

    // gpt-5.x/o-series reasoning models 400 on any non-default `temperature`
    // ("Only the default (1) value is supported"). Same learn-on-400 memo the
    // Anthropic provider uses — omit it once the model is known to reject it.
    const temperature = isSamplingRejected(ctx.model) ? undefined : ctx.temperature;
    const body: Record<string, unknown> = {
      model: ctx.model,
      ...(temperature !== undefined && { temperature }),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: ctx.userText },
            {
              type: "image_url",
              image_url: { url: `data:${ctx.mime};base64,${ctx.imageBase64}` },
            },
          ],
        },
      ],
      response_format:
        mode === "json_object"
          ? { type: "json_object" }
          : {
              type: "json_schema",
              json_schema: { name: SCHEMA_NAME, strict: true, schema },
            },
    };

    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.settings.apiKey}`,
        ...this.extraHeaders,
      },
      body,
    };
  }

  protected override buildBatchRequest(ctx: BatchBuildContext): ProviderRequest {
    const schema = toOpenAiBatchSchema();
    // Same per-endpoint downgrade memo as the single-page path (§5.2).
    const mode = getEndpointMode(this.baseUrl) ?? ctx.mode;
    const system =
      mode === "json_object"
        ? `${ctx.systemPrompt}\n\nReturn a JSON object matching this schema exactly:\n${JSON.stringify(schema)}`
        : ctx.systemPrompt;

    const temperature = isSamplingRejected(ctx.model) ? undefined : ctx.temperature;
    const body: Record<string, unknown> = {
      model: ctx.model,
      ...(temperature !== undefined && { temperature }),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: ctx.userText },
            // N image_url blocks in order (PROMPTS §4.2).
            ...ctx.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${img.imageBase64}` },
            })),
          ],
        },
      ],
      response_format:
        mode === "json_object"
          ? { type: "json_object" }
          : {
              type: "json_schema",
              json_schema: { name: SCHEMA_NAME, strict: true, schema },
            },
    };

    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.settings.apiKey}`,
        ...this.extraHeaders,
      },
      body,
    };
  }

  protected override extractOutput(responseJson: unknown): ProviderOutput {
    const root = responseJson as {
      choices?: {
        message?: { content?: unknown; refusal?: unknown };
        finish_reason?: unknown;
      }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const choice = root.choices?.[0];
    if (!choice) {
      return { kind: "text", value: "" }; // no choices → downstream malformed
    }
    // OpenAI's structured-output refusal field, and the content-filter stop.
    if (typeof choice.message?.refusal === "string" && choice.message.refusal) {
      return { kind: "refusal", message: choice.message.refusal };
    }
    if (choice.finish_reason === "content_filter") {
      return { kind: "refusal", message: "Content filtered by provider" };
    }
    const content = choice.message?.content;
    return {
      kind: "text",
      value: typeof content === "string" ? content : "",
      usage: {
        tokensIn: tokenCount(root.usage?.prompt_tokens),
        tokensOut: tokenCount(root.usage?.completion_tokens),
      },
    };
  }

  protected override downgrade<C extends BuildContextBase>(
    ctx: C,
    bodyText: string,
  ): C | null {
    // A 400 blaming `temperature` means this model rejects a non-default value
    // (gpt-5.x / o-series only allow the default 1): remember the model and
    // retry once with it omitted. Checked before the response_format downgrade
    // because the two 400 causes are independent and the retry is one-shot.
    //
    // WHY the retry decision keys off `ctx.temperature` (what THIS request sent)
    // and NOT `isSamplingRejected(ctx.model)`: the memo is shared and set
    // SYNCHRONOUSLY the instant any sibling learns. At concurrency N the whole
    // first wave builds with temperature (memo empty) and all 400 together; if
    // the retry were gated on `!isSamplingRejected`, the first sibling to process
    // its 400 flips the memo and every OTHER sibling then skips this branch,
    // falls through to a null downgrade, and blanks permanently (only the winner
    // recovers). `ctx.temperature !== undefined` already excludes the
    // already-learned case (buildRequest omits temperature once the memo is set,
    // so a later request never sends it) and `allowDowngrade=false` on the retry
    // prevents any loop — so the memo guard was pure harm.
    if (ctx.temperature !== undefined && /temperature/i.test(bodyText)) {
      learnSamplingRejected(ctx.model);
      return { ...ctx, temperature: undefined };
    }
    // Only worth retrying if we haven't already downgraded and the server is
    // complaining about the structured-output request specifically. Generic over
    // the context so the single-page AND batch requests share this downgrade.
    if (ctx.mode !== "json_schema" || getEndpointMode(this.baseUrl) === "json_object") {
      return null;
    }
    if (!/response_format|json_schema/i.test(bodyText)) return null;
    learnEndpointMode(this.baseUrl, "json_object");
    return { ...ctx, mode: "json_object" };
  }
}

/** Construct the standard OpenAI provider. */
export function createOpenAiProvider(
  options?: ProviderBaseOptions,
): OpenAiProvider {
  return new OpenAiProvider(
    "openai",
    { baseUrl: OPENAI_BASE_URL, defaultModel: DEFAULT_MODELS.openai },
    options,
  );
}

/**
 * Construct a custom OpenAI-compatible provider pointed at the user's endpoint.
 * The endpoint should be the API base (e.g. `https://host/v1`); the provider
 * appends `/chat/completions`.
 */
export function createCustomProvider(
  baseUrl: string,
  options?: ProviderBaseOptions,
): OpenAiProvider {
  return new OpenAiProvider(
    "custom",
    { baseUrl, defaultModel: DEFAULT_MODELS.custom },
    options,
  );
}
