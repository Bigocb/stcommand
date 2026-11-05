import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/** The split read through the real ledger: keeper and explorer fuel and jumps come out of trading and into expansion. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let admin: pg.Pool;
let pool: pg.Pool;
let store: Store;
let tenant: string;

before(async () => {
  admin = createPool(DB_URL);
  pool = createPool(DB_URL);
  const me = (await admin.query<{ bypass: boolean }>(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (me?.bypass) {
    const schema = dbSchema();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_test_app') THEN CREATE ROLE ledger_test_app NOLOGIN; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ledger_test_app`);
    pool.on("connect", (c) => { void c.query("SET ROLE ledger_test_app"); });
  }
  tenant = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-PS-${Date.now()}`])).rows[0]!.id;
  store = new Store(pool);
});
after(async () => {
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenant]]);
  await pool.end();
  await admin.end();
});

describe("Store.tradingPaceSplitBuckets", () => {
  it("splits the hour: sales and a trader's overhead are trading, a keeper's jumps are expansion, and the two add up to the old figure", async () => {
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    await store.recordLedger(tenant, { timestamp: at(5), shipSymbol: "T-1", waypointSymbol: "X1-A-B1", type: "SELL", tradeSymbol: "IRON", units: 10, pricePerUnit: 100, total: 1000, realizedPnl: 300 });
    await store.recordLedger(tenant, { timestamp: at(4), shipSymbol: "T-1", waypointSymbol: "X1-A-GATE", type: "JUMP", units: 0, total: 50 });
    await store.recordLedger(tenant, { timestamp: at(3), shipSymbol: "K-1", waypointSymbol: "X1-A-GATE", type: "JUMP", units: 0, total: 200 });
    await store.recordLedger(tenant, { timestamp: at(2), shipSymbol: "K-1", waypointSymbol: "X1-A-B1", type: "REFUEL", units: 10, total: 40 });

    const split = await store.tradingPaceSplitBuckets(tenant, 1, 15, new Set(["K-1"]));
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    assert.equal(sum(split.trading), 250);      // 300 profit - 50 for the trader's own jump
    assert.equal(sum(split.expansion), -240);   // the keeper's jump and refuel
    const old = await store.tradingPaceBuckets(tenant, 1, 15);
    assert.equal(sum(old), sum(split.trading) + sum(split.expansion));
  });
});
