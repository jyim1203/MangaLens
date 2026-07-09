/**
 * Provider factory: map a {@link ProviderSettings} to the concrete
 * {@link Translator} that talks to that provider. The one place the rest of the
 * background layer names providers — callers depend only on the
 * {@link Translator} interface.
 */
import type { ProviderSettings, Translator } from "../../shared/types";
import { ProviderError, type ProviderBaseOptions } from "./ProviderBase";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import {
  createCustomProvider,
  createOpenAiProvider,
} from "./openai";
import { createOpenRouterProvider } from "./openrouter";

/**
 * Build the translator for the active provider. `options` injects the fetch /
 * sleep / backoff seams (tests only); production passes nothing.
 *
 * @throws {ProviderError} `unknown` for an unrecognized provider id, or
 *   `custom` with no endpoint configured.
 */
export function createProvider(
  settings: ProviderSettings,
  options?: ProviderBaseOptions,
): Translator {
  switch (settings.provider) {
    case "gemini":
      return new GeminiProvider("gemini", options);
    case "anthropic":
      return new AnthropicProvider("anthropic", options);
    case "openai":
      return createOpenAiProvider(options);
    case "openrouter":
      return createOpenRouterProvider(options);
    case "custom": {
      const endpoint = settings.customEndpoint?.trim();
      if (!endpoint) {
        throw new ProviderError(
          "unknown",
          "Custom provider selected but no endpoint is configured",
          { provider: "custom" },
        );
      }
      return createCustomProvider(endpoint, options);
    }
    default:
      throw new ProviderError(
        "unknown",
        `Unknown provider: ${String(settings.provider)}`,
      );
  }
}
