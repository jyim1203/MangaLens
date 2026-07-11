/**
 * Wrap a promise so it rejects if it hasn't settled within `ms` (gap #8). Used by
 * both the viewport queue and the region-select controller (Phase 7): the
 * background event page is NOT persistent, so a request whose event page died
 * mid-flight might never settle — the timeout returns control so the caller can
 * reset and retry.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message = `request timed out after ${ms} ms`,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
