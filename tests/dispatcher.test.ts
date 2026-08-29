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

describe("RouteDispatcher: contractBuy priority reflects the contract's real payout, not just units left", () => {
  it("without a value, a nearly-finished contract's tiny shortfall loses out to an ordinary route (the bug)", () => {
    // Confirmed live: a COPPER contract down to its last 4 units scored
    // 4*100=400 — below an entirely ordinary IRON_ORE route's 1000 — so the
    // one available trader took the ordinary route and the contract's last
    // few units sat unclaimed. This test documents that old behavior still
    // happens when no `value` is supplied (e.g. a caller that hasn't been
    // updated); the next test shows the fix.
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 110, volume: 10,
      distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    }];
    const targets: ContractBuyTarget[] = [{ good: "COPPER", buyAt: "X1-A-M3", buyPrice: 10, needed: 4 }];

    d.recompute(routes, [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-1")?.good, "IRON_ORE", "the ordinary route still outranks the unvalued contract shortfall");
  });

  it("with a value, the same tiny shortfall outranks the ordinary route — completing the contract is worth more than one trip", () => {
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 110, volume: 10,
      distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    }];
    // Same 4-unit shortfall as above, but now the caller supplies the
    // contract's real onFulfilled payout (27,219c, matching the live
    // COPPER contract this was found on) via `value`.
    const targets: ContractBuyTarget[] = [{ good: "COPPER", buyAt: "X1-A-M3", buyPrice: 10, needed: 4, value: 27219 }];

    d.recompute(routes, [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.good, "COPPER", "finishing the contract must now outrank the ordinary route");
    assert.equal(a?.profitPerTrip, 400, "the assignment's displayed profitPerTrip stays the needed*100 estimate — the 27,219c payout is a completion bonus, not a real per-trip figure, and must not be shown as one");
  });
});

describe("RouteDispatcher: cross-system direct routes", () => {
  it("never assigns a cross-system route as 'direct' — TraderAgent.viableRoute() refuses to fly one", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }]);

    assert.equal(d.assignmentFor("SHIP-1"), undefined, "no ship should be assigned a route no trader can actually fly");
  });

  it("still assigns a same-system route as 'direct', unaffected", () => {
    const d = new RouteDispatcher();
    const sameSystem = {
      good: "COPPER", buyAt: "X1-TQ19-H48", buySystem: "X1-TQ19", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([sameSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }]);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "direct");
    assert.equal(a?.good, "COPPER");
  });

  it("a cross-system route with a warehouse target can still be assigned as buy/sell (single-leg roles, unaffected by the direct-only restriction)", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }], [{ good: "COPPER", target: 100, balance: 0 }]);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "buy", "buy/sell legs are single-system-side, not a same-ship round trip — the cross-system restriction only applies to 'direct'");
  });
});
