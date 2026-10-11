import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import type { DecisionRow } from "../src/engine/judge.js";

/** The decision-model log (migrations/048): kept per tenant under row-level security, newest first, and pruned by age. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let admin: pg.Pool;
let pool: pg.Pool;
let store: Store;
let tenantA: string;
let tenantB: string;

/** A superuser skips row-level security, so run the app's queries as a plain role when connected as one (see ledgerUniverse.test.ts). */
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

const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  feature: "attention", subject: "THEOREM-1", question: "stuck", answer: { type: "noul", noul: 0.91 }, confidence: 0.91,
  state: { ship: "THEOREM-1" }, model: "jev-test", inputTokens: 120, latencyMs: 85, acted: false, ...over,
});

before(async () => {
  admin = createPool(DB_URL);
  pool = await appPool();
  const mk = async (tag: string) => (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-J${tag}-${Date.now()}`])).rows[0]!.id;
  tenantA = await mk("A");
  tenantB = await mk("B");
  store = new Store(pool);
});
after(async () => {
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
  await admin.end();
});

describe("judge_decisions", () => {
  it("keeps one row per answered question, newest first, and filters by feature", async () => {
    await store.recordJudgeDecisions(tenantA, [row({ question: "stuck" }), row({ question: "looping", answer: { type: "noul", noul: 0.2 }, confidence: 0.8 })]);
    await store.recordJudgeDecisions(tenantA, [row({ feature: "router", subject: "why is 1 stuck", question: "intent", acted: true, note: "router: intent ship_diagnosis: 95% sure" })]);
    const all = await store.recentJudgeDecisions(tenantA, { sinceIso: "2020-01-01T00:00:00Z", limit: 10 });
    assert.equal(all.length, 3);
    assert.equal(all[0]!.feature, "router", "newest first");
    const attention = await store.recentJudgeDecisions(tenantA, { feature: "attention", sinceIso: "2020-01-01T00:00:00Z", limit: 10 });
    assert.deepEqual(attention.map((r) => r.question).sort(), ["looping", "stuck"]);
    assert.equal(all.find((r) => r.question === "intent")!.acted, true);
  });

  it("is invisible to another tenant", async () => {
    assert.deepEqual(await store.recentJudgeDecisions(tenantB, { sinceIso: "2020-01-01T00:00:00Z", limit: 10 }), []);
  });

  it("a long subject is trimmed, and an empty batch is a no-op", async () => {
    await store.recordJudgeDecisions(tenantA, []);
    await store.recordJudgeDecisions(tenantA, [row({ subject: "x".repeat(900), question: "trim" })]);
    const r = (await store.recentJudgeDecisions(tenantA, { sinceIso: "2020-01-01T00:00:00Z", limit: 1 }))[0]!;
    assert.equal((r.subject as string).length, 300);
  });

  it("prunes rows older than the given days and keeps the rest", async () => {
    await admin.query(`INSERT INTO judge_decisions (tenant_id, at, feature, subject, question, answer) VALUES ($1, now() - interval '30 days', 'attention', 'OLD-1', 'stuck', '{}'::jsonb)`, [tenantA]);
    const dropped = await store.pruneJudgeDecisions(tenantA, 14);
    assert.equal(dropped, 1);
    const left = await store.recentJudgeDecisions(tenantA, { sinceIso: "2000-01-01T00:00:00Z", limit: 50 });
    assert.ok(!left.some((r) => r.subject === "OLD-1") && left.length >= 3);
  });

  it("survives the weekly wipe: it describes the model, not the universe", async () => {
    await store.wipeTenantGameData(tenantA);
    assert.ok((await store.recentJudgeDecisions(tenantA, { sinceIso: "2000-01-01T00:00:00Z", limit: 50 })).length >= 3);
  });
});
