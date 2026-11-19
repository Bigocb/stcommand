import { it } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
it("marketChangeCounts counts changed reads per bucket, first read never a change", async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand");
  const store = new Store(pool);
  const w = "X1-ZZTEST-M1";
  await pool.query("DELETE FROM market_snapshots WHERE waypoint_symbol=$1", [w]);
  const ins = (t: string, p: number, sup: string) => pool.query(
    "INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp) VALUES ('X1-ZZTEST',$1,'IRON','EXPORT',$2,$3,$3,10,$4)", [w, sup, p, t]);
  await ins("2026-11-18T00:05:00Z", 100, "LIMITED");
  await ins("2026-11-18T00:35:00Z", 100, "LIMITED");
  await ins("2026-11-18T01:05:00Z", 110, "LIMITED");
  await ins("2026-11-18T01:35:00Z", 110, "MODERATE");
  const rows = (await store.marketChangeCounts("2026-11-18T00:00:00Z", 60, "X1-ZZTEST")).sort((a, b) => a.bucket - b.bucket);
  assert.deepEqual(rows.map((r) => [r.reads, r.changed]), [[2, 0], [2, 2]]);
  await pool.query("DELETE FROM market_snapshots WHERE waypoint_symbol=$1", [w]);
  await pool.end();
});
