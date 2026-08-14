import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Greenfield Phase 3: the persisted ship_manifest table. Covers the Store
 * round-trip/isolation directly, then FleetManager.syncShipManifests() (the
 * one place anything writes to this table) against fake agents standing in
 * for real ones, same pattern as tests/shipState.test.ts.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const tenantIds: string[] = [];

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
});

after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function makeTenant(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`SHIPMANIFEST-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

describe("Store.shipManifest", () => {
  it("upsertManifestRows + getManifestForShip round-trips", async () => {
    const tenantId = await makeTenant();
    assert.deepEqual(await store.getManifestForShip(tenantId, "SHIP-1"), []);
    await store.upsertManifestRows(tenantId, [
      { shipSymbol: "SHIP-1", goodSymbol: "IRON_ORE", units: 20, costBasis: 15, basisKind: "actual", intent: "resale" },
    ]);
    const rows = await store.getManifestForShip(tenantId, "SHIP-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.units, 20);
    assert.equal(rows[0]?.costBasis, 15);
    assert.equal(rows[0]?.intent, "resale");
  });

  it("upsertManifestRows overwrites in place, not one row per write", async () => {
    const tenantId = await makeTenant();
    await store.upsertManifestRows(tenantId, [
      { shipSymbol: "SHIP-1", goodSymbol: "IRON_ORE", units: 10, costBasis: 10, basisKind: "estimated", intent: "resale" },
    ]);
    await store.upsertManifestRows(tenantId, [
      { shipSymbol: "SHIP-1", goodSymbol: "IRON_ORE", units: 25, costBasis: 12, basisKind: "actual", intent: "resale" },
    ]);
    const rows = await store.getManifestForShip(tenantId, "SHIP-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.units, 25);
    assert.equal(rows[0]?.basisKind, "actual");
  });

  it("deleteManifestRows drops only the named goods", async () => {
    const tenantId = await makeTenant();
    await store.upsertManifestRows(tenantId, [
      { shipSymbol: "SHIP-1", goodSymbol: "IRON_ORE", units: 10, costBasis: 10, basisKind: "estimated", intent: "resale" },
      { shipSymbol: "SHIP-1", goodSymbol: "GOLD", units: 5, costBasis: 100, basisKind: "estimated", intent: "resale" },
    ]);
    await store.deleteManifestRows(tenantId, "SHIP-1", ["IRON_ORE"]);
    const rows = await store.getManifestForShip(tenantId, "SHIP-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.goodSymbol, "GOLD");
  });

  it("is invisible across tenants, same as every other tenant-scoped table", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await store.upsertManifestRows(tenantA, [
      { shipSymbol: "SHIP-1", goodSymbol: "IRON_ORE", units: 10, costBasis: 10, basisKind: "estimated", intent: "resale" },
    ]);
    assert.deepEqual(await store.getManifestForShip(tenantB, "SHIP-1"), []);
    assert.deepEqual(await store.getAllManifestRows(tenantB), []);
  });
});

/** A minimal stand-in for the agent classes FleetManager holds in its role maps. */
function makeFakeAgent(symbol: string, inventory: { symbol: string; units: number }[]) {
  return {
    symbol,
    getShip: () => ({
      symbol,
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
      cargo: { capacity: 40, units: inventory.reduce((n, i) => n + i.units, 0), inventory: inventory.map((i) => ({ ...i, name: i.symbol, description: "" })) },
    }),
    isManual: () => false,
    isSuspended: () => false,
    pinnedField: () => undefined,
  };
}

describe("FleetManager.syncShipManifests", () => {
  it("reconciles real cargo into the manifest, tagged resale by default", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", [{ symbol: "IRON_ORE", units: 20 }]));

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "TRADER-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.goodSymbol, "IRON_ORE");
    assert.equal(rows[0]?.units, 20);
    assert.equal(rows[0]?.intent, "resale");
    assert.equal(rows[0]?.basisKind, "estimated"); // no ledger purchase recorded for this ship
    assert.equal(rows[0]?.costBasis, 0); // ...and no fleet-wide average either
  });

  it("tags the warehouse ship's own cargo warehouse-deposit instead of resale", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("WH-1", makeFakeAgent("WH-1", [{ symbol: "FAB_MATS", units: 30 }]));
    (fleet as any).warehouseShip = { shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" };

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "WH-1");
    assert.equal(rows[0]?.intent, "warehouse-deposit");
  });

  it("prefers this ship's own last purchase price over the fleet-wide average", async () => {
    const tenantId = await makeTenant();
    await store.recordLedger(tenantId, {
      timestamp: new Date().toISOString(), shipSymbol: "TRADER-1", waypointSymbol: "X1-A-A1",
      type: "PURCHASE", tradeSymbol: "GOLD", units: 10, pricePerUnit: 50, total: 500,
    });
    // A different ship's purchase feeds the fleet-wide average, deliberately
    // priced differently so the two sources are distinguishable in the assertion.
    await store.recordLedger(tenantId, {
      timestamp: new Date().toISOString(), shipSymbol: "TRADER-2", waypointSymbol: "X1-A-A1",
      type: "PURCHASE", tradeSymbol: "GOLD", units: 10, pricePerUnit: 90, total: 900,
    });
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", [{ symbol: "GOLD", units: 10 }]));

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "TRADER-1");
    assert.equal(rows[0]?.costBasis, 50, "must use this ship's own last purchase, not the fleet average");
    assert.equal(rows[0]?.basisKind, "actual");
  });

  it("drops a good from the manifest once the ship no longer holds it", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    const agent = makeFakeAgent("TRADER-1", [{ symbol: "IRON_ORE", units: 20 }]);
    (fleet as any).traders.set("TRADER-1", agent);
    await (fleet as any).syncShipManifests();
    assert.equal((await store.getManifestForShip(tenantId, "TRADER-1")).length, 1);

    // Cargo sold — the agent now reports an empty hold.
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", []));
    await (fleet as any).syncShipManifests();

    assert.deepEqual(await store.getManifestForShip(tenantId, "TRADER-1"), []);
  });

  it("does nothing when the fleet has no tenantId/store", async () => {
    const fleet = new FleetManager({ api: {} as any });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", [{ symbol: "IRON_ORE", units: 5 }]));
    await assert.doesNotReject(() => (fleet as any).syncShipManifests());
  });

  it("tags a mission-committed ship's cargo mission-delivery instead of resale", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("CARRIER-1", makeFakeAgent("CARRIER-1", [{ symbol: "FAB_MATS", units: 40 }]));
    (fleet as any).missions.committedShips = () => new Set(["CARRIER-1"]);

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "CARRIER-1");
    assert.equal(rows[0]?.intent, "mission-delivery");
  });

  it("tags cargo held-position when its live sell price at this ship's waypoint is below the loss floor", async () => {
    const tenantId = await makeTenant();
    // Bought at 100/unit — market_latest sell price well below the loss
    // floor (15% under cost, matching TraderAgent's own default maxLossPct).
    await store.recordLedger(tenantId, {
      timestamp: new Date().toISOString(), shipSymbol: "TRADER-1", waypointSymbol: "X1-A-A1",
      type: "PURCHASE", tradeSymbol: "PLATINUM", units: 10, pricePerUnit: 100, total: 1000,
    });
    await store.recordMarket({
      systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "PLATINUM",
      type: "EXPORT", supply: "SCARCE", purchasePrice: 105, sellPrice: 50, tradeVolume: 10,
    });
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", [{ symbol: "PLATINUM", units: 10 }]));

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "TRADER-1");
    assert.equal(rows[0]?.intent, "held-position");
  });

  it("does not tag held-position when the live sell price still clears the loss floor", async () => {
    const tenantId = await makeTenant();
    await store.recordLedger(tenantId, {
      timestamp: new Date().toISOString(), shipSymbol: "TRADER-1", waypointSymbol: "X1-A-A1",
      type: "PURCHASE", tradeSymbol: "PLATINUM", units: 10, pricePerUnit: 100, total: 1000,
    });
    // Only a few percent under cost — inside the allowed loss band, not below the floor.
    await store.recordMarket({
      systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "PLATINUM",
      type: "EXPORT", supply: "SCARCE", purchasePrice: 105, sellPrice: 98, tradeVolume: 10,
    });
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", [{ symbol: "PLATINUM", units: 10 }]));

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "TRADER-1");
    assert.equal(rows[0]?.intent, "resale");
  });

  it("the warehouse ship's own cargo stays warehouse-deposit even if it's also mission-committed or below the loss floor", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("WH-1", makeFakeAgent("WH-1", [{ symbol: "FAB_MATS", units: 40 }]));
    (fleet as any).warehouseShip = { shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" };
    (fleet as any).missions.committedShips = () => new Set(["WH-1"]);

    await (fleet as any).syncShipManifests();

    const rows = await store.getManifestForShip(tenantId, "WH-1");
    assert.equal(rows[0]?.intent, "warehouse-deposit", "warehouse designation must take priority over mission/held-position");
  });
});
