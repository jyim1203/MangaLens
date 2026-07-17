import { describe, expect, it } from "vitest";
import manifest from "../../src/manifest";

/** Narrow into the gecko settings block. */
function gecko(): Record<string, unknown> {
  const bss = manifest.browser_specific_settings as { gecko: Record<string, unknown> };
  return bss.gecko;
}

describe("manifest — data_collection_permissions (§8 AMO)", () => {
  it("declares required collection of website content and nothing else", () => {
    const dcp = gecko().data_collection_permissions as {
      required: string[];
      optional?: string[];
    };
    expect(dcp).toBeDefined();
    // The HONEST declaration: page images → the user's chosen provider only.
    expect(dcp.required).toEqual(["websiteContent"]);
    // No analytics/telemetry → no other required or optional categories.
    expect(dcp.optional ?? []).toEqual([]);
  });

  it("keeps the Firefox event-page shape + minimum version (no bump for §8)", () => {
    expect(manifest.manifest_version).toBe(3);
    expect((manifest.background as { scripts: string[] }).scripts).toContain(
      "src/background/index.ts",
    );
    expect(gecko().strict_min_version).toBe("128.0");
  });

  it("uses localized name/description + keeps permissions minimal", () => {
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.description).toBe("__MSG_extensionDescription__");
    expect(manifest.permissions).toEqual(["storage", "activeTab"]);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
  });
});
