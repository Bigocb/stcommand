import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * A restart must not re-route a trader that is already flying an auto direct trip. Before this, the trip and its
 * commitment lived only in memory: after a restart an empty trader in transit to its buy market looked idle and was
 * handed the best route again, mid-flight.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const OLD = route("OLD", "X1-A-10", "X1-A-100", 40_000);
const BETTER = route("BETTER", "X1-A-20", "X1-A-200", 90_000);
const t1 = (over: Record<string, unknown> = {}) => ({ shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5000, ...over });

describe("dispatcher commitments across a restart", () => {
  it("an empty trader on its way to its buy market keeps its trip after a restart", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const before = new RouteDispatcher();
    before.recompute([OLD], [t1()], [], [], [], [], () => false, distance);
    assert.equal(before.assignmentFor("T-1")?.good, "OLD");
    const saved = before.commitmentsSnapshot();
    assert.ok(saved);
    assert.equal(before.commitmentsSnapshot(), undefined, "unchanged since the last save");

    // New process, same saved trips. The ship is empty and still short of OLD's buy market, and a better route now exists.
    const after = new RouteDispatcher();
    after.restoreCommitments(saved!);
    t.mock.timers.tick(60_001);
    after.recompute([BETTER, OLD], [t1()], [], [], [], [], () => false, distance);
    assert.equal(after.assignmentFor("T-1")?.good, "OLD", "kept on the trip it was already flying");
  });

  it("an empty trader with no saved trip picks fresh, as before", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.restoreCommitments("{\"trips\":[],\"committed\":[]}");
    d.recompute([BETTER, OLD], [t1()], [], [], [], [], () => false, distance);
    assert.equal(d.assignmentFor("T-1")?.good, "BETTER");
  });

  it("ignores a malformed saved commitment", () => {
    const d = new RouteDispatcher();
    d.restoreCommitments("not json at all");
    d.restoreCommitments(JSON.stringify({ trips: [["T-1", { nonsense: true }], 7, null], committed: ["x"] }));
    assert.equal(d.commitmentsSnapshot(), undefined);
  });
});
