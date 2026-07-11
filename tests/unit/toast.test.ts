import { describe, expect, it } from "vitest";
import { toastPolicy } from "../../src/content/toast";
import type { ProviderErrorKind } from "../../src/shared/types";

describe("toast — toastPolicy (Phase 7 item 6)", () => {
  it("shows an auth toast once, then skips further auth failures", () => {
    const seen = new Set<ProviderErrorKind>();
    expect(toastPolicy("auth", seen)).toBe("show");
    seen.add("auth");
    expect(toastPolicy("auth", seen)).toBe("skip");
  });

  it("tracks rate-limit independently of auth", () => {
    const seen = new Set<ProviderErrorKind>(["auth"]);
    // auth already toasted, but rate-limit is a fresh, independent signal.
    expect(toastPolicy("rate-limit", seen)).toBe("show");
    seen.add("rate-limit");
    expect(toastPolicy("rate-limit", seen)).toBe("skip");
  });

  it("never toasts the non-actionable kinds (badge-only)", () => {
    const seen = new Set<ProviderErrorKind>();
    for (const kind of ["network", "malformed", "refusal", "unknown", "aborted"] as const) {
      expect(toastPolicy(kind, seen)).toBe("skip");
    }
  });

  it("resets when the set is empty (a fresh activation gives fresh signal)", () => {
    // A new activation constructs a ToastManager with an empty set → show again.
    expect(toastPolicy("auth", new Set())).toBe("show");
  });
});
