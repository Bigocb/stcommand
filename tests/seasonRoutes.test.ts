import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { createAnalysisRouter, createSeasonRouter } from "../src/http/season.js";

/** The season routes against the real tables (migrations/054): start, set goals, close a week, open the next. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let admin: pg.Pool;
let pool: pg.Pool;
let server: Server;
let base: string;
let tenant: string;
const actions: unknown[] = [];

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
  tenant = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-SEASON-${Date.now()}`])).rows[0]!.id;
  const store = new Store(pool);
  const w = { tenantId: tenant, store, fleet: { recordAction: (e: unknown) => { if (e) actions.push(e); }, fleetStatusSummary: () => [] } } as any;
  const app = express();
  app.use(express.json());
  app.use("/api/season", createSeasonRouter(() => w));
  app.use("/api/analysis", createAnalysisRouter(() => w));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
  await pool.end();
  await admin.end();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as any };
};

describe("season routes", () => {
  it("has no season until one is started, and lists the phases and metrics", async () => {
    const r = await call("GET", "/api/season?live=0");
    assert.equal(r.json.season, null);
    assert.ok(r.json.phases.some((p: any) => p.key === "cross_system"));
    assert.ok(r.json.metrics.some((m: any) => m.key === "overheadShare"));
  });

  it("starts a season at week 1, Recover", async () => {
    const r = await call("POST", "/api/season", { name: "Season one" });
    assert.equal(r.json.season.name, "Season one");
    assert.equal(r.json.week.weekNo, 1);
    assert.equal(r.json.week.phase, "recover");
  });

  it("sets the phase and goals of the current week, and rejects bad input", async () => {
    assert.equal((await call("PUT", "/api/season/week", { phase: "orbit" })).status, 400);
    assert.equal((await call("PUT", "/api/season/week", { goals: [{ text: "" }] })).status, 400);
    const r = await call("PUT", "/api/season/week", {
      phase: "cross_system",
      goals: [{ text: "At least 1M an hour", metric: "profitPerHour", target: 1_000_000 }, { text: "Scout FY6" }],
    });
    assert.equal(r.json.week.phase, "cross_system");
    assert.equal(r.json.week.goals.length, 2);
    assert.ok(actions.some((a: any) => a.subject === "season:phase"));
  });

  it("closes the week with a saved report, scores the goals, and opens week 2 at Recover with the unfinished goals", async () => {
    const r = await call("POST", "/api/season/week/close", {});
    assert.equal(r.status, 200);
    const w1 = r.json.weeks.find((x: any) => x.weekNo === 1);
    assert.ok(w1.closedAt);
    assert.ok(w1.findingsId);
    assert.equal(w1.record.phase, "cross_system");
    assert.equal(w1.record.goals.find((g: any) => g.metric === "profitPerHour").status, "missed"); // no trades: 0 an hour
    assert.equal(r.json.week.weekNo, 2);
    assert.equal(r.json.week.phase, "recover");
    assert.equal(r.json.week.goals.length, 2); // the missed measured goal and the still-open hand-tracked one
    assert.ok(r.json.week.goals.every((g: any) => g.fromWeek === 1 && g.status === "pending"));
  });

  it("saves a report on demand", async () => {
    const r = await call("POST", "/api/analysis/capture", { sinceHours: 6, label: "now" });
    assert.equal(r.json.ok, true);
    assert.ok(r.json.id > 0);
  });

  it("ends the season", async () => {
    const r = await call("POST", "/api/season/end");
    assert.equal(r.json.season, null);
  });
});
