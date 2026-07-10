/**
 * Google Gemini provider (PROMPTS.md §5.1) — the default provider (Flash tier
 * is the cheapest vision option, §11).
 *
 * Enforcement: `generationConfig.responseMimeType: "application/json"` +
 * `responseSchema` (the Gemini schema dialect strips `additionalProperties`).
 * The system prompt goes in `systemInstruction`; the image is an inline base64
 * part. `maxOutputTokens` is generous (8192) for dense action pages.
 */
import {
  DEFAULT_MODELS,
  ProviderBase,
  tokenCount,
  type BuildContext,
  type ProviderOutput,
  type ProviderRequest,
} from "./ProviderBase";
import { toGeminiSchema } from "./prompt";

/** Base for the Generative Language API. */
export const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

/** Generous output cap: dense pages can hit ~40 regions × ~60 tokens (§5.1). */
const MAX_OUTPUT_TOKENS = 8192;

/** Finish reasons / block reasons that mean the model declined (→ ContentRefusalError). */
const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "RECITATION",
  "SPII",
]);

/** Gemini provider. */
export class GeminiProvider extends ProviderBase {
  protected readonly defaultModel = DEFAULT_MODELS.gemini;

  protected override buildRequest(ctx: BuildContext): ProviderRequest {
    const body = {
      systemInstruction: { parts: [{ text: ctx.systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: ctx.mime, data: ctx.imageBase64 } },
            { text: ctx.userText },
          ],
        },
      ],
      generationConfig: {
        ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(),
      },
    };

    return {
      // WHY the key in a header, not `?key=`: keeps it out of any URL that might
      // get logged. `generateContent` is the non-streaming endpoint.
      url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(ctx.model)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": ctx.settings.apiKey,
      },
      body,
    };
  }

  protected override extractOutput(responseJson: unknown): ProviderOutput {
    const root = responseJson as {
      candidates?: {
        content?: { parts?: { text?: unknown }[] };
        finishReason?: unknown;
      }[];
      promptFeedback?: { blockReason?: unknown };
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
    };

    // A prompt-level block (before any candidate) is a refusal.
    const blockReason = root.promptFeedback?.blockReason;
    if (typeof blockReason === "string" && blockReason) {
      return { kind: "refusal", message: `Gemini blocked prompt: ${blockReason}` };
    }

    const candidate = root.candidates?.[0];
    const finishReason =
      typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
    if (REFUSAL_REASONS.has(finishReason)) {
      return { kind: "refusal", message: `Gemini declined (${finishReason})` };
    }

    const text = (candidate?.content?.parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    return {
      kind: "text",
      value: text,
      usage: {
        tokensIn: tokenCount(root.usageMetadata?.promptTokenCount),
        tokensOut: tokenCount(root.usageMetadata?.candidatesTokenCount),
      },
    };
  }
}
