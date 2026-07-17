/**
 * Multi-page batching (F12, PROMPTS §4.2) — the grouping + flush + split-retry
 * decisions and a thin timer-driven collector that assembles eligible
 * priority-2 cache-miss jobs into one provider request.
 *
 * Split per the pure-core / thin-shell rule:
 *  - PURE, unit-tested: {@link batchEligible}, {@link clampBatchSize},
 *    {@link batchSignature}, {@link planFlush}, {@link classifyBatchFailure}.
 *  - THIN shell: {@link createBatchCollector} — the module-level accumulator with
 *    a linger timer. It owns NO translation logic; the group executor is injected
 *    by {@link import("./translateHandlers")}, so this file has no dependency on
 *    the browser-only prep/provider/cache path and stays testable.
 *
 * WHY only priority-2 jobs batch (visible/near never do): a visible page must
 * never wait for batch-mates. WHY the SAME cache key for batch vs single: a batch
 * is a delivery mechanism, not a quality-affecting setting — folding it into the
 * key would halve cache hits for zero user benefit.
 */
import type { ProviderSettings } from "../shared/types";
import { resolveEffectiveModel } from "./providers/factory";
import { BatchLengthError, ProviderError } from "./providers/ProviderBase";

/**
 * Minimum priority that batches. Visible (0) and near-viewport (1) jobs always go
 * solo; only prefetch / translate-all (2) group. Higher number = lower urgency,
 * so `priority >= BATCH_MIN_PRIORITY` is "prefetch tier or below".
 */
export const BATCH_MIN_PRIORITY = 2;

/** Hard cap on images per batch request (PROMPTS §4.2: "pages per request" 2–4). */
export const MAX_BATCH_SIZE = 4;

/**
 * Linger window (ms) a not-yet-full group waits for more members before flushing.
 * WHY ~300 ms: a translate-all burst enqueues its misses within a few ms, so they
 * group; a lone prefetch page pays at most this before going out (§4.2 batching
 * is opt-in, and a small linger keeps a solitary prefetch from stalling).
 */
export const BATCH_LINGER_MS = 300;

/**
 * Clamp the user's `pagesPerRequest` to the valid batch size [1, 4]. A value of 1
 * (the shipped default) means batching is OFF. Non-finite / <1 heals to 1.
 */
export function clampBatchSize(pagesPerRequest: number): number {
  if (!Number.isFinite(pagesPerRequest)) return 1;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(pagesPerRequest)));
}

/**
 * Whether a cache-miss job is eligible to batch: it must be a prefetch/all-tier
 * job (priority ≥ 2) AND batching must be enabled (`pagesPerRequest` ≥ 2). A
 * value of 1 keeps every job solo — batching stays opt-in.
 */
export function batchEligible(priority: number, pagesPerRequest: number): boolean {
  return priority >= BATCH_MIN_PRIORITY && clampBatchSize(pagesPerRequest) >= 2;
}

/**
 * A stable signature over the request-shaping settings: two members with
 * DIFFERENT signatures must NEVER mix into one batch (a mid-flight settings
 * change must not blend prompts, models, or endpoints). Includes everything that
 * changes the request/prompt bytes or the prepped image: provider, resolved
 * model, endpoint, target language, source hint, honorifics, reading direction,
 * and the two prep dimensions. Temperature is excluded (a continuous sampling
 * knob that doesn't change the prompt, mirroring its exclusion from the cache key).
 */
export function batchSignature(
  settings: ProviderSettings,
  prep: { maxEdgePx: number; jpegQuality: number },
): string {
  return [
    settings.provider,
    resolveEffectiveModel(settings),
    settings.customEndpoint ?? "",
    settings.targetLang,
    settings.sourceLangHint ?? "",
    settings.preserveHonorifics ? "h1" : "h0",
    settings.readingDirection,
    String(prep.maxEdgePx),
    String(prep.jpegQuality),
  ]
    .map(encodeURIComponent)
    .join("|");
}

/** Why a group flushed (diagnostics / tests). */
export interface FlushDecision {
  flush: boolean;
  reason?: "size" | "linger";
}

/**
 * Decide whether an open group should flush now: at `batchSize` members (size
 * trigger) or once the linger window has elapsed with at least one member
 * (linger trigger). Pure — the collector shell owns the actual timer.
 */
export function planFlush(
  memberCount: number,
  batchSize: number,
  elapsedMs: number,
  lingerMs: number,
): FlushDecision {
  if (memberCount >= batchSize) return { flush: true, reason: "size" };
  if (memberCount > 0 && elapsedMs >= lingerMs) return { flush: true, reason: "linger" };
  return { flush: false };
}

/** Failure ladder verdict for a batch provider call (PROMPTS §4.2 guardrails). */
export type BatchFailureAction = "split" | "fail-all";

/**
 * Classify a `translateBatch` failure into split-retry vs fail-every-member:
 *  - {@link BatchLengthError} (`pages.length !== n`) → split (retry each solo).
 *  - `malformed` (still malformed after the one whole-batch repair) → split.
 *  - `refusal` (the batch was declined) → split — one bad image must not damn its
 *    batch-mates; the guilty single then negative-caches on its own.
 *  - `auth` / `rate-limit` / `network` / `aborted` / `unknown` → fail-all: a split
 *    would just repeat the same error N times (rate-limit already backed off).
 *
 * Pure and total (an unexpected non-Error → fail-all).
 */
