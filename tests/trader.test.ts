import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * Covers the fix for the contract-goods-get-dumped bug: TraderAgent had no
 * deliverCargo hook at all (only ShipAgent did) and clearLeftoverCargo()
 * never consulted protectedGoods(), so any contract-deliverable good that
 * ended up in a trader's hold was sold — or jettisoned, if no market would
 * buy it — on the very next tick. tick()'s pre-existing buy/sell/route
 * logic itself has no test coverage (see traderNextTask.test.ts's own
 * comment on that); these only exercise what changed.
 */

function makeShip(cargo: { symbol: string; units: number }[] = []): Ship {
  const units = cargo.reduce((sum, i) => sum + i.units, 0);
  return {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units, inventory: cargo },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

describe("TraderAgent.tick: contract delivery priority", () => {
  it("checks deliverCargo before clearLeftoverCargo — a ship holding contract cargo gets delivered, not swept for sale", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let sold = false;
    let delivered = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        sellCargo: async () => { sold = true; return { cargo: ship.cargo, transaction: {} } as any; },
      } as any,
      deliverCargo: async () => { delivered = true; return true; },
    });

    const made = await trader.tick();

    assert.equal(delivered, true, "deliverCargo must be called");
    assert.equal(sold, false, "the held-for-delivery cargo must never reach the sell path");
    assert.equal(made, true);
  });

  it("navigates toward the delivery destination when deliverCargo returns a waypoint, without touching clearLeftoverCargo", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let sold = false;
    let navigated: string | undefined;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        navigateShip: async (_s: string, wp: string) => { navigated = wp; return { nav: { ...ship.nav, status: "IN_TRANSIT", route: { arrival: new Date().toISOString(), destination: { symbol: wp } } } } as any; },
        orbitShip: async () => ({ nav: { ...ship.nav, status: "IN_ORBIT" } } as any),
        dockShip: async () => ({ nav: { ...ship.nav, status: "DOCKED" } } as any),
        sellCargo: async () => { sold = true; return { cargo: ship.cargo, transaction: {} } as any; },
      } as any,
      deliverCargo: async (s) => (s.nav.waypointSymbol === "X1-A-A2" ? true : "X1-A-A2"),
    });
    // Avoid needing a full navigateTo()/waitForArrival() simulation — this
    // test only cares that deliverCargo's routing wins over clearLeftoverCargo,
    // not the mechanics of flying there.
    (trader as any).navigateTo = async (wp: string) => { navigated = wp; };
    (trader as any).ensureDocked = async () => {};

    const made = await trader.tick();

    assert.equal(navigated, "X1-A-A2");
    assert.equal(sold, false);
    assert.equal(made, true);
  });

  it("without a deliverCargo hook, falls through to clearLeftoverCargo exactly as before", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let sold = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        sellCargo: async () => { sold = true; return { cargo: { ...ship.cargo, units: 0, inventory: [] }, transaction: { pricePerUnit: 5, totalPrice: 25 } } as any; },
      } as any,
    });

    await trader.tick();

    assert.equal(sold, true, "with no deliverCargo hook wired in, leftover cargo must still be sellable");
  });
});

describe("TraderAgent.tick: clearLeftoverCargo respects protectedGoods", () => {
  it("never sells or jettisons a protectedGoods-listed leftover item", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let sold = false;
    let jettisoned = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        sellCargo: async () => { sold = true; return { cargo: ship.cargo, transaction: {} } as any; },
        jettisonCargo: async () => { jettisoned = true; return { cargo: ship.cargo } as any; },
      } as any,
      protectedGoods: () => new Set(["IRON_ORE"]),
    });

    await trader.tick();

    assert.equal(sold, false);
    assert.equal(jettisoned, false);
  });

  it("still sells a non-protected leftover item normally", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let sold = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        sellCargo: async () => { sold = true; return { cargo: { ...ship.cargo, units: 0, inventory: [] }, transaction: { pricePerUnit: 5, totalPrice: 25 } } as any; },
      } as any,
      protectedGoods: () => new Set(["SOME_OTHER_GOOD"]),
    });

    await trader.tick();

    assert.equal(sold, true);
  });

  it("sells an unprotected item while leaving a protected item untouched, when both are in the hold", async () => {
    const ship = makeShip([
      { symbol: "IRON_ORE", units: 5 }, // protected — must survive
      { symbol: "COPPER_ORE", units: 3 }, // not protected — sellable
    ]);
    const sold: string[] = [];
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        sellCargo: async (_s: string, good: string) => {
          sold.push(good);
          return { cargo: { ...ship.cargo, inventory: ship.cargo.inventory.filter((i) => i.symbol !== good) }, transaction: { pricePerUnit: 5, totalPrice: 15 } } as any;
        },
      } as any,
      protectedGoods: () => new Set(["IRON_ORE"]),
    });

    await trader.tick();

    assert.deepEqual(sold, ["COPPER_ORE"]);
  });
});

