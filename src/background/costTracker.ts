/**
 * Usage & cost accounting (F17, Architecture §5). Tallies provider requests,
 * images, and token counts, and estimates dollar cost so the popup/options can
 * show users real numbers before a "translate all" surprises them.
 *
 * Split as usual:
 *  - a PURE core — the pricing table, per-request cost estimation, and the
 *    accumulator ({@link addUsage}) — unit-tested with no browser;
 *  - a THIN persistence layer over `storage.local` ({@link recordUsage} /
 *    {@link getCostStats} / {@link resetCostStats}), testable via fake-browser
 *    exactly like settings. Totals live in `storage.local` (never `sync`,
 *    consistent with §7.6) so they survive event-page unloads.
 *
 * PRICING IS BALLPARK. Architecture §3/§6.2 is explicit that pricing must be
 * verified at build time; these are order-of-magnitude USD-per-million-token
 * figures for the cheap vision tiers, used only for a rough estimate. Wrong
 * numbers make the estimate wrong, never break translation.
 */
import browser from "webextension-polyfill";
import { createLogger } from "../shared/log";
import type { PageTranslation, ProviderId } from "../shared/types";

const log = createLogger("cost");

/** storage.local key holding the cumulative cost stats. */
export const COST_KEY = "mangalens:cost";

/** USD per 1,000,000 tokens, input/output, for a provider's cheap-tier model. */
export interface TokenPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
}

/**
 * Ballpark cheap-tier pricing per provider (USD / 1M tokens). Custom + OpenRouter
 * vary by the underlying model, so they use a neutral middle estimate. VERIFY AT
 * BUILD TIME (Architecture §3) — bump these when provider pricing moves.
 */
export const PRICING: Record<ProviderId, TokenPricing> = {
  gemini: { inputPerMTokens: 0.1, outputPerMTokens: 0.4 },
  anthropic: { inputPerMTokens: 1.0, outputPerMTokens: 5.0 },
  openai: { inputPerMTokens: 0.15, outputPerMTokens: 0.6 },
  openrouter: { inputPerMTokens: 0.5, outputPerMTokens: 1.5 },
  custom: { inputPerMTokens: 0.5, outputPerMTokens: 1.5 },
};

/** One usage event to fold into the running totals (typically one page). */
export interface UsageEntry {
  provider: ProviderId;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Provider image calls represented (a tiled webtoon page is > 1). */
  images: number;
}

/** Per-provider running totals. */
export interface ProviderCostStats {
  /** Number of usage events (≈ pages) recorded — one per {@link recordUsage} call. */
  calls: number;
  /** Provider image requests represented; a tiled webtoon page contributes > 1,
   *  so this — not {@link calls} — is the count that tracks cost for strips. */
  images: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
}

/** The complete persisted cost record. */
export interface CostStats {
  byProvider: Partial<Record<ProviderId, ProviderCostStats>>;
  totalEstCostUsd: number;
  /** Epoch ms of the last update, 0 when never recorded. */
  updatedAt: number;
}

// --- Pure core (unit-tested, browser-free) ---------------------------------

/** A zeroed {@link CostStats} — the default before anything is recorded. */
export function emptyCostStats(): CostStats {
  return { byProvider: {}, totalEstCostUsd: 0, updatedAt: 0 };
}

/**
 * Estimate the USD cost of one usage event from {@link PRICING}. Linear in token
 * counts; missing/negative counts are treated as 0.
 *
 * @param entry the usage to price.
 * @returns estimated dollars (a small float).
 */
export function estimateRequestCost(entry: UsageEntry): number {
  const price = PRICING[entry.provider];
  const tin = Math.max(0, entry.tokensIn);
  const tout = Math.max(0, entry.tokensOut);
  return (
    (tin / 1_000_000) * price.inputPerMTokens +
    (tout / 1_000_000) * price.outputPerMTokens
  );
}

/**
 * Fold a usage event into the totals, returning a NEW {@link CostStats} (pure —
 * the input is not mutated). Unknown providers still tally; their cost uses the
 * table entry for that id.
 *
 * @param stats current totals.
 * @param entry the event to add.
 * @param now epoch ms to stamp as `updatedAt` (injectable for tests).
 */
