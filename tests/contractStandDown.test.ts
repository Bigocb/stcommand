import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractManager } from "../src/engine/contract.js";

/**
 * Once the operator has stood every open contract down, nothing changes the
 * list from our side, so it must stop being re-read every 30 seconds — while
 * any operator decision still takes effect at once.
 */

const contract = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  accepted: true,
  fulfilled: false,
  terms: { deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(), payment: { onAccepted: 1, onFulfilled: 10 }, deliver: [] },
  ...over,
}) as any;

function setup(list: any[]) {
  const calls = { get: 0 };
  const api = { getContracts: async () => { calls.get += 1; return list; } } as any;
  return { mgr: new ContractManager(api), calls };
}

/** Run `fn` with the clock `ms` later. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

describe("ContractManager cache when contracts are stood down", () => {
  it("re-reads a contract being worked every 30 seconds, as before", async () => {
    const { mgr, calls } = setup([contract("c1")]);
    await mgr.listActive();
    await later(31_000, () => mgr.listActive());
    assert.equal(calls.get, 2);
  });

  it("does not re-read once every open contract has been abandoned", async () => {
    const { mgr, calls } = setup([contract("c1")]);
    await mgr.abandon("c1");
    await mgr.listActive();
    await later(5 * 60_000, () => mgr.listActive());
    assert.equal(calls.get, 1, "five minutes later it is still the cached list");
  });

  it("still re-reads after ten minutes, so an expiry is noticed", async () => {
    const { mgr, calls } = setup([contract("c1")]);
    await mgr.abandon("c1");
    await mgr.listActive();
    await later(11 * 60_000, () => mgr.listActive());
    assert.equal(calls.get, 2);
  });

  it("treats a declined offer as stood down too", async () => {
    const { mgr, calls } = setup([contract("o1", { accepted: false, deadlineToAccept: new Date(Date.now() + 86_400_000).toISOString() })]);
    await mgr.decline("o1");
    await mgr.listActive();
    await later(5 * 60_000, () => mgr.listActive());
    assert.equal(calls.get, 1);
  });

  it("keeps polling while any open contract is still being worked", async () => {
    const { mgr, calls } = setup([contract("c1"), contract("c2")]);
    await mgr.abandon("c1");
    await mgr.listActive();
    await later(31_000, () => mgr.listActive());
    assert.equal(calls.get, 2);
  });

  it("keeps polling when there is no open contract, since the fleet wants to negotiate one", async () => {
    const { mgr, calls } = setup([]);
    await mgr.listActive();
    await later(31_000, () => mgr.listActive());
    assert.equal(calls.get, 2);
  });

  it("picks a contract back up at once when the operator resumes it", async () => {
    const { mgr, calls } = setup([contract("c1")]);
    await mgr.abandon("c1");
    await mgr.listActive();
    await mgr.resume("c1");
    await mgr.listActive();
    assert.equal(calls.get, 2, "resume invalidates the long cache");
  });
});
