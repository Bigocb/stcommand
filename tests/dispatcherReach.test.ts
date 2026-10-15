import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Local-only ships (reach "system") and the cross-system fleet share one dispatch. A local ship only ever gets a route
 * whose markets are both in its own system, and the cross-system ships choose first, so a local route never takes a
 * cross-system one away. See shipReach.ts.
 */

const route = (good: string, buySys: string, sellSys: string, profit: number): DispatchRoute => ({
  good,
  buyAt: `${buySys}-BUY`, sellAt: `${sellSys}-SELL`,
  buySystem: buySys, sellSystem: sellSys,
  buyPrice: 10, sellPrice: 100, profitPerTrip: profit,
} as unknown as DispatchRoute);

/** X1-A and X1-B are one gate apart. */
const canJump = (from: string, to: string) => [from, to].sort().join("|") === "X1-A|X1-B";

function assign(traders: { shipSymbol: string; capacity: number; system?: string; reach?: "any" | "system" }[], routes: DispatchRoute[]) {
  const d = new RouteDispatcher();
  d.recompute(routes, traders, [], [], [], [], canJump);
  return Object.fromEntries(traders.map((t) => [t.shipSymbol, d.assignmentFor(t.shipSymbol)?.good ?? null]));
}

describe("local-only ships", () => {
  it("never get a route that leaves their system, even when it is the richest on the board", () => {
    const got = assign(
      [{ shipSymbol: "LOCAL-1", capacity: 40, system: "X1-A", reach: "system" }],
      [route("GOLD", "X1-A", "X1-B", 900_000), route("FUEL", "X1-A", "X1-A", 5_000)],
    );
    assert.equal(got["LOCAL-1"], "FUEL");
  });

  it("are left idle rather than sent across a gate when only cross-system work exists", () => {
    const got = assign(
      [{ shipSymbol: "LOCAL-1", capacity: 40, system: "X1-A", reach: "system" }],
      [route("GOLD", "X1-A", "X1-B", 900_000)],
    );
    assert.equal(got["LOCAL-1"], null);
  });

  it("do not take a cross-system route from the cross-system fleet", () => {
    const got = assign(
      [
        { shipSymbol: "LOCAL-1", capacity: 80, system: "X1-A", reach: "system" },
        { shipSymbol: "CROSS-1", capacity: 40, system: "X1-A" },
      ],
      [route("GOLD", "X1-A", "X1-B", 900_000), route("FUEL", "X1-A", "X1-A", 5_000)],
    );
    assert.equal(got["CROSS-1"], "GOLD", "the cross-system ship keeps the cross route even though the bigger local ship ranks first");
    assert.equal(got["LOCAL-1"], "FUEL");
  });

  it("an any-ship is unchanged: it still takes cross-system work", () => {
    const got = assign(
      [{ shipSymbol: "CROSS-1", capacity: 40, system: "X1-A", reach: "any" }],
      [route("GOLD", "X1-A", "X1-B", 900_000)],
    );
    assert.equal(got["CROSS-1"], "GOLD");
  });
});
