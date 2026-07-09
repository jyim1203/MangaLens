import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  getLogLevel,
  isLevelEnabled,
  setLogLevel,
} from "../../src/shared/log";

describe("shared/log", () => {
  afterEach(() => {
    setLogLevel("debug");
    vi.restoreAllMocks();
  });

  it("emits messages at or above the current threshold (happy path)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    createLogger("test").warn("something", 42);
    expect(warnSpy).toHaveBeenCalledOnce();
    const call = warnSpy.mock.calls[0];
    expect(call?.[0]).toContain("MangaLens:test");
    expect(call?.[1]).toBe("something");
  });

  it("suppresses messages below the threshold (edge: filtering)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setLogLevel("error");
    createLogger("test").debug("hidden");
    expect(logSpy).not.toHaveBeenCalled();
    expect(isLevelEnabled("debug")).toBe(false);
    expect(isLevelEnabled("error")).toBe(true);
  });

  it("setLogLevel round-trips (edge: threshold changes at runtime)", () => {
    setLogLevel("info");
    expect(getLogLevel()).toBe("info");
    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
  });
});
