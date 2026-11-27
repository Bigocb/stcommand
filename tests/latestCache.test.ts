import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LatestMarketCache, type LatestRow } from "../src/db/latestCache.js";

const row = (wp: string, good: string, sell: number, ts = "2026-11-27T10:00:00.000Z"): LatestRow =>
  ({ systemSymbol: "X1-A", waypointSymbol: wp, goodSymbol: good, type: "EXCHANGE", supply: "HIGH", purchasePrice: 1, sellPrice: sell, tradeVolume: 10, timestamp: ts });

describe("LatestMarketCache (issue #88 P4)", () => {
  it("loads once, applies writes in place, and reloads only after reloadMs", async () => {
    let t = 0, loads = 0;
    let db = [row("A1", "FOOD", 10), row("A2", "FOOD", 20)];
    const c = new LatestMarketCache(async () => { loads++; return db.map((r) => ({ ...r })); }, 60_000, () => t);
    assert.equal((await c.all()).length, 2);
    c.apply([{ ...row("A1", "FOOD", 99), activity: "STRONG" }, row("A3", "FUEL", 5)], "2026-11-27T10:01:00.000Z");
    const after = await c.all();
    assert.equal(after.find((r) => r.waypointSymbol === "A1")!.sellPrice, 99);
    assert.equal(after.length, 3);
    assert.equal((after.find((r) => r.waypointSymbol === "A1") as unknown as Record<string, unknown>).activity, undefined, "same shape as a read row");
    assert.equal(loads, 1, "a write does not cause a re-read");
    t = 60_000;
    db = [row("A9", "FOOD", 1)];
    assert.deepEqual((await c.all()).map((r) => r.waypointSymbol), ["A9"]);
    assert.equal(loads, 2);
  });

  it("returns the same array until something changes", async () => {
    const c = new LatestMarketCache(async () => [row("A1", "FOOD", 10)]);
    const a = await c.all();
    assert.equal(await c.all(), a);
    c.apply([row("A1", "FOOD", 11)], "x");
    assert.notEqual(await c.all(), a);
  });

  it("a write made while a reload is in flight survives the reload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = new LatestMarketCache(async () => { await gate; return [row("A1", "FOOD", 10)]; });
    const pending = c.all();
    c.apply([row("A1", "FOOD", 50)], "late");
    release();
    const rows = await pending;
    assert.equal(rows.find((r) => r.waypointSymbol === "A1")!.sellPrice, 50);
  });

  it("concurrent readers share one load; clear() forces a fresh one", async () => {
    let loads = 0;
    const c = new LatestMarketCache(async () => { loads++; return [row("A1", "FOOD", 10)]; });
    await Promise.all([c.all(), c.all(), c.all()]);
    assert.equal(loads, 1);
    c.clear();
    await c.all();
    assert.equal(loads, 2);
  });
});
