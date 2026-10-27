import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MissionManager, withinRecovery, nextChunkWithinCeiling, PACING_RECHECK_MS } from "../src/engine/mission.js";

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

describe("nextChunkWithinCeiling", () => {
  it("stops before the chunk that would land over the ceiling (the 2026-10-12 FAB_MATS case)", () => {
    // ceiling 1,147 x 1.2; chunk 1 paid 1,363 for 20u at trade volume 20, so the next ask is projected ~1,440
    assert.equal(nextChunkWithinCeiling(1363, 20, 20, Math.round(1147 * 1.2)), false);
  });
  it("lets a chunk go ahead while the projected ask is still under it", () => {
    assert.equal(nextChunkWithinCeiling(1200, 20, 20, 1376), true);
  });
  it("a small chunk moves the ask less than a full lot", () => {
    assert.equal(nextChunkWithinCeiling(1330, 5, 20, 1376), true);
    assert.equal(nextChunkWithinCeiling(1330, 20, 20, 1376), false);
  });
});

describe("MissionManager.carrierStatus", () => {
  it("says why a carrier is waiting and when it next looks", async () => {
    const h = harness({ tradeVolume: 20, price: 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 40, cashFloor: 9_999_500 });
    const before = Date.now();
    await h.mgr.tick();
    const [c] = h.mgr.carrierStatus("X1-A-I1");
    assert.match(c!.waiting ?? "", /cannot afford one unit/);
    const next = Date.parse(c!.nextCheckAt ?? "");
    assert.ok(next >= before + PACING_RECHECK_MS - 1000 && next <= Date.now() + PACING_RECHECK_MS + 1000);
  });

  it("reports no wait before the carrier has looked, then buys", async () => {
    const h = harness({ tradeVolume: 20, price: 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 5, buyGapMin: 40 });
    assert.equal(h.mgr.carrierStatus("X1-A-I1")[0]?.waiting, undefined, "nothing waiting before the first look");
    await h.mgr.tick();
    assert.deepEqual(h.bought, [5]);
  });
});

describe("MissionPacing.maxPrice: an absolute price in credits", () => {
  it("setPacing keeps it, clears it with null, and validates the range", async () => {
    const { mgr } = harness();
    await mgr.startConstruction("X1-A-I1");
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { maxPrice: 5000 }), { maxPrice: 5000 });
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { buyLotUnits: 20 }), { maxPrice: 5000, buyLotUnits: 20 });
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { maxPrice: null }), { buyLotUnits: 20 });
    await assert.rejects(() => mgr.setPacing("X1-A-I1", { maxPrice: -5 }), /between/);
  });

  async function run(maxPrice: number | undefined, ask: number) {
    const h = harness({ price: ask, tradeVolume: 20 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 20, maxInflationPct: 100_000, ...(maxPrice !== undefined ? { maxPrice } : {}) });
    await h.mgr.tick();
    return h.bought;
  }

  it("buys nothing while the ask is above it, and says why", async () => {
    assert.deepEqual(await run(5000, 6000), []);
  });
  it("buys when the ask is at or under it", async () => {
    assert.deepEqual(await run(5000, 5000), [20]);
    assert.deepEqual(await run(5000, 4000), [20]);
  });
  it("without it nothing changes", async () => {
    assert.deepEqual(await run(undefined, 6000), [20]);
  });
});

describe("maxPrice replaces the percentage ceiling", () => {
  // 2026-10-27: max price 7,000 was set with the ask at 5,386, but the default 40% cap over the 1,243 low (1,740) still blocked every buy.
  async function runWithBaseline(pacing: Record<string, number>, ask: number) {
    const h = harness({ price: ask, tradeVolume: 20 });
    await h.mgr.startConstruction("X1-A-I1", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0, priceBaselines: { "X1-A-M1": { price: 1000, seededAt: Date.now() } } } as any]);
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 20, ...pacing });
    await h.mgr.tick();
    return h.bought;
  }
  it("buys at 5,000 against a 1,000 baseline when the max price is 7,000, with no percentage set", async () => {
    assert.deepEqual(await runWithBaseline({ maxPrice: 7000 }, 5000), [20]);
  });
  it("a percentage still applies when no max price is set (default 40% over 1,000 = 1,400)", async () => {
    assert.deepEqual(await runWithBaseline({}, 5000), []);
  });
  it("a max price is not undone by a smaller percentage that is also set", async () => {
    assert.deepEqual(await runWithBaseline({ maxPrice: 7000, maxInflationPct: 40 }, 5000), [20]);
  });
  it("still holds above the max price", async () => {
    assert.deepEqual(await runWithBaseline({ maxPrice: 4000 }, 5000), []);
  });
});
