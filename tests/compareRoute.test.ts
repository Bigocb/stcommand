import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { createPool, dbSchema, setTenantUniverse } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { createCompareRouter } from "../src/http/compare.js";

/**
 * The week-over-week routes against the real ledger: a tenant sees its own kept weeks; only an operator (OPERATOR_AGENTS) sees another
 * tenant's, and a non-operator who names another tenant's week is refused.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let admin: pg.Pool, pool: pg.Pool, server: Server, base: string, store: Store;
let me: string, other: string;
const stamp = Date.now();
const MY = `TEST-CMP-A-${stamp}`, OTHER = `TEST-CMP-B-${stamp}`;
let asAgent = MY;

async function appPool(): Promise<pg.Pool> {
  const app = createPool(DB_URL);
  const r = (await admin.query<{ bypass: boolean }>(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (r?.bypass) {
    const schema = dbSchema();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_test_app') THEN CREATE ROLE ledger_test_app NOLOGIN; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ledger_test_app`);
    app.on("connect", (c) => { void c.query("SET ROLE ledger_test_app"); });
  }
  return app;
}

async function rec(tenant: string, key: string, over: Record<string, unknown>) {
  setTenantUniverse(tenant, key);
  await store.recordLedger(tenant, { shipSymbol: "S-1", waypointSymbol: "X1-A-A1", type: "SELL", tradeSymbol: "GOLD", units: 10, pricePerUnit: 100, total: 1000, realizedPnl: 200, ...over } as Parameters<Store["recordLedger"]>[1]);
}

before(async () => {
  admin = createPool(DB_URL);
  pool = await appPool();
  store = new Store(pool);
  me = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [MY])).rows[0]!.id;
  other = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [OTHER])).rows[0]!.id;
  const mine = (d: string) => `${MY.toUpperCase()}@${d}`, theirs = (d: string) => `${OTHER.toUpperCase()}@${d}`;
  await rec(me, mine("2026-10-11"), { timestamp: "2026-10-12T00:00:00Z", realizedPnl: 100 });
  await rec(me, mine("2026-10-11"), { timestamp: "2026-10-12T02:30:00Z", realizedPnl: 300, walletAfter: 5000 });
  await rec(me, mine("2026-10-25"), { timestamp: "2026-10-26T00:00:00Z", realizedPnl: 50 });
  await rec(me, mine("2026-10-25"), { timestamp: "2026-10-26T01:10:00Z", type: "JUMP", tradeSymbol: null, realizedPnl: null, total: 5000 });
  await rec(other, theirs("2026-10-18"), { timestamp: "2026-10-19T00:00:00Z", realizedPnl: 9000 });
  setTenantUniverse(me, mine("2026-10-25"));
  const app = express();
  app.use((req, _res, next) => { (req as any).agentSymbol = asAgent; next(); });
  const w = { tenantId: me, agentSymbol: MY, store } as any;
  app.use("/api/compare", createCompareRouter(() => w));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  setTenantUniverse(me, undefined);
  await new Promise<void>((r) => server.close(() => r()));
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[me, other]]);
  await pool.end();
  await admin.end();
  delete process.env.OPERATOR_AGENTS;
});

const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, json: (await r.json()) as any }; };

describe("week-over-week routes", () => {
  it("a tenant lists only its own kept weeks and flags the current one, when OPERATOR_AGENTS names someone else", async () => {
    process.env.OPERATOR_AGENTS = "SOMEONE-ELSE";
    const r = await get("/api/compare/weeks");
    assert.equal(r.json.operator, false);
    assert.deepEqual(r.json.weeks.map((x: any) => x.universeKey).sort(), [`${MY.toUpperCase()}@2026-10-11`, `${MY.toUpperCase()}@2026-10-25`]);
    assert.equal(r.json.weeks.find((x: any) => x.current).universeKey, `${MY.toUpperCase()}@2026-10-25`);
  });

  it("compares this week with an earlier one by hours since the first trade", async () => {
    const r = await get(`/api/compare?week=${encodeURIComponent(`${me}|${MY.toUpperCase()}@2026-10-11`)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.a.universeKey, `${MY.toUpperCase()}@2026-10-25`, "the base is this tenant's current week");
    assert.equal(r.json.b.totals.matchedPnl, 400);
    assert.equal(r.json.b.reached, 2, "the second row is 2.5 hours in");
    assert.equal(r.json.b.points[2].cumPnl, 400);
    assert.equal(r.json.a.firstJumpHour, 1, "the first gate jump, 1.17 hours in");
    assert.equal(r.json.b.points[2].wallet, 5000);
  });

  it("with OPERATOR_AGENTS unset (one owner on the box) every tenant's weeks are listed", async () => {
    delete process.env.OPERATOR_AGENTS;
    const list = await get("/api/compare/weeks");
    assert.ok(list.json.weeks.some((x: any) => x.universeKey === `${OTHER.toUpperCase()}@2026-10-18`));
  });

  it("refuses another tenant's week unless the caller is an operator", async () => {
    process.env.OPERATOR_AGENTS = "SOMEONE-ELSE";
    const id = encodeURIComponent(`${other}|${OTHER.toUpperCase()}@2026-10-18`);
    const r = await get(`/api/compare?week=${id}`);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /operator access/);
  });

  it("an operator sees every tenant's weeks and can compare against them", async () => {
    process.env.OPERATOR_AGENTS = MY;
    const list = await get("/api/compare/weeks");
    assert.equal(list.json.operator, true);
    assert.ok(list.json.weeks.some((x: any) => x.universeKey === `${OTHER.toUpperCase()}@2026-10-18` && x.own === false));
    const r = await get(`/api/compare?week=${encodeURIComponent(`${other}|${OTHER.toUpperCase()}@2026-10-18`)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.b.totals.matchedPnl, 9000);
    delete process.env.OPERATOR_AGENTS;
  });

  it("a week id that is not a universe key is refused", async () => {
    const r = await get(`/api/compare?week=${encodeURIComponent(`${me}|nonsense`)}`);
    assert.equal(r.status, 400);
  });
});
