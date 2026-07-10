/**
 * OpenRouter provider (PROMPTS.md §5.4): an OpenAI-compatible surface, so it is
 * just {@link OpenAiProvider} pointed at OpenRouter's base URL with the
 * `HTTP-Referer` / `X-Title` attribution headers OpenRouter asks browser clients
 * to send. Structured-output support varies by the underlying model, so it
 * inherits the `json_schema` → `json_object` downgrade ladder unchanged.
 */
import { OpenAiProvider } from "./openai";
import { DEFAULT_MODELS, type ProviderBaseOptions } from "./ProviderBase";

/** Canonical OpenRouter API base. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Attribution headers OpenRouter uses for its app leaderboard. Static, key-free,
 * and safe to send from the extension.
 */
const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/mangalens",
  "X-Title": "MangaLens",
};

/** Construct the OpenRouter provider. */
export function createOpenRouterProvider(
  options?: ProviderBaseOptions,
): OpenAiProvider {
  return new OpenAiProvider(
    "openrouter",
    {
      baseUrl: OPENROUTER_BASE_URL,
      defaultModel: DEFAULT_MODELS.openrouter,
      extraHeaders: OPENROUTER_HEADERS,
    },
    options,
  );
}
