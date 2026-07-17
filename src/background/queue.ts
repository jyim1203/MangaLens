/**
 * Priority job queue with a concurrency limiter, abort propagation, and opt-in
 * retry-with-backoff (Architecture §5/§7.5). This is what turns "10 pages" into
 * "≤ N provider requests in flight, visible page first".
 *
 * Scheduling: lower `priority` number runs first (0 = visible now, 1 = near
 * viewport, 2 = prefetch/all, §7.5); ties break FIFO by insertion order, so
 * equal-priority jobs keep the order they were enqueued.
 *
 * Abort: a queue-wide {@link PriorityQueueOptions.signal} rejects every queued
 * and in-flight job; a per-job signal passed to {@link PriorityQueue.add}
 * rejects just that job. Either way the task function is invoked with a *merged*
 * signal so a running task can cancel its own work (e.g. `fetch`).
 *
 * Retry is off by default: the provider layer already owns rate-limit backoff
 * (429/529 ladder), so the translate path leaves `maxRetries` at 0 to avoid
 * double-backoff. It exists here for generic transient faults and is fully
 * seam-injected (`sleep`) so tests never wait on real time.
 *
 * Pure of any browser API — unit-tested directly with fake timers / deferreds.
 */
import { isAbortError } from "../shared/guards";

/** Default exponential backoff: 250 ms, 500 ms, 1 s, … per attempt (0-indexed). */
function defaultBackoffMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

/** Options for a {@link PriorityQueue}. Only `concurrency` is required. */
export interface PriorityQueueOptions {
  /** Max jobs running at once (≥ 1). Clamped to ≥ 1. */
  concurrency: number;
  /** Aborts the whole queue: every queued/active job rejects with this reason. */
  signal?: AbortSignal;
  /** Max retry attempts after the first try for retryable failures (default 0). */
  maxRetries?: number;
  /** Backoff before retry attempt `n` (0-indexed); default exponential. */
  backoffMs?: (attempt: number) => number;
  /** Whether a rejection is retryable (default: anything that is not an abort). */
  shouldRetry?: (err: unknown) => boolean;
  /** Delay seam; injected in tests to avoid real waits. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** A job's async work; receives the merged abort signal for cooperative cancel. */
export type Task<T> = (signal: AbortSignal) => Promise<T>;

/**
 * A handle to an enqueued job (Phase 8 §2 re-prioritization). {@link setPriority}
 * lifts a STILL-QUEUED job to a better (lower-number) priority so a prefetched
 * page that scrolls into view jumps the queue instead of waiting behind the whole
 * chapter. It is UPGRADE-ONLY (`min(current, requested)` — a request can never
 * WORSEN a job's priority) and a no-op returning `false` once the job has started
 * or settled.
 */
export interface QueueHandle<T> {
  /** Settles with the task's result (or rejects on failure/abort). */
  promise: Promise<T>;
  /**
   * Raise this job's priority to `min(current, requested)` and re-insert it (fresh
   * seq — fair "back of the new class"). Returns `true` while the job is still
   * queued, `false` once it has started or settled (nothing to reorder).
   */
  setPriority(priority: number): boolean;
}

interface QueueEntry {
  priority: number;
  /** Monotonic insertion index — the FIFO tiebreaker within a priority. */
  seq: number;
  /** Run the task and settle the caller's promise; resolves when fully done. */
  start: () => Promise<void>;
  /** Reject the caller before the task ever starts (queue/job abort while queued). */
  reject: (err: unknown) => void;
  /** Per-job signal, if the caller supplied one. */
  jobSignal?: AbortSignal;
  /** Listener bound to `jobSignal`, removed once the entry leaves the queue. */
  onJobAbort?: () => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The reason to reject with when a signal aborts (its own reason, or a default). */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Merge several {@link AbortSignal}s into one that aborts as soon as any input
 * does, forwarding the first abort's reason. Returns the merged signal plus a
 * `cleanup` that detaches listeners (call it once the merged signal is dead, to
 * avoid leaking listeners on long-lived parent signals like the queue's).
 */
function mergeSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];

  const cleanup = () => {
    for (const detach of listeners) detach();
    listeners.length = 0;
  };

  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      cleanup();
      return { signal: controller.signal, cleanup };
    }
    const onAbort = () => {
      controller.abort(s.reason);
      cleanup();
    };
    s.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => s.removeEventListener("abort", onAbort));
  }

  return { signal: controller.signal, cleanup };
}

/**
 * A concurrency-limited, priority-ordered async task queue.
 *
 * @example
 * const q = new PriorityQueue({ concurrency: 6 });
 * const page = await q.add((signal) => translate(job, settings, signal), job.priority);
 */
export class PriorityQueue {
  private concurrency: number;
  private readonly queueSignal?: AbortSignal;
  private readonly maxRetries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly shouldRetry: (err: unknown) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly pending: QueueEntry[] = [];
  private active = 0;
  private seqCounter = 0;
  private queueAbortListener?: () => void;

