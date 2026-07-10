import { describe, expect, it } from "vitest";
import { formatBytes, formatTokens, formatUsd } from "../../src/shared/format";
import { LANGUAGE_NAMES, languageOptions } from "../../src/shared/languages";

describe("format — formatUsd", () => {
  it("keeps 4 decimals under a cent so early usage isn't a flat $0.00", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("uses currency precision from a cent up", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(1.239)).toBe("$1.24");
  });

  it("heals zero/negative/non-finite to $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-1)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("format — formatBytes", () => {
  it("picks the unit by magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3.4 * 1024)).toBe("3.4 KB");
    expect(formatBytes(12.1 * 1024 * 1024)).toBe("12.1 MB");
  });

  it("heals zero/negative/non-finite to 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("format — formatTokens", () => {
  it("compacts by magnitude", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(4_200_000)).toBe("4.2M");
  });

  it("heals zero/negative to 0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-3)).toBe("0");
  });
});

describe("languages — languageOptions (dropdown source)", () => {
  it("lists every curated language in display order with resolved names", () => {
    const options = languageOptions();
    expect(options.map((o) => o.code)).toEqual(Object.keys(LANGUAGE_NAMES));
    expect(options[0]).toEqual({ code: "en", name: "English" });
  });

  it("appends an uncurated current value so the dropdown shows the stored setting", () => {
    const options = languageOptions("fi");
    expect(options[options.length - 1]!.code).toBe("fi");
    // A curated current value is NOT duplicated.
    expect(
      languageOptions("ja").filter((o) => o.code.toLowerCase() === "ja"),
    ).toHaveLength(1);
  });
});
