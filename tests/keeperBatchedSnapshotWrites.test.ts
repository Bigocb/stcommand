import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { FleetManager } from "../src/engine/fleet.js";

const goods = [
  { symbol: "IRON", type: "IMPORT", supply: "MODERATE", purchasePrice: 50, sellPrice: 40, tradeVolume: 20, activity: "WEAK" },
  { symbol: "FUEL", type: "EXCHANGE", supply: "HIGH", purchasePrice: 70, sellPrice: 68, tradeVolume: 60 },
  { symbol: "MODULE_CARGO_HOLD_I", type: "EXPORT", supply: "LIMITED", purchasePrice: 9_000, sellPrice: 8_000, tradeVolume: 5, activity: "GROWING" },
];
const rowsFor = (system: string, waypoint: string) =>
  goods.map((g) => ({ systemSymbol: system, waypointSymbol: waypoint, goodSymbol: g.symbol, type: g.type, supply: g.supply, purchasePrice: g.purchasePrice, sellPrice: g.sellPrice, tradeVolume: g.tradeVolume, activity: (g as { activity?: string }).activity }));

describe("keeperBatchedSnapshotWrites: the batched write saves the same rows (DB)", () => {
  it("market_snapshots and market_latest match the per-good path, a repeated good included", async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand");
    const store = new Store(pool);
    const sys = "X1-ZZBATCH";
    const perGood = `${sys}-PG`;
    const batched = `${sys}-BT`;
    const clean = async () => {
      await pool.query("DELETE FROM market_snapshots WHERE waypoint_symbol = ANY($1)", [[perGood, batched]]);
      await pool.query("DELETE FROM market_latest WHERE waypoint_symbol = ANY($1)", [[perGood, batched]]);
    };
    try {
      await clean();
      // Twice, the second with IRON listed again at a new price: latest must end on the last IRON row on both paths.
      const second = (wp: string) => [...rowsFor(sys, wp), { ...rowsFor(sys, wp)[0]!, purchasePrice: 55, supply: "LIMITED" }];
      for (const r of rowsFor(sys, perGood)) await store.recordMarket(r);
      for (const r of second(perGood)) await store.recordMarket(r);
      await store.recordMarketSnapshotBatch(rowsFor(sys, batched));
      await store.recordMarketSnapshotBatch(second(batched));

      const cols = "system_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, activity";
      const read = async (table: string, wp: string) =>
        (await pool.query(`SELECT ${cols} FROM ${table} WHERE waypoint_symbol = $1 ORDER BY good_symbol, purchase_price`, [wp])).rows;
      const histPG = await read("market_snapshots", perGood);
      assert.equal(histPG.length, 7);
      assert.deepEqual(await read("market_snapshots", batched), histPG);
      const latestPG = await read("market_latest", perGood);
      assert.equal(latestPG.length, 3);
      assert.deepEqual(await read("market_latest", batched), latestPG);
      assert.equal(latestPG.find((r) => r.good_symbol === "IRON")!.purchase_price, 55);
      assert.equal(latestPG.find((r) => r.good_symbol === "FUEL")!.activity, null);
      await store.recordMarketSnapshotBatch([]);
    } finally {
      await clean();
      await pool.end();
    }
  });
});

/** A fleet with one market and a fake store that records which write path was used. */
function fleetWith(clauseOn: boolean) {
  const writes: { perGood: unknown[]; batches: unknown[][]; catalog: unknown[] } = { perGood: [], batches: [], catalog: [] };
  const api = {
    getMarket: async (_s: string, symbol: string) => ({ symbol, tradeGoods: goods, imports: [], exports: [], exchange: [] }),
  } as any;
  const store = {
    recordMarket: async (r: unknown) => { writes.perGood.push(r); },
    recordMarketSnapshotBatch: async (rows: unknown[]) => { writes.batches.push(rows); },
    recordModuleCatalog: async (...args: unknown[]) => { writes.catalog.push(args); },
  } as any;
  const fleet = new FleetManager({ api, log: () => {} });
  const f = fleet as any;
  f.store = store;
  f.maybeRequestKeeperProbeForMarket = async () => false;
  f.registry = { systemOf: (wp: string) => wp.slice(0, wp.lastIndexOf("-")), isMarket: () => true, market: () => undefined, recordMarket: () => {} };
  const real = f.doctrine.isEnabledOr.bind(f.doctrine);
  f.doctrine.isEnabledOr = (key: string, d: boolean) => (key === "keeperBatchedSnapshotWrites" ? clauseOn : real(key, d));
  return { fleet, writes };
}

describe("keeperBatchedSnapshotWrites: the seam in recordMarketSnapshot", () => {
  it("ships off by default", () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} }) as any;
    assert.equal(fleet.doctrine.isEnabledOr("keeperBatchedSnapshotWrites", true), false);
  });

  it("clause off: one write per good, as before", async () => {
    const { fleet, writes } = fleetWith(false);
    await fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 0 });
    assert.equal(writes.perGood.length, 3);
    assert.equal(writes.batches.length, 0);
    assert.equal(writes.catalog.length, 1, "module catalog still written");
  });

  it("clause on: one batch holding the same rows", async () => {
    const off = fleetWith(false);
    await off.fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 0 });
    const on = fleetWith(true);
    await on.fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 0 });
    assert.equal(on.writes.perGood.length, 0);
    assert.equal(on.writes.batches.length, 1);
    assert.deepEqual(on.writes.batches[0], off.writes.perGood);
    assert.deepEqual(on.writes.catalog, off.writes.catalog);
  });
});
