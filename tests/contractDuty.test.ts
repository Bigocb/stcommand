import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

// A trader pinned to contract work takes contract-buy jobs and no ordinary trading route (operator request, 2026-10-12).
const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
const route = (good: string, buyAt: string, sellAt: string, profit: number) => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);
const CONTRACT = [{ good: "ALUMINUM_ORE", buyAt: "X1-A-30", buyPrice: 50, needed: 80, value: 90_000 }];
const ship = (s: string) => ({ shipSymbol: s, capacity: 40, system: "X1-A", waypoint: "X1-A-10", fuelCapacity: 5000 });

function run(d: RouteDispatcher, traders: ReturnType<typeof ship>[], contracts: typeof CONTRACT = CONTRACT, routes = [route("FOOD", "X1-A-10", "X1-A-20", 40_000)]) {
  d.recompute(routes, traders, [], [], [], contracts, () => false, distance, () => {});
}

describe("contract duty", () => {
  it("a pinned ship gets the contract job even when ordinary trading pays more, an unpinned one takes the route", () => {
    const d = new RouteDispatcher();
    d.setContractDuty("T-1", true);
    run(d, [ship("T-1"), ship("T-2")]);
    assert.equal(d.assignmentFor("T-1")?.role, "contractBuy");
    assert.equal(d.assignmentFor("T-2")?.good, "FOOD");
  });

  it("with no contract work a pinned ship gets nothing, and cannot claim an ordinary route either", () => {
    const d = new RouteDispatcher();
    d.setContractDuty("T-1", true);
    run(d, [ship("T-1")], []);
    assert.equal(d.assignmentFor("T-1"), undefined);
    assert.equal(d.claim("T-1"), undefined);
  });

  it("releasing it puts it back on ordinary trading", () => {
    const d = new RouteDispatcher();
    d.setContractDuty("T-1", true);
    d.setContractDuty("T-1", false);
    run(d, [ship("T-1")], []);
    assert.equal(d.assignmentFor("T-1")?.good, "FOOD");
    assert.deepEqual(d.contractDutyShips(), []);
  });

  it("pinning drops an ordinary route the ship already held", () => {
    const d = new RouteDispatcher();
    run(d, [ship("T-1")], []);
    assert.equal(d.assignmentFor("T-1")?.good, "FOOD");
    d.setContractDuty("T-1", true);
    assert.equal(d.assignmentFor("T-1"), undefined);
  });
});
