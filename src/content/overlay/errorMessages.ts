/**
 * Map a {@link ProviderErrorKind} to a short, user-facing overlay message
 * (§7.2 error state). Pure and total over the taxonomy; shared with the Phase 7
 * toast surface. `aborted` returns `null` — the request was cancelled because the
 * user scrolled away or toggled off, so the overlay renders nothing (nothing is
 * wrong).
 *
 * Strings are localized via {@link t} with the English text as the fallback
 * (Phase 7 i18n): under the built extension `browser.i18n` returns the
 * `_locales` message; under node tests the fallback IS today's string, so the
 * totality/wording tests keep passing untouched.
 */
import { t } from "../../shared/i18n";
import type { ProviderErrorKind } from "../../shared/types";

/**
 * @param kind the provider error taxonomy value.
 * @returns a message for the ⚠ badge's `title`, or `null` to render nothing.
 */
export function errorKindToMessage(kind: ProviderErrorKind): string | null {
  switch (kind) {
    case "auth":
      return t("errorAuth", undefined, "MangaLens: check your API key");
    case "rate-limit":
      return t(
        "errorRateLimit",
        undefined,
        "MangaLens: rate limited — try again shortly",
      );
    case "refusal":
      return t(
        "errorRefusal",
        undefined,
        "MangaLens: the provider declined this image",
      );
    case "network":
      return t(
        "errorNetwork",
        undefined,
        "MangaLens: network error — couldn't reach the provider",
      );
    case "malformed":
      return t(
        "errorMalformed",
        undefined,
        "MangaLens: couldn't read the provider's response",
      );
    case "unknown":
      return t("errorUnknown", undefined, "MangaLens: translation failed");
    case "aborted":
      return null;
  }
}