describe("TraderAgent.discoverPrices: reachability", () => {
  it("picks a same-system market without ever calling getConstruction", async () => {
    const ship = makeShip();
    let constructionChecked = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getConstruction: async () => { constructionChecked = true; return { isComplete: true } as any; },
      } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
    });
    (trader as any).navigateTo = async () => {};
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, true);
    assert.equal(constructionChecked, false, "same-system reachability must not need a construction check at all");
  });

  it("skips a cross-system market when no gate connection is known", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => [] } as any,
    });
    let navigated = false;
    (trader as any).navigateTo = async () => { navigated = true; };

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, false, "with no reachable market at all, this must report no progress — that's what gives nextTask() its 30s backoff instead of looping with zero delay");
    assert.equal(navigated, false);
  });

  it("skips a cross-system market whose gate is still under construction", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getConstruction: async () => ({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 10 }] } as any),
      } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => ["X1-A-GATE"] } as any,
    });
    let navigated = false;
    (trader as any).navigateTo = async () => { navigated = true; };

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, false, "an under-construction gate must not be treated as reachable, even though atlas.gatesTo() found a connection");
    assert.equal(navigated, false);
  });

  it("uses a cross-system market once its gate is complete", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getConstruction: async () => ({ isComplete: true, materials: [] } as any),
      } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => ["X1-A-GATE"] } as any,
    });
    let navigatedTo: string | undefined;
    (trader as any).navigateTo = async (wp: string) => { navigatedTo = wp; };
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, true);
    assert.equal(navigatedTo, "X1-B-A2");
  });

  it("treats a gate with no construction record (already built) as reachable", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getConstruction: async () => { throw new Error("404: no construction record"); },
      } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => ["X1-A-GATE"] } as any,
    });
    let navigatedTo: string | undefined;
    (trader as any).navigateTo = async (wp: string) => { navigatedTo = wp; };
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, true);
    assert.equal(navigatedTo, "X1-B-A2");
  });

  it("visits a preferred market with no cached price yet, instead of requiring it to already be known", async () => {
    // Reproduces the reported live bug: runArbitrage() passes the
    // dispatcher's assigned buyAt/sellAt as `preferred` specifically when
    // viableRoute() rejected the assignment for lacking a cached price at
    // that market — so requiring `preferred` to already be a known/fresh
    // market (the old behavior) excluded the one case this exists for,
    // leaving the trader silently idle with no log line and an assignment
    // it could never act on.
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [], // nothing known yet — no other ship has priced this market
    });
    let navigatedTo: string | undefined;
    (trader as any).navigateTo = async (wp: string) => { navigatedTo = wp; };
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    const made = await (trader as any).discoverPrices(["X1-A-A9"]); // same system as the ship — no gate needed

    assert.equal(made, true, "an assigned-but-unpriced same-system market must still be visited, not silently skipped");
    assert.equal(navigatedTo, "X1-A-A9");
  });

  it("prefers a reachable preferred market over an unreachable one, instead of dropping preferred cross-system markets outright", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getConstruction: async () => ({ isComplete: true, materials: [] } as any),
      } as any,
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 },
        { waypointSymbol: "X1-A-A9", goodSymbol: "COPPER", purchasePrice: 3, sellPrice: 6, tradeVolume: 10 },
      ],
      atlas: { gatesTo: () => ["X1-A-GATE"] } as any,
    });
    let navigatedTo: string | undefined;
    (trader as any).navigateTo = async (wp: string) => { navigatedTo = wp; };
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    // The caller's preferred market is the cross-system one — a completed
    // gate makes it reachable, so it must win over the same-system market
    // even though it's listed second, since "preferred" comes first.
    const made = await (trader as any).discoverPrices(["X1-B-A2"]);

    assert.equal(made, true);
    assert.equal(navigatedTo, "X1-B-A2");
  });
});

