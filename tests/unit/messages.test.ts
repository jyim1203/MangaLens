import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import type { Runtime } from "webextension-polyfill";

vi.mock("webextension-polyfill", () => ({ default: fakeBrowser }));

import {
  createMessageRouter,
  isEnvelope,
  sendToBackground,
} from "../../src/shared/messages";

describe("shared/messages — isEnvelope", () => {
  it("accepts objects with a string type and rejects everything else (edge: guards)", () => {
    expect(isEnvelope({ type: "ping" })).toBe(true);
    expect(isEnvelope({ type: "ping", payload: { a: 1 } })).toBe(true);
    expect(isEnvelope({ notType: "ping" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope("ping")).toBe(false);
    expect(isEnvelope(42)).toBe(false);
  });
});

describe("shared/messages — router + sendToBackground round-trip", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a typed message to its handler and returns the response (happy path)", async () => {
    const router = createMessageRouter({
      ping: () => ({ ok: true }),
    });
    fakeBrowser.runtime.onMessage.addListener(router);

    const reply = await sendToBackground("ping");
    expect(reply).toEqual({ ok: true });
  });

  it("passes the request payload through to the handler (edge: payload delivery)", async () => {
    const seen: unknown[] = [];
    const router = createMessageRouter({
      setSettings: (payload) => {
        seen.push(payload);
        // Echo a minimal settings-shaped response; the handler contract only
        // needs the type to line up, not a full object for this test.
        return { ...(payload as object), schemaVersion: 1 } as never;
      },
    });
    fakeBrowser.runtime.onMessage.addListener(router);

    await sendToBackground("setSettings", { enabled: true });
    expect(seen).toEqual([{ enabled: true }]);
  });

  it("ignores messages it has no handler for, so other listeners can reply (edge: co-existing routers)", async () => {
    const handled: string[] = [];
    // Router A only knows ping; Router B only knows toggleEnabled.
    fakeBrowser.runtime.onMessage.addListener(
      createMessageRouter({
        ping: () => {
          handled.push("A:ping");
          return { ok: true };
        },
      }),
    );
    fakeBrowser.runtime.onMessage.addListener(
      createMessageRouter({
        toggleEnabled: () => {
          handled.push("B:toggle");
          return { schemaVersion: 1 } as never;
        },
      }),
    );

    await sendToBackground("ping");
    await sendToBackground("toggleEnabled");
    expect(handled).toEqual(["A:ping", "B:toggle"]);
  });

  it("rejects the sender's promise when a handler throws (edge: error propagation)", async () => {
    // The router logs a warning on handler failure; silence it for clean output.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const router = createMessageRouter({
      ping: () => {
        throw new Error("boom");
      },
    });
    fakeBrowser.runtime.onMessage.addListener(router);

    await expect(sendToBackground("ping")).rejects.toThrow("boom");
  });

  it("returns undefined for non-envelope input, leaving it unhandled (edge: foreign messages)", () => {
    const router = createMessageRouter({ ping: () => ({ ok: true }) });
    const sender = {} as Runtime.MessageSender;
    expect(router("not-an-envelope", sender)).toBeUndefined();
    expect(router({ noType: 1 }, sender)).toBeUndefined();
  });
});
