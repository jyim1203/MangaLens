/**
 * Provider factory: map a {@link ProviderSettings} to the concrete
 * {@link Translator} that talks to that provider. The one place the rest of the
 * background layer names providers — callers depend only on the
 * {@link Translator} interface.
 */
import type { ProviderSettings } from "../../shared/types";
import {
  DEFAULT_MODELS,
  ProviderBase,
  ProviderError,
  type ProviderBaseOptions,
} from "./ProviderBase";
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
 * Returns the concrete {@link ProviderBase} (which `implements Translator`), not
 * the bare {@link import("../../shared/types").Translator} interface — so the
 * background batch collector can reach the background-local
 * {@link ProviderBase.translateBatch} (F12, handoff rule 4: batching lives here,
 * not on the shared interface). Callers that only need single-page translation
 * still see the `Translator` surface.
 *
 * @throws {ProviderError} `unknown` for an unrecognized provider id, or
 *   `custom` with no endpoint configured.
 */
export function createProvider(
  settings: ProviderSettings,
  options?: ProviderBaseOptions,
): ProviderBase {
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

/**
 * The model that {@link createProvider}'s translator will actually run for these
 * settings: the user's explicit choice, or the provider's default when none is
 * set. This MUST mirror `ProviderBase`'s own `settings.model || this.defaultModel`
 * resolution (both read {@link DEFAULT_MODELS}), so the cache key
 * ({@link import("../cache").buildCacheKey}) is keyed by the same model string
 * the request used and the stored {@link import("../../shared/types").PageTranslation}
 * is stamped with (Phase 4.1 item 3).
 *
 * WHY custom can resolve to `""`: an OpenAI-compatible endpoint has no canonical
 * default model; when the user hasn't named one the empty segment is still a
 * stable, self-consistent key (the same endpoint always keys the same way).
 *
 * @param settings the provider slice.
 * @returns the resolved model id (possibly `""` for an unconfigured custom endpoint).
 */
export function resolveEffectiveModel(settings: ProviderSettings): string {
  return settings.model || DEFAULT_MODELS[settings.provider];
}
