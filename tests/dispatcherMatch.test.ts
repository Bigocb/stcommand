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
