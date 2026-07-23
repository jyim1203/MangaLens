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

  it("pins PROMPT_VERSION at 3 (Phase 9.5 whole-balloon bbox rule)", () => {
    // Phase 9.5 §1 rewrote the bbox rule to box speech/thought bubbles as the
    // WHOLE balloon (not the tight text strip), so the version bumped 2 → 3 to
    // re-translate every cached p2 page once on next view (the accepted paid cost).
    expect(PROMPT_VERSION).toBe(3);
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