export function classifyBatchFailure(err: unknown): BatchFailureAction {
  if (err instanceof BatchLengthError) return "split";
  if (err instanceof ProviderError) {
    return err.kind === "malformed" || err.kind === "refusal" ? "split" : "fail-all";
  }
  return "fail-all";
}

// --- Thin collector shell ---------------------------------------------------

/** One accumulated batch member: its opaque payload plus a promise to settle. */
export interface BatchJob<T, R> {
  payload: T;
  resolve: (value: R) => void;
  reject: (err: unknown) => void;
}

/** Timer seam so tests can drive the linger flush deterministically. */
export interface BatchCollectorTimers {
  /** Schedule `fn` after `ms`; returns a handle for {@link cancel}. */
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Cancel a scheduled handle. */
  cancel: (handle: ReturnType<typeof setTimeout>) => void;
  /** Current time (ms). */
  now: () => number;
}

const REAL_TIMERS: BatchCollectorTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle),
  now: () => Date.now(),
};

/** Config for {@link createBatchCollector}. */
export interface BatchCollectorConfig<T, R> {
  /** Linger window (ms) before a partial group flushes. */
  lingerMs: number;
  /**
   * Execute one flushed group. The collector invokes this fire-and-forget the
   * moment a group flushes; the executor is responsible for settling EVERY job's
   * promise (resolve on success, reject on failure). Must not throw.
   */
  runGroup: (jobs: BatchJob<T, R>[]) => void;
  /** Timer seam (defaults to real setTimeout/Date.now). */
  timers?: BatchCollectorTimers;
}

/** A live batch collector. */
export interface BatchCollector<T, R> {
  /**
   * Submit one eligible member. It joins the open group for `signature` (members
   * with different signatures never mix), and the group flushes at `batchSize`
   * members or after the linger window. Returns the promise the group executor
   * settles for this member.
   */
  submit(signature: string, batchSize: number, payload: T): Promise<R>;
  /**
   * Pull the first still-buffered member whose payload matches `match` out of its
   * open group, returning its {@link BatchJob} (so the caller can run it solo and
   * settle its promise) — Phase 8 §2 re-prioritization "pull it out". Returns
   * `undefined` when no open group holds a match (already flushed / never here).
   * Empties are cleaned up (timer cancelled) so a drained group doesn't linger.
   */
  remove(match: (payload: T) => boolean): BatchJob<T, R> | undefined;
  /** Flush every open group NOW (e.g. teardown). */
  flushAll(): void;
  /** Number of members currently buffered across all open groups (test seam). */
  pendingCount(): number;
}

interface OpenGroup<T, R> {
  jobs: BatchJob<T, R>[];
  batchSize: number;
  createdAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Build the batch collector (thin shell). Accumulates submitted members per
 * signature and flushes each group at `batchSize` or after the linger window,
 * handing the group to the injected {@link BatchCollectorConfig.runGroup}. Holds
 * NO translation logic — every decision is delegated to the pure helpers above,
 * so its grouping/timing is unit-testable with fake timers.
 */
export function createBatchCollector<T, R>(
  config: BatchCollectorConfig<T, R>,
): BatchCollector<T, R> {
  const timers = config.timers ?? REAL_TIMERS;
  const lingerMs = config.lingerMs;
  const groups = new Map<string, OpenGroup<T, R>>();

  const flush = (signature: string): void => {
    const group = groups.get(signature);
    if (!group) return;
    groups.delete(signature);
    if (group.timer !== undefined) timers.cancel(group.timer);
    if (group.jobs.length > 0) config.runGroup(group.jobs);
  };

  return {
    submit(signature: string, batchSize: number, payload: T): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        let group = groups.get(signature);
        if (!group) {
          group = { jobs: [], batchSize, createdAt: timers.now(), timer: undefined };
          groups.set(signature, group);
        }
        // Latest submission's batchSize wins so a mid-session pagesPerRequest
        // change takes effect on the next group.
        group.batchSize = batchSize;
        group.jobs.push({ payload, resolve, reject });

        const decision = planFlush(
          group.jobs.length,
          group.batchSize,
          timers.now() - group.createdAt,
          lingerMs,
        );
        if (decision.flush) {
          flush(signature);
          return;
        }
        if (group.timer === undefined) {
          group.timer = timers.schedule(() => flush(signature), lingerMs);
        }
      });
    },

    remove(match: (payload: T) => boolean): BatchJob<T, R> | undefined {
      for (const [signature, group] of groups) {
        const idx = group.jobs.findIndex((j) => match(j.payload));
        if (idx === -1) continue;
        const [job] = group.jobs.splice(idx, 1);
        if (group.jobs.length === 0) {
          if (group.timer !== undefined) timers.cancel(group.timer);
          groups.delete(signature);
        }
        return job;
      }
      return undefined;
    },

    flushAll(): void {
      for (const signature of [...groups.keys()]) flush(signature);
    },

    pendingCount(): number {
      let total = 0;
      for (const group of groups.values()) total += group.jobs.length;
      return total;
    },
  };
}
