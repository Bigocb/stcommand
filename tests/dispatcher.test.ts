import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type ContractBuyTarget } from "../src/engine/dispatcher.js";

/**
 * Covers the "contractBuy" role added to close the contract-sourcing gap:
 * previously nothing ever proactively bought a good a contract needed
 * (wantsGood() was dead code with zero call sites) — this is the dispatcher
 * half of that fix. RouteDispatcher had no test coverage before this.
 */

describe("RouteDispatcher: contractBuy assignments", () => {
  it("assigns a contractBuy role from a contractBuyTarget, with no sell/warehouse leg", () => {
    const d = new RouteDispatcher();
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute([], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "contractBuy");
    assert.equal(a?.good, "IRON_ORE");
    assert.equal(a?.buyAt, "X1-A-M1");
    assert.equal(a?.sellAt, undefined);
  });

  it("skips a target with nothing outstanding (needed <= 0)", () => {
    const d = new RouteDispatcher();
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 0 }];

    d.recompute([], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-1"), undefined);
  });

  it("reserves its own `${good}:contractBuy` key, distinct from an ordinary direct route on the same good", () => {
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 20, volume: 10,
      distance: 5, fuelUnits: 5, fuelCost: 5, profitPerTrip: 100, ageMinutes: 1,
    }];
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute(routes, [
      { shipSymbol: "SHIP-1", capacity: 40 },
      { shipSymbol: "SHIP-2", capacity: 40 },
    ], [], [], [], targets);

    const roles = new Set([d.assignmentFor("SHIP-1")?.role, d.assignmentFor("SHIP-2")?.role]);
    assert.ok(roles.has("direct"), "the ordinary route must still be assignable");
    assert.ok(roles.has("contractBuy"), "the contract-buy target must also be assignable to a different ship");
  });

  it("a manual override on a good reserves it against auto contractBuy assignment too", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-1", {
      shipSymbol: "SHIP-1", good: "IRON_ORE", role: "direct",
      buyAt: "X1-A-M1", sellAt: "X1-A-M2", profitPerTrip: 50, source: "manual",
    });
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute([], [
      { shipSymbol: "SHIP-1", capacity: 40 },
      { shipSymbol: "SHIP-2", capacity: 40 },
    ], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-2"), undefined, "IRON_ORE is reserved by SHIP-1's manual override, in every role");
  });
});