export function addUsage(
  stats: CostStats,
  entry: UsageEntry,
  now: number = Date.now(),
): CostStats {
  const cost = estimateRequestCost(entry);
  const prev =
    stats.byProvider[entry.provider] ??
    ({ calls: 0, images: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0 } satisfies ProviderCostStats);

  const nextProvider: ProviderCostStats = {
    calls: prev.calls + 1,
    images: prev.images + Math.max(0, entry.images),
    tokensIn: prev.tokensIn + Math.max(0, entry.tokensIn),
    tokensOut: prev.tokensOut + Math.max(0, entry.tokensOut),
    estCostUsd: prev.estCostUsd + cost,
  };

  return {
    byProvider: { ...stats.byProvider, [entry.provider]: nextProvider },
    totalEstCostUsd: stats.totalEstCostUsd + cost,
    updatedAt: now,
  };
}

/**
 * Build a {@link UsageEntry} from a completed {@link PageTranslation}. Absent
 * token counts (a provider that didn't report usage) count as 0.
 *
 * @param page the translated page.
 * @param images provider image calls the page represents (default 1).
 */
export function usageFromPage(page: PageTranslation, images = 1): UsageEntry {
  return {
    provider: page.provider,
    model: page.model,
    tokensIn: page.tokensIn ?? 0,
    tokensOut: page.tokensOut ?? 0,
    images,
  };
}

// --- Persistence (thin, fail-soft) -----------------------------------------

/** True for an object that looks like a stored {@link CostStats}. */
function isCostStats(value: unknown): value is CostStats {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CostStats).totalEstCostUsd === "number" &&
    typeof (value as CostStats).byProvider === "object"
  );
}

/** Load the persisted totals, or a zeroed record when none/corrupt. Fail-soft. */
export async function getCostStats(): Promise<CostStats> {
  try {
    const raw = (await browser.storage.local.get(COST_KEY))[COST_KEY];
    return isCostStats(raw) ? raw : emptyCostStats();
  } catch (err) {
    log.warn("getCostStats failed", err);
    return emptyCostStats();
  }
}

/**
 * Serializes every cost WRITE (item 1). Default concurrency is 6, so two
 * translations routinely finish near-simultaneously; an un-serialized
 * read-modify-write would let both read the same totals and one page's tokens
 * vanish (a lost update). Each write appends a link here and awaits its own, so
 * they run strictly one at a time. WHY the `.catch` on the tail: a failed link
 * must never reject the chain and block every later write — the per-link
 * try/catch keeps the result fail-soft, and this keeps the *chain* alive.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/** Append `run` to the serialized write chain and return its own result. */
function enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
  const link = writeChain.then(run);
  writeChain = link.catch(() => undefined);
  return link;
}

/**
 * Record one usage event: load totals, fold it in, persist, and return the new
 * totals. Serialized against other writes (see {@link writeChain}) so concurrent
 * completions never lose an update. Fail-soft — a storage error logs and returns
 * best-effort totals so a cost-tracking hiccup never fails a translation.
 *
 * @param entry the usage to record.
 */
export async function recordUsage(entry: UsageEntry): Promise<CostStats> {
  return enqueueWrite(async () => {
    try {
      const current = await getCostStats();
      const next = addUsage(current, entry);
      await browser.storage.local.set({ [COST_KEY]: next });
      return next;
    } catch (err) {
      log.warn("recordUsage failed", err);
      return getCostStats();
    }
  });
}

/** Reset all cost stats to zero (options page "reset usage"). Serialized with
 *  {@link recordUsage} so a reset can't interleave with an in-flight add. Fail-soft. */
export async function resetCostStats(): Promise<CostStats> {
  return enqueueWrite(async () => {
    const zero = emptyCostStats();
    try {
      await browser.storage.local.set({ [COST_KEY]: zero });
    } catch (err) {
      log.warn("resetCostStats failed", err);
    }
    return zero;
  });
}
