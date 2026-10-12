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

describe("several ships on one contract good", () => {
  const need = (n: number) => [{ good: "ALUMINUM_ORE", buyAt: "X1-A-30", buyPrice: 50, needed: n, value: 90_000 }];
  const duty = (d: RouteDispatcher, ...ships: string[]) => ships.forEach((s) => d.setContractDuty(s, true));

  it("two ships on contract duty split a contract that needs two holds", () => {
    const d = new RouteDispatcher();
    duty(d, "T-1", "T-2");
    run(d, [ship("T-1"), ship("T-2")], need(80));
    assert.equal(d.assignmentFor("T-1")?.role, "contractBuy");
    assert.equal(d.assignmentFor("T-2")?.role, "contractBuy");
    assert.deepEqual([d.assignmentFor("T-1")?.slot, d.assignmentFor("T-2")?.slot].sort(), [1, 2]);
  });

  it("a contract that needs only one hold goes to one ship; the other waits", () => {
    const d = new RouteDispatcher();
    duty(d, "T-1", "T-2");
    run(d, [ship("T-1"), ship("T-2")], need(40));
    const roles = [d.assignmentFor("T-1"), d.assignmentFor("T-2")].filter((a) => a?.role === "contractBuy");
    assert.equal(roles.length, 1);
  });

  it("a need between one and two holds still gets a second ship (the buy itself is sized to what is left)", () => {
    const d = new RouteDispatcher();
    duty(d, "T-1", "T-2");
    run(d, [ship("T-1"), ship("T-2")], need(50));
    assert.equal([d.assignmentFor("T-1"), d.assignmentFor("T-2")].filter((a) => a?.role === "contractBuy").length, 2);
  });

  it("a ship not on contract duty never takes a parallel slot", () => {
    const d = new RouteDispatcher();
    duty(d, "T-1");
    run(d, [ship("T-1"), ship("T-2")], need(80));
    assert.equal(d.assignmentFor("T-1")?.role, "contractBuy");
    assert.notEqual(d.assignmentFor("T-2")?.role, "contractBuy");
  });

  it("a ship already carrying a contract buy counts as its hold, so a need it covers sends nobody else", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    duty(d, "T-1", "T-2");
    run(d, [ship("T-1")], need(40)); // T-1 gets it
    assert.equal(d.assignmentFor("T-1")?.role, "contractBuy");
    t.mock.timers.tick(60_001);
    run(d, [{ ...ship("T-1"), busy: true } as any, ship("T-2")], need(40)); // T-1 is now flying the cargo
    assert.notEqual(d.assignmentFor("T-2")?.role, "contractBuy");
  });
});
