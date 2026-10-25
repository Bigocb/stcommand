import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MissionManager } from "../src/engine/mission.js";

/**
 * 2026-10-25: the gate's only carrier sat docked at the FAB_MATS market waiting for its price to recover, next to a cheap
 * ADVANCED_CIRCUITRY market it could have bought from. A pacing wait on one material now hands the carrier to another free one.
 */
const FAB_MARKET = "X1-A-M1";
const ADV_MARKET = "X1-A-M2";

function harness(opts: { materials?: string[]; fabPrice: () => number }) {
  const bought: { sym: string; units: number }[] = [];
  const moved: string[] = [];
  const ship: any = {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: FAB_MARKET, systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] as { symbol: string; units: number }[] },
    fuel: { current: 100, capacity: 100 },
  };
  const mats = (opts.materials ?? ["FAB_MATS", "ADVANCED_CIRCUITRY"]).map((tradeSymbol) => ({ tradeSymbol, required: 100, fulfilled: 0 }));
  const api: any = {
    getConstruction: async () => ({ isComplete: false, materials: mats }),
    getShipCargo: async () => ship.cargo,
    dockShip: async () => {},
    purchaseCargo: async (_s: string, sym: string, units: number) => {
      bought.push({ sym, units });
      ship.cargo.units += units;
      ship.cargo.inventory = [{ symbol: sym, units: (ship.cargo.inventory.find((i: any) => i.symbol === sym)?.units ?? 0) + units }];
      return { transaction: { pricePerUnit: 1000, totalPrice: 1000 * units } };
    },
    supplyConstruction: async (_sys: string, _wp: string, _s: string, sym: string, units: number) => {
      const m = mats.find((x) => x.tradeSymbol === sym)!;
      m.fulfilled += units;
      ship.cargo.units = 0;
      ship.cargo.inventory = [];
    },
  };
  const mgr = new MissionManager({
    api,
    getShip: async () => ship,
    listBuyers: async (good: string) => (good === "FAB_MATS" ? [{ waypoint: FAB_MARKET, purchasePrice: opts.fabPrice(), tradeVolume: 20 }] : [{ waypoint: ADV_MARKET, purchasePrice: 4000, tradeVolume: 20 }]),
    getCredits: async () => 100_000_000,
    suspend: () => {},
    resume: () => {},
    dispatchShip: async (_s: string, wp: string) => { moved.push(wp); ship.nav.waypointSymbol = wp; },
    canReach: async () => true,
    estimatedFuelBetween: () => 1,
  } as any);
  return { mgr, bought, moved, ship, mats };
}

async function drive(h: ReturnType<typeof harness>, steps: number) {
  for (let i = 0; i < steps; i++) {
    await h.mgr.tick();
    mock.timers.tick(20_000);
  }
}

afterEach(() => mock.timers.reset());

describe("a pacing wait on one material hands the carrier to another", () => {
  it("buys circuitry while FAB_MATS is above its recovery band, then returns", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // The first lot is bought at 1,000; the market then asks 1,060, 6% over, outside the 3% band.
    const holder: { h?: ReturnType<typeof harness> } = {};
    const h = harness({ fabPrice: () => (holder.h && holder.h.bought.length > 0 ? 1060 : 1000) });
    holder.h = h;
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 20, recoverPct: 3 });
    await drive(h, 16);
    assert.equal(h.bought[0]?.sym, "FAB_MATS", "the first lot is FAB_MATS");
    assert.ok(h.bought.some((b) => b.sym === "ADVANCED_CIRCUITRY"), `expected a circuitry buy, got ${JSON.stringify(h.bought)}`);
    assert.equal(h.bought.filter((b) => b.sym === "FAB_MATS").length, 1, "no second FAB_MATS lot while it is above the band");
    assert.ok(h.moved.includes(ADV_MARKET), "the carrier went to the circuitry market");
  });

  it("does not move on while the hold still carries the material it is waiting on", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness({ fabPrice: () => 1000 });
    await h.mgr.startConstruction("X1-A-I1");
    await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 20, recoverPct: 3 });
    h.ship.cargo.units = 5;
    h.ship.cargo.inventory = [{ symbol: "FAB_MATS", units: 5 }];
    const mgr: any = h.mgr;
    const t: any = { step: "source", currentMaterial: "FAB_MATS", retryAt: 0 };
    const moved = mgr.yieldToOtherMaterial({ materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }, { tradeSymbol: "ADVANCED_CIRCUITRY", required: 100, fulfilled: 0 }], pacing: {} }, t, "FAB_MATS", h.ship.cargo.inventory, 300_000);
    assert.equal(moved, false);
    assert.equal(t.currentMaterial, "FAB_MATS");
  });

  it("with only one material outstanding it keeps waiting where it is", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness({ materials: ["FAB_MATS"], fabPrice: () => 1000 });
    const mgr: any = h.mgr;
    const t: any = { step: "source", currentMaterial: "FAB_MATS", retryAt: 0 };
    assert.equal(mgr.yieldToOtherMaterial({ materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }], pacing: {} }, t, "FAB_MATS", [], 300_000), false);
    assert.equal(t.currentMaterial, "FAB_MATS");
  });

  it("does not hand over to a material that is itself held back", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness({ fabPrice: () => 1000 });
    const mgr: any = h.mgr;
    const t: any = { step: "source", currentMaterial: "FAB_MATS", retryAt: 0, blockedUntil: { ADVANCED_CIRCUITRY: Date.now() + 600_000 } };
    assert.equal(mgr.yieldToOtherMaterial({ materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }, { tradeSymbol: "ADVANCED_CIRCUITRY", required: 100, fulfilled: 0 }], pacing: {} }, t, "FAB_MATS", [], 300_000), false);
  });
});
