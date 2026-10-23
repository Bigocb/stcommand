import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { createPool, dbSchema } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { createPushRouter } from "../src/http/push.js";

/** The push subscription store and routes against the real table (migrations/062), with row-level security enforced. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let admin: pg.Pool;
let pool: pg.Pool;
let server: Server;
let base: string;
let store: Store;
let tenantA: string;
let tenantB: string;
let currentTenant: string;
const tests: string[] = [];

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

const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

before(async () => {
  admin = createPool(DB_URL);
  pool = await appPool();
  store = new Store(pool);
  const mk = async (n: string) => (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`TEST-PUSH-${n}-${Date.now()}`])).rows[0]!.id;
  tenantA = await mk("A");
  tenantB = await mk("B");
  currentTenant = tenantA;
  const registry = {
    get: (id: string) => ({ tenantId: id, store, notifications: { sendTest: async (endpoint: string) => { tests.push(endpoint); return { ok: true }; } } }),
  } as any;
  const app = express();
  app.use(express.json());
  app.use("/api", (req: any, _res, next) => { req.tenantId = currentTenant; next(); }, createPushRouter(registry));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
  await admin.end();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + "/api" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as any };
};

describe("push subscription store", () => {
  it("adds a device, refreshes its keys on a repeat, and keeps its saved choices unless new ones come", async () => {
    const a = await store.upsertPushSubscription(tenantA, { endpoint: "https://push.example/s1", p256dh: "k1", auth: "a1", prefs: { maxPerHour: 3 } });
    assert.equal(a.prefs.maxPerHour, 3);
    assert.deepEqual(a.delivery, { sent: {}, recent: [] });
    const b = await store.upsertPushSubscription(tenantA, { endpoint: "https://push.example/s1", p256dh: "k2", auth: "a2" });
    assert.equal(b.id, a.id, "same endpoint, same row");
    assert.equal(b.p256dh, "k2");
    assert.equal(b.prefs.maxPerHour, 3, "no prefs given: the saved ones stay");
    const c = await store.upsertPushSubscription(tenantA, { endpoint: "https://push.example/s1", p256dh: "k2", auth: "a2", prefs: { maxPerHour: 9 } });
    assert.equal(c.prefs.maxPerHour, 9);
  });

  it("keeps one tenant's devices out of another's reach", async () => {
    await store.upsertPushSubscription(tenantA, { endpoint: "https://push.example/iso", p256dh: "k", auth: "a" });
    assert.equal((await store.getPushSubscription(tenantB, "https://push.example/iso")), undefined);
    assert.equal((await store.listPushSubscriptions(tenantB)).some((s) => s.endpoint.endsWith("/iso")), false);
    assert.equal(await store.deletePushSubscription(tenantB, "https://push.example/iso"), false);
    assert.equal(await store.setPushPrefs(tenantB, "https://push.example/iso", { enabled: false }), false);
    assert.ok(await store.getPushSubscription(tenantA, "https://push.example/iso"));
  });

  it("records what a device was told, counts failures and clears them on a delivery", async () => {
    const s = await store.upsertPushSubscription(tenantA, { endpoint: "https://push.example/d1", p256dh: "k", auth: "a" });
    await store.savePushDelivery(tenantA, s.id, { sent: { x: 5 }, recent: [5], seeded: true }, { error: "503" });
    let row = (await store.getPushSubscription(tenantA, s.endpoint))!;
    assert.deepEqual(row.delivery, { sent: { x: 5 }, recent: [5], seeded: true });
    assert.equal(row.failures, 1);
    assert.equal(row.lastError, "503");
    await store.savePushDelivery(tenantA, s.id, { sent: { x: 5 }, recent: [5], seeded: true }, { error: "503" });
    assert.equal((await store.getPushSubscription(tenantA, s.endpoint))!.failures, 2);
    await store.savePushDelivery(tenantA, s.id, { sent: {}, recent: [], seeded: true }, { sent: true });
    row = (await store.getPushSubscription(tenantA, s.endpoint))!;
    assert.equal(row.failures, 0);
    assert.equal(row.lastError, null);
    assert.ok(row.lastSentAt);
  });
});

describe("push routes", () => {
  it("reports whether push is on and offers the registered categories", async () => {
    const r = await call("GET", "/push/config");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.categories) && r.json.categories.some((c: any) => c.id === "approvals" && c.defaultOn === true));
    assert.equal(r.json.categories.find((c: any) => c.id === "rate").defaultOn, false);
  });

  it("subscribes a device, shows its effective choices, changes them (sanitised), and removes it", async () => {
    const s = sub("r1");
    const added = await call("POST", "/push/subscribe", { subscription: s });
    assert.equal(added.status, 200);
    assert.equal(added.json.prefs.maxPerHour, 6, "defaults fill in what the device did not choose");
    const got = await call("GET", `/push/subscription?endpoint=${encodeURIComponent(s.endpoint)}`);
    assert.equal(got.json.subscribed, true);
    const set = await call("PUT", "/push/prefs", { endpoint: s.endpoint, prefs: { categories: { rate: true, bogus: true, approvals: "yes" }, maxPerHour: 500, quietHours: { startMin: 1320, endMin: 420, tzOffsetMin: -300 } } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.json.prefs.categories, { rate: true }, "unknown and non-boolean entries are dropped");
    assert.equal(set.json.prefs.maxPerHour, 60, "clamped");
    assert.deepEqual(set.json.prefs.quietHours, { startMin: 1320, endMin: 420, tzOffsetMin: -300, allowCritical: true });
    const gone = await call("POST", "/push/unsubscribe", { endpoint: s.endpoint });
    assert.equal(gone.json.ok, true);
    assert.equal((await call("GET", `/push/subscription?endpoint=${encodeURIComponent(s.endpoint)}`)).json.subscribed, false);
  });

  it("rejects a malformed subscription, and an unknown device", async () => {
    assert.equal((await call("POST", "/push/subscribe", { subscription: { endpoint: "http://insecure.example/x", keys: { p256dh: "k", auth: "a" } } })).status, 400);
    assert.equal((await call("POST", "/push/subscribe", { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "bad key!", auth: "a" } } })).status, 400);
    assert.equal((await call("PUT", "/push/prefs", { endpoint: "https://push.example/unknown", prefs: {} })).status, 404);
    assert.equal((await call("GET", "/push/subscription")).status, 400);
  });

  it("sends a test to the caller's own device and no other tenant's", async () => {
    const s = sub("t1");
    await call("POST", "/push/subscribe", { subscription: s });
    const r = await call("POST", "/push/test", { endpoint: s.endpoint });
    assert.equal(r.status, 200);
    assert.deepEqual(tests, [s.endpoint]);
    currentTenant = tenantB;
    assert.equal((await call("GET", `/push/subscription?endpoint=${encodeURIComponent(s.endpoint)}`)).json.subscribed, false, "another tenant cannot see it");
    currentTenant = tenantA;
  });
});
