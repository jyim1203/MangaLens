/**
 * Global rate-limit cooldown (Phase 7.2 item 3 — the 429-storm brake).
 *
 * `ProviderBase` already backs off PER JOB (its 2s/8s/30s ladder, honoring
 * `retry-after`), but at concurrency 6 every queued job discovers a globally
 * exhausted key independently — the live test logged 40+ consecutive 429s. This
 * is ONE shared brake above the per-job ladder: when any job sees a rate-limit,
 * the whole pipeline waits out a cooldown before the next HTTP request fires.
 * The two layers are intentional — the ladder handles transient per-request
 * limits and `retry-after`; the gate stops NEW cross-job requests when the key
 * is exhausted.
 *
 * Split per the pure-core / thin-shell rule:
 *  - PURE, unit-tested: the cooldown ladder ({@link reportRateLimit},
 *    {@link clearRateLimit}, {@link waitMsFor}) over an immutable
 *    {@link RateGateState}.
 *  - THIN stateful wrapper: {@link createRateGate} — holds the state and an
 *    abortable {@link RateGate.waitUntilClear} (its `sleep`/`now` seams injected
 *    so it is testable without real waits or a real clock).
 */

/** The gate's cooldown memory. `untilMs` is on the same clock as `now`. */
export interface RateGateState {
  /** Timestamp (ms) until which new requests must wait; 0 = clear. */
  untilMs: number;
  /** Consecutive rate-limit reports since the last success — the ladder rung. */
  strikes: number;
}

/**
 * Base cooldown; each consecutive strike doubles it (8s → 16s → 32s → capped),
 * so a persistently-exhausted key paces the pipeline out to the cap.
 */
export const RATE_GATE_BASE_MS = 8_000;

/** Cap on the cooldown; a hostile/large `retry-after` also can't exceed it. */
export const RATE_GATE_MAX_MS = 60_000;

/** The zero (clear) state. */
export function emptyRateGateState(): RateGateState {
  return { untilMs: 0, strikes: 0 };
}

/**
 * Fold a rate-limit report into the cooldown state (pure). The new cooldown is
 * `min(MAX, max(retryAfterMs ?? 0, BASE << strikes))`: a server-sent
 * `retry-after` wins when larger, the exponential ladder otherwise, and both are
 * capped at {@link RATE_GATE_MAX_MS}. `strikes` increments so consecutive reports
 * escalate.
 *
 * @param state current cooldown state.
 * @param now current timestamp (ms), same clock as {@link RateGateState.untilMs}.
 * @param retryAfterMs optional server-sent hint (from the ProviderError).
 */
export function reportRateLimit(
  state: RateGateState,
  now: number,
  retryAfterMs?: number,
): RateGateState {
  // WHY 2 ** min(strikes, cap) rather than `BASE << strikes`: the left shift is
  // 32-bit and would wrap negative after ~19 consecutive strikes, collapsing the
  // cooldown to 0 exactly when the key is most exhausted. The exponent saturates
  // at the cap long before that; clamping the exponent keeps it well-defined.
  const laddered = RATE_GATE_BASE_MS * 2 ** Math.min(state.strikes, 10);
  const cooldown = Math.min(RATE_GATE_MAX_MS, Math.max(retryAfterMs ?? 0, laddered));
  return { untilMs: now + cooldown, strikes: state.strikes + 1 };
}

/** Reset to clear on any success (pure). */
export function clearRateLimit(): RateGateState {
  return emptyRateGateState();
}

/** How long (ms) a caller must still wait given the state and current time (pure). */
export function waitMsFor(state: RateGateState, now: number): number {
  return Math.max(0, state.untilMs - now);
}

/** A live global rate gate (one module-level instance in the background). */
export interface RateGate {
  /**
   * Resolve once no cooldown is active. Re-checks after each sleep so a report
   * landing mid-wait extends it. Rejects promptly with a typed abort if `signal`
   * fires during a wait.
   */
  waitUntilClear(signal?: AbortSignal): Promise<void>;
  /** Report a rate-limit (extends/starts the cooldown; `retryAfterMs` from the error). */
  report(retryAfterMs?: number): void;
  /** Clear the cooldown on a successful request. */
  clear(): void;
}

/** A sleep that rejects promptly on abort with a DOMException `AbortError`. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Rate-gate wait aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Rate-gate wait aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Build the global rate gate. The `sleep`/`now` seams are injected so the
 * wrapper is unit-testable without real waits or a real clock.
 *
 * @param sleep resolves after `ms` (rejects on abort); defaults to a real timer.
 * @param now current timestamp; defaults to `Date.now`.
 */
export function createRateGate(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  now: () => number = () => Date.now(),
): RateGate {
  let state = emptyRateGateState();
  return {
    async waitUntilClear(signal?: AbortSignal): Promise<void> {
      // Loop, not a single sleep: a report() landing while we sleep pushes
      // `untilMs` out, and the re-check picks that up so the whole pipeline
      // self-paces to the provider's rate.
      for (;;) {
        const waitMs = waitMsFor(state, now());
        if (waitMs <= 0) return;
        await sleep(waitMs, signal);
      }
    },
    report(retryAfterMs?: number): void {
      state = reportRateLimit(state, now(), retryAfterMs);
    },
    clear(): void {
      state = clearRateLimit();
    },
  };
}
