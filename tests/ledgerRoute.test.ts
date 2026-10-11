import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/** A trade's route tag (migrations/050) is stored and comes back from the ledger read. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let admin: pg.Pool;
let store: Store;
let tenant: string;

before(async () => {
  admin = createPool(DB_URL);
  tenant = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-RT-${Date.now()}`])).rows[0]!.id;
  store = new Store(admin);
});
after(async () => {
  await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
  await admin.end();
});

describe("ledger route tag", () => {
  it("is stored with a sale and read back, and is null on rows without one", async () => {
    const base = { shipSymbol: "T-1", waypointSymbol: "X1-A-2", type: "SELL" as const, tradeSymbol: "DIAMONDS", units: 5, pricePerUnit: 100, total: 500 };
    await store.recordLedger(tenant, { ...base, timestamp: new Date().toISOString(), route: "X1-A-1>X1-A-2 auto circuit1" });
    await store.recordLedger(tenant, { ...base, timestamp: new Date(Date.now() - 1000).toISOString() });
    const rows = await store.opsLedger(tenant, { sinceIso: new Date(Date.now() - 60_000).toISOString(), limit: 10 });
    assert.deepEqual(rows.map((r: { route: string | null }) => r.route), ["X1-A-1>X1-A-2 auto circuit1", null]);
  });
});
