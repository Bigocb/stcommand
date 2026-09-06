import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * A movement primitive that cannot move the ship must not return normally.
 *
 * jumpToSystem() used to log and return on every failure, which reads to the
 * caller exactly like arrival — and the caller's next moves are ensureDocked()
 * and a purchase or sale. DAGGER-F ran that loop for over twenty minutes:
 * sitting in X1-ZU53, "no jump gate from X1-ZU53 to X1-TV75", then buying at
 * X1-RD37-D20E and selling at X1-TV75-X20F, two markets in two other systems
 * it was not at, losing 9,036c a cycle.
 */

function trader(atlas: any, assigned?: any): TraderAgent {
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-ZU53-A1", systemSymbol: "X1-ZU53", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  return new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    atlas,
    ...(assigned ? { assignedRoute: () => assigned } : {}),
  } as any);
}

describe("a jump that cannot happen fails loudly", () => {
  it("throws when there is no gate to the target system", async () => {
    const a = trader({ gatesTo: () => [], scanJumpGates: async () => {}, canJump: () => true });
    await assert.rejects(
      () => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"),
      /no jump gate from X1-ZU53 to X1-TV75/,
      "returning here let the caller buy and sell at the wrong market",
    );
  });

  it("throws when the target system has no gate waypoint", async () => {
    const a = trader({
      gatesTo: () => ["X1-ZU53-GATE"],
      loadSystem: async () => ({ waypoints: [{ symbol: "X1-TV75-A1", type: "PLANET" }] }),
    });
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /no jump gate waypoint/);
  });

  it("throws when the atlas returns a gate outside the current system", async () => {
    const a = trader({ gatesTo: () => ["X1-OTHER-GATE"] });
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /is not in X1-ZU53/);
  });

  it("throws with no atlas at all, rather than reporting arrival", async () => {
    const a = trader(undefined);
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /no galaxy atlas/);
  });

  it("retires the route so the dispatcher stops re-issuing an unreachable leg", async () => {
    // Otherwise the throw is honest but useless: the same leg comes back next
    // tick and the ship fails on it forever — the same loop with an error line
    // where the loss used to be.
    const assigned = { good: "ANTIMATTER", role: "direct", buyAt: "X1-RD37-D20E", sellAt: "X1-TV75-X20F", buyPrice: 5919, sellPrice: 5417 };
    const a = trader({ gatesTo: () => [], scanJumpGates: async () => {} }, assigned);
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"));
    assert.ok((a as any).deadRoutes.has("ANTIMATTER@X1-RD37-D20E"), "the unreachable leg must not be retried");
  });
});

describe("a trader refuses to transact anywhere but where the plan says it is", () => {
  // The class the jump fix closes only one case of. A trade runs straight
  // through — navigate, dock, buy, navigate, dock, sell — with no diff between
  // statements, so any movement that quietly fails leaves every later
  // statement acting on the plan's waypoint instead of the ship's.
  // mission.ts and stepRescue() are safe because they re-check position each
  // step; this is that same precondition for the one role that does not.
  it("throws instead of trading at whatever market it happens to be standing on", () => {
    const a = trader({});
    assert.throws(
      () => (a as any).assertAt("X1-RD37-D20E", "buy ANTIMATTER"),
      /refusing to buy ANTIMATTER at X1-RD37-D20E: ship is at X1-ZU53-A1/,
      "this is the check that would have caught DAGGER-F on its first cycle",
    );
  });

  it("permits the transaction when the ship really is there", () => {
    const a = trader({});
    assert.doesNotThrow(() => (a as any).assertAt("X1-ZU53-A1", "sell ANTIMATTER"));
  });
});

describe("a route must start somewhere the ship can actually get to", () => {
  // The dispatcher and viableRoute both validated buy↔sell — the pair the
  // route is made of — and neither validated here→buy, the leg the ship flies
  // first. When X1-RD37 was surveyed its fresh spreads took over the top of
  // the value list, and all six traders were handed routes starting in a
  // system none of them could reach: a ~20-second error loop, nothing trading.
  const legIn = (buySys: string) => ({
    good: "MEDICINE", role: "direct" as const,
    buyAt: `${buySys}-XC5A`, sellAt: `${buySys}-DX2F`, buyPrice: 100, sellPrice: 900,
  });

  function agentAt(homeSystem: string, reachable: readonly string[]) {
    const a = trader({
      canJump: (from: string, to: string) => from === homeSystem && reachable.includes(to),
      gatesTo: () => ["G"],
    });
    const t = (a as any).priceTable as Map<string, Map<string, any>>;
    for (const sys of ["X1-RD37", "X1-ZU53"]) {
      t.set(`${sys}-XC5A`, new Map([["MEDICINE", { buy: 100, sell: 90, volume: 40 }]]));
      t.set(`${sys}-DX2F`, new Map([["MEDICINE", { buy: 950, sell: 900, volume: 40 }]]));
    }
    (a as any).distBetween = () => 10;
    (a as any).getCredits = () => 10_000_000;
    return a;
  }

  it("rejects a rich route in a system the ship cannot jump to", () => {
    // Ship is in X1-ZU53; X1-RD37 is not one gate away.
    const a = agentAt("X1-ZU53", []);
    assert.equal((a as any).viableRoute(legIn("X1-RD37")), undefined,
      "both ends connect to each other, but the hull cannot reach either");
  });

  it("accepts the same route once that system is one gate away", () => {
    const a = agentAt("X1-ZU53", ["X1-RD37"]);
    assert.ok((a as any).viableRoute(legIn("X1-RD37")), "a genuinely reachable leg must still be taken");
  });

  it("still accepts a route entirely inside the ship's own system", () => {
    const a = agentAt("X1-ZU53", []);
    assert.ok((a as any).viableRoute(legIn("X1-ZU53")), "local trade must not be collateral damage");
  });

  it("retires an unreachable leg from either end, not just the sell end", () => {
    const a = trader({ gatesTo: () => [], scanJumpGates: async () => {} },
      { good: "MEDICINE", role: "direct", buyAt: "X1-RD37-XC5A", sellAt: "X1-KU72-D47", buyPrice: 1, sellPrice: 2 });
    (a as any).markRouteUnreachable("X1-RD37");
    assert.ok((a as any).deadRoutes.has("MEDICINE@X1-RD37-XC5A"), "the buy-side case looped before this");
  });
});
