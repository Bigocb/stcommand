import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * The per-speed route-shape clause (docs/slow-hull-local-routes-spec.md). A hull at or below `slowHullSpeed` may only be
 * offered a loaded leg and an empty positioning leg up to its caps; fast hulls keep the old behaviour, and manual routes
 * are never gated. Topology: X1-B is one gate from home X1-A, X1-C is two.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const canJump = (from: string, to: string): boolean =>
  (from === "X1-A" && to === "X1-B") || (from === "X1-B" && to === "X1-A");
const path = (from: string, to: string): string[] | undefined => {
  const legs: Record<string, string[]> = {
    "X1-A>X1-C": ["X1-A", "X1-B", "X1-C"],
    "X1-C>X1-A": ["X1-C", "X1-B", "X1-A"],
  };
  return legs[`${from}>${to}`];
};
const crossSystem = { enabled: true, path, hopCost: () => 5_000 };

const leg = (good: string, buyAt: string, sellAt: string, profit: number, tripSeconds = 600): DispatchRoute => ({
  good, buyAt, sellAt,
  buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")),
  sellSystem: sellAt.slice(0, sellAt.lastIndexOf("-")),
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const LOCAL = leg("FUEL", "X1-A-10", "X1-A-20", 50_000);
/** Buys in home, sells two gates away: a 2-gate loaded leg, no positioning. */
const TWO_GATE = leg("MEDICINE", "X1-A-10", "X1-C-20", 500_000, 1_500);
/** One gate away (allowed positioning at 1), same-system loaded leg. */
const NEAR = leg("FOOD", "X1-B-10", "X1-B-20", 400_000);
/** Two gates away (refused positioning at 1). */
const FAR = leg("EQUIPMENT", "X1-C-10", "X1-C-20", 400_000);

const ON = { slowHullSpeed: 15, slowHullHauledHops: 1, slowHullPositioningHops: 2 };

const ship = (symbol: string, speed: number, extra: Record<string, unknown> = {}) =>
  ({ shipSymbol: symbol, capacity: 40, speed, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5_000, ...extra });

function run(
  routes: DispatchRoute[],
  traders: ReturnType<typeof ship>[],
  tuning?: Record<string, unknown>,
  lines?: string[],
): RouteDispatcher {
  const d = new RouteDispatcher();
  d.recompute(routes, traders as never[], [], [], [], [], canJump, distance,
    lines ? (m) => lines.push(m) : undefined, undefined, crossSystem, tuning);
  return d;
}

describe("slow-hull route shape (clause slowHullHauledHops)", () => {
  it("on, a speed-15 hull is not offered a 2-gate loaded leg; a speed-36 hull is", () => {
    assert.equal(run([LOCAL, TWO_GATE], [ship("SLOW", 15)], ON).assignmentFor("SLOW")?.good, "FUEL",
      "the richer 2-gate leg is over the slow-hull limit, so the local route is taken");
    assert.equal(run([LOCAL, TWO_GATE], [ship("FAST", 36)], ON).assignmentFor("FAST")?.good, "MEDICINE",
      "a freighter is unaffected");
  });

  it("off (all caps undefined), the speed-15 hull flies the 2-gate leg as before", () => {
    assert.equal(run([LOCAL, TWO_GATE], [ship("SLOW", 15)], {}).assignmentFor("SLOW")?.good, "MEDICINE");
  });

  it("an unknown speed is treated as slow", () => {
    const d = run([LOCAL, TWO_GATE], [{ shipSymbol: "UNKNOWN", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5_000 } as never], ON);
    assert.equal(d.assignmentFor("UNKNOWN")?.good, "FUEL");
  });
});

describe("slow-hull route shape (clause slowHullPositioningHops)", () => {
  it("on, a slow hull may position one gate but not two", () => {
    const oneGate = { slowHullSpeed: 15, slowHullPositioningHops: 1 };
    assert.equal(run([LOCAL, NEAR], [ship("SLOW", 15)], oneGate).assignmentFor("SLOW")?.good, "FOOD", "one gate of empty flight is within the cap");
    assert.equal(run([LOCAL, FAR], [ship("SLOW", 15)], oneGate).assignmentFor("SLOW")?.good, "FUEL", "two gates of empty flight is not");
  });

  it("on, raising the cap to two opens the same route", () => {
    const twoGates = { slowHullSpeed: 15, slowHullPositioningHops: 2 };
    assert.equal(run([LOCAL, FAR], [ship("SLOW", 15)], twoGates).assignmentFor("SLOW")?.good, "EQUIPMENT");
  });

  it("a fast hull is not subject to the positioning cap", () => {
    assert.equal(run([LOCAL, FAR], [ship("FAST", 36)], { slowHullSpeed: 15, slowHullPositioningHops: 1 }).assignmentFor("FAST")?.good, "EQUIPMENT");
  });
});

describe("slow-hull route shape: manual routes and soon-free matching", () => {
  it("a manual route is never gated (assign_route is the operator's override)", () => {
    const d = new RouteDispatcher();
    d.setManual("SLOW", {
      shipSymbol: "SLOW", good: "MEDICINE", role: "direct", buyAt: "X1-A-10", sellAt: "X1-C-20",
      profitPerTrip: 500_000, source: "manual",
    });
    d.recompute([LOCAL, TWO_GATE], [ship("SLOW", 15) as never], [], [], [], [], canJump, distance, undefined, undefined, crossSystem, ON);
    assert.equal(d.assignmentFor("SLOW")?.good, "MEDICINE");
    assert.equal(d.assignmentFor("SLOW")?.source, "manual");
  });

  it("soon-free matching uses the soon-free hull's own speed", () => {
    // SOON is a speed-15 hull finishing at X1-C-20, 60s from now; the only other ship is a local-only hull at home that
    // cannot reach X1-C at all. A 2-gate loaded leg may only be held for SOON while the clause is off.
    const soon = ship("SOON", 15, { system: "X1-C", waypoint: "X1-C-1", busy: true, freeInSec: 60, freeAtWaypoint: "X1-C-20" });
    const home = ship("HOME", 36, { reach: "system" });
    const bad = leg("MEDICINE", "X1-C-10", "X1-A-20", 500_000, 1_500);
    const tuning = { ...ON, matchTopN: 2, soonFreeSec: 300 };

    const lines: string[] = [];
    run([bad], [soon, home], tuning, lines);
    assert.ok(!lines.some((l) => l.includes("kept for SOON")), `a 2-gate leg must not be held for a speed-15 hull: ${lines.join(" | ")}`);

    const off: string[] = [];
    run([bad], [soon, home], { matchTopN: 2, soonFreeSec: 300 }, off);
    assert.ok(off.some((l) => l.includes("kept for SOON")), `with the clause off the same leg is held for it: ${off.join(" | ")}`);
  });
});
