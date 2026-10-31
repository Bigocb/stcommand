import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { ShipRegistry } from "../src/engine/shipRegistry.js";

/**
 * The per-pass mirrors (ship states, claims, cargo manifests) write only what changed, in batches (changeTracker.ts). Real Postgres:
 * the batch statements use unnest() and casts that only a real database proves.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const tenantIds: string[] = [];

before(async () => { pool = createPool(DB_URL); store = new Store(pool); });
after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function makeTenant(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`BATCHWRITES-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  tenantIds.push(res.rows[0]!.id);
  return res.rows[0]!.id;
}

const fakeApi = { onMarket: () => {}, setShipObserver: () => {}, setShipSource: () => {} } as any;
function agent(symbol: string, status: string, units = 0, inventory: { symbol: string; units: number }[] = []): any {
  return {
    symbol,
    getShip: () => ({ symbol, nav: { status, waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units, inventory: inventory.map((i) => ({ ...i, name: i.symbol, description: "" })) } }),
    isManual: () => false, isSuspended: () => false, pinnedField: () => undefined,
  };
}

describe("Store batch writes", () => {
  it("updateShipStates inserts, then updates in place, with target and step JSON, in one statement", async () => {
    const t = await makeTenant();
    await store.updateShipStates(t, [
      { shipSymbol: "S-1", state: "docked", target: "X1-A-A1" },
      { shipSymbol: "S-2", state: "transacting", step: { kind: "transacting", good: "IRON" } },
    ]);
    await store.updateShipStates(t, [{ shipSymbol: "S-1", state: "travelling", target: "X1-A-Z9" }]);
    const rows = (await store.getAllShipStates(t)).filter((r) => r.shipSymbol === "S-1" || r.shipSymbol === "S-2");
    assert.equal(rows.length, 2);
    assert.deepEqual([rows.find((r) => r.shipSymbol === "S-1")!.state, rows.find((r) => r.shipSymbol === "S-1")!.target], ["travelling", "X1-A-Z9"]);
    assert.deepEqual(rows.find((r) => r.shipSymbol === "S-2")!.step, { kind: "transacting", good: "IRON" });
    assert.equal(rows.find((r) => r.shipSymbol === "S-2")!.target, undefined);
  });

  it("recordClaims inserts then updates, and round-trips through ShipRegistry", async () => {
    const t = await makeTenant();
    const reg = new ShipRegistry();
    reg.claim("S-1", "operator", "trader", { reason: "hold" });
    reg.claim("S-2", "auto", "miner");
    await reg.persistDirtyState(t, store);
    reg.claim("S-2", "keeper", "keeper", { status: "DOCKED" }, { preempt: true });
    await reg.persistDirtyState(t, store);
    const back = new ShipRegistry();
    await back.loadAllClaims(t, store);
    assert.deepEqual([back.ownerOf("S-1")?.owner, back.ownerOf("S-1")?.intent.reason, back.ownerOf("S-2")?.owner, back.ownerOf("S-2")?.intent.status], ["operator", "hold", "keeper", "DOCKED"]);
  });

  it("deleteManifestPairs drops exactly the named (ship, good) pairs", async () => {
    const t = await makeTenant();
    await store.upsertManifestRows(t, [
      { shipSymbol: "S-1", goodSymbol: "IRON", units: 1, costBasis: 1, basisKind: "estimated", intent: "resale" },
      { shipSymbol: "S-1", goodSymbol: "GOLD", units: 1, costBasis: 1, basisKind: "estimated", intent: "resale" },
      { shipSymbol: "S-2", goodSymbol: "IRON", units: 1, costBasis: 1, basisKind: "estimated", intent: "resale" },
    ]);
    await store.deleteManifestPairs(t, [{ shipSymbol: "S-1", goodSymbol: "IRON" }, { shipSymbol: "S-2", goodSymbol: "IRON" }]);
    assert.deepEqual((await store.getManifestForShip(t, "S-1")).map((r) => r.goodSymbol), ["GOLD"]);
    assert.deepEqual(await store.getManifestForShip(t, "S-2"), []);
  });
});

describe("FleetManager mirrors write only changes", () => {
  it("syncShipStates writes every ship once, then nothing until a ship's state changes", async () => {
    const t = await makeTenant();
    const fleet = new FleetManager({ api: fakeApi, store, tenantId: t });
    const calls: number[] = [];
    const real = store.updateShipStates.bind(store);
    (store as any).updateShipStates = async (tid: string, rows: unknown[]) => { calls.push(rows.length); return real(tid, rows as any); };
    try {
      (fleet as any).traders.set("A", agent("A", "DOCKED"));
      (fleet as any).traders.set("B", agent("B", "DOCKED"));
      await (fleet as any).syncShipStates();
      await (fleet as any).syncShipStates();
      (fleet as any).traders.set("B", agent("B", "IN_TRANSIT"));
      await (fleet as any).syncShipStates();
      assert.deepEqual(calls, [2, 1], "both ships once, then only B");
      // The test database role bypasses row-level security (see CLAUDE.md), so other tests' rows are visible: look at this test's ships only.
      const rows = (await store.getAllShipStates(t)).filter((r) => r.shipSymbol === "A" || r.shipSymbol === "B");
      assert.deepEqual(rows.map((r) => [r.shipSymbol, r.state]).sort(), [["A", "docked"], ["B", "travelling"]]);
    } finally { (store as any).updateShipStates = real; }
  });

  it("syncShipManifests writes a new hold once, rewrites only when units or intent change, and drops a sold good in one delete", async () => {
    const t = await makeTenant();
    const fleet = new FleetManager({ api: fakeApi, store, tenantId: t });
    const upserts: number[] = [];
    const deletes: number[] = [];
    const realU = store.upsertManifestRows.bind(store);
    const realD = store.deleteManifestPairs.bind(store);
    (store as any).upsertManifestRows = async (tid: string, rows: unknown[]) => { upserts.push(rows.length); return realU(tid, rows as any); };
    (store as any).deleteManifestPairs = async (tid: string, rows: unknown[]) => { deletes.push(rows.length); return realD(tid, rows as any); };
    try {
      (fleet as any).traders.set("T", agent("T", "DOCKED", 20, [{ symbol: "IRON", units: 20 }]));
      await (fleet as any).syncShipManifests();
      await (fleet as any).syncShipManifests();
      assert.deepEqual(upserts, [1], "the second pass finds nothing to write");
      (fleet as any).traders.set("T", agent("T", "DOCKED", 30, [{ symbol: "IRON", units: 30 }]));
      await (fleet as any).syncShipManifests();
      assert.deepEqual(upserts, [1, 1]);
      assert.equal((await store.getManifestForShip(t, "T"))[0]!.units, 30);
      (fleet as any).traders.set("T", agent("T", "DOCKED", 0, []));
      await (fleet as any).syncShipManifests();
      assert.deepEqual(deletes, [1]);
      assert.deepEqual(await store.getManifestForShip(t, "T"), []);
    } finally { (store as any).upsertManifestRows = realU; (store as any).deleteManifestPairs = realD; }
  });
});
