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
  ProviderBase,
  tokenCount,
  type BuildContext,
  type ProviderBaseOptions,
  type ProviderOutput,
  type ProviderRequest,
} from "./ProviderBase";
import { toOpenAiStrictSchema } from "./prompt";
import type { ProviderId } from "../../shared/types";

/** Canonical OpenAI API base. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** JSON name the schema is registered under (OpenAI requires one). */
const SCHEMA_NAME = "manga_translation";

/**
 * Remembered structured-output mode per endpoint base URL, so an endpoint that
 * 400s on `json_schema` pays the downgrade round trip once per event-page
 * lifetime instead of once per request (PROMPTS.md §5.2 "remember the working
 * mode per endpoint"). NOTE: §5.2 asks for persistence in settings; that needs
 * the background settings write path + an options-page surface and is deferred
 * to Phase 6 — this in-memory memo covers the burst-of-pages common case.
 */
const endpointModes = new Map<string, "json_schema" | "json_object">();

/** Test seam: forget every remembered endpoint mode. */
export function resetEndpointModes(): void {
  endpointModes.clear();
}

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
    const mode = endpointModes.get(this.baseUrl) ?? ctx.mode;
    // json_object downgrade: no native schema enforcement, so paste it into the
    // system prompt as a best-effort instruction (§5.2).
    const system =
      mode === "json_object"
        ? `${ctx.systemPrompt}\n\nReturn a JSON object matching this schema exactly:\n${JSON.stringify(schema)}`
        : ctx.systemPrompt;

    const body: Record<string, unknown> = {
      model: ctx.model,
      ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
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

  protected override downgrade(
    ctx: BuildContext,
    bodyText: string,
  ): BuildContext | null {
    // Only worth retrying if we haven't already downgraded and the server is
    // complaining about the structured-output request specifically.
    if (ctx.mode !== "json_schema" || endpointModes.get(this.baseUrl) === "json_object") {
      return null;
    }
    if (!/response_format|json_schema/i.test(bodyText)) return null;
    endpointModes.set(this.baseUrl, "json_object");
    return { ...ctx, mode: "json_object" };
  }
}

/** Construct the standard OpenAI provider. */
export function createOpenAiProvider(
  options?: ProviderBaseOptions,
): OpenAiProvider {
  return new OpenAiProvider(
    "openai",
    { baseUrl: OPENAI_BASE_URL, defaultModel: "gpt-4o-mini" },
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
    { baseUrl, defaultModel: "" },
    options,
  );
}
