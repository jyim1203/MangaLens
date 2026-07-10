import { describe, expect, it } from "vitest";

// coalesce is a pure, browser-free helper (no polyfill import) — tested directly.
import { coalesce } from "../../src/background/coalesce";

describe("coalesce", () => {
  it("shares one execution for concurrent same-key calls", async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    let resolve!: (n: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => {
        resolve = r;
      });
    };

    const p1 = coalesce(map, "k", fn);
    const p2 = coalesce(map, "k", fn);

    // Second caller coalesced onto the first: fn ran once, same pending promise.
    expect(calls).toBe(1);
    expect(p2).toBe(p1);
    expect(map.size).toBe(1);

    resolve(42);
    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
    // Cleaned up once settled so a later call re-runs.
    expect(map.size).toBe(0);
  });

  it("cleans up on rejection and lets a later call retry", async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error("boom"));
    };

    await expect(coalesce(map, "k", fn)).rejects.toThrow("boom");
    expect(map.size).toBe(0);

    // Not coalesced onto the settled (rejected) promise — fn runs again.
    await expect(coalesce(map, "k", fn)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  it("runs different keys independently", async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(calls);
    };

    const a = coalesce(map, "a", fn);
    const b = coalesce(map, "b", fn);
    expect(calls).toBe(2);
    await Promise.all([a, b]);
    expect(map.size).toBe(0);
  });

  it("does not leave a map entry when fn throws synchronously", async () => {
    const map = new Map<string, Promise<number>>();
    const fn = (): Promise<number> => {
      throw new Error("sync boom");
    };
    await expect(coalesce(map, "k", fn)).rejects.toThrow("sync boom");
    expect(map.size).toBe(0);
  });
});
