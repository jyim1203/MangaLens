/**
 * In-flight request coalescing (Phase 4.1 item 7). A tiny, browser-free helper
 * so that concurrent callers asking for the *same* key while a call is pending
 * share one execution and one result — instead of each paying the (expensive)
 * work independently.
 *
 * Used by the translate path to guarantee F13's "never translate the same image
 * twice" even for requests that arrive before the first finishes (scanner +
 * prefetch overlap, duplicate scroll events, two tabs on one chapter) — the
 * cache only helps once a result is stored.
 *
 * Pure and generic: the caller owns the `Map`, so its lifetime/reset is its
 * concern and this stays trivially unit-testable.
 */

/**
 * Run `fn` at most once per `key` while an invocation is in flight. Concurrent
 * callers with the same key receive the same pending promise; the entry is
 * removed once it settles (success OR rejection), so a later call re-runs `fn`.
 *
 * @param inflight caller-owned map of key → pending result.
 * @param key identity to coalesce on.
 * @param fn the work to run when no call for `key` is already pending.
 * @returns the shared promise for `key`.
 */
export function coalesce<K, V>(
  inflight: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
): Promise<V> {
  const existing = inflight.get(key);
  if (existing) return existing;

  let started: Promise<V>;
  try {
    started = fn();
  } catch (err) {
    // A synchronous throw never entered the map; nothing to clean up.
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  // WHY finally-then-set ordering is safe: `finally`'s callback only runs on a
  // later microtask (after settle), while `set` runs synchronously here — so a
  // second caller in the same tick always sees the entry before it is removed.
  const tracked = started.finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}
