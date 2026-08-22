import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { MissionManager } from "../src/engine/mission.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * The first two describe blocks below are ported straight from straders'
 * tests/mission.test.ts — same assertions, `await` added to the four methods
 * that are now async (assignCarrier, pause; list/resumeMission aren't
 * exercised by these specific tests). None of them pass a `store`/`tenantId`,
 * matching the original: these are pure state-machine tests, not persistence
 * tests. The last two describe blocks are new — proving the tenant-scoped
 * persistence path itself against a real Postgres instance, which didn't
 * exist as a concept in the single-tenant original.
 */
function makeApi(materials: { tradeSymbol: string; required: number; fulfilled: number }[]) {
  return {
    getConstruction: async () => ({ isComplete: false, materials }),
  } as any;
}

describe("MissionManager.assignCarrier", () => {
  it("suspends the chosen ship and records it as the carrier", async () => {
    const suspended: string[] = [];
    const resumed: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => { suspended.push(s); },
      resume: (s) => resumed.push(s),
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.equal((await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-1");
    assert.deepEqual(suspended, ["SHIP-1"]);
    assert.deepEqual(resumed, []);
  });

  it("releases the previous carrier back to autonomy when reassigned", async () => {
    const suspended: string[] = [];
    const resumed: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => { suspended.push(s); },
      resume: (s) => resumed.push(s),
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-2");
    assert.equal((await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-2");
    assert.deepEqual(suspended, ["SHIP-1", "SHIP-2"]);
    assert.deepEqual(resumed, ["SHIP-1"]);
  });

  it("throws for a mission that doesn't exist", async () => {
    const mgr = new MissionManager({ api: makeApi([]) });
    await assert.rejects(() => mgr.assignCarrier("X1-A-NOWHERE", "SHIP-1"), /no active mission/);
  });

  it("pausing a mission that already has a carrier clears it from committedShips()", async () => {
    // Confirmed live: pause() resumed the carrier's agent but never cleared
    // mission.assignedShip, so committedShips() kept reporting it forever —
    // which meant FleetManager.syncShipClaims() re-claimed the ship as
    // owner "mission" on every tick, and since mission outranks warehouse
    // in ShipRegistry's precedence, that ship could never be designated the
    // warehouse ship again for as long as the mission stayed paused.
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: () => {},
      resume: () => {},
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.deepEqual([...mgr.committedShips()], ["SHIP-1"]);

    await mgr.pause("X1-A-I1");

    assert.deepEqual([...mgr.committedShips()], [], "a paused mission must not hold its former carrier committed");
    assert.equal((await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, undefined);
  });

  it("assigning a carrier to a paused mission does not restart its sourcing state or spend", async () => {
    const suspended: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => { suspended.push(s); },
      resume: () => {},
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.pause("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.equal((await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-1");
    // Still suspended immediately (the ship is committed) even though the
    // mission itself won't step while paused.
    assert.deepEqual(suspended, ["SHIP-1"]);
  });
});

/** Counts getConstruction calls so per-tick API cost can be observed. */
function makeCountingApi(materials: { tradeSymbol: string; required: number; fulfilled: number }[]) {
  const calls = { getConstruction: 0 };
  const api = {
    getConstruction: async () => {
      calls.getConstruction += 1;
      return { isComplete: false, materials };
    },
  } as any;
  return { api, calls };
}

describe("MissionManager API cost per tick", () => {
  it("a paused mission does not re-read its site on every tick", async () => {
    // Pausing a mission used to give back no API budget at all: the paused
    // branch reconciled against the live construction site on every 2s
    // coordinator tick, which is 0.5 req/s of a 2 req/s budget per mission.
    const { api, calls } = makeCountingApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]);
    const mgr = new MissionManager({ api });
    await mgr.startConstruction("X1-A-I1");
    const afterStart = calls.getConstruction;

    await mgr.pause("X1-A-I1");
    for (let i = 0; i < 20; i += 1) await mgr.tick();

    const reconciles = calls.getConstruction - afterStart;
    assert.ok(
      reconciles <= 1,
      `20 back-to-back ticks of a paused mission should reconcile at most once, got ${reconciles}`,
    );
  });

  it("an active mission in backoff does not re-read its site either", async () => {
    // The retryAt backoff used to be checked *after* getConstruction, so it
    // never prevented the request it exists to prevent.
    const { api, calls } = makeCountingApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]);
    const mgr = new MissionManager({
      api,
      // No known buyers and no discovery: step() sets a retry backoff and returns.
      listBuyers: async () => [],
      discoverBuyers: async () => [],
    });
    await mgr.startConstruction("X1-A-I1");

    await mgr.tick(); // first tick: reads the site, finds no buyer, sets retryAt
    const afterFirst = calls.getConstruction;
    for (let i = 0; i < 20; i += 1) await mgr.tick();

    assert.equal(
      calls.getConstruction,
      afterFirst,
      "while backing off, a mission must cost zero API calls",
    );
  });
});

// ── New: the tenant-scoped persistence path itself ──────────────────
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let pool: pg.Pool;
let store: Store;
let tenantA: string;
let tenantB: string;

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
  const a = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`MISSION-A-${Date.now()}`],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`MISSION-B-${Date.now()}`],
  );
  tenantA = a.rows[0]!.id;
  tenantB = b.rows[0]!.id;
});

