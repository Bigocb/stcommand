import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/** action_events and analysis_findings (migrations/053): written, read back, kept per tenant. */
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
  const mk = async (tag: string) => (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-AE${tag}-${Date.now()}`])).rows[0]!.id;
  tenantA = await mk("A");
  tenantB = await mk("B");
  store = new Store(pool);
});
after(async () => {
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
  await admin.end();
});

const ts = (m: number) => new Date(Date.parse("2026-10-15T01:00:00Z") + m * 60_000).toISOString();

describe("action events", () => {
  it("are written and read back oldest first, with their json parts", async () => {
    await store.recordActionEvent(tenantA, {
      at: ts(5), kind: "trip_closed", actor: "engine", shipSymbol: "S-1", good: "G", waypoint: "X1-B-2", correlationId: "trip:S-1:G:1",
      subject: "X1-A-1>X1-B-2", observed: { profit: 1600, minutes: 30 }, reason: "sold",
    });
    await store.recordActionEvent(tenantA, {
      at: ts(0), kind: "trip_planned", actor: "engine", shipSymbol: "S-1", good: "G", waypoint: "X1-A-1", correlationId: "trip:S-1:G:1",
      subject: "X1-A-1>X1-B-2", expected: { profit: 2000 }, context: { lotSize: 20 },
    });
    const rows = await store.actionEvents(tenantA, { sinceIso: ts(-1) });
    assert.deepEqual(rows.map((r) => r.kind), ["trip_planned", "trip_closed"]);
    assert.deepEqual(rows[0]!.expected, { profit: 2000 });
    assert.deepEqual(rows[1]!.observed, { profit: 1600, minutes: 30 });
    assert.equal(rows[1]!.correlationId, "trip:S-1:G:1");
  });

  it("filter by kind and ship", async () => {
    await store.recordActionEvent(tenantA, { at: ts(10), kind: "config_change", actor: "operator", subject: "doctrine:marginFloor", context: { before: { value: 10 }, after: { value: 25 } } });
    const changes = await store.actionEvents(tenantA, { sinceIso: ts(-1), kinds: ["config_change"] });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.subject, "doctrine:marginFloor");
    assert.equal((await store.actionEvents(tenantA, { sinceIso: ts(-1), ship: "S-1" })).length, 2);
  });

  it("are invisible to another tenant", async () => {
    assert.equal((await store.actionEvents(tenantB, { sinceIso: ts(-1) })).length, 0);
  });
});

describe("analysis findings", () => {
  it("are saved and listed newest first, with the report on request", async () => {
    const first = await store.saveAnalysisFindings(tenantA, { windowStart: ts(0), windowEnd: ts(60), label: "first", report: { findings: [1] } });
    const second = await store.saveAnalysisFindings(tenantA, { windowStart: ts(60), windowEnd: ts(120), label: "second", report: { findings: [2] } });
    const list = await store.listAnalysisFindings(tenantA);
    assert.deepEqual(list.map((r) => r.id), [second, first]);
    assert.equal(list[0]!.report, undefined);
    const one = await store.listAnalysisFindings(tenantA, { id: first, withReport: true });
    assert.deepEqual(one[0]!.report, { findings: [1] });
    assert.equal((await store.listAnalysisFindings(tenantB)).length, 0);
  });
});

describe("analysis reads", () => {
  it("market snapshots come back only for the requested (waypoint, good) pairs and window", async () => {
    const wp = `X1-AETEST-${Date.now()}`;
    await admin.query(
      `INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp)
       VALUES ('X1-AETEST', $1, 'G', 'EXPORT', 'HIGH', 100, 90, 20, $2), ('X1-AETEST', $1, 'G', 'EXPORT', 'HIGH', 110, 99, 20, $3),
              ('X1-AETEST', $1, 'OTHER', 'EXPORT', 'HIGH', 5, 4, 20, $2)`,
      [wp, ts(0), ts(30)],
    );
    const rows = await store.analysisSnapshots([{ waypoint: wp, good: "G" }], ts(-1), ts(20));
    assert.deepEqual(rows.map((r) => [r.good, r.purchasePrice]), [["G", 100]]);
    await admin.query(`DELETE FROM market_snapshots WHERE waypoint_symbol = $1`, [wp]);
  });
});
