import { describe, expect, it, vi } from "vitest";

// queue.ts imports only shared/guards (dependency-free) — no browser mock needed.
import { PriorityQueue } from "../../src/background/queue";

/** A manually-settled promise, for holding tasks open on demand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so started tasks reach their first await. */
const tick = () => Promise.resolve();

describe("PriorityQueue — concurrency", () => {
  it("never runs more than `concurrency` jobs at once", async () => {
    const q = new PriorityQueue({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 5 }, () => deferred());

    const results = gates.map((g, i) =>
      q.add(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await g.promise;
        active--;
        return i;
      }),
    );

    // Only 2 should have started; 3 wait.
    expect(q.running).toBe(2);
    expect(q.size).toBe(3);

    gates.forEach((g) => g.resolve());
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(2);
  });

  it("setConcurrency raises the cap and immediately starts more queued jobs", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gates = Array.from({ length: 3 }, () => deferred());
    let active = 0;

    const results = gates.map((g) =>
      q.add(async () => {
        active++;
        await g.promise;
        active--;
      }),
    );

    expect(active).toBe(1);
    q.setConcurrency(3);
    expect(active).toBe(3);

    gates.forEach((g) => g.resolve());
    await Promise.all(results);
  });
});

describe("PriorityQueue — ordering", () => {
  it("runs lower priority-number first, FIFO within a priority", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const order: string[] = [];
    const gate = deferred();

    // Occupy the single slot so everything else queues.
    const blocker = q.add(async () => {
      await gate.promise;
      order.push("blocker");
    });

    const p2 = q.add(async () => void order.push("p2"), 2);
    const p0a = q.add(async () => void order.push("p0a"), 0);
    const p1 = q.add(async () => void order.push("p1"), 1);
    const p0b = q.add(async () => void order.push("p0b"), 0); // same priority as p0a, later

    gate.resolve();
    await Promise.all([blocker, p2, p0a, p1, p0b]);

    // priority 0 (a then b, FIFO), then 1, then 2.
    expect(order).toEqual(["blocker", "p0a", "p0b", "p1", "p2"]);
  });
});

describe("PriorityQueue — abort", () => {
  it("a per-job abort rejects that queued job and removes it", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const blocker = q.add(() => gate.promise); // holds the only slot

    const ac = new AbortController();
    const job = q.add(async () => "never", 0, ac.signal);
    expect(q.size).toBe(1);

    ac.abort();
    await expect(job).rejects.toBeInstanceOf(DOMException);
    expect(q.size).toBe(0);

    gate.resolve();
    await blocker;
  });

  it("aborting a RUNNING job fires the task's merged signal", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const ac = new AbortController();
    let sawAbort = false;

    const job = q.add(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(signal.reason);
          });
        }),
      0,
      ac.signal,
    );

    await tick(); // let it start
    ac.abort();
    await expect(job).rejects.toBeInstanceOf(DOMException);
    expect(sawAbort).toBe(true);
  });

  it("a queue-wide abort rejects both queued and running jobs", async () => {
    const ac = new AbortController();
    const q = new PriorityQueue({ concurrency: 1, signal: ac.signal });

    const running = q.add(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const queued = q.add(async () => "later");

    await tick();
    ac.abort();
    await expect(running).rejects.toBeInstanceOf(DOMException);
    await expect(queued).rejects.toBeInstanceOf(DOMException);
  });

  it("rejects immediately when added to an already-aborted queue", async () => {
    const ac = new AbortController();
    ac.abort();
    const q = new PriorityQueue({ concurrency: 1, signal: ac.signal });
    await expect(q.add(async () => "x")).rejects.toBeInstanceOf(DOMException);
  });

  it("§3 dead-signal guard: never invokes the task when the merged signal is aborted at start", async () => {
    // A signal whose `addEventListener` is a NO-OP: the queue's per-job abort
    // listener is never actually registered, so flipping `aborted` after enqueue
    // does NOT remove the entry — it stays queued and reaches `start()` with an
    // aborted parent, reproducing the dequeue→start abort window the guard closes.
    let aborted = false;
    const deadSignal = {
      get aborted() {
        return aborted;
      },
      reason: new DOMException("Aborted", "AbortError"),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
      onabort: null,
    } as unknown as AbortSignal;

    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    q.add(() => gate.promise); // occupy the single slot so the next job stays queued

    const task = vi.fn(async () => "ran");
    const job = q.add(task, 0, deadSignal); // enqueued (aborted still false)
    expect(q.size).toBe(1);

    aborted = true; // dies while queued — no listener fires to remove it
    gate.resolve(); // free the slot → the queued job dequeues and reaches start()

    await expect(job).rejects.toBeInstanceOf(DOMException);
    // The guard threw BEFORE the task — no ghost work (fetch) could ever run.
    expect(task).not.toHaveBeenCalled();
  });
});

