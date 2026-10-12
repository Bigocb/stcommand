import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

// Live 2026-10-12: THEOREM-D carried 80u IRON_ORE to a market that takes 60u per sale and failed the whole 80u every 5s.
describe("feed selling into a market with a per-sale cap", () => {
  const harness = (limit: number) => {
    const sales: number[] = [];
    const ship: any = { symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-2" }, fuel: { capacity: 100, current: 100 }, cargo: { capacity: 80, units: 80, inventory: [{ symbol: "IRON_ORE", units: 80 }] } };
    const fm = new FeedManager({
      api: {
        getShipCargo: async () => ship.cargo,
        dockShip: async () => {},
        sellCargo: async (_s: string, _g: string, units: number) => {
          if (units > limit) throw new Error(`Market transaction failed. Trade good IRON_ORE has a limit of ${limit} units per transaction.`);
          sales.push(units);
          ship.cargo.units -= units;
          ship.cargo.inventory = [{ symbol: "IRON_ORE", units: ship.cargo.units }].filter((i) => i.units > 0);
          return { transaction: { pricePerUnit: 70, totalPrice: 70 * units } };
        },
      } as any,
      getShip: async () => ship,
    } as any);
    return { fm, sales, ship };
  };

  it("sells the hold in chunks of the cap it was refused at", async () => {
    const { fm, sales, ship } = harness(60);
    await fm.start("X1-A-2", "IRON_ORE", { carrierTarget: 1 });
    const feed = (await fm.list()).find((x) => x.good === "IRON_ORE")!;
    await (fm as any).stepCarrier({ ...feed, force: true }, "S-1", { retryAt: 0 });
    assert.deepEqual(sales, [60, 20]);
    assert.equal(ship.cargo.units, 0);
  });

  it("a market with no cap still takes the whole hold in one sale", async () => {
    const { fm, sales } = harness(1000);
    await fm.start("X1-A-2", "IRON_ORE", { carrierTarget: 1 });
    const feed = (await fm.list()).find((x) => x.good === "IRON_ORE")!;
    await (fm as any).stepCarrier({ ...feed, force: true }, "S-1", { retryAt: 0 });
    assert.deepEqual(sales, [80]);
  });
});
