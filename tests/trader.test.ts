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
    // Real, close-together coordinates: the delivery-reachability guard
    // (trader.ts's contract-delivery branch) treats an unknown distance as
    // "can't confirm it's reachable" and skips, same as an actually-too-far
    // leg — this test cares about routing precedence, not distance, so it
    // needs real positions to fall through that guard cleanly.
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-A2", x: 1, y: 1 },
    ]);
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

  it("routes through a known fuel stop when the delivery destination is beyond single-hop range", async () => {
    // Confirmed live: a ship whose contract cargo purchase left it out of
    // single-hop range of the delivery destination just sat there holding
    // it forever, re-hitting the same "out of single-hop range; skipping
    // for now" log every tick — nothing here ever tried a multi-hop route,
    // even though the mission carrier path already handled the identical
    // problem (fleet.ts's dispatchShipHop).
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let navigated: string | undefined;
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      deliverCargo: async () => "X1-A-DEST",
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-A-HOP", goodSymbol: "FUEL", purchasePrice: 5, sellPrice: 2, tradeVolume: 100 },
      ],
    });
    // A1 -> DEST is 150 units, beyond the 100-fuel-capacity tank. HOP sits
    // 50 units out (reachable) and is a known fuel-selling market.
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-HOP", x: 50, y: 0 },
      { symbol: "X1-A-DEST", x: 150, y: 0 },
    ]);
    (trader as any).navigateTo = async (wp: string) => { navigated = wp; };

    const made = await trader.tick();

    assert.equal(navigated, "X1-A-HOP", "must route through the reachable fuel stop, not attempt the out-of-range direct leg");
    assert.equal(made, true);
  });

  it("gives up cleanly, without attempting the impossible direct leg, when no known fuel stop gets any closer", async () => {
    const ship = makeShip([{ symbol: "IRON_ORE", units: 5 }]);
    let navigateCalled = false;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        // Reached via clearLeftoverCargo()'s fallthrough after the hop
        // attempt declines — not this test's concern, just needs to not
        // crash on a good with no known live price.
        sellCargo: async () => ({ cargo: ship.cargo, transaction: {} }) as any,
        jettisonCargo: async () => ({ cargo: { ...ship.cargo, units: 0, inventory: [] } }) as any,
      } as any,
      deliverCargo: async () => "X1-A-DEST",
      getMarketSnapshots: async () => [], // no known fuel-selling markets anywhere
    });
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-DEST", x: 150, y: 0 },
    ]);
    (trader as any).navigateTo = async () => { navigateCalled = true; };

    // clearLeftoverCargo()'s own fallthrough handling of the undeliverable
    // cargo (sell/jettison) isn't this test's concern — only that the hop
    // logic itself never attempts the impossible direct leg.
    await trader.tick();

    assert.equal(navigateCalled, false, "must not attempt any navigate call when no route can work");
  });
});

describe("TraderAgent.tick: contractBuy respects the market's per-transaction limit", () => {
  it("caps the purchase at the market's tradeVolume instead of trying to buy the whole cargo hold at once", async () => {
    // Confirmed live: FALCON-D, manually assigned to buy SILVER for a
    // contract, retried the exact same purchase every ~2 minutes for over an
    // hour, always failing with "Trade good SILVER has a limit of 60 units
    // per transaction" — runContractBuy() computed units from cargo space
    // and affordability only, with no tradeVolume cap at all, unlike
    // runBuy()'s identical purchase path (line ~1025) which already respects
    // it. Cargo capacity (80) and affordability (both far above the
    // market's 60-unit limit) mean any request this test's mock rejects
    // above 60 reproduces the exact live failure.
    const ship = makeShip([]);
    ship.cargo.capacity = 80;
    let purchasedUnits: number | undefined;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getMyAgent: async () => ({ credits: 1_000_000 }) as any,
        purchaseCargo: async (_s: string, _g: string, units: number) => {
          purchasedUnits = units;
          if (units > 60) throw new Error("Market transaction failed. Trade good SILVER has a limit of 60 units per transaction.");
          return { cargo: { ...ship.cargo, units, inventory: [{ symbol: "SILVER", units }] }, transaction: { pricePerUnit: 400, totalPrice: units * 400 } } as any;
        },
      } as any,
      assignedRoute: () => ({ shipSymbol: "SHIP-1", good: "SILVER", role: "contractBuy", buyAt: "X1-A-A1", buyPrice: 400, profitPerTrip: 0, source: "manual" }),
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-A-A1", goodSymbol: "SILVER", purchasePrice: 400, sellPrice: 200, tradeVolume: 60 },
      ],
    });

    const made = await trader.tick();

    assert.equal(purchasedUnits, 60, "must cap the single purchase at the market's tradeVolume");
    assert.equal(made, true);
  });
});

