import { describe, expect, it } from "vitest";
import {
  CMD_PEEK_ORIGINAL,
  CMD_SELECT_REGION,
  CMD_TOGGLE,
  PROMPT_VERSION,
} from "../../src/shared/constants";
import manifest from "../../src/manifest";

describe("shared/constants", () => {
  it("prompt version is a positive integer", () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });

  it("pins PROMPT_VERSION at 2 (Phase 7.4 corner-format bbox schema)", () => {
    // The corner-format bbox schema + no-overlap rule changed prompt output, so
    // the version bumped from 1 → 2 to invalidate old-format-era cache entries.
    expect(PROMPT_VERSION).toBe(2);
  });

  it("command ids stay in sync with the manifest (edge: drift)", () => {
    const commands = manifest["commands"] as Record<string, unknown>;
    const ids = Object.keys(commands);
    expect(ids).toContain(CMD_TOGGLE);
    expect(ids).toContain(CMD_SELECT_REGION);
    expect(ids).toContain(CMD_PEEK_ORIGINAL);
  });

  it("declares a default_locale so __MSG_*__ manifest strings resolve", () => {
    expect(manifest["default_locale"]).toBe("en");
  });

  it("manifest is Firefox MV3 with an event page, not a service worker (edge: platform regressions)", () => {
    expect(manifest["manifest_version"]).toBe(3);
    const background = manifest["background"] as Record<string, unknown>;
    expect(Array.isArray(background["scripts"])).toBe(true);
    expect(background["service_worker"]).toBeUndefined();
  });
});
