/**
 * Display formatters shared by the popup and options pages (Phase 6).
 * Pure, dependency-free, unit-tested.
 */

/**
 * Format an estimated dollar amount. Sub-cent totals keep 4 decimals so early
 * usage doesn't render as a flat "$0.00" and look broken; anything bigger uses
 * normal currency precision. Non-finite/negative input heals to "$0.00".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** "512 B" / "3.4 KB" / "12.1 MB" for the cache panel. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact token count: 999 → "999", 12_345 → "12.3k", 4_200_000 → "4.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
