import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MissionManager } from "../src/engine/mission.js";

/**
 * 2026-10-27: the gate carrier waited with "cash 661,853c under the 750,000c floor" while the wallet read 832,693. The mission's
 * floor was compared with spendable cash, which is the wallet minus the fleet-wide cash floor (100,000), so the two floors stacked:
 * a 750,000 floor needed an 850,000 wallet. The mission's floor is now a wallet level, and the larger of the two floors holds.
 */
function build(wallet: number, fleetFloor: number) {
  const bought: number[] = [];
  const ship: any = {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A" },
    cargo: { capacity: 80, units: 0, inventory: [] as { symbol: string; units: number }[] },
    fuel: { current: 100, capacity: 100 },
  };
  const api: any = {
    getConstruction: async () => ({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 500, fulfilled: 0 }] }),
    getShipCargo: async () => ship.cargo,
    dockShip: async () => {},
    purchaseCargo: async (_s: string, sym: string, units: number) => {
      bought.push(units);
      ship.cargo.units += units;
      ship.cargo.inventory = [{ symbol: sym, units: ship.cargo.units }];
      return { transaction: { pricePerUnit: 1000, totalPrice: 1000 * units } };
    },
    supplyConstruction: async () => {},
  };
  const mgr = new MissionManager({
    api,
    getShip: async () => ship,
    listBuyers: async () => [{ waypoint: "X1-A-M1", purchasePrice: 1000, tradeVolume: 100 }],
    // The fleet's own wiring: spendable is the wallet net of the fleet-wide floor.
    getCredits: async () => Math.max(0, wallet - fleetFloor),
    getWalletCredits: () => wallet,
    suspend: () => {},
    resume: () => {},
    dispatchShip: async () => {},
    canReach: async () => true,
    estimatedFuelBetween: () => 1,
  } as any);
  return { mgr, bought };
}

async function run(wallet: number, fleetFloor: number, missionFloor: number) {
  const h = build(wallet, fleetFloor);
  await h.mgr.startConstruction("X1-A-I1");
  await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
  await h.mgr.setPacing("X1-A-I1", { buyLotUnits: 80, cashFloor: missionFloor, cashResume: missionFloor });
  await h.mgr.tick();
  return h.bought;
}

describe("the mission's cash floor is a wallet level", () => {
  it("buys with a wallet of 832,693 against a 750,000 mission floor and a 100,000 fleet floor", async () => {
    const bought = await run(832_693, 100_000, 750_000);
    assert.ok(bought.length > 0, "should buy");
    assert.equal(bought.reduce((a, b) => a + b, 0), 80, "lot cap 80 (82,693 sits above the 750,000 floor)");
  });
  it("holds when the wallet is under the mission floor", async () => {
    assert.deepEqual(await run(740_000, 100_000, 750_000), []);
  });
  it("the fleet floor still holds when it is the higher one", async () => {
    // wallet 900,000, fleet floor 800,000, mission floor 750,000: only 100,000 of it is spendable
    const bought = await run(900_000, 800_000, 750_000);
    assert.equal(bought.reduce((a, b) => a + b, 0), 80);
    assert.deepEqual(await run(790_000, 800_000, 750_000), []);
  });
});
