import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Node affinity for the trade scheduler.
 *
 * `work` is ranked by profit alone, and the assignment loop used to hand every
 * trader the globally best unclaimed item regardless of where that ship was.
 * When X1-RD37 was first surveyed, its fresh spreads took nine of the top
 * twelve slots and all six traders were assigned routes starting in a system
 * none of them could reach: a ~20-second error loop with nothing trading.
 */

const route = (good: string, sys: string, profit: number): DispatchRoute => ({
  good,
  buyAt: `${sys}-BUY`, sellAt: `${sys}-SELL`,
  buySystem: sys, sellSystem: sys,
  buyPrice: 10, sellPrice: 100, profitPerTrip: profit,
} as unknown as DispatchRoute);

/** Only X1-KU72 <-> X1-ZU53 have a gate; X1-RD37 is unreachable from both. */
const canJump = (from: string, to: string) =>
  (from === "X1-KU72" && to === "X1-ZU53") || (from === "X1-ZU53" && to === "X1-KU72");

function assign(traders: { shipSymbol: string; capacity: number; system?: string }[], routes: DispatchRoute[]) {
  const d = new RouteDispatcher();
  d.recompute(routes, traders, [], [], [], [], canJump);
  return traders.map((t) => [t.shipSymbol, d.assignmentFor(t.shipSymbol)?.good] as const);
}

describe("the dispatcher assigns work a ship can actually start", () => {
  it("passes over a richer route in an unreachable system", () => {
    const got = assign(
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72" }],
      [route("MEDICINE", "X1-RD37", 18072), route("FUEL", "X1-KU72", 6601)],
    );
    assert.deepEqual(got, [["T-1", "FUEL"]], "the reachable route earns less but is the only one that can be flown");
  });

  it("takes the richer route when the ship is one gate from it", () => {
    const got = assign(
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72" }],
      [route("MEDICINE", "X1-ZU53", 18072), route("FUEL", "X1-KU72", 6601)],
    );
    assert.deepEqual(got, [["T-1", "MEDICINE"]], "one gate away is reachable, and profit should still win");
  });

  it("does not let one freshly-surveyed system capture the whole fleet", () => {
    // The live shape: several rich routes in an unreachable system, a couple
    // of ordinary ones at home, and every trader standing at home.
    const traders = ["T-1", "T-2", "T-3"].map((s) => ({ shipSymbol: s, capacity: 40, system: "X1-KU72" }));
    const got = assign(traders, [
      route("MEDICINE", "X1-RD37", 18072),
      route("MACHINERY", "X1-RD37", 13128),
      route("EQUIPMENT", "X1-RD37", 9672),
      route("FUEL", "X1-KU72", 6601),
      route("COPPER", "X1-KU72", 1005),
    ]);
    const goods = got.map(([, g]) => g).filter(Boolean);
    assert.ok(goods.includes("FUEL") && goods.includes("COPPER"),
      `both reachable routes must be worked, got ${JSON.stringify(goods)}`);
  });

  it("still assigns distant work rather than idling when there is nothing else", () => {
    // The trader's own viableRoute() is the authority that declines it; the
    // dispatcher should not silently park a hull.
    const got = assign(
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72" }],
      [route("MEDICINE", "X1-RD37", 18072)],
    );
    assert.deepEqual(got, [["T-1", "MEDICINE"]]);
  });

  it("behaves exactly as before for a trader whose system is unknown", () => {
    const got = assign(
      [{ shipSymbol: "T-1", capacity: 40 }],
      [route("MEDICINE", "X1-RD37", 18072), route("FUEL", "X1-KU72", 6601)],
    );
    assert.deepEqual(got, [["T-1", "MEDICINE"]], "no locality information means rank by profit, as before");
  });
});
