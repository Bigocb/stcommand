import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
const WP = `X1-TESTBM-${Date.now()}`;

before(async () => { pool = createPool(DB_URL); });
after(async () => {
  await pool.query(`DELETE FROM market_snapshots WHERE waypoint_symbol = $1`, [WP]);
  await pool.end();
});

describe("Store.bidMediansSince", () => {
  it("returns the median bid per market and good, ignoring pairs with too few readings, so one spike does not move it", async () => {
    const now = Date.now();
    const rows: [string, number][] = [["CYBER_IMPLANTS", 11_800], ["CYBER_IMPLANTS", 12_000], ["CYBER_IMPLANTS", 12_400], ["CYBER_IMPLANTS", 42_430], ["CYBER_IMPLANTS", 11_900], ["GOLD", 300], ["GOLD", 310]];
    for (const [i, [good, price]] of rows.entries()) {
      await pool.query(
        `INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp) VALUES ('X1-TESTBM', $1, $2, 'EXCHANGE', 'MODERATE', $3, $4, 18, $5)`,
        [WP, good, price * 2, price, new Date(now - i * 60_000).toISOString()],
      );
    }
    const store = new Store(pool);
    const out = await store.bidMediansSince(new Date(now - 3_600_000).toISOString(), 4);
    const cyber = out.find((r) => r.waypoint === WP && r.good === "CYBER_IMPLANTS");
    assert.equal(cyber?.samples, 5);
    assert.equal(cyber?.median, 12_000);
    assert.equal(out.some((r) => r.waypoint === WP && r.good === "GOLD"), false, "two readings is below the minimum");
  });
});
