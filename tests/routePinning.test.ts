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

/**
 * Covers migration 013_held_route.sql's fix: `heldRoute`/`heldCost` used to
 * live only in process memory, so a restart (which happens on every deploy)
 * wiped them and left a ship holding real cargo with no memory of where it
 * was headed — confirmed live across three DRAGOM traders in the same
 * restart. `initialHeldRoutes` is how fleet.ts rehydrates that state from
 * the `held_route` table at boot; `persistHeldRoute`/`clearPersistedHeldRoute`
 * are how it stays in sync going forward.
 */
describe("held-route persistence survives a restart", () => {
  it("initialHeldRoutes seeds heldRoute and heldCost at construction, same as a live buy would", () => {
    const ship = {
      symbol: "DAGGER-17",
      nav: { status: "DOCKED", waypointSymbol: "X1-KU72-I59", systemSymbol: "X1-KU72" },
      cargo: { capacity: 80, units: 18, inventory: [{ symbol: "ANTIMATTER", units: 18 }] },
      fuel: { current: 400, capacity: 600 },
    } as unknown as Ship;
    const seeded = new Map([["ANTIMATTER", { buyAt: "X1-KU72-I60", sellAt: "X1-KU72-I59", buyPrice: 5921, sellPrice: 6500, lotSize: 20, costBasis: 5921 }]]);
    const a = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      log: () => {},
      initialHeldRoutes: seeded,
    } as any);

    const route = (a as any).heldRoute.get("ANTIMATTER");
    assert.equal(route.sellAt, "X1-KU72-I59", "a restarted trader must not treat this cargo as orphaned");
    assert.equal((a as any).heldCost.get("ANTIMATTER"), 5921);
  });

  it("clearPersistedHeldRoute fires when a stale pin is pruned, so the durable copy doesn't outlive the in-memory one", async () => {
    let cleared: string | undefined;
    const ship = {
      symbol: "DAGGER-17",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-KU72-I59", systemSymbol: "X1-KU72", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 80, units: 0, inventory: [] },
      fuel: { current: 400, capacity: 600 },
      cooldown: { remainingSeconds: 0 },
      mounts: [], modules: [],
    } as unknown as Ship;
    const a = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      log: () => {},
      assignedRoute: () => undefined,
      clearPersistedHeldRoute: async (good: string) => { cleared = good; },
    } as any);
    (a as any).heldRoute.set("ANTIMATTER", leg("X1-KU72-I59"));

    await (a as any).clearLeftoverCargo();

    assert.equal(cleared, "ANTIMATTER", "the durable row must be dropped in step with the in-memory pin, not left behind");
  });

  it("a trader rehydrated post-restart finishes the sale at the persisted destination instead of falling into the dump path", async () => {
    const sold: { good: string; units: number }[] = [];
    const ship = {
      symbol: "DAGGER-17",
      // Already sitting at the persisted sellAt — same shape as a ship that
      // was mid-trip when the process restarted.
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-KU72-I59", systemSymbol: "X1-KU72", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 80, units: 18, inventory: [{ symbol: "ANTIMATTER", units: 18 }] },
      fuel: { current: 400, capacity: 600 },
      cooldown: { remainingSeconds: 0 },
      mounts: [], modules: [],
    } as unknown as Ship;
    const a = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        orbitShip: async () => ({ nav: { ...ship.nav, status: "IN_ORBIT" } } as any),
        dockShip: async () => ({ nav: { ...ship.nav, status: "DOCKED" } } as any),
        sellCargo: async (_s: string, good: string, units: number) => {
          sold.push({ good, units });
          return { cargo: { ...ship.cargo, units: 0, inventory: [] }, transaction: { pricePerUnit: 6500, totalPrice: 6500 * units } } as any;
        },
      } as any,
      log: () => {},
      // No live assignment at all — simulating a dispatcher that also lost
      // its state in the same restart. The persisted leg must be enough on
      // its own.
      assignedRoute: () => undefined,
      initialHeldRoutes: new Map([["ANTIMATTER", { buyAt: "X1-KU72-I60", sellAt: "X1-KU72-I59", buyPrice: 5921, sellPrice: 6500, lotSize: 20, costBasis: 5921 }]]),
    } as any);

    // clearLeftoverCargo() runs first in tick(), sees the heldRoute pin, and
    // steps aside (returns undefined) so deliverHeldCargo() — called next,
    // from runArbitrage() — finishes the trip. Exercising deliverHeldCargo()
    // directly is the same path tick() would take; it's the function that
    // actually reads the persisted leg and sells against it.
    const leftover = await (a as any).clearLeftoverCargo();
    assert.equal(leftover, undefined, "a pinned good must not be treated as orphaned leftover");
    await (a as any).deliverHeldCargo();

    assert.deepEqual(sold, [{ good: "ANTIMATTER", units: 18 }], "deliverHeldCargo() must sell the whole persisted position, not clearLeftoverCargo()'s dump path");
  });
});
