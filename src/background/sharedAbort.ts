/**
 * Shared abort refcounting for coalesced translations (Phase 5, item 4).
 *
 * When several `translatePage` requests coalesce onto ONE underlying provider
 * run (F13 "never translate the same image twice"), each request brings its own
 * cancellation signal (the content side cancels on teardown / element removal).
 * The underlying run must keep going as long as *any* waiter still wants the
 * result, and abort only once *every* waiter has left — otherwise one cancelled
 * tab would cancel work another tab is still waiting on.
 *
 * This is the pure counterpart to {@link import("./coalesce").coalesce}: coalesce
 * shares the promise, this shares the abort. Browser-free (only AbortController /
 * AbortSignal, present in the event page and the Node test runtime) so the
 * refcount logic is unit-tested directly.
 *
 * Rule: the underlying controller aborts iff the number of *live* waiters drops
 * to zero. A waiter is live until its signal aborts; a waiter registered with no
 * signal is permanently live (it keeps the run alive forever). Registration
 * after the run has settled is a no-op.
 */

/** A no-op unregister handle. */
const NOOP = (): void => {};

/**
 * A shared abort context for one coalesced run. Hand {@link signal} to the
 * underlying provider call; call {@link addWaiter} once per coalesced caller.
 */
export interface SharedAbort {
  /** The signal to pass to the underlying provider run. */
  readonly signal: AbortSignal;
  /**
   * Register a coalesced caller's external abort signal. The returned function
   * detaches the listener (call it when the caller's await settles, to avoid
   * leaking listeners on long-lived signals) — it does NOT count as leaving, so
   * cleaning up after a resolved run never triggers an abort.
   *
   * @param signal the caller's abort signal, or `undefined` for a waiter that
   *   never aborts (keeps the run alive).
   * @returns a detach handle; idempotent.
   */
  addWaiter(signal?: AbortSignal): () => void;
  /**
   * Mark the run settled: further {@link addWaiter} calls become no-ops and the
   * refcount can no longer trigger an abort. Called by the run's owner once the
   * coalesced promise resolves or rejects.
   */
  settle(): void;
}

/**
 * Create a {@link SharedAbort}. The underlying {@link SharedAbort.signal} starts
 * un-aborted and aborts only when every live waiter has aborted.
 */
export function createSharedAbort(): SharedAbort {
  const controller = new AbortController();
  let liveCount = 0;
  let settled = false;

  const maybeAbort = (): void => {
    // Only abort on the >0 → 0 transition, and never after settle. WHY guard on
    // settled: a settled run is already done; aborting its (dead) controller is
    // pointless and could surface a spurious abort to a late observer.
    if (!settled && liveCount === 0 && !controller.signal.aborted) {
      controller.abort(new DOMException("All waiters aborted", "AbortError"));
    }
  };

  return {
    signal: controller.signal,

    addWaiter(signal?: AbortSignal): () => void {
      if (settled || controller.signal.aborted) return NOOP;

      // No signal → permanently live: increment and never decrement, so the run
      // can never abort while this waiter is registered.
      if (!signal) {
        liveCount++;
        return NOOP;
      }

      // Already aborted → it contributes nothing; if it's the only waiter this
      // drops the live count straight back to zero and aborts the run.
      if (signal.aborted) {
        // Was counted as a (transient) waiter then immediately left.
        maybeAbort();
        return NOOP;
      }

      liveCount++;
      let left = false;
      const onAbort = (): void => {
        if (left) return;
        left = true;
        liveCount--;
        maybeAbort();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // Detach only — does NOT decrement the live count, so tearing down after a
      // successful run never trips maybeAbort.
      return () => signal.removeEventListener("abort", onAbort);
    },

    settle(): void {
      settled = true;
    },
  };
}