  constructor(opts: PriorityQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency));
    this.queueSignal = opts.signal;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 0);
    this.backoffMs = opts.backoffMs ?? defaultBackoffMs;
    this.shouldRetry = opts.shouldRetry ?? ((err) => !isAbortError(err));
    this.sleep = opts.sleep ?? realSleep;

    if (this.queueSignal) {
      // A queue-wide abort clears every queued job at once; in-flight jobs see
      // it through their merged signal and reject on their own.
      this.queueAbortListener = () => this.clear(abortReason(this.queueSignal!));
      this.queueSignal.addEventListener("abort", this.queueAbortListener, {
        once: true,
      });
    }
  }

  /** Jobs waiting to start. */
  get size(): number {
    return this.pending.length;
  }

  /** Jobs currently running. */
  get running(): number {
    return this.active;
  }

  /** Queued + running jobs — i.e. everything not yet settled. */
  get pendingCount(): number {
    return this.pending.length + this.active;
  }

  /** Change the concurrency cap at runtime (e.g. when settings change). */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }

  /**
   * Enqueue `task` at `priority`. The returned promise settles with the task's
   * result, or rejects if the task (after any retries) fails or is aborted. Thin
   * wrapper over {@link addJob} for callers that don't need a re-prioritize handle.
   *
   * @param task async work; receives a merged abort signal.
   * @param priority lower runs first; ties are FIFO (default 0).
   * @param jobSignal optional per-job abort that cancels only this job.
   */
  add<T>(task: Task<T>, priority = 0, jobSignal?: AbortSignal): Promise<T> {
    return this.addJob(task, priority, jobSignal).promise;
  }

  /**
   * Enqueue `task` and return a {@link QueueHandle} whose {@link QueueHandle.setPriority}
   * can lift the job to a better priority while it is still queued (Phase 8 §2).
   * Same scheduling/abort semantics as {@link add}.
   */
  addJob<T>(task: Task<T>, priority = 0, jobSignal?: AbortSignal): QueueHandle<T> {
    let entry: QueueEntry | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      // Already-aborted fast paths: never enqueue a dead job.
      if (this.queueSignal?.aborted) {
        reject(abortReason(this.queueSignal));
        return;
      }
      if (jobSignal?.aborted) {
        reject(abortReason(jobSignal));
        return;
      }

      const created: QueueEntry = {
        priority,
        seq: this.seqCounter++,
        jobSignal,
        reject,
        start: async () => {
          this.detachJobAbort(created);
          const parents: AbortSignal[] = [];
          if (this.queueSignal) parents.push(this.queueSignal);
          if (jobSignal) parents.push(jobSignal);
          const merged = mergeSignals(parents);
          try {
            const result = await this.runWithRetry(task, merged.signal);
            resolve(result);
          } catch (err) {
            reject(err);
          } finally {
            merged.cleanup();
            this.active--;
            this.pump();
          }
        },
      };
      entry = created;

      // A per-job abort while still queued rejects and removes it before it runs.
      if (jobSignal) {
        created.onJobAbort = () => {
          if (this.remove(created)) {
            this.detachJobAbort(created);
            reject(abortReason(jobSignal));
          }
        };
        jobSignal.addEventListener("abort", created.onJobAbort, { once: true });
      }

      this.insert(created);
      this.pump();
    });

    // Upgrade-only re-prioritization: a job not in `pending` (started/settled/
    // aborted) can't reorder. `min` guarantees a request never worsens priority.
    const setPriority = (requested: number): boolean => {
      if (!entry) return false;
      const i = this.pending.indexOf(entry);
      if (i === -1) return false;
      const effective = Math.min(entry.priority, requested);
      if (effective !== entry.priority) {
        this.pending.splice(i, 1);
        entry.priority = effective;
        entry.seq = this.seqCounter++; // fresh seq → fair back of the new class
        this.insert(entry);
      }
      return true;
    };

    return { promise, setPriority };
  }

  /**
   * Reject and drop every *queued* job (running jobs are left to settle via
   * their own abort signals). Used by a queue-wide abort; also callable directly
   * to drain the queue.
   *
   * @param reason rejection reason for the cleared jobs.
   */
  clear(reason: unknown = new DOMException("Queue cleared", "AbortError")): void {
    const dropped = this.pending.splice(0, this.pending.length);
    for (const entry of dropped) {
      this.detachJobAbort(entry);
      entry.reject(reason);
    }
  }

  /** Insert keeping the array sorted by (priority asc, seq asc). */
  private insert(entry: QueueEntry): void {
    // Linear scan is fine: queue depth is bounded by on-screen images (§7.1).
    let i = this.pending.length;
    while (i > 0) {
      const prev = this.pending[i - 1]!;
      if (
        prev.priority < entry.priority ||
        (prev.priority === entry.priority && prev.seq <= entry.seq)
      ) {
        break;
      }
      i--;
    }
    this.pending.splice(i, 0, entry);
  }

  /** Remove a specific entry from the queue; returns whether it was present. */
  private remove(entry: QueueEntry): boolean {
    const i = this.pending.indexOf(entry);
    if (i === -1) return false;
    this.pending.splice(i, 1);
    return true;
  }

  private detachJobAbort(entry: QueueEntry): void {
    if (entry.jobSignal && entry.onJobAbort) {
      entry.jobSignal.removeEventListener("abort", entry.onJobAbort);
      entry.onJobAbort = undefined;
    }
  }

  /** Start as many queued jobs as the concurrency cap allows. */
  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      this.active++;
      // `start` is async but self-contained (it decrements `active` and re-pumps
      // in its finally); we deliberately don't await it here.
      void entry.start();
    }
  }

  /** Run the task, retrying retryable failures up to `maxRetries` with backoff. */
  private async runWithRetry<T>(task: Task<T>, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await task(signal);
      } catch (err) {
        const canRetry =
          attempt < this.maxRetries &&
          !signal.aborted &&
          this.shouldRetry(err);
        if (!canRetry) throw err;
        await this.sleep(this.backoffMs(attempt));
        if (signal.aborted) throw abortReason(signal);
        attempt++;
      }
    }
  }
}
