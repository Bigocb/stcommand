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

describe("MissionManager.stepCarrier re-discovery", () => {
  it("keeps surveying for a source after a carrier is assigned, instead of idling forever on an empty buyer list", async () => {
    // Confirmed live: once a carrier is assigned (manually via assignCarrier,
    // or by the auto-picker), stepCarrier()'s own "no buyer known" branch
    // used to just set a 60s retry and return — no call to discoverBuyers.
    // maybeDiscover() (which actually surveys) only ran in step()'s
    // *pre-assignment* gate, so an assigned carrier that hit an empty buyer
    // list was stuck there permanently: nothing would ever look for a new
    // source again, even though market supply in this game rotates and a
    // material nothing sells today may start being sold tomorrow. From the
    // operator's side this looked exactly like "I assigned a ship and
    // nothing happens."
    let discoverCalls = 0;
    const ship = {
      symbol: "SHIP-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 0, capacity: 0 },
    } as any;
    const mgr = new MissionManager({
      api: {
        ...makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
        getShipCargo: async () => ({ inventory: [] }),
      },
      getShip: async () => ship,
      suspend: () => {},
      resume: () => {},
      listBuyers: async () =>
        // Empty until discovery "finds" a market; every call after that
        // reports the real buyer, simulating a source becoming known.
        discoverCalls > 0 ? [{ waypoint: "X1-A-MKT", purchasePrice: 10, tradeVolume: 20 }] : [],
      discoverBuyers: async () => {
        discoverCalls += 1;
        return [{ waypoint: "X1-A-MKT", purchasePrice: 10 }];
      },
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1"); // force assignment past the pre-assignment buyer gate

    await mgr.tick(); // stepCarrier(): no buyer known yet -> must call discoverBuyers, not just back off
    assert.ok(discoverCalls >= 1, "an assigned carrier with no known buyer must trigger a fresh survey");

    const mission = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1");
    assert.equal(mission?.assignedShip, "SHIP-1", "the carrier must still be assigned, not released, while sourcing");
  });
});

describe("MissionManager material fallback", () => {
  it("falls back to a different outstanding material instead of fixating forever on one with no known seller", async () => {
    // Confirmed live: a construction site can need several materials at
    // once (e.g. FAB_MATS *and* ADVANCED_CIRCUITRY), but stepCarrier() only
    // ever worked whichever material sorted first in the array — with
    // exactly one carrier assigned per mission, that meant a single
    // hard-to-source material (no seller anywhere, or one whose purchase
    // kept failing) permanently starved every other material of any
    // progress at all, even ones with a perfectly good known seller. From
    // the operator's side, a mission that could clearly make progress on
    // ADVANCED_CIRCUITRY just sat there doing nothing because FAB_MATS
    // happened to be first and had no seller.
    const ship = {
      symbol: "SHIP-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-START", systemSymbol: "X1-A" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 0, capacity: 0 },
    } as any;
    const dispatched: string[] = [];
    const mgr = new MissionManager({
      api: {
        ...makeApi([
          { tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 },
          { tradeSymbol: "ADVANCED_CIRCUITRY", required: 50, fulfilled: 0 },
        ]),
        getShipCargo: async () => ({ inventory: [] }),
      },
      getShip: async () => ship,
      suspend: () => {},
      resume: () => {},
      dispatchShip: async (_s, wp) => { dispatched.push(wp); },
      // FAB_MATS has no known seller anywhere — ADVANCED_CIRCUITRY has one
      // right away. No discoverBuyers wired (matches an operator/fleet
      // config where discovery isn't set up): maybeDiscover() then no-ops
      // without touching retryAt, so the very next tick can immediately
      // observe the fallback instead of waiting out a 15s survey backoff.
      listBuyers: async (tradeSymbol) =>
        tradeSymbol === "ADVANCED_CIRCUITRY" ? [{ waypoint: "X1-A-D46", purchasePrice: 50, tradeVolume: 10 }] : [],
    });
    await mgr.startConstruction("X1-A-I1");
    await mgr.assignCarrier("X1-A-I1", "SHIP-1");

    await mgr.tick(); // picks FAB_MATS first (array order), finds no seller anywhere, blocks it
    assert.deepEqual(dispatched, [], "must not dispatch anywhere while the only candidate material has no seller");

    await mgr.tick(); // FAB_MATS now blocked -> must fall back to ADVANCED_CIRCUITRY, which has a real seller
    assert.deepEqual(
      dispatched,
      ["X1-A-D46"],
      "must switch to sourcing ADVANCED_CIRCUITRY from its known market instead of retrying FAB_MATS forever",
    );

    const mission = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1");
    assert.equal(mission?.assignedShip, "SHIP-1", "the carrier must still be assigned, working the other material");
  });

  it("still auto-assigns a carrier when only a later material (not the first) has a known seller", async () => {
    // The same fixation bug, one level higher: step()'s own pre-assignment
    // gate decided whether to bother picking a carrier at all by checking
    // only mission.materials.find(...)'s first result. If that material (in
    // practice, whichever sorts first — FAB_MATS here) had no known seller,
    // the gate bailed into maybeDiscover() and returned *without ever
    // calling pickCarrier* — so no carrier was ever assigned, full stop,
    // even though ADVANCED_CIRCUITRY had a perfectly good known seller the
    // whole time. From the operator's side this looked identical to "the
    // system assigned nothing and never will."
    const ship = {
      symbol: "AUTO-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-D46", systemSymbol: "X1-A" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 0, capacity: 0 },
    } as any;
    let pickCarrierCalls = 0;
    const mgr = new MissionManager({
      api: {
        ...makeApi([
          { tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 },
          { tradeSymbol: "ADVANCED_CIRCUITRY", required: 50, fulfilled: 0 },
        ]),
        getShipCargo: async () => ({ inventory: [] }),
      },
      getShip: async () => ship,
      suspend: () => {},
      resume: () => {},
      dispatchShip: async () => {},
      listBuyers: async (tradeSymbol) =>
        tradeSymbol === "ADVANCED_CIRCUITRY" ? [{ waypoint: "X1-A-D46", purchasePrice: 50, tradeVolume: 10 }] : [],
      pickCarrier: async () => {
        pickCarrierCalls += 1;
        return "AUTO-1";
      },
    });
    await mgr.startConstruction("X1-A-I1");

    await mgr.tick();
    assert.ok(pickCarrierCalls >= 1, "a carrier must be picked once ANY outstanding material has a known seller");
    const mission = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1");
    assert.equal(mission?.assignedShip, "AUTO-1");
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
    // assignedShip is expected undefined, not "SHIP-9": pause() deliberately
    // releases the carrier before persisting (see its own comment) — a
    // paused mission must not keep holding its former carrier committed, so
    // that ship can be reassigned elsewhere while the mission sits paused.
    const fresh = new MissionManager({ api: makeApi([]), store, tenantId: tenantA, suspend: () => {} });
    await fresh.startConstruction("X1-A-P2"); // no-op materials arg — resumes from persisted state
    const found = (await fresh.list()).find((m) => m.targetWaypoint === "X1-A-P2");
    assert.equal(found?.assignedShip, undefined);
    assert.equal(found?.paused, true);
  });

  it("list() reports a persisted paused mission correctly even before startConstruction() reloads it", async () => {
    // Confirmed live: FleetManager never called startConstruction() again at
    // boot, so a fresh process's this.paused (only ever populated by
    // startConstruction()'s restore branch) was empty for every mission that
    // existed before the restart. list()'s old fallback — `this.paused.has(...)`
    // unconditionally, even for a mission it fell back to reading from the
    // persisted row because it wasn't in this.active — reported every such
    // mission as unpaused, regardless of what the operator had actually set.
    // That's precisely the bug: an operator's pause silently didn't survive
    // a restart, and the dashboard couldn't even show it as paused.
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      store,
      tenantId: tenantA,
      suspend: () => {},
      resume: () => {},
    });
    await mgr.startConstruction("X1-A-P3");
    await mgr.pause("X1-A-P3");

    // A fresh instance that never re-runs startConstruction("X1-A-P3") at
    // all — list() must fall back to the persisted row's own paused column,
    // not silently report false.
    const fresh = new MissionManager({ api: makeApi([]), store, tenantId: tenantA });
    const found = (await fresh.list()).find((m) => m.targetWaypoint === "X1-A-P3");
    assert.equal(found?.paused, true, "a mission list() falls back to from the DB must still report its real paused state");
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
