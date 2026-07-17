import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveI18n } from "../../src/shared/i18nDom";

afterEach(() => vi.unstubAllGlobals());

describe("i18nDom — resolveI18n (§8 walker core)", () => {
  it("keeps the English fallback when the i18n API is absent (node env)", () => {
    expect(resolveI18n([{ key: "popupAddKey", fallback: "Add key" }])).toEqual(["Add key"]);
  });

  it("uses the localized message when the API resolves the key", () => {
    vi.stubGlobal("browser", {
      i18n: { getMessage: (k: string) => (k === "popupAddKey" ? "Ajouter" : "") },
    });
    expect(resolveI18n([{ key: "popupAddKey", fallback: "Add key" }])).toEqual(["Ajouter"]);
  });

  it("never emits __MSG_ soup or an empty string for a missing key", () => {
    vi.stubGlobal("browser", { i18n: { getMessage: () => "" } });
    const out = resolveI18n([{ key: "missing", fallback: "English text" }]);
    expect(out).toEqual(["English text"]);
    expect(out[0]).not.toContain("__MSG_");
    expect(out[0]).not.toBe("");
  });

  it("resolves each target independently, preserving order", () => {
    vi.stubGlobal("browser", {
      i18n: { getMessage: (k: string) => (k === "a" ? "A!" : "") },
    });
    expect(
      resolveI18n([
        { key: "a", fallback: "a-fb" },
        { key: "b", fallback: "b-fb" },
      ]),
    ).toEqual(["A!", "b-fb"]);
  });
});
