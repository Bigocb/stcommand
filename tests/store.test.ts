import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, withTenant } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Runs against a real local Postgres — set TEST_DATABASE_URL. These tests
 * exist to prove the RLS design in docs/architecture-plan.md actually holds,
 * not just that the SQL is syntactically valid. See particularly
 * "RLS blocks a cross-tenant read even with zero WHERE clause" below —
 * that's the one guarantee this whole storage design rests on.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let pool: pg.Pool;
let tenantA: string;
let tenantB: string;
let store: Store;

before(async () => {
  pool = createPool(DB_URL);
  // Fresh tenant rows per test run so tests don't collide with each other's data.
  const a = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`TEST-A-${Date.now()}`],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`TEST-B-${Date.now()}`],
  );
  tenantA = a.rows[0]!.id;
  tenantB = b.rows[0]!.id;
  store = new Store(pool);
});

after(async () => {
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
});

describe("withTenant", () => {
  it("rejects a non-uuid tenant id rather than interpolating it into SQL", async () => {
    await assert.rejects(
      () => withTenant(pool, "'; DROP TABLE tenants; --", async () => {}),
      /not a uuid/,
    );
  });
});

describe("Store RLS isolation", () => {
  it("RLS blocks a cross-tenant read even with zero WHERE clause", async () => {
    // This is the whole point of the design: isolation enforced by Postgres,
    // not by every query remembering a tenant_id clause. Prove it by running
    // a query that has NO tenant filter at all and confirming it still only
    // ever sees the one tenant app.tenant_id was set to.
    await store.setDoctrine(tenantA, "cashFloor", 20_000, true);
    await store.setDoctrine(tenantB, "cashFloor", 99_999, true);

    const asA = await withTenant(pool, tenantA, (c) => c.query(`SELECT tenant_id, value FROM doctrine`));
    assert.equal(asA.rows.length, 1, "tenant A must see exactly its own row, not both");
    assert.equal(asA.rows[0].tenant_id, tenantA);
    assert.equal(Number(asA.rows[0].value), 20_000);

    const asB = await withTenant(pool, tenantB, (c) => c.query(`SELECT tenant_id, value FROM doctrine`));
    assert.equal(asB.rows.length, 1);
    assert.equal(Number(asB.rows[0].value), 99_999);
  });

  it("an INSERT for the wrong tenant_id is rejected, not silently redirected", async () => {
    // FORCE ROW LEVEL SECURITY means the WITH CHECK side of the policy
    // applies too: even the app's own connection can't write a row tagged
    // for a tenant other than the one app.tenant_id names.
    await assert.rejects(() =>
      withTenant(pool, tenantA, (c) =>
        c.query(`INSERT INTO doctrine (tenant_id, key, value, enabled) VALUES ($1, 'x', 1, true)`, [tenantB]),
      ),
    );
  });

  it("sessions has no RLS — it must be readable by id before tenant_id is known", async () => {
    const res = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'sessions' AND relnamespace = 'public'::regnamespace`,
    );
    assert.equal(res.rows[0]?.relrowsecurity, false);
  });

  it("shared galaxy tables have no RLS and no tenant_id column", async () => {
    for (const table of ["market_snapshots", "shipyard_inventory", "module_catalog"]) {
      const rls = await pool.query<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      assert.equal(rls.rows[0]?.relrowsecurity, false, `${table} must not be tenant-gated`);
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      assert.equal(col.rows.length, 0, `${table} must not have a tenant_id column`);
    }
  });
});

describe("Store.ledger", () => {
  it("records a purchase and totals it separately from sells", async () => {
    await store.recordLedger(tenantA, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-1",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "IRON_ORE",
      units: 10,
      pricePerUnit: 20,
      total: -200,
    });
    await store.recordLedger(tenantA, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-1",
      waypointSymbol: "X1-A-A2",
      type: "SELL",
      tradeSymbol: "IRON_ORE",
      units: 10,
      pricePerUnit: 40,
      total: 400,
    });
    const totals = await store.ledgerTotals(tenantA);
    assert.equal(totals.buys, -200);
    assert.equal(totals.sells, 400);
    assert.equal(totals.credits, 200);
  });

  it("recovers what a ship last paid for a good, ignoring sells", async () => {
    await store.recordLedger(tenantA, {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      shipSymbol: "SHIP-2",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "GOLD",
      units: 5,
      pricePerUnit: 100,
      total: -500,
    });
    await store.recordLedger(tenantA, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-2",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "GOLD",
      units: 5,
      pricePerUnit: 120,
      total: -600,
    });
    assert.equal(await store.lastPurchasePrice(tenantA, "SHIP-2", "GOLD"), 120);
  });

  it("volume-weights the fleet-wide average", async () => {
    await store.recordLedger(tenantB, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-3",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "SILVER",
      units: 90,
      pricePerUnit: 10,
      total: -900,
    });
    await store.recordLedger(tenantB, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-4",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "SILVER",
      units: 10,
      pricePerUnit: 110,
      total: -1100,
    });
    // Naive mean would be 60; volume-weighted is (900 + 1100) / 100 = 20.
    assert.equal(await store.avgPurchasePrice(tenantB, "SILVER"), 20);
  });
});

describe("Store.warehouse", () => {
  it("computes the weighted-average cost basis across two deposits", async () => {
    await store.warehouseDeposit(tenantA, "FAB_MATS", 100, 10, "SHIP-1", "buy");
    await store.warehouseDeposit(tenantA, "FAB_MATS", 50, 40, "SHIP-2", "buy");
    // (100*10 + 50*40) / 150 = 20
    const all = await store.warehouseAll(tenantA);
    const row = all.find((r) => r.goodSymbol === "FAB_MATS");
    assert.equal(row?.units, 150);
    assert.equal(row?.avgCost, 20);
    assert.equal(row?.value, 3_000);
  });

  it("withdrawal clamps to what's actually held and never changes avgCost", async () => {
    await store.warehouseDeposit(tenantA, "ICE_WATER", 10, 5, undefined, "buy");
    const result = await store.warehouseWithdraw(tenantA, "ICE_WATER", 999, 5, undefined, "sell");
    assert.equal(result.units, 10, "clamped to what was actually held");
    assert.equal(result.avgCost, 5);
    assert.equal(await store.warehouseBalance(tenantA, "ICE_WATER"), 0);
  });

  it("a tenant's warehouse balance is invisible to another tenant", async () => {
    await store.warehouseDeposit(tenantA, "PLATINUM", 5, 1_000, undefined, "buy");
    assert.equal(await store.warehouseBalance(tenantB, "PLATINUM"), 0);
  });
});

describe("Store.fleetFlags", () => {
  it("round-trips a JSON blob flag and removes it cleanly", async () => {
    await store.setFleetFlag(tenantA, "keeperMarkets", JSON.stringify(["X1-A-B1", "X1-A-C2"]));
    assert.deepEqual(JSON.parse((await store.getFleetFlag(tenantA, "keeperMarkets"))!), ["X1-A-B1", "X1-A-C2"]);
    await store.removeFleetFlag(tenantA, "keeperMarkets");
    assert.equal(await store.getFleetFlag(tenantA, "keeperMarkets"), undefined);
  });
});
