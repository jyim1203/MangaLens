import { describe, expect, it } from "vitest";
import {
  RATE_GATE_BASE_MS,
  RATE_GATE_MAX_MS,
  clearRateLimit,
  createRateGate,
  emptyRateGateState,
  reportRateLimit,
  waitMsFor,
  type RateGateState,
} from "../../src/background/rateGate";

describe("rateGate — pure ladder", () => {
  it("escalates 8s → 16s → 32s → 60s cap on consecutive reports", () => {
    let state = emptyRateGateState();
    const cooldowns: number[] = [];
    for (let i = 0; i < 5; i++) {
      state = reportRateLimit(state, 0);
      cooldowns.push(state.untilMs); // now=0, so untilMs === cooldown
    }
    expect(cooldowns).toEqual([8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(RATE_GATE_BASE_MS).toBe(8_000);
    expect(RATE_GATE_MAX_MS).toBe(60_000);
  });

  it("honors retry-after when it exceeds the ladder rung, still capped at 60s", () => {
    const state = emptyRateGateState();
    // First rung is 8s; a 20s retry-after wins.
    expect(reportRateLimit(state, 0, 20_000).untilMs).toBe(20_000);
    // A 90s retry-after is capped to 60s.
    expect(reportRateLimit(state, 0, 90_000).untilMs).toBe(60_000);
    // A tiny retry-after loses to the ladder rung.
    expect(reportRateLimit(state, 0, 1_000).untilMs).toBe(8_000);
  });

  it("never collapses to 0 after many consecutive strikes (no 32-bit shift wrap)", () => {
    let state: RateGateState = emptyRateGateState();
    for (let i = 0; i < 40; i++) state = reportRateLimit(state, 0);
    expect(reportRateLimit(state, 0).untilMs).toBe(60_000);
  });

  it("success resets strikes and clears the cooldown", () => {
    let state = reportRateLimit(reportRateLimit(emptyRateGateState(), 0), 0);
    expect(state.strikes).toBe(2);
    state = clearRateLimit();
    expect(state).toEqual({ untilMs: 0, strikes: 0 });
    // A report after a clear starts back at the first rung.
    expect(reportRateLimit(state, 0).untilMs).toBe(8_000);
  });

  it("waitMsFor is the remaining time, clamped to zero", () => {
    expect(waitMsFor({ untilMs: 5_000, strikes: 1 }, 2_000)).toBe(3_000);
    expect(waitMsFor({ untilMs: 5_000, strikes: 1 }, 9_000)).toBe(0);
    expect(waitMsFor(emptyRateGateState(), 0)).toBe(0);
  });
});

describe("rateGate — wrapper (injected sleep + clock)", () => {
  /** A gate driven by a manual clock; sleep advances it and returns instantly. */
  function fakeGate() {
    let clock = 0;
    const sleeps: number[] = [];
    const gate = createRateGate(
      (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      () => clock,
    );
    return { gate, sleeps, now: () => clock };
  }

  it("returns immediately when there is no cooldown", async () => {
    const { gate, sleeps } = fakeGate();
    await gate.waitUntilClear();
    expect(sleeps).toEqual([]);
  });

  it("waits out a cooldown then releases (concurrent waiters all release)", async () => {
    const { gate, now } = fakeGate();
    gate.report(); // untilMs = 8000 at clock 0
    await Promise.all([gate.waitUntilClear(), gate.waitUntilClear()]);
    expect(now()).toBeGreaterThanOrEqual(8_000);
    // Both resolved (no throw); a further wait is now a no-op.
    const before = now();
    await gate.waitUntilClear();
    expect(now()).toBe(before);
  });

  it("a report landing mid-wait extends the wait", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    let extendOnce = true;
    const gate = createRateGate(
      (ms) => {
        sleeps.push(ms);
        clock += ms;
        // Simulate a second job hitting a 429 while we sleep the first cooldown.
        if (extendOnce) {
          extendOnce = false;
          gate.report();
        }
        return Promise.resolve();
      },
      () => clock,
    );
    gate.report(); // untilMs = 8000 (clock 0)
    await gate.waitUntilClear();
    // First sleep of 8000 advanced clock to 8000 AND reported again (rung 2 →
    // 16000), so untilMs became 8000 + 16000 = 24000; a second sleep covers it.
    expect(sleeps).toEqual([8_000, 16_000]);
    expect(clock).toBe(24_000);
  });

  it("rejects with a typed abort when the signal fires mid-wait", async () => {
    // Real sleep so the abort races the timer; abort immediately.
    const gate = createRateGate();
    gate.report(); // 8s cooldown with the real clock
    const controller = new AbortController();
    const p = gate.waitUntilClear(controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
