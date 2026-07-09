import { describe, expect, it } from "vitest";
import { CMD_TOGGLE, PROMPT_VERSION } from "../../src/shared/constants";
import manifest from "../../src/manifest";

describe("shared/constants", () => {
  it("prompt version is a positive integer", () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });

  it("toggle command id stays in sync with the manifest (edge: drift)", () => {
    const commands = manifest["commands"] as Record<string, unknown>;
    expect(Object.keys(commands)).toContain(CMD_TOGGLE);
  });

  it("manifest is Firefox MV3 with an event page, not a service worker (edge: platform regressions)", () => {
    expect(manifest["manifest_version"]).toBe(3);
    const background = manifest["background"] as Record<string, unknown>;
    expect(Array.isArray(background["scripts"])).toBe(true);
    expect(background["service_worker"]).toBeUndefined();
  });
});
