import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jumpCashBlock } from "../src/engine/jumpCashGuard.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

describe("jumpCashBlock (pure)", () => {
  it("blocks a jump route under the floor, with a reason", () => {
    assert.match(jumpCashBlock(22_000, 100_000, true) ?? "", /under the 100000c jump floor/);
  });
  it("never blocks a same-system route", () => {
    assert.equal(jumpCashBlock(22_000, 100_000, false), undefined);
  });
  it("floor 0 / unset (clause off) and an unknown wallet behave as before", () => {
    assert.equal(jumpCashBlock(22_000, 0, true), undefined);
    assert.equal(jumpCashBlock(22_000, undefined, true), undefined);
    assert.equal(jumpCashBlock(undefined, 100_000, true), undefined);
  });
  it("at or above the floor jumps are allowed", () => {
    assert.equal(jumpCashBlock(100_000, 100_000, true), undefined);
  });
});

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellSystem: sellAt.slice(0, sellAt.lastIndexOf("-")),
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

describe("the dispatcher applies the jump cash guard", () => {
  const FAR = route("FAR", "X1-B-10", "X1-B-20", 90_000); // buy one gate away
  const HAUL = route("HAUL", "X1-A-10", "X1-B-20", 80_000); // buy here, sell one gate away
  const NEAR = route("NEAR", "X1-A-10", "X1-A-20", 5_000); // same system
  const trader = { shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5000 };
  const pick = (credits: number, floor: number, routes: DispatchRoute[]) => {
    const d = new RouteDispatcher();
    (d.recompute as any)(routes, [trader], [], [], [], [], () => true, () => 1, undefined, undefined, undefined, { credits, jumpCashFloor: floor });
    return d.assignmentFor("T-1")?.good;
  };
  it("under the floor: the far route is refused and the local one taken", () => {
    assert.equal(pick(22_000, 100_000, [FAR, NEAR]), "NEAR");
  });
  it("under the floor: a route whose sell leg needs a jump is refused too", () => {
    assert.equal(pick(22_000, 100_000, [HAUL, NEAR]), "NEAR");
  });
  it("above the floor: unchanged, the better far route wins", () => {
    assert.equal(pick(500_000, 100_000, [FAR, NEAR]), "FAR");
  });
  it("clause off (floor 0): unchanged", () => {
    assert.equal(pick(22_000, 0, [FAR, NEAR]), "FAR");
  });
});
