import { EXTENSION_NAME } from "./constants";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// WHY: import.meta.env is provided by Vite at build time; in Vitest (node env)
// it also exists. Default threshold is "warn" in production builds so we never
// spam the console of host pages, "debug" otherwise.
const DEFAULT_LEVEL: LogLevel = import.meta.env?.PROD ? "warn" : "debug";

let currentLevel: LogLevel = DEFAULT_LEVEL;

/** Override the log threshold (used by a hidden debug setting later). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Current threshold — exported for tests. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** True if a message at `level` would be emitted at the current threshold. */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (!isLevelEnabled(level)) return;
  const prefix = `[${EXTENSION_NAME}:${scope}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, ...args);
}

/**
 * Create a scoped logger, e.g. `const log = createLogger("scanner")`.
 * Scope shows up in every line so host-page noise is easy to filter.
 */
export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit("debug", scope, args),
    info: (...args: unknown[]) => emit("info", scope, args),
    warn: (...args: unknown[]) => emit("warn", scope, args),
    error: (...args: unknown[]) => emit("error", scope, args),
  };
}
