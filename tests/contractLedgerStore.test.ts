import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { buildMetrics } from "../src/engine/metrics.js";

/** Per-contract ledger rows (migrations/049): stored with their contract id, summed per contract, read back for the metrics. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let admin: pg.Pool;
let pool: pg.Pool;
let store: Store;
let tenantA: string;
let tenantB: string;

async function appPool(): Promise<pg.Pool> {
  const app = createPool(DB_URL);
  const me = (await admin.query<{ bypass: boolean }>(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (me?.bypass) {
    const schema = dbSchema();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_test_app') THEN CREATE ROLE ledger_test_app NOLOGIN; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ledger_test_app`);
    app.on("connect", (c) => { void c.query("SET ROLE ledger_test_app"); });
  }
  return app;
}

before(async () => {
  admin = createPool(DB_URL);
  pool = await appPool();
  const mk = async (tag: string) => (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-CL${tag}-${Date.now()}`])).rows[0]!.id;
  tenantA = await mk("A");
  tenantB = await mk("B");
  store = new Store(pool);
});
after(async () => {
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
  await admin.end();
});

const ts = (m: number) => new Date(Date.parse("2026-10-11T18:00:00Z") + m * 60_000).toISOString();

describe("contract ledger rows", () => {
  it("are summed per contract: advance, payout, units delivered and their cost", async () => {
    await store.recordLedger(tenantA, { timestamp: ts(0), shipSymbol: "fleet", waypointSymbol: "", type: "CONTRACT", tradeSymbol: "ADVANCE", total: 3107, contractId: "c1" });
    await store.recordLedger(tenantA, { timestamp: ts(5), shipSymbol: "T-1", waypointSymbol: "X1-A-K101", type: "DELIVERY", tradeSymbol: "POLYNUCLEOTIDES", units: 20, pricePerUnit: 285, total: 0, contractId: "c1" });
    await store.recordLedger(tenantA, { timestamp: ts(6), shipSymbol: "T-1", waypointSymbol: "X1-A-K101", type: "DELIVERY", tradeSymbol: "POLYNUCLEOTIDES", units: 2, total: 0, contractId: "c1" }); // mined: no basis
    await store.recordLedger(tenantA, { timestamp: ts(7), shipSymbol: "fleet", waypointSymbol: "", type: "CONTRACT", tradeSymbol: "PAYOUT", total: 7607, contractId: "c1" });
    await store.recordLedger(tenantA, { timestamp: ts(8), shipSymbol: "fleet", waypointSymbol: "", type: "CONTRACT", total: 999 }); // no id: not in the per-contract sums
    const rows = await store.contractLedger(tenantA);
    assert.deepEqual(rows, [{ contractId: "c1", advance: 3107, payout: 7607, unitsDelivered: 22, costDelivered: 5700 }]);
  });

  it("are read back with their contract id and unit price for the metrics, which then net them", async () => {
    const rows = await store.ledgerRowsSince(tenantA, ts(-60));
    const delivery = rows.find((r) => r.type === "DELIVERY" && r.units === 20)!;
    assert.equal(delivery.contractId, "c1");
    assert.equal(delivery.pricePerUnit, 285);
    const m = buildMetrics(rows, { now: Date.parse(ts(30)), hours: 1, bucketMinutes: 10 });
    const c1 = m.contracts.byContract.find((l) => l.contractId === "c1")!;
    assert.deepEqual({ advance: c1.advance, payout: c1.payout, units: c1.units, cost: c1.cost, net: c1.net }, { advance: 3107, payout: 7607, units: 22, cost: 5700, net: 5014 });
    assert.equal(m.contracts.byContract.find((l) => l.contractId === "untracked")!.payout, 999);
  });

  it("stay private to their tenant", async () => {
    assert.deepEqual(await store.contractLedger(tenantB), []);
  });
});
