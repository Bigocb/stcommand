import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * A pinned (manual direct) route skips the margin floor on purpose, but must never keep buying at a negative
 * margin, and stops after two losing trips in a row. 2026-10-06: a pinned ALUMINUM route bought at H55 while its
 * own trades ran the buy price from 167 to 552 and pushed the D47 sell price from 266 to 127, losing ~50k.
 */

const pinned = {
  shipSymbol: "SHIP-1", good: "ALUMINUM", role: "direct" as const,
  buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: 167, sellPrice: 266, profitPerTrip: 3960, source: "manual" as const,
};

function makeShip(cargo: { symbol: string; units: number }[] = []): Ship {
  const units = cargo.reduce((sum, i) => sum + i.units, 0);
  return {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units, inventory: cargo },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

function trader(liveBuy: number, snapshotSell: number, onStop: (r: string) => void, onBuy: () => void) {
  const ship = makeShip();
  const t = new TraderAgent(ship, {
    api: {
      getCallCount: () => 0,
      getShip: async () => ship,
      getMarket: async () => ({ tradeGoods: [{ symbol: "ALUMINUM", purchasePrice: liveBuy, sellPrice: 100, tradeVolume: 60 }] }),
      purchaseCargo: async () => { onBuy(); throw new Error("must not buy"); },
    } as any,
    assignedRoute: () => pinned,
    getCredits: () => 1_000_000,
    getMarketSnapshots: async () => [
      { waypointSymbol: "X1-A-A1", goodSymbol: "ALUMINUM", purchasePrice: 167, sellPrice: 80, tradeVolume: 60 },
      { waypointSymbol: "X1-A-A2", goodSymbol: "ALUMINUM", purchasePrice: 400, sellPrice: snapshotSell, tradeVolume: 60 },
    ],
    stopManualRoute: async (r) => onStop(r),
  });
  t.withWorld([{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-A2", x: 10, y: 0 }]);
  (t as any).ensureDocked = async () => {};
  (t as any).spendableNow = async () => 1_000_000;
  return t;
}

describe("pinned route safety stop", () => {
  it("unpins instead of buying when the live buy price is at or above the destination's latest sell price", async () => {
    let stopped: string | undefined;
    let bought = false;
    const t = trader(300, 250, (r) => { stopped = r; }, () => { bought = true; });
    await t.tick();
    assert.equal(bought, false, "a negative-margin pinned buy must not happen");
    assert.match(stopped ?? "", /live buy 300c .* latest sell 250c/);
  });

  it("unpins after two losing trips in a row, and a winning trip resets the count", async () => {
    const reasons: string[] = [];
    const t = trader(100, 250, (r) => reasons.push(r), () => {});
    const sellLosing = async (units: number, paidEach: number, soldEach: number) => {
      const ship = makeShip([{ symbol: "ALUMINUM", units }]);
      ship.nav.waypointSymbol = "X1-A-A2";
      (t as any).ship = ship;
      (t as any).heldCost.set("ALUMINUM", paidEach);
      (t as any).heldRoute.set("ALUMINUM", { good: "ALUMINUM", buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: paidEach, sellPrice: soldEach, lotSize: 60 });
      (t as any).api.sellCargo = async (_s: string, _g: string, lot: number) => ({
        cargo: { capacity: 40, units: 0, inventory: [] },
        transaction: { pricePerUnit: soldEach, totalPrice: soldEach * lot },
      });
      (t as any).api.getMarket = async () => ({ tradeGoods: [{ symbol: "ALUMINUM", purchasePrice: 400, sellPrice: soldEach, tradeVolume: 60 }] });
      await (t as any).deliverHeldCargo();
    };
    await sellLosing(40, 300, 200);
    assert.equal(reasons.length, 0, "one losing trip is not enough");
    await sellLosing(40, 150, 200);
    await sellLosing(40, 300, 200);
    assert.equal(reasons.length, 0, "a winning trip in between resets the count");
    await sellLosing(40, 300, 200);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /two losing trips in a row on ALUMINUM/);
  });
});
