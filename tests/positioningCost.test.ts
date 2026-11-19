import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { positioningCharge, tripProfitForPositioning } from "../src/engine/positioningCost.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * 2026-11-19: the dispatcher took positioning jump fees off a per-600-second score as a lump, refusing rich far routes
 * (ANTIMATTER AB12 -> XS51, 160,578 a trip, for THEO-A7 five jumps away). positioningCostScaled puts the fee on the same scale.
 */
describe("positioningCharge (pure)", () => {
  const ON = { scaled: true, referenceSeconds: 600 };
  const OFF = { scaled: false, referenceSeconds: 600 };
  it("off: the fee comes off in full (the old rule)", () => {
    assert.equal(positioningCharge(33_000, 3_240, 3_000, OFF), 33_000);
  });
  it("on: the fee is scaled to 600 s of the whole trip", () => {
    assert.equal(positioningCharge(33_000, 3_240, 3_000, ON), (33_000 * 600) / 6_240);
  });
  it("on, but a route with no trip time (score not time-scaled): in full", () => {
    assert.equal(positioningCharge(33_000, undefined, 3_000, ON), 33_000);
  });
  it("no fee, no charge", () => {
    assert.equal(positioningCharge(0, 3_240, 3_000, ON), 0);
  });
  it("first-trip test: on uses the trip's real profit, off the old score", () => {
    assert.equal(tripProfitForPositioning(29_737, 160_578, { scaled: true }), 160_578);
    assert.equal(tripProfitForPositioning(29_737, 160_578, { scaled: false }), 29_737);
    assert.equal(tripProfitForPositioning(29_737, undefined, { scaled: true }), 29_737);
  });
});

describe("the dispatcher with positioningCostScaled (the 11-19 ANTIMATTER case)", () => {
  const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
  const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
  const FAR: DispatchRoute = {
    good: "ANTIMATTER", buyAt: "X1-AB-1", sellAt: "X1-XS-60", buySystem: "X1-AB", sellSystem: "X1-XS",
    buyPrice: 5_000, sellPrice: 8_750, volume: 225, lotSize: 18, distance: 10, fuelUnits: 10, fuelCost: 10,
    profitPerTrip: 160_578, tripSeconds: 3_240, secPerDist: 1, ageMinutes: 1,
  } as unknown as DispatchRoute;
  const ship = { shipSymbol: "THEO-A7", capacity: 225, system: "X1-XS", waypoint: "X1-XS-1", fuelCapacity: 2_300 };
  const PATH = ["X1-XS", "X1-P1", "X1-P2", "X1-P3", "X1-P4", "X1-AB"];
  const crossSystem = { enabled: true, path: (a: string, b: string) => (a === b ? [a] : a === "X1-XS" && b === "X1-AB" ? PATH : a === "X1-AB" && b === "X1-XS" ? [...PATH].reverse() : undefined), hopCost: () => 6_600 };
  const run = (scaled: boolean) => {
    const d = new RouteDispatcher();
    d.recompute([FAR], [ship], [], [], [], [], (a: string, b: string) => a === b, distance, undefined, undefined, crossSystem as never, { positioningCostScaled: scaled });
    return d.assignmentFor("THEO-A7")?.good;
  };
  it("clause off: refused, as today (a ~30k-per-600-s rate minus 33k of fees)", () => {
    assert.equal(run(false), undefined);
  });
  it("clause on: assigned (about 127k a trip after the 5 jumps)", () => {
    assert.equal(run(true), "ANTIMATTER");
  });
});
