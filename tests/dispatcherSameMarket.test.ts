import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * A route that buys and sells at the same waypoint is never handed to a trader, even when it is the richest on the board.
 * (THEO-22 X1-NK98-D12D>X1-NK98-D12D lost 855,816 in two hours.)
 */
const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt,
  buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 10, sellPrice: 100, profitPerTrip: profit,
} as unknown as DispatchRoute);

function assign(routes: DispatchRoute[]) {
  const d = new RouteDispatcher();
  const traders = [{ shipSymbol: "T-1", capacity: 40, system: "X1-A" }];
  d.recompute(routes, traders, [], [], [], [], () => false);
  return d.assignmentFor("T-1")?.good ?? null;
}

describe("same-market routes", () => {
  it("are never assigned, even when they are the best-paying route", () => {
    const got = assign([route("MICRO", "X1-A-D12D", "X1-A-D12D", 900_000), route("FUEL", "X1-A-B1", "X1-A-C2", 5_000)]);
    assert.equal(got, "FUEL");
  });

  it("leave the ship idle when a same-market route is all that exists", () => {
    assert.equal(assign([route("MICRO", "X1-A-D12D", "X1-A-D12D", 900_000)]), null);
  });
});
