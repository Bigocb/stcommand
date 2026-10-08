import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MissionManager, withinRecovery } from "../src/engine/mission.js";

// No database: pure state-machine tests of the per-mission buy pacing.
function harness(opts: { price?: number; tradeVolume?: number } = {}) {
  const bought: number[] = [];
  const ship: any = {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] as { symbol: string; units: number }[] },
    fuel: { current: 100, capacity: 100 },
  };
  const api: any = {
    getConstruction: async () => ({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }] }),
    getShipCargo: async () => ship.cargo,
    dockShip: async () => {},
    purchaseCargo: async (_s: string, sym: string, units: number) => {
      bought.push(units);
      ship.cargo.units += units;
      ship.cargo.inventory = [{ symbol: sym, units: (ship.cargo.inventory[0]?.units ?? 0) + units }];
      return { transaction: { pricePerUnit: opts.price ?? 1000, totalPrice: (opts.price ?? 1000) * units } };
    },
    supplyConstruction: async () => {},
  };
  const mgr = new MissionManager({
    api,
    getShip: async () => ship,
    listBuyers: async () => [{ waypoint: "X1-A-M1", purchasePrice: opts.price ?? 1000, tradeVolume: opts.tradeVolume ?? 20 }],
    getCredits: async () => 10_000_000,
    suspend: () => {},
    resume: () => {},
    dispatchShip: async () => {},
    canReach: async () => true,
    estimatedFuelBetween: () => 1,
  } as any);
  return { mgr, bought, ship };
}

describe("MissionManager.setPacing", () => {
  it("merges keys, clears with null/0, and validates ranges", async () => {
    const { mgr } = harness();
    await mgr.startConstruction("X1-A-I1");
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { buyLotUnits: 5, buyGapMin: 40 }), { buyLotUnits: 5, buyGapMin: 40 });
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { maxInflationPct: 8 }), { buyLotUnits: 5, buyGapMin: 40, maxInflationPct: 8 });
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { buyGapMin: null }), { buyLotUnits: 5, maxInflationPct: 8 });
    assert.equal(await mgr.setPacing("X1-A-I1", { buyLotUnits: 0, maxInflationPct: null }), null, "all keys cleared -> null");
    await assert.rejects(() => mgr.setPacing("X1-A-I1", { buyLotUnits: -3 }), /between/);
    await assert.rejects(() => mgr.setPacing("X1-A-NOWHERE", { buyLotUnits: 5 }), /no active mission/);
  });

  it("is reported by list()", async () => {
    const { mgr } = harness();
    await mgr.startConstruction("X1-A-I1");
    await mgr.setPacing("X1-A-I1", { buyLotUnits: 5 });
    assert.deepEqual((await mgr.list())[0]?.pacing, { buyLotUnits: 5 });
  });
});

describe("MissionManager buy pacing", () => {
  async function run(pacing: { buyLotUnits?: number; buyGapMin?: number } | null, ticks: number) {
    const h = harness();
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    if (pacing) await h.mgr.setPacing("X1-A-I1", pacing);
    for (let i = 0; i < ticks; i++) await h.mgr.tick();
    return h.bought;
  }

  it("without pacing a purchase is the market's full lot", async () => {
    const bought = await run(null, 1);
    assert.equal(bought[0], 20);
  });

  it("buyLotUnits caps the purchase", async () => {
    const bought = await run({ buyLotUnits: 5 }, 1);
    assert.equal(bought[0], 5);
  });

  it("withinRecovery: first lot always allowed, then only within the band", () => {
    assert.equal(withinRecovery(undefined, 5000, 3), true);
    assert.equal(withinRecovery(1000, 1050, 3), false);
    assert.equal(withinRecovery(1000, 1030, 3), true);
    assert.equal(withinRecovery(1000, 1020, 3), true);
  });

  it("buyGapMin holds the next purchase back", async () => {
    const bought = await run({ buyLotUnits: 5, buyGapMin: 40 }, 6);
    assert.equal(bought.length, 1, `only one purchase inside the gap, got ${JSON.stringify(bought)}`);
  });
});

describe("MissionManager multi-transaction lots", () => {
  it("a lot larger than the market's trade volume is bought as several transactions in one stop", async () => {
    const h = harness({ tradeVolume: 20 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 40, buyGapMin: 20 });
    await h.mgr.tick();
    assert.deepEqual(h.bought, [20, 20]);
  });

  it("stops chunking before a later transaction would dip under the cash floor", async () => {
    const h = harness({ tradeVolume: 20, price: 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    // 10,000,000 credits and a 9,970,000 floor: 30,000 to spend, so 20u then 10u, never a second full 20u.
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 40, cashFloor: 9_970_000 });
    await h.mgr.tick();
    assert.deepEqual(h.bought, [20, 10]);
  });

  it("sizes the first transaction from the cash above the floor, not the whole balance", async () => {
    const h = harness({ tradeVolume: 20, price: 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    // 5,000 above the floor at 1,000/unit: 5 units, not 20.
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 40, cashFloor: 9_995_000 });
    await h.mgr.tick();
    assert.deepEqual(h.bought, [5]);
  });

  it("buys nothing when less than one unit fits above the floor", async () => {
    const h = harness({ tradeVolume: 20, price: 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 40, cashFloor: 9_999_500 });
    await h.mgr.tick();
    assert.deepEqual(h.bought, []);
  });
});