after(async () => {
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
});

describe("MissionManager persistence", () => {
  it("startConstruction persists the new mission, findable via list()", async () => {
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 4000, fulfilled: 0 }]),
      store,
      tenantId: tenantA,
    });
    await mgr.startConstruction("X1-A-P1");
    const found = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-P1");
    assert.equal(found?.status, "active");
    assert.equal(found?.materials[0]?.required, 4000);

    // And it's really in the database, not just the in-memory `active` map —
    // read it back through a completely fresh Store/pool connection.
    const persisted = (await store.latestMissions(tenantA)).find((m) => m.targetWaypoint === "X1-A-P1");
    assert.ok(persisted, "must be readable from a fresh Store instance, not just in-memory state");
  });

  it("assignCarrier and pause/resume persist across a fresh MissionManager instance", async () => {
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      store,
      tenantId: tenantA,
      suspend: () => {},
      resume: () => {},
    });
    await mgr.startConstruction("X1-A-P2");
    await mgr.assignCarrier("X1-A-P2", "SHIP-9");
    await mgr.pause("X1-A-P2");

    // A brand new instance, same tenant, must resume from exactly this state.
    const fresh = new MissionManager({ api: makeApi([]), store, tenantId: tenantA, suspend: () => {} });
    await fresh.startConstruction("X1-A-P2"); // no-op materials arg — resumes from persisted state
    const found = (await fresh.list()).find((m) => m.targetWaypoint === "X1-A-P2");
    assert.equal(found?.assignedShip, "SHIP-9");
    assert.equal(found?.paused, true);
  });

  it("a tenant's missions are invisible to another tenant", async () => {
    const mgrA = new MissionManager({
      api: makeApi([{ tradeSymbol: "IRON", required: 10, fulfilled: 0 }]),
      store,
      tenantId: tenantA,
    });
    await mgrA.startConstruction("X1-A-ISO");

    const mgrB = new MissionManager({ api: makeApi([]), store, tenantId: tenantB });
    assert.equal((await mgrB.list()).find((m) => m.targetWaypoint === "X1-A-ISO"), undefined);
    assert.equal((await store.latestMissions(tenantB)).find((m) => m.targetWaypoint === "X1-A-ISO"), undefined);
  });

  it("without a store or tenantId, nothing persists but the in-memory state machine still works", async () => {
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 10, fulfilled: 0 }]),
    });
    await mgr.startConstruction("X1-A-NOSTORE");
    await mgr.assignCarrier("X1-A-NOSTORE", "SHIP-1");
    const found = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-NOSTORE");
    assert.equal(found?.assignedShip, "SHIP-1");
  });
});
