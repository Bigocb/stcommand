import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CashReservations } from "../src/engine/cashReservations.js";

describe("CashReservations (issue #88 P2)", () => {
  it("other traders see the wallet less what is reserved; a release frees it once", () => {
    const r = new CashReservations();
    const releaseA = r.reserve("A", 40_000_000);
    r.reserve("B", 10_000_000);
    assert.equal(r.othersThan("A"), 10_000_000);
    assert.equal(r.othersThan("B"), 40_000_000);
    assert.equal(r.othersThan("C"), 50_000_000);
    releaseA();
    releaseA();
    assert.equal(r.othersThan("C"), 10_000_000);
  });
  it("a new reservation by the same ship replaces its old one, and the old release cannot drop the new one", () => {
    const r = new CashReservations();
    const old = r.reserve("A", 5);
    r.reserve("A", 7);
    old();
    assert.equal(r.total(), 7);
  });
});

import { TraderAgent, type Ship } from "../src/engine/trader.js";

describe("TraderAgent: spendable cash is net of other traders' reservations (the seam)", () => {
  it("subtracts what other traders reserved before the cash floor applies", async () => {
    const ship = { symbol: "T-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 1, capacity: 1 } } as unknown as Ship;
    const r = new CashReservations();
    r.reserve("T-2", 30_000_000);
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getMyAgent: async () => ({ credits: 100_000_000 }) } as any,
      applyCashFloor: (c: number) => Math.max(0, c - 25_000_000),
      cashReservedByOthers: () => r.othersThan("T-1"),
      reserveCash: (a: number) => r.reserve("T-1", a),
    });
    assert.equal(await (trader as any).spendableNow(), 45_000_000);
  });
});
