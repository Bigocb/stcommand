import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { FleetManager } from "../src/engine/fleet.js";
import { Scheduler } from "../src/engine/scheduler.js";

/**
 * Slice 1 of the parked-ships design (docs/parked-ships-design.md §3):
 * a park is a persisted operator decision, and it remembers the role the hull
 * had so unparking can resume it rather than guess.
 *
 * These tests go through the public interfaces an operator's decision actually
 * travels: the store row, then a full fleet boot. Nothing here reaches into
 * private state to prove the decision stuck — if init() forgets it, these
 * fail.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:***@localhost:5432/stcommand";
let pool: pg.Pool;
const tenantIds: string[] = [];

before(async () => {
  pool = createPool(DB_URL);
});

after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function makeTenant(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`PARKED-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

describe("a park remembers the role it replaced", () => {
  it("round-trips through the fleet state row", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);

    await store.setFleetState(tenantId, "SHIP-1", "parked", undefined, "miner");

    const row = (await store.getFleetState(tenantId)).find((r) => r.shipSymbol === "SHIP-1");
    assert.equal(row?.role, "parked", "the park itself must be the persisted role");
    assert.equal(row?.parkedFrom, "miner", "the role it replaced must survive with it");
  });

  it("keeps the remembered role out of the way of ordinary role rows", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);

    await store.setFleetState(tenantId, "SHIP-1", "trader");

    const row = (await store.getFleetState(tenantId)).find((r) => r.shipSymbol === "SHIP-1");
    assert.equal(row?.role, "trader");
    assert.equal(row?.parkedFrom, undefined, "a ship that was never parked has nothing remembered");
  });
});

/** A ship whose hull alone would make assignRole() pick "trader" (big hold, nothing to mine with). */
function makeRawShip(symbol: string, opts: { cargoCapacity?: number; waypoint?: string } = {}): any {
  const waypoint = opts.waypoint ?? "X1-TEST-A1";
  return {
    symbol,
    registration: { role: "HAULER" },
    nav: { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-TEST" },
    cargo: { capacity: opts.cargoCapacity ?? 200, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
    frame: { symbol: "FRAME_FRIGATE" },
    mounts: [],
    modules: [],
  };
}

/**
 * Everything FleetManager.init() asks of the game API, including the market
 * hook (api.onMarket) the fleet registers when it has a store. Its absence is
 * what makes several older suites in this repo fail at boot, so it is here
 * from the start.
 */
function makeInitApi(ships: any[]) {
  return {
    getCallCount: () => 0,
    onMarket: () => {},
    getMyAgent: async () => ({ credits: 100_000, headquarters: "X1-TEST-A1", symbol: "TEST", shipCount: ships.length }),
    getSystem: async () => ({}),
    getAllSystemWaypoints: async () => [],
    listAllShips: async () => ships,
    getShip: async (symbol: string) => ships.find((s) => s.symbol === symbol) ?? ships[0],
  } as any;
}

describe("a parked hull survives a fleet boot", () => {
  it("comes back parked, is not re-derived, and still reports where it is", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const ship = makeRawShip("SHIP-PARKED");
    await store.setFleetState(tenantId, "SHIP-PARKED", "parked", undefined, "trader");

    const fleet = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await fleet.init();

    const rows = fleet.getShipStatuses().filter((s) => s.symbol === "SHIP-PARKED");
    assert.equal(rows.length, 1, "a parked hull is reported once, not once per role map it leaked into");
    assert.equal(rows[0]!.role, "parked");
    assert.equal(rows[0]!.parkedFrom, "trader", "the role it replaced must come back with it");
    assert.equal(rows[0]!.status, "DOCKED", "its real nav status, not a placeholder");

    const summary = fleet.fleetStatusSummary().find((s) => s.symbol === "SHIP-PARKED")!;
    assert.equal(summary.waypoint, "X1-TEST-A1", "the dashboard must know where the parked hull is");
    assert.equal(summary.fuel, 100, "and how much fuel it has");
    assert.equal(summary.cargoCap, 200, "and what it can carry");
    assert.equal(summary.doing, "parked", "and say plainly that it is parked, not 'manual hold' or 'docked'");

    // The park is still the operator's decision after a second boot, not a
    // one-shot that init() forgets the next time the process comes up.
    const restarted = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await restarted.init();
    const again = restarted.getShipStatuses().find((s) => s.symbol === "SHIP-PARKED");
    assert.equal(again?.role, "parked", "the park must survive a restart");
    assert.equal(again?.parkedFrom, "trader", "with its remembered role intact");

    // And every controller that asks the ownership registry must see an
    // operator decision, not a free hull.
    await (restarted as any).syncShipClaims();
    assert.equal(restarted.shipRegistry.ownerOf("SHIP-PARKED")?.owner, "operator");
    assert.equal(restarted.shipRegistry.ownerOf("SHIP-PARKED")?.role, "parked");
  });

  it("is given no task chain, so it can never spend a call", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const ship = makeRawShip("SHIP-PARKED");
    await store.setFleetState(tenantId, "SHIP-PARKED", "parked", undefined, "trader");
    const scheduler = new Scheduler({ log: () => {} });

    const fleet = new FleetManager({ api: makeInitApi([ship]), store, tenantId, scheduler });
    await fleet.init();
    (fleet as any).syncSchedulerTasks();

    assert.equal(scheduler.size(), 1, "only the fleet-wide rescue task may be queued for a fleet of one parked hull");
  });

  it("still derives a role for a hull that was never parked", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const ship = makeRawShip("SHIP-FREE");

    const fleet = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await fleet.init();

    const row = fleet.getShipStatuses().find((s) => s.symbol === "SHIP-FREE");
    assert.equal(row?.role, "trader", "an untouched hull must be roled exactly as it is today");
    assert.equal(row?.parkedFrom, undefined);
  });
});