describe("TraderAgent: stranded flag self-clears once fuel is real again", () => {
  it("clears on the next tick once fuel.current > 0, without needing a tender rescue", async () => {
    const ship = makeShip();
    ship.fuel = { current: 100, capacity: 100 } as any; // e.g. an operator's manual Refuel, or the ship topped off itself
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
    trader.markStranded();
    assert.equal(trader.isStranded(), true, "sanity: starts stranded");

    await trader.tick();

    assert.equal(trader.isStranded(), false, "real fuel is the ground truth — the dashboard must not keep reporting a rescued/refueled ship as stranded forever");
  });

  it("stays stranded while fuel.current is genuinely still 0", async () => {
    const ship = makeShip();
    ship.fuel = { current: 0, capacity: 100 } as any;
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
    trader.markStranded();

    await trader.tick();

    assert.equal(trader.isStranded(), true, "must not clear itself while the ship genuinely still can't move");
  });
});

describe("TraderAgent.viableRoute: fuel tank capacity bounds", () => {
  function makeTraderAt(waypoint: string, fuelCapacity: number) {
    const ship = makeShip();
    ship.nav = { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-A" } as any;
    ship.fuel = { current: fuelCapacity, capacity: fuelCapacity } as any;
    return new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
  }

  function seedPrices(trader: TraderAgent, buyAt: string, sellAt: string, good = "COPPER_ORE") {
    (trader as any).priceTable.set(buyAt, new Map([
      [good, { buy: 10, sell: 12, volume: 40 }],
      ["FUEL", { buy: 72, sell: 72, volume: 100 }],
    ]));
    (trader as any).priceTable.set(sellAt, new Map([
      [good, { buy: 8, sell: 30, volume: 40 }],
    ]));
  }

  it("rejects the route when here → buyAt exceeds the ship's fuel capacity", () => {
    const trader = makeTraderAt("X1-A-A1", 50);
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 70, y: 0 },
      { symbol: "X1-A-A3", x: 5, y: 0 },
    ]);
    seedPrices(trader, "X1-A-A2", "X1-A-A3");

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-A-A3" });

    assert.equal(route, undefined, "a leg longer than the fuel tank capacity can never be flown, even with a full tank");
  });

  it("rejects the route when buyAt → sellAt exceeds the ship's fuel capacity", () => {
    const trader = makeTraderAt("X1-A-A1", 50);
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 5, y: 0 },
      { symbol: "X1-A-A3", x: 70, y: 0 },
    ]);
    seedPrices(trader, "X1-A-A2", "X1-A-A3");

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-A-A3" });

    assert.equal(route, undefined, "the loaded return leg must also fit in the tank");
  });

  it("accepts the route when both legs fit within the ship's fuel capacity", () => {
    const trader = makeTraderAt("X1-A-A1", 50);
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 10, y: 0 },
      { symbol: "X1-A-A3", x: 20, y: 0 },
    ]);
    seedPrices(trader, "X1-A-A2", "X1-A-A3");

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-A-A3" });

    assert.ok(route, "a profitable route whose legs both fit in the tank must be viable");
    assert.equal(route.good, "COPPER_ORE");
    assert.equal(route.buyAt, "X1-A-A2");
    assert.equal(route.sellAt, "X1-A-A3");
  });
});

describe("TraderAgent.canReachMarket: same-system fuel capacity", () => {
  function makeTraderAt(waypoint: string, fuelCapacity: number) {
    const ship = makeShip();
    ship.nav = { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-A" } as any;
    ship.fuel = { current: fuelCapacity, capacity: fuelCapacity } as any;
    return new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
  }

  it("returns false for a same-system market farther than the ship's fuel capacity", async () => {
    const trader = makeTraderAt("X1-A-A1", 50);
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 70, y: 0 },
    ]);

    const reachable = await (trader as any).canReachMarket("X1-A-A2");

    assert.equal(reachable, false, "a same-system market beyond tank capacity is not reachable by navigate");
  });

  it("returns true for a same-system market within the ship's fuel capacity", async () => {
    const trader = makeTraderAt("X1-A-A1", 100);
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 30, y: 0 },
    ]);

    const reachable = await (trader as any).canReachMarket("X1-A-A2");

    assert.equal(reachable, true, "a same-system market within tank capacity is reachable");
  });
});
