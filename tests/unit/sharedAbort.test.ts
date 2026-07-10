import { describe, expect, it } from "vitest";
import { createSharedAbort } from "../../src/background/sharedAbort";

describe("sharedAbort — refcounted cancellation of a coalesced run", () => {
  it("stays alive while any waiter remains; aborts only when all abort", () => {
    const a = new AbortController();
    const b = new AbortController();
    const shared = createSharedAbort();
    shared.addWaiter(a.signal);
    shared.addWaiter(b.signal);

    a.abort();
    expect(shared.signal.aborted).toBe(false); // b still wants the result

    b.abort();
    expect(shared.signal.aborted).toBe(true); // now nobody does
  });

  it("a waiter with no signal keeps the run alive forever", () => {
    const a = new AbortController();
    const shared = createSharedAbort();
    shared.addWaiter(undefined); // permanently live (e.g. a fire-and-forget caller)
    shared.addWaiter(a.signal);

    a.abort();
    expect(shared.signal.aborted).toBe(false);
  });

  it("an already-aborted sole waiter aborts the run immediately", () => {
    const a = new AbortController();
    a.abort();
    const shared = createSharedAbort();
    shared.addWaiter(a.signal);
    expect(shared.signal.aborted).toBe(true);
  });

  it("an already-aborted waiter does not abort a run others still want", () => {
    const a = new AbortController();
    const dead = new AbortController();
    dead.abort();
    const shared = createSharedAbort();
    shared.addWaiter(a.signal); // live
    shared.addWaiter(dead.signal); // already gone — contributes nothing
    expect(shared.signal.aborted).toBe(false);
  });

  it("late registration after settle is a no-op", () => {
    const shared = createSharedAbort();
    shared.settle();
    const a = new AbortController();
    shared.addWaiter(a.signal);
    a.abort();
    expect(shared.signal.aborted).toBe(false);
  });

  it("the detach handle removes the listener without counting as leaving", () => {
    const a = new AbortController();
    const shared = createSharedAbort();
    const detach = shared.addWaiter(a.signal);
    detach(); // cleanup on settle must NOT trip the refcount
    a.abort();
    expect(shared.signal.aborted).toBe(false);
  });
});
