/**
 * Map a {@link ProviderErrorKind} to a short, user-facing overlay message
 * (§7.2 error state). Pure and total over the taxonomy; shared with the Phase
 * 6/7 toast surfaces later. `aborted` returns `null` — the request was cancelled
 * because the user scrolled away or toggled off, so the overlay renders nothing
 * (nothing is wrong).
 */
import type { ProviderErrorKind } from "../../shared/types";

/**
 * @param kind the provider error taxonomy value.
 * @returns a message for the ⚠ badge's `title`, or `null` to render nothing.
 */
export function errorKindToMessage(kind: ProviderErrorKind): string | null {
  switch (kind) {
    case "auth":
      return "MangaLens: check your API key";
    case "rate-limit":
      return "MangaLens: rate limited — try again shortly";
    case "refusal":
      return "MangaLens: the provider declined this image";
    case "network":
      return "MangaLens: network error — couldn't reach the provider";
    case "malformed":
      return "MangaLens: couldn't read the provider's response";
    case "unknown":
      return "MangaLens: translation failed";
    case "aborted":
      return null;
  }
}