describe("PriorityQueue — retry with backoff", () => {
  it("retries retryable failures with injected backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const q = new PriorityQueue({
      concurrency: 1,
      maxRetries: 2,
      sleep: async (ms) => void sleeps.push(ms),
      backoffMs: (n) => (n + 1) * 100,
    });

    let attempts = 0;
    const result = await q.add(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]); // backoff before retry 1 and retry 2
  });

  it("gives up after maxRetries and rejects with the last error", async () => {
    const q = new PriorityQueue({ concurrency: 1, maxRetries: 1, sleep: async () => {} });
    let attempts = 0;
    await expect(
      q.add(async () => {
        attempts++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(2); // initial try + 1 retry
  });

  it("does not retry an aborted task (default shouldRetry)", async () => {
    const q = new PriorityQueue({ concurrency: 1, maxRetries: 5, sleep: async () => {} });
    let attempts = 0;
    await expect(
      q.add(async () => {
        attempts++;
        throw new DOMException("Aborted", "AbortError");
      }),
    ).rejects.toBeInstanceOf(DOMException);
    expect(attempts).toBe(1);
  });

  it("does not retry by default (maxRetries 0)", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    let attempts = 0;
    await expect(
      q.add(async () => {
        attempts++;
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(attempts).toBe(1);
  });
});

describe("PriorityQueue — bookkeeping", () => {
  it("tracks size / running / pendingCount", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const a = q.add(() => gate.promise);
    const b = q.add(async () => {});
    expect(q.running).toBe(1);
    expect(q.size).toBe(1);
    expect(q.pendingCount).toBe(2);
    gate.resolve();
    await Promise.all([a, b]);
    expect(q.pendingCount).toBe(0);
  });

  it("clear() drops queued jobs but leaves running ones", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const running = q.add(() => gate.promise);
    const queued = q.add(async () => "later");

    q.clear();
    await expect(queued).rejects.toBeInstanceOf(DOMException);
    expect(q.size).toBe(0);

    gate.resolve();
    await expect(running).resolves.toBeUndefined();
  });
});

describe("PriorityQueue — addJob / setPriority (Phase 8 §2 re-prioritization)", () => {
  it("upgrades a still-queued job ahead of same-priority earlier entries", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    // Job 0 occupies the single slot; 1, 2, 3 queue behind it at priority 2.
    q.add(async () => {
      await gate.promise;
      order.push(0);
    }, 2);
    q.add(async () => void order.push(1), 2);
    const h2 = q.addJob(async () => void order.push(2), 2);
    q.add(async () => void order.push(3), 2);

    // Lift job 2 to priority 0 → it should run first among the queued ones.
    expect(h2.setPriority(0)).toBe(true);
    gate.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([0, 2, 1, 3]);
  });

  it("min() never worsens: a higher-number request leaves priority unchanged", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    q.add(async () => {
      await gate.promise;
      order.push(0);
    }, 0);
    const h1 = q.addJob(async () => void order.push(1), 0); // already visible-tier
    q.add(async () => void order.push(2), 0);

    // A "downgrade" to 2 is ignored (min(0, 2) = 0) — still returns true (queued).
    expect(h1.setPriority(2)).toBe(true);
    gate.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([0, 1, 2]); // FIFO order preserved, not worsened
  });

  it("returns false once the job has started or settled", async () => {
    const q = new PriorityQueue({ concurrency: 1 });
    const gate = deferred();
    const h = q.addJob(async () => {
      await gate.promise;
    }, 0);
    // It started immediately (concurrency 1, nothing ahead).
    expect(h.setPriority(0)).toBe(false);
    gate.resolve();
    await h.promise;
    expect(h.setPriority(0)).toBe(false); // settled
  });

  it("add() is a thin wrapper that still resolves with the task result", async () => {
    const q = new PriorityQueue({ concurrency: 2 });
    expect(await q.add(async () => 42)).toBe(42);
  });
});
