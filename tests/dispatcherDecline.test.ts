import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const route = (good: string, profitPerTrip: number) => ({
  good, buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
  sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 20, volume: 10, lotSize: 10,
  distance: 5, fuelUnits: 5, fuelCost: 5, profitPerTrip, ageMinutes: 1,
});
const again = (d: RouteDispatcher) => { (d as unknown as { lastComputed: number }).lastComputed = 0; };

describe("RouteDispatcher.decline", () => {
  it("a refused auto leg is dropped and the trader gets the next-best leg instead of staying committed", () => {
    const d = new RouteDispatcher();
    const routes = [route("FOOD", 500), route("CLOTHING", 400)];
    const traders = [{ shipSymbol: "SHIP-1", capacity: 40 }];
    d.recompute(routes, traders);
    assert.equal(d.assignmentFor("SHIP-1")?.good, "FOOD");

    d.decline("SHIP-1");
    assert.equal(d.assignmentFor("SHIP-1"), undefined);

    again(d);
    d.recompute(routes, traders);
    assert.equal(d.assignmentFor("SHIP-1")?.good, "CLOTHING", "the refused FOOD leg stays out of this trader's picks");
  });

  it("without a decline, an empty committed trader keeps the leg (the bug this closes)", () => {
    const d = new RouteDispatcher();
    const traders = [{ shipSymbol: "SHIP-1", capacity: 40 }];
    d.recompute([route("FOOD", 500), route("CLOTHING", 400)], traders);
    again(d);
    d.recompute([route("FOOD", 500), route("CLOTHING", 400)], traders);
    assert.equal(d.assignmentFor("SHIP-1")?.good, "FOOD");
  });

  it("never drops a manual pin", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-1", { shipSymbol: "SHIP-1", good: "FOOD", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", profitPerTrip: 50, source: "manual" });
    d.decline("SHIP-1");
    assert.equal(d.assignmentFor("SHIP-1")?.source, "manual");
  });
});

describe("RouteDispatcher: margin floor and whole-good declines", () => {
  const leg = (good: string, sellAt: string, buyPrice: number, sellPrice: number, profitPerTrip: number) => ({
    ...route(good, profitPerTrip), sellAt, buyPrice, sellPrice,
  });

  it("never hands out a direct leg at or under the trader's margin floor", () => {
    const d = new RouteDispatcher();
    const traders = [{ shipSymbol: "SHIP-1", capacity: 40 }];
    // FOOD +208 on a 2,282 ask with a 300c floor (live 2026-10-07), ranked above CLOTHING.
    d.recompute([leg("FOOD", "X1-A-M2", 2282, 2490, 9000), leg("CLOTHING", "X1-A-M3", 4000, 5000, 8000)], traders, [], [], [], [],
      undefined, undefined, undefined, undefined, undefined, { marginFloor: 300 });
    assert.equal(d.assignmentFor("SHIP-1")?.good, "CLOTHING");
  });

  it("a whole-good decline keeps every leg of that good away from the trader", () => {
    const d = new RouteDispatcher();
    const traders = [{ shipSymbol: "SHIP-1", capacity: 40 }];
    const routes = [leg("POLY", "X1-A-M2", 10, 20, 500), leg("POLY", "X1-A-M3", 10, 20, 450), leg("IRON", "X1-A-M2", 10, 20, 100)];
    d.recompute(routes, traders);
    assert.equal(d.assignmentFor("SHIP-1")?.good, "POLY");
    d.decline("SHIP-1", true);
    again(d);
    d.recompute(routes, traders);
    assert.equal(d.assignmentFor("SHIP-1")?.good, "IRON");
  });
});
