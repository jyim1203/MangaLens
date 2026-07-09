/**
 * Tiny dependency-free runtime type guards shared across modules. Kept in
 * their own file (not settings.ts/log.ts) so importing a guard never drags a
 * browser polyfill or logger into the importer's module graph.
 */

/** True for a non-null, non-array plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True if `err` is (or wraps) an abort — either a DOMException or a named object. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return (err as { name?: unknown } | null)?.name === "AbortError";
}
