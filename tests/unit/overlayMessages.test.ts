import { describe, expect, it } from "vitest";
import { errorKindToMessage } from "../../src/content/overlay/errorMessages";
import type { ProviderErrorKind } from "../../src/shared/types";

// Every member of the taxonomy — a compile error here means a missing case.
const ALL_KINDS: ProviderErrorKind[] = [
  "auth",
  "rate-limit",
  "malformed",
  "network",
  "aborted",
  "refusal",
  "unknown",
];

describe("overlay — errorKindToMessage (totality over ProviderErrorKind)", () => {
  it("maps every kind: a string message, except aborted which is null", () => {
    for (const kind of ALL_KINDS) {
      const message = errorKindToMessage(kind);
      if (kind === "aborted") {
        expect(message).toBeNull(); // aborted → render nothing (silent)
      } else {
        expect(typeof message).toBe("string");
        expect((message as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("auth points the user at their API key", () => {
    expect(errorKindToMessage("auth")).toMatch(/API key/i);
  });

  it("rate-limit tells the user to retry shortly", () => {
    expect(errorKindToMessage("rate-limit")).toMatch(/rate limited/i);
  });

  it("refusal explains the provider declined", () => {
    expect(errorKindToMessage("refusal")).toMatch(/declined/i);
  });
});
