import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../src/shared/i18n";

/** Restore any globalThis.browser stub between tests. */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared/i18n — t()", () => {
  it("returns the platform message when the API provides one", () => {
    vi.stubGlobal("browser", {
      i18n: { getMessage: (key: string) => `msg:${key}` },
    });
    expect(t("errorAuth", undefined, "fallback")).toBe("msg:errorAuth");
  });

  it("passes substitutions through to getMessage", () => {
    const getMessage = vi.fn((_key: string, _subs?: unknown) => "done");
    vi.stubGlobal("browser", { i18n: { getMessage } });
    t("greeting", ["a", "b"]);
    expect(getMessage).toHaveBeenCalledWith("greeting", ["a", "b"]);
  });

  it("falls back when getMessage returns empty (missing/untranslated key)", () => {
    vi.stubGlobal("browser", { i18n: { getMessage: () => "" } });
    expect(t("nope", undefined, "English fallback")).toBe("English fallback");
  });

  it("falls back when no i18n API is present (node test env)", () => {
    // No globalThis.browser stubbed → API absent.
    expect(t("errorAuth", undefined, "English fallback")).toBe("English fallback");
  });

  it("returns the key itself when there is no fallback and no API", () => {
    expect(t("some.key")).toBe("some.key");
  });

  it("falls back when getMessage throws (very defensive)", () => {
    vi.stubGlobal("browser", {
      i18n: {
        getMessage: () => {
          throw new Error("boom");
        },
      },
    });
    expect(t("k", undefined, "safe")).toBe("safe");
  });

  it("reads chrome.i18n when browser is absent (Chrome-port safety)", () => {
    vi.stubGlobal("chrome", {
      i18n: { getMessage: (key: string) => `chrome:${key}` },
    });
    expect(t("x", undefined, "fb")).toBe("chrome:x");
  });
});
