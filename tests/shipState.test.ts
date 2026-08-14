import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Greenfield Phase 2: the persisted ship_state table. Covers the Store
 * round-trip/isolation directly, then FleetManager.syncShipStates() (the one
 * place anything writes to this table) against fake agents standing in for
 * real ones, same pattern as tests/fleet.test.ts.
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
    [`SHIPSTATE-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

describe("Store.shipState", () => {
  it("updateShipState + getShipState round-trips", async () => {
    const tenantId = await makeTenant();
    assert.equal(await store.getShipState(tenantId, "SHIP-1"), undefined);
    await store.updateShipState(tenantId, "SHIP-1", "travelling", "X1-A-B2");
    const row = await store.getShipState(tenantId, "SHIP-1");
    assert.equal(row?.state, "travelling");
    assert.equal(row?.target, "X1-A-B2");
  });

  it("updateShipState upserts in place, not one row per write", async () => {
    const tenantId = await makeTenant();
    await store.updateShipState(tenantId, "SHIP-1", "docked");
    await store.updateShipState(tenantId, "SHIP-1", "idle");
    const all = await store.getAllShipStates(tenantId);
    assert.equal(all.filter((s) => s.shipSymbol === "SHIP-1").length, 1);
    assert.equal(all.find((s) => s.shipSymbol === "SHIP-1")?.state, "idle");
  });

  it("getAllShipStates returns every ship for the tenant", async () => {
    const tenantId = await makeTenant();
    await store.updateShipState(tenantId, "SHIP-A", "idle");
    await store.updateShipState(tenantId, "SHIP-B", "assigned");
    const all = await store.getAllShipStates(tenantId);
    assert.equal(all.length, 2);
    assert.ok(all.some((s) => s.shipSymbol === "SHIP-A" && s.state === "idle"));
    assert.ok(all.some((s) => s.shipSymbol === "SHIP-B" && s.state === "assigned"));
  });

  it("is invisible across tenants, same as every other tenant-scoped table", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await store.updateShipState(tenantA, "SHIP-1", "docked");
    assert.equal(await store.getShipState(tenantB, "SHIP-1"), undefined);
    assert.deepEqual(await store.getAllShipStates(tenantB), []);
  });
});

/** A minimal stand-in for the agent classes FleetManager holds in its role maps. */
function makeFakeAgent(symbol: string, status: string, waypointSymbol = "X1-A-A1") {
  return {
    symbol,
    getShip: () => ({ symbol, nav: { status, waypointSymbol, systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
    isManual: () => false,
    isSuspended: () => false,
    pinnedField: () => undefined,
  };
}

describe("FleetManager.syncShipStates", () => {
  it("maps role + live nav status to a coarse persisted lifecycle state", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("TRADER-TRANSIT", makeFakeAgent("TRADER-TRANSIT", "IN_TRANSIT"));
    (fleet as any).miners.set("MINER-DOCKED", makeFakeAgent("MINER-DOCKED", "DOCKED"));
    (fleet as any).scouts.set("SCOUT-ORBIT", makeFakeAgent("SCOUT-ORBIT", "IN_ORBIT"));
    (fleet as any).idleShips.set("IDLE-1", true);

    await (fleet as any).syncShipStates();

    const states = await store.getAllShipStates(tenantId);
    const byShip = Object.fromEntries(states.map((s) => [s.shipSymbol, s.state]));
    assert.equal(byShip["TRADER-TRANSIT"], "travelling");
    assert.equal(byShip["MINER-DOCKED"], "docked");
    assert.equal(byShip["SCOUT-ORBIT"], "assigned");
    assert.equal(byShip["IDLE-1"], "idle");
  });

  it("re-syncing overwrites the previous state rather than accumulating rows", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "IN_TRANSIT"));
    await (fleet as any).syncShipStates();
    assert.equal((await store.getShipState(tenantId, "SHIP-1"))?.state, "travelling");

    (fleet as any).traders.delete("SHIP-1");
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "DOCKED"));
    await (fleet as any).syncShipStates();

    const all = await store.getAllShipStates(tenantId);
    assert.equal(all.filter((s) => s.shipSymbol === "SHIP-1").length, 1);
    assert.equal(all.find((s) => s.shipSymbol === "SHIP-1")?.state, "docked");
  });

  it("does nothing when the fleet has no tenantId/store (e.g. tests without Postgres)", async () => {
    const fleet = new FleetManager({ api: {} as any });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "DOCKED"));
    await assert.doesNotReject(() => (fleet as any).syncShipStates());
  });
});
