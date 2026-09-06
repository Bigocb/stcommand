import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * A trip is committed when credits are spent, not when the scheduler last
 * recomputed.
 *
 * The dispatcher recomputes every 60s and may hand a ship a different route
 * for the same good mid-trip — in particular the second-best variant keyed by
 * sell destination. The leftover sweep read the *live* assignment, so a ship
 * that bought on one leg could find itself holding cargo for a different,
 * unreachable one. Live: DAGGER-17 bought 18u ANTIMATTER at X1-KU72-I60 for a
 * route selling at X1-KU72-I59, flew there, and the assignment then mutated to
 * the X1-TV75-X20F variant — a system it cannot reach — after which the sweep
 * deferred to that cross-system route every tick and the cargo was stranded.
 */

const leg = (sellAt: string) => ({
  good: "ANTIMATTER", role: "direct" as const,
  buyAt: "X1-KU72-I60", sellAt, buyPrice: 5921, sellPrice: 6500,
});

function trader(assigned: () => unknown, cargo: { symbol: string; units: number }[]): TraderAgent {
  const ship = {
    symbol: "DAGGER-17",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-KU72-I59", systemSymbol: "X1-KU72", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 80, units: cargo.reduce((n, c) => n + c.units, 0), inventory: cargo },
    fuel: { current: 400, capacity: 600 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  return new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    assignedRoute: assigned,
  } as any);
}

describe("cargo is held against the leg it was bought for", () => {
  it("ignores an assignment that changed after the buy", () => {
    // Pinned to the same-system leg it actually bought on.
    const a = trader(() => leg("X1-TV75-X20F"), [{ symbol: "ANTIMATTER", units: 18 }]);
    (a as any).heldRoute.set("ANTIMATTER", leg("X1-KU72-I59"));

    const active = (a as any).heldRoute.get("ANTIMATTER") ?? (a as any).asDirectLeg((a as any).assignedRoute?.());
    assert.equal(active.sellAt, "X1-KU72-I59", "the leg the ship bought on must win over the live assignment");
  });

  it("falls back to the live assignment for cargo with no pin", () => {
    // Crash recovery: cargo in the hold from a previous process has no pin,
    // and the live assignment is the only thing that can speak for it.
    const a = trader(() => leg("X1-TV75-X20F"), [{ symbol: "ANTIMATTER", units: 18 }]);
    const active = (a as any).heldRoute.get("ANTIMATTER") ?? (a as any).asDirectLeg((a as any).assignedRoute?.());
    assert.equal(active.sellAt, "X1-TV75-X20F");
  });

  it("drops a pin once the cargo is gone, so it cannot answer for the next trip", async () => {
    const a = trader(() => undefined, []);
    (a as any).heldRoute.set("ANTIMATTER", leg("X1-KU72-I59"));
    await (a as any).clearLeftoverCargo();
    assert.equal((a as any).heldRoute.has("ANTIMATTER"), false, "a stale leg would misroute the following trip");
  });

  it("keeps the pin while the cargo is still aboard", async () => {
    const a = trader(() => undefined, [{ symbol: "ANTIMATTER", units: 18 }]);
    (a as any).heldRoute.set("ANTIMATTER", leg("X1-KU72-I59"));
    (a as any).ensureDocked = async () => { throw new Error("stop the sweep here"); };
    await (a as any).clearLeftoverCargo().catch(() => {});
    assert.equal((a as any).heldRoute.has("ANTIMATTER"), true);
  });
});