describe("TraderAgent.tick: contractBuy caps the purchase at what the contract still needs", () => {
  it("buys only the outstanding units, not a full market-limit lot, when the contract is nearly filled", async () => {
    // Confirmed live: FALCON-D delivered 60/63 SILVER, went back to buy the
    // remaining 3, and bought another 60 anyway — the tradeVolume cap (fixed
    // above) still let the purchase run all the way up to the market limit
    // with no idea only 3 units were actually still wanted. It delivered 3
    // of the 60 and was left holding 57 with no role for them.
    const ship = makeShip([]);
    ship.cargo.capacity = 80;
    let purchasedUnits: number | undefined;
    let neededQueriedFor: string | undefined;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getMyAgent: async () => ({ credits: 1_000_000 }) as any,
        purchaseCargo: async (_s: string, _g: string, units: number) => {
          purchasedUnits = units;
          return { cargo: { ...ship.cargo, units, inventory: [{ symbol: "SILVER", units }] }, transaction: { pricePerUnit: 400, totalPrice: units * 400 } } as any;
        },
      } as any,
      assignedRoute: () => ({ shipSymbol: "SHIP-1", good: "SILVER", role: "contractBuy", buyAt: "X1-A-A1", buyPrice: 400, profitPerTrip: 0, source: "manual" }),
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-A-A1", goodSymbol: "SILVER", purchasePrice: 400, sellPrice: 200, tradeVolume: 60 },
      ],
      contractNeeded: async (good) => { neededQueriedFor = good; return 3; },
    });

    const made = await trader.tick();

    assert.equal(neededQueriedFor, "SILVER");
    assert.equal(purchasedUnits, 3, "must buy only what the contract still needs, not the full tradeVolume/cargo/affordability limit");
    assert.equal(made, true);
  });

  it("subtracts cargo already held from the outstanding amount, instead of double-counting it", async () => {
    const ship = makeShip([{ symbol: "SILVER", units: 2 }]);
    ship.cargo.capacity = 80;
    let purchasedUnits: number | undefined;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        getMyAgent: async () => ({ credits: 1_000_000 }) as any,
        purchaseCargo: async (_s: string, _g: string, units: number) => {
          purchasedUnits = units;
          return { cargo: { ...ship.cargo, units: ship.cargo.units + units }, transaction: { pricePerUnit: 400, totalPrice: units * 400 } } as any;
        },
      } as any,
      assignedRoute: () => ({ shipSymbol: "SHIP-1", good: "SILVER", role: "contractBuy", buyAt: "X1-A-A1", buyPrice: 400, profitPerTrip: 0, source: "manual" }),
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-A-A1", goodSymbol: "SILVER", purchasePrice: 400, sellPrice: 200, tradeVolume: 60 },
      ],
      contractNeeded: async () => 3,
      // Held SILVER is contract cargo, not sellable leftover — same
      // exclusion allProtectedGoods() gives it in production, needed here so
      // clearLeftoverCargo() doesn't try to sell it out from under this test.
      protectedGoods: () => new Set(["SILVER"]),
    });

    await trader.tick();

    assert.equal(purchasedUnits, 1, "already holding 2 of the 3 still needed must only buy the remaining 1");
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
    // canReachMarket()'s same-system branch now also checks the leg fits in
    // the tank (distBetween(here, waypoint) <= fuel.capacity) — distBetween()
    // falls back to a conservative 1000 for a waypoint with no known
    // position, which would wrongly read as "too far" for a synthetic test
    // waypoint with a real, small ship fuel capacity. Register real
    // close-together positions so the distance is genuinely small.
    trader.withWorld([{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-A2", x: 1, y: 1 }]);
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
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      // canReachMarket() goes through GalaxyAtlas.refreshGateConstruction()
      // now, not api.getConstruction() directly — see galaxy.test.ts for
      // coverage of that method's own real fetch/cache/fallback logic.
      atlas: { gatesTo: () => ["X1-A-GATE"], refreshGateConstruction: async () => false } as any,
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
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => ["X1-A-GATE"], refreshGateConstruction: async () => true } as any,
    });
    let navigatedTo: string | undefined;
    (trader as any).navigateTo = async (wp: string) => { navigatedTo = wp; };
    (trader as any).refuelAt = async () => {};
    (trader as any).observeMarket = async () => {};

    const made = await (trader as any).discoverPrices([]);

    assert.equal(made, true);
    assert.equal(navigatedTo, "X1-B-A2");
  });

  it("trusts atlas.refreshGateConstruction()'s answer as-is (the no-construction-record fallback itself is galaxy.test.ts's job)", async () => {
    const ship = makeShip();
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [{ waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 }],
      atlas: { gatesTo: () => ["X1-A-GATE"], refreshGateConstruction: async () => true } as any,
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
    // See the capacity-check comment in the "picks a same-system market"
    // test above — same fix needed here.
    trader.withWorld([{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-A9", x: 1, y: 1 }]);
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
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      getMarketSnapshots: async () => [
        { waypointSymbol: "X1-B-A2", goodSymbol: "IRON", purchasePrice: 5, sellPrice: 10, tradeVolume: 10 },
        { waypointSymbol: "X1-A-A9", goodSymbol: "COPPER", purchasePrice: 3, sellPrice: 6, tradeVolume: 10 },
      ],
      atlas: { gatesTo: () => ["X1-A-GATE"], refreshGateConstruction: async () => true } as any,
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

describe("TraderAgent.runLoop: a fuel-mentioning error only strands a genuinely low-fuel ship", () => {
  // Confirmed live: a full-tank trader whose contract delivery (or any other
  // navigateTo() call) targets a leg outside single-hop range throws
  // "requires N more fuel for navigation" — the old blanket /fuel/i match
  // treated that identically to a real 0-fuel stranding, sending a tender
  // rescue after a ship that didn't need one and that would hit the exact
  // same unreachable leg again next tick.
  it("does not mark stranded when the fuel error fires on a full tank", async () => {
    const ship = makeShip();
    ship.fuel = { current: 100, capacity: 100 } as any;
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
    (trader as any).tick = async () => { throw new Error("Navigate request failed. Ship requires 358 more fuel for navigation."); };

    await trader.runLoop(1);

    assert.equal(trader.isStranded(), false, "a full tank means this leg is simply out of range, not a real stranding");
  });

  it("still marks stranded when the same error fires on a genuinely near-empty tank", async () => {
    const ship = makeShip();
    ship.fuel = { current: 2, capacity: 100 } as any;
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
    });
    (trader as any).tick = async () => { throw new Error("Navigate request failed. Ship requires 8 more fuel for navigation."); };

    await trader.runLoop(1);

    assert.equal(trader.isStranded(), true, "a near-empty tank on the same error is a real stranding the tender rescue must still catch");
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

describe("TraderAgent.viableRoute: cross-system, gate-aware", () => {
  function makeTraderAt(waypoint: string, atlas: any) {
    const ship = makeShip();
    ship.nav = { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-A" } as any;
    ship.fuel = { current: 400, capacity: 400 } as any;
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      atlas,
    });
    // Only the here→buyAt leg is same-system (checked against the fuel
    // tank); buyAt→sellAt crosses a gate and is deliberately not distance-
    // checked at all — see viableRoute()'s own comment. This just needs
    // "here" and buyAt close enough together that the same-system leg fits.
    trader.withWorld([{ symbol: waypoint, x: 0, y: 0 }, { symbol: "X1-A-A2", x: 5, y: 0 }]);
    return trader;
  }

  function seedPrices(trader: TraderAgent, buyAt: string, sellAt: string, good = "COPPER_ORE") {
    (trader as any).priceTable.set(buyAt, new Map([[good, { buy: 10, sell: 12, volume: 40 }]]));
    (trader as any).priceTable.set(sellAt, new Map([[good, { buy: 8, sell: 200, volume: 40 }]]));
  }

  it("rejects a cross-system route when the gate isn't complete", () => {
    const trader = makeTraderAt("X1-A-A1", { gatesTo: () => ["X1-A-GATE"], canJump: () => false });
    seedPrices(trader, "X1-A-A2", "X1-B-A3");

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-B-A3" });

    assert.equal(route, undefined);
  });

  it("accepts a cross-system route once the gate is complete, using the flat estimate with no jump history", () => {
    const trader = makeTraderAt("X1-A-A1", { gatesTo: () => ["X1-A-GATE"], canJump: () => true, learnedJumpCost: () => undefined });
    seedPrices(trader, "X1-A-A2", "X1-B-A3");

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-B-A3" });

    assert.ok(route, "a completed gate with a wide enough margin to absorb the flat jump-cost estimate must be viable");
  });

  it("prefers the learned per-gate-pair average over the flat estimate once a real jump has been paid for", () => {
    const learnedCosts: Record<string, number> = {};
    const atlas = {
      gatesTo: () => ["X1-A-GATE"],
      canJump: () => true,
      learnedJumpCost: (gate: string, sys: string) => learnedCosts[`${gate}->${sys}`],
    };
    const trader = makeTraderAt("X1-A-A1", atlas);
    seedPrices(trader, "X1-A-A2", "X1-B-A3");

    // Margin*volume = (200-10)*40 = 7,600 — profitable against the flat
    // CROSS_SYSTEM_JUMP_COST_ESTIMATE (5,000), but not against a learned
    // cost this high.
    learnedCosts["X1-A-GATE->X1-B"] = 50_000;

    const route = (trader as any).viableRoute({ good: "COPPER_ORE", buyAt: "X1-A-A2", sellAt: "X1-B-A3" });

    assert.equal(route, undefined, "the learned (much higher) real cost must be what decides viability, not the flat placeholder");
  });
});

/**
 * Regression coverage for a live production incident: jumpToSystem() passed
 * its caller's ultimate destination waypoint straight to the jump endpoint,
 * which only ever accepts the target system's own jump gate. That happened
 * to work whenever the destination was itself a gate (an antimatter market
 * often sits on one), which is exactly why viableRoute()'s tests above never
 * caught it — none of them execute the jump. The first time a real route's
 * destination *wasn't* the gate, the jump call failed outright ("Waypoint
 * ... is not connected to the current location"), stranding the ship at the
 * far system, retrying the identical failing jump every poll indefinitely.
 */
describe("TraderAgent.jumpToSystem: jumps to the destination system's own gate, not an arbitrary waypoint", () => {
  function makeTrader() {
    const ship = makeShip();
    ship.nav = { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A" } as any;
    const jumpCalls: string[] = [];
    const navigateCalls: string[] = [];
    const atlas = {
      gatesTo: () => ["X1-A-GATE"],
      loadSystem: async () => ({
        symbol: "X1-B",
        waypoints: [{ symbol: "X1-B-GATE", type: "JUMP_GATE" }],
        jumpGates: [],
        markets: [],
        shipyards: [],
      }),
      recordJumpCost: () => {},
    };
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ship,
        jumpShip: async (_s: string, wp: string) => {
          jumpCalls.push(wp);
          ship.nav = { status: "IN_ORBIT", waypointSymbol: wp, systemSymbol: "X1-B" } as any;
          return { nav: ship.nav, cooldown: { remainingSeconds: 0 }, transaction: { totalPrice: 1000 }, agent: {} } as any;
        },
        orbitShip: async () => ({ nav: ship.nav } as any),
      } as any,
      atlas: atlas as any,
    });
    // Stubbed out entirely: this test is about what jumpShip() gets called
    // with, not about simulating real same-system flight (fuel/positions).
    (trader as any).navigateTo = async (wp: string) => { navigateCalls.push(wp); };
    return { trader, jumpCalls, navigateCalls };
  }

  it("jumps to the remote gate, then covers the last leg locally, when the destination isn't the gate itself", async () => {
    const { trader, jumpCalls, navigateCalls } = makeTrader();

    await (trader as any).jumpToSystem("X1-B", "X1-B-MARKET");

    assert.deepEqual(jumpCalls, ["X1-B-GATE"], "the jump call must target the remote system's own gate, never the ultimate destination waypoint");
    assert.deepEqual(navigateCalls, ["X1-A-GATE", "X1-B-MARKET"], "reaches the local gate, jumps, then navigates on to the real destination");
  });

  it("skips the redundant local leg when the destination already is the remote gate", async () => {
    const { trader, jumpCalls, navigateCalls } = makeTrader();

    await (trader as any).jumpToSystem("X1-B", "X1-B-GATE");

    assert.deepEqual(jumpCalls, ["X1-B-GATE"]);
    assert.deepEqual(navigateCalls, ["X1-A-GATE"], "no second navigate call back to the waypoint we just jumped to");
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
