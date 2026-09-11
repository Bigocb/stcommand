import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { findOrCreateTenant } from "../src/db/tenants.js";
import { TenantRegistry } from "../src/engine/tenantRegistry.js";
import { createAdminRouter } from "../src/http/admin.js";

/**
 * Integration tests for the admin router, against a real HTTP server and
 * real Postgres — same shape as dashboard.test.ts. Covers the auth gate
 * (unconfigured, wrong key, right key) and the list/delete tenant flow,
 * including that delete actually cascades (a real DB effect, not a mock).
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
const ADMIN_KEY = "test-admin-key-do-not-use-in-prod";
let pool: pg.Pool;
let registry: TenantRegistry;
const tenantIds: string[] = [];
let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
  pool = createPool(DB_URL);
  registry = new TenantRegistry(pool);

  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter(pool, registry));

  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  registry.stopAll();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function makeTenant(): Promise<string> {
  const agentSymbol = `ADMINTEST-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await findOrCreateTenant(pool, agentSymbol, "st-token");
  tenantIds.push(tenant.id);
  return tenant.id;
}

describe("admin auth gate", () => {
  it("503s every route when ADMIN_KEY is unset — fails closed, not open", async () => {
    delete process.env.ADMIN_KEY;
    const res = await fetch(`${baseUrl}/api/admin/tenants`);
    assert.equal(res.status, 503);
  });

  it("401s a request with no key, or the wrong key, once ADMIN_KEY is set", async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    try {
      const noKey = await fetch(`${baseUrl}/api/admin/tenants`);
      assert.equal(noKey.status, 401);
      const wrongKey = await fetch(`${baseUrl}/api/admin/tenants`, { headers: { "x-admin-key": "nope" } });
      assert.equal(wrongKey.status, 401);
    } finally {
      delete process.env.ADMIN_KEY;
    }
  });

  it("lets the right key through", async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    try {
      const res = await fetch(`${baseUrl}/api/admin/tenants`, { headers: { "x-admin-key": ADMIN_KEY } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.tenants));
    } finally {
      delete process.env.ADMIN_KEY;
    }
  });
});

describe("admin tenant list + delete", () => {
  it("lists a known tenant with running:false when this process never booted it", async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    try {
      const tenantId = await makeTenant();
      const res = await fetch(`${baseUrl}/api/admin/tenants`, { headers: { "x-admin-key": ADMIN_KEY } });
      const { tenants } = await res.json();
      const row = tenants.find((t: any) => t.id === tenantId);
      assert.ok(row, "the new tenant must appear in the list");
      assert.equal(row.running, false);
      assert.ok(row.createdAt);
      assert.ok(row.lastSeenAt);
    } finally {
      delete process.env.ADMIN_KEY;
    }
  });

  it("delete actually removes the tenant row (a real cascade, not a mock)", async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    try {
      const tenantId = await makeTenant();
      const del = await fetch(`${baseUrl}/api/admin/tenants/${tenantId}`, { method: "DELETE", headers: { "x-admin-key": ADMIN_KEY } });
      assert.equal(del.status, 200);

      const row = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
      assert.equal(row.rowCount, 0, "the row must actually be gone from the database");

      // Already deleted — drop it from the cleanup list so `after` doesn't
      // try to delete it again (harmless, but asserting the row count above
      // already proved the point; no need to also prove DELETE is a no-op
      // on a missing row here).
      const idx = tenantIds.indexOf(tenantId);
      if (idx >= 0) tenantIds.splice(idx, 1);
    } finally {
      delete process.env.ADMIN_KEY;
    }
  });

  it("404s deleting a tenant that doesn't exist", async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    try {
      const res = await fetch(`${baseUrl}/api/admin/tenants/00000000-0000-0000-0000-000000000000`, {
        method: "DELETE",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      assert.equal(res.status, 404);
    } finally {
      delete process.env.ADMIN_KEY;
    }
  });
});
