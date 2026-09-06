import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";

/**
 * Rule 5 at the sites the trader's fix left behind.
 *
 * `assertAt` was added to trader.ts after DAGGER-F spent twenty minutes
 * buying and selling at markets in systems it was not in, losing 9,036c a
 * cycle. That fixed one role. Three more transaction sites had the same
 * exposure and no guard:
 *
 *   - ShipAgent.executeArbitrage() — buy, navigate, sell, straight through,
 *     the identical shape to the trader's runArbitrage()
 *   - ShipAgent.sellAllCargo() — called after a navigate whose return value
 *     the caller never inspects
 *   - SiphonerAgent.sellAllCargo() — same, one dock later
 *
 * These pin the guard at each of them. The assertion is not that an error is
 * raised for its own sake: it is that a sale which would have happened at the
 * wrong market does not happen at all.
 */

function minerShip(waypointSymbol = "X1-A-A1"): Ship {
  return {
    symbol: "MINER-1",
    nav: { status: "DOCKED", waypointSymbol, systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity: 40, units: 12, inventory: [{ symbol: "IRON_ORE", units: 12 }] },
    fuel: { current: 100, capacity: 100 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
}

/** An API that fails the test if any transaction reaches it. */
function noTransactions() {
  return {
    getCallCount: () => 0,
    purchaseCargo: async () => { throw new Error("purchaseCargo must never be reached at the wrong waypoint"); },
    sellCargo: async () => { throw new Error("sellCargo must never be reached at the wrong waypoint"); },
  } as any;
}

describe("a miner refuses to trade anywhere but where the plan says it is", () => {
  const route = {
    good: "IRON_ORE", buyAt: "X1-A-MARKET", sellAt: "X1-A-FAR",
    buyPrice: 10, sellPrice: 90, units: 12, profit: 900,
  };

  it("does not buy when the ship never reached the buy market", async () => {
    const agent = new ShipAgent(minerShip("X1-A-ASTEROID"), { api: noTransactions() });
    // Docking is a no-op where it already is; the refuel path must not be the
    // thing that saves us, so stub both out and let the guard be the only
    // thing standing between this and a purchase.
    (agent as any).ensureDocked = async () => {};
    (agent as any).refuelIfNeeded = async () => true;
    await assert.rejects(
      () => (agent as any).executeArbitrage(route),
      /refusing to buy IRON_ORE at X1-A-MARKET: ship is at X1-A-ASTEROID/,
    );
  });

  it("does not sell when the navigate to the sell market did not arrive", async () => {
    // The leg that carries the loss: the buy succeeded, so the hold now has
    // cargo bought at the buy price, and selling it back at the buy market is
    // a guaranteed loss dressed up as a completed arbitrage.
    const ship = minerShip("X1-A-MARKET");
    const agent = new ShipAgent(ship, {
      api: {
        getCallCount: () => 0,
        purchaseCargo: async () => ({
          cargo: { capacity: 40, units: 12, inventory: [{ symbol: "IRON_ORE", units: 12 }] },
          transaction: { pricePerUnit: 10, totalPrice: 120 },
        }),
        sellCargo: async () => { throw new Error("sellCargo must never be reached at the wrong waypoint"); },
      } as any,
    });
    (agent as any).ensureDocked = async () => {};
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async () => {}; // the silent failure this guards
    await assert.rejects(
      () => (agent as any).executeArbitrage(route),
      /refusing to sell IRON_ORE at X1-A-FAR: ship is at X1-A-MARKET/,
    );
  });

  it("completes the arbitrage when the ship really does travel", async () => {
    const ship = minerShip("X1-A-MARKET");
    const agent = new ShipAgent(ship, {
      api: {
        getCallCount: () => 0,
        purchaseCargo: async () => ({
          cargo: { capacity: 40, units: 12, inventory: [{ symbol: "IRON_ORE", units: 12 }] },
          transaction: { pricePerUnit: 10, totalPrice: 120 },
        }),
        sellCargo: async () => ({
          cargo: { capacity: 40, units: 0, inventory: [] },
          transaction: { pricePerUnit: 90, totalPrice: 1080 },
        }),
      } as any,
    });
    (agent as any).ensureDocked = async () => {};
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async (wp: string) => {
      (agent as any).proxy.setShip({ ...(agent as any).ship, nav: { ...(agent as any).ship.nav, waypointSymbol: wp } });
      (agent as any).ship = (agent as any).proxy.getShip();
    };
    assert.equal(await (agent as any).executeArbitrage(route), true, "the guard must not block a legitimate trip");
  });
});

describe("sellAllCargo will not dump the hold at the wrong market", () => {
  it("miner: throws rather than selling ore where it was mined", async () => {
    const agent = new ShipAgent(minerShip("X1-A-ASTEROID"), { api: noTransactions() });
    await assert.rejects(
      () => (agent as any).sellAllCargo("X1-A-MARKET"),
      /refusing to sell cargo at X1-A-MARKET: ship is at X1-A-ASTEROID/,
      "a miner whose trip to market never happened would otherwise sell at whatever the API found",
    );
  });

  it("siphoner: throws rather than selling gases at the siphon site", async () => {
    const ship = {
      symbol: "SIPH-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-GASGIANT", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
      cargo: { capacity: 40, units: 8, inventory: [{ symbol: "HYDROCARBON", units: 8 }] },
      fuel: { current: 100, capacity: 100 },
      cooldown: { remainingSeconds: 0 },
      mounts: [], modules: [],
    } as any;
    const agent = new SiphonerAgent(ship, { api: noTransactions() });
    await assert.rejects(
      () => (agent as any).sellAllCargo("X1-A-MARKET"),
      /refusing to sell cargo at X1-A-MARKET: ship is at X1-A-GASGIANT/,
    );
  });

  it("sells normally once the ship is actually at the market", async () => {
    let sold = 0;
    const agent = new ShipAgent(minerShip("X1-A-MARKET"), {
      api: {
        getCallCount: () => 0,
        sellCargo: async () => {
          sold += 1;
          return { cargo: { capacity: 40, units: 0, inventory: [] }, transaction: { pricePerUnit: 40, totalPrice: 480 } };
        },
      } as any,
    });
    await (agent as any).sellAllCargo("X1-A-MARKET");
    assert.equal(sold, 1, "the guard must not stand between a docked ship and its own market");
  });
});
