import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Route-first matching (src/engine/matching.ts) through the dispatcher. Route A is the richer on the rank figure and pays
 * the same on any hold; route B pays far more on the big hold than the small one. BIG stands at B's buy market and a
 * short flight from A; SMALL stands at A's. Old order: BIG (biggest hold) is served first and takes A, SMALL gets B.
 * Matched: A goes to SMALL, B to BIG.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number, volume: number, byHold: Record<string, number>): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, profitByHold: byHold, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const A = route("A", "X1-A-400", "X1-A-450", 60_000, 40, { "40": 60_000, "150": 60_000 });
const B = route("B", "X1-A-500", "X1-A-560", 50_000, 150, { "40": 15_000, "150": 50_000 });

const big = { shipSymbol: "BIG", capacity: 150, system: "X1-A", waypoint: "X1-A-500", fuelCapacity: 5000 };
const small = { shipSymbol: "SMALL", capacity: 40, system: "X1-A", waypoint: "X1-A-400", fuelCapacity: 5000 };

function run(d: RouteDispatcher, tuning: Record<string, unknown> | undefined, lines: string[] = []) {
  d.recompute([A, B], [big, small], [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, tuning);
}

describe("dispatcher route-first matching", () => {
  it("off (no tuning, or topN 0) serves ships by hold size, as before", () => {
    for (const tuning of [undefined, { matchTopN: 0 }]) {
      const d = new RouteDispatcher();
      const lines: string[] = [];
      run(d, tuning, lines);
      assert.equal(d.assignmentFor("BIG")?.good, "A");
      assert.equal(d.assignmentFor("SMALL")?.good, "B");
      assert.ok(!lines.some((l) => l.startsWith("dispatch match")));
    }
  });

  it("on, each of the top routes goes to the ship that earns most from it", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, { matchTopN: 2 }, lines);
    assert.equal(d.assignmentFor("SMALL")?.good, "A");
    assert.equal(d.assignmentFor("BIG")?.good, "B");
    assert.ok(lines.some((l) => l.includes("dispatch match: A -> SMALL")));
  });
});

describe("dispatcher: hold-aware score (clause routeHoldAware)", () => {
  // C pays 60k on the big hold but only 15k on a 40 hold; D pays 20k on either. SMALL stands at C's buy market.
  const C = route("C", "X1-A-400", "X1-A-450", 60_000, 150, { "40": 15_000, "150": 60_000 });
  const D = route("D", "X1-A-410", "X1-A-460", 20_000, 40, { "40": 20_000, "150": 20_000 });
  const only = (tuning?: Record<string, unknown>) => {
    const d = new RouteDispatcher();
    d.recompute([C, D], [small], [], [], [], [], () => false, distance, () => {}, undefined, undefined, tuning);
    return d.assignmentFor("SMALL")?.good;
  };
  it("off, a small ship is scored on the big hold's figure and takes the richer route", () => {
    assert.equal(only(undefined), "C");
  });
  it("on, it is scored on its own hold and takes the route that pays it more", () => {
    assert.equal(only({ holdAware: true }), "D");
  });
});

describe("dispatcher: planning the next route for ships about to finish (clause routeSoonFreeMin)", () => {
  const busyBig = { ...big, busy: true, freeInSec: 60, freeAtWaypoint: "X1-A-500" };
  const run2 = (tuning: Record<string, unknown> | undefined, lines: string[] = []) => {
    const d = new RouteDispatcher();
    d.recompute([B], [busyBig, small], [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, tuning);
    return d.assignmentFor("SMALL")?.good;
  };
  it("off, the idle small ship takes the route the big hull would earn far more from", () => {
    assert.equal(run2({ matchTopN: 2 }), "B");
  });
  it("on, the route is held for the big hull that is free in a minute", () => {
    const lines: string[] = [];
    assert.equal(run2({ matchTopN: 2, soonFreeSec: 300 }, lines), undefined);
    assert.ok(lines.some((l) => l.includes("dispatch hold: B kept for BIG")));
  });
  it("a ship not free within the window is not waited for", () => {
    assert.equal(run2({ matchTopN: 2, soonFreeSec: 30 }), "B");
  });
});
