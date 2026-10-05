import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager, supplyReached } from "../src/engine/feed.js";

describe("supplyReached", () => {
  it("compares supply buckets in order and never stops on unknown names", () => {
    assert.equal(supplyReached("HIGH", "HIGH"), true);
    assert.equal(supplyReached("ABUNDANT", "HIGH"), true);
    assert.equal(supplyReached("MODERATE", "HIGH"), false);
    assert.equal(supplyReached("SCARCE", "MODERATE"), false);
    assert.equal(supplyReached(undefined, "HIGH"), false);
    assert.equal(supplyReached("HIGH", undefined), false);
    assert.equal(supplyReached("WHATEVER", "HIGH"), false);
  });
});

describe("feed limits", () => {
  const mk = (supply: string | undefined, purchases: string[]) => {
    const fm = new FeedManager({
      api: {
        getShipCargo: async () => ({ inventory: [], capacity: 40, units: 0 }),
        purchaseCargo: async (_s: string, g: string) => { purchases.push(g); return { transaction: { pricePerUnit: 1, totalPrice: 1 } }; },
      } as any,
      getShip: async () => ({ symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-1" }, fuel: { capacity: 100, current: 100 }, cargo: { capacity: 40, units: 0, inventory: [] } }) as any,
      supplyAt: async () => supply,
    } as any);
    return fm;
  };

  it("setLimits validates and clears values", async () => {
    const fm = mk("MODERATE", []);
    await fm.start("X1-A-2", "QUARTZ_SAND", { carrierTarget: 1 });
    await assert.rejects(fm.setLimits("X1-A-2", "QUARTZ_SAND", { stopAtSupply: "FULL" }), /MODERATE, HIGH or ABUNDANT/);
    await assert.rejects(fm.setLimits("X1-A-2", "QUARTZ_SAND", { maxLossPerUnit: -1 }), /0-100000/);
    await assert.rejects(fm.setLimits("X1-A-9", "QUARTZ_SAND", { maxLossPerUnit: 5 }), /no active feed/);
    await fm.setLimits("X1-A-2", "QUARTZ_SAND", { maxLossPerUnit: 25, stopAtSupply: "HIGH" });
    let f = (await fm.list()).find((x) => x.good === "QUARTZ_SAND")!;
    assert.equal(f.maxLossPerUnit, 25);
    assert.equal(f.stopAtSupply, "HIGH");
    await fm.setLimits("X1-A-2", "QUARTZ_SAND", { maxLossPerUnit: null, stopAtSupply: null });
    f = (await fm.list()).find((x) => x.good === "QUARTZ_SAND")!;
    assert.equal(f.maxLossPerUnit, undefined);
    assert.equal(f.stopAtSupply, undefined);
  });

  it("an empty carrier does not source once the target's supply reaches the stop level", async () => {
    const purchases: string[] = [];
    const fm = mk("ABUNDANT", purchases);
    await fm.start("X1-A-2", "QUARTZ_SAND", { carrierTarget: 1 });
    await fm.setLimits("X1-A-2", "QUARTZ_SAND", { stopAtSupply: "HIGH" });
    const feed = (await fm.list()).find((x) => x.good === "QUARTZ_SAND")!;
    const t: any = { retryAt: 0 };
    await (fm as any).stepCarrier(feed, "S-1", t);
    assert.deepEqual(purchases, []);
    assert.ok(t.retryAt > Date.now(), "the carrier is told to wait before looking again");
  });
});
