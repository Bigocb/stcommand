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
      // total is always a positive magnitude at insertion (res.transaction.totalPrice,
      // never negated) — direction comes from `type`, not the sign of `total`.
      // See ledgerTotals' comment for why this was a real bug caught here.
      total: 200,
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
    assert.equal(totals.buys, 200);
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
      total: 500,
    });
    await store.recordLedger(tenantA, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-2",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "GOLD",
      units: 5,
      pricePerUnit: 120,
      total: 600,
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
      total: 900,
    });
    await store.recordLedger(tenantB, {
      timestamp: new Date().toISOString(),
      shipSymbol: "SHIP-4",
      waypointSymbol: "X1-A-A1",
      type: "PURCHASE",
      tradeSymbol: "SILVER",
      units: 10,
      pricePerUnit: 110,
      total: 1100,
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

  it("target list round-trips forMission and survives removal", async () => {
    await store.setWarehouseTarget(tenantA, "FAB_MATS", 300, true);
    await store.setWarehouseTarget(tenantA, "IRON_ORE", 100, false);
    const list = await store.warehouseTargetList(tenantA);
    assert.deepEqual(
      list.map((t) => [t.goodSymbol, t.target, t.forMission]),
      [["FAB_MATS", 300, true], ["IRON_ORE", 100, false]],
    );
    await store.removeWarehouseTarget(tenantA, "IRON_ORE");
    assert.deepEqual(
      (await store.warehouseTargetList(tenantA)).map((t) => t.goodSymbol),
      ["FAB_MATS"],
    );
  });

  it("ledger records deposits and withdrawals with the right sign", async () => {
    await store.warehouseDeposit(tenantA, "COPPER_ORE", 20, 8, "SHIP-1", "buy");
    await store.warehouseWithdraw(tenantA, "COPPER_ORE", 5, 8, "SHIP-2", "sell");
    const ledger = await store.warehouseLedger(tenantA);
    const forGood = ledger.filter((l) => l.goodSymbol === "COPPER_ORE");
    assert.deepEqual(forGood.map((l) => l.delta).sort((a, b) => a - b), [-5, 20]);
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

describe("Store.fleetState", () => {
  it("upserts a ship's role and keeper market, then removes it", async () => {
    await store.setFleetState(tenantA, "SHIP-9", "miner");
    await store.setFleetState(tenantA, "SHIP-9", "keeper", "X1-A-D46");
    const state = await store.getFleetState(tenantA);
    const row = state.find((r) => r.shipSymbol === "SHIP-9");
    assert.equal(row?.role, "keeper");
    assert.equal(row?.keeperMarket, "X1-A-D46");
    await store.removeFleetState(tenantA, "SHIP-9");
    assert.equal((await store.getFleetState(tenantA)).find((r) => r.shipSymbol === "SHIP-9"), undefined);
  });

  it("is invisible across tenants", async () => {
    await store.setFleetState(tenantA, "SHIP-ONLY-A", "trader");
    assert.equal((await store.getFleetState(tenantB)).find((r) => r.shipSymbol === "SHIP-ONLY-A"), undefined);
  });
});

describe("Store.missions", () => {
  it("round-trips materials as real objects, not JSON strings, through jsonb", async () => {
    await store.recordMission(tenantA, {
      kind: "SUPPLY_CONSTRUCTION",
      targetSystem: "X1-A",
      targetWaypoint: "X1-A-I59",
      status: "active",
      materials: [{ tradeSymbol: "FAB_MATS", required: 4000, fulfilled: 500 }],
    });
    const missions = await store.latestMissions(tenantA);
    const m = missions.find((x) => x.targetWaypoint === "X1-A-I59");
    assert.deepEqual(m?.materials, [{ tradeSymbol: "FAB_MATS", required: 4000, fulfilled: 500 }]);
    assert.equal(m?.paused, false);
  });

  it("re-recording the same target_waypoint upserts rather than duplicating", async () => {
    await store.recordMission(tenantA, {
      kind: "SUPPLY_CONSTRUCTION",
      targetSystem: "X1-A",
      targetWaypoint: "X1-A-I60",
      status: "active",
      materials: [{ tradeSymbol: "IRON", required: 100, fulfilled: 0 }],
    });
    await store.recordMission(tenantA, {
      kind: "SUPPLY_CONSTRUCTION",
      targetSystem: "X1-A",
      targetWaypoint: "X1-A-I60",
      status: "active",
      assignedShip: "SHIP-1",
      materials: [{ tradeSymbol: "IRON", required: 100, fulfilled: 50 }],
    });
    const matches = (await store.latestMissions(tenantA)).filter((m) => m.targetWaypoint === "X1-A-I60");
    assert.equal(matches.length, 1, "must upsert, not duplicate");
    assert.equal(matches[0]?.assignedShip, "SHIP-1");
    assert.equal(matches[0]?.materials[0]?.fulfilled, 50);
  });

  it("completeMission marks status complete", async () => {
    await store.recordMission(tenantA, {
      kind: "SUPPLY_CONSTRUCTION",
      targetSystem: "X1-A",
      targetWaypoint: "X1-A-I61",
      status: "active",
      materials: [{ tradeSymbol: "IRON", required: 10, fulfilled: 10 }],
    });
    await store.completeMission(tenantA, "X1-A-I61");
    const m = (await store.latestMissions(tenantA)).find((x) => x.targetWaypoint === "X1-A-I61");
    assert.equal(m?.status, "complete");
  });
});

describe("Store shared galaxy tables (no tenant scoping)", () => {
  it("recordMarket + latestMarketSnapshots round-trip and are visible to every tenant", async () => {
    await store.recordMarket({
      systemSymbol: "X1-Z",
      waypointSymbol: "X1-Z-TEST1",
      goodSymbol: "TRITIUM_AMMONIA",
      type: "EXPORT",
      supply: "ABUNDANT",
      purchasePrice: 15,
      sellPrice: 25,
      tradeVolume: 40,
    });
    const snaps = await store.latestMarketSnapshots();
    const row = snaps.find((s) => s.waypointSymbol === "X1-Z-TEST1");
    assert.equal(row?.goodSymbol, "TRITIUM_AMMONIA");
    assert.equal(row?.purchasePrice, 15);
    // No tenantId param exists on this method at all — proving it's
    // reachable without any tenant context, matching the schema's lack of
    // RLS on this table.
  });

  it("freshMarketSnapshots excludes stale rows", async () => {
    // Backdate directly via SQL rather than racing a razor-thin maxAgeMinutes
    // window against real test execution time, which was flaky.
    const wp = `X1-Z-STALE${Date.now()}`;
    await pool.query(
      `INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp)
       VALUES ('X1-Z', $1, 'STALE_GOOD', 'EXPORT', 'ABUNDANT', 10, 20, 5, now() - interval '2 hours')`,
      [wp],
    );
    const fresh = await store.freshMarketSnapshots(90);
    assert.ok(!fresh.some((s) => s.waypointSymbol === wp), "a 2-hour-old row must not pass a 90-minute freshness window");
    const all = await store.latestMarketSnapshots();
    assert.ok(all.some((s) => s.waypointSymbol === wp), "but it must still exist in the unfiltered view");
  });

  it("bestTrades ranks by margin and finds the actual cheapest/priciest waypoints", async () => {
    const sys = `X1-BT${Date.now()}`;
    await store.recordMarket({ systemSymbol: sys, waypointSymbol: `${sys}-CHEAP`, goodSymbol: "ORE", type: "EXPORT", supply: "HIGH", purchasePrice: 10, sellPrice: 5, tradeVolume: 10 });
    await store.recordMarket({ systemSymbol: sys, waypointSymbol: `${sys}-EXPENSIVE`, goodSymbol: "ORE", type: "IMPORT", supply: "LOW", purchasePrice: 50, sellPrice: 90, tradeVolume: 10 });
    const trades = await store.bestTrades(sys);
    const row = trades.find((t) => t.goodSymbol === "ORE");
    assert.equal(row?.cheapestMarket, `${sys}-CHEAP`);
    assert.equal(row?.expensiveMarket, `${sys}-EXPENSIVE`);
    assert.equal(row?.spread, 80); // 90 - 10
  });

  it("tradeLegs takes the smaller of the two markets' trade volume (LEAST, not SQLite's scalar MIN)", async () => {
    const sys = `X1-TL${Date.now()}`;
    await store.recordMarket({ systemSymbol: sys, waypointSymbol: `${sys}-BUY`, goodSymbol: "GOLD", type: "EXPORT", supply: "HIGH", purchasePrice: 10, sellPrice: 5, tradeVolume: 3 });
    await store.recordMarket({ systemSymbol: sys, waypointSymbol: `${sys}-SELL`, goodSymbol: "GOLD", type: "IMPORT", supply: "LOW", purchasePrice: 5, sellPrice: 50, tradeVolume: 90 });
    const legs = await store.tradeLegs(90);
    const leg = legs.find((l) => l.goodSymbol === "GOLD" && l.buyAt === `${sys}-BUY`);
    assert.equal(leg?.volume, 3, "must take the smaller of {3, 90}, not the larger or a syntax error");
  });

  it("shipyard + module catalog upsert on unique_key rather than duplicating", async () => {
    const wp = `X1-SY${Date.now()}`;
    await store.recordShipyardInventory("X1-SY", wp, [{ type: "SHIP_MINING_DRONE", name: "Mining Drone", purchasePrice: 78_000, frame: { fuelCapacity: 0 } }]);
    await store.recordShipyardInventory("X1-SY", wp, [{ type: "SHIP_MINING_DRONE", name: "Mining Drone", purchasePrice: 80_000, frame: { fuelCapacity: 0 } }]);
    const yards = await store.shipyardInventory();
    const matches = yards.filter((y) => y.waypointSymbol === wp && y.shipType === "SHIP_MINING_DRONE");
    assert.equal(matches.length, 1, "must upsert on unique_key, not duplicate");
    assert.equal(matches[0]?.purchasePrice, 80_000);

    await store.recordModuleCatalog("X1-SY", wp, [{ symbol: "MOUNT_MINING_LASER_II", name: "Mining Laser II", category: "mount", purchasePrice: 22_000 }], "mount");
    const mods = await store.moduleCatalog("MOUNT_MINING_LASER_II");
    assert.equal(mods.find((m) => m.waypointSymbol === wp)?.kind, "mount");
  });
});
