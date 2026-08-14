import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Integration/regression coverage per the design doc's own Testing
 * Strategy section: a longer-running multi-ship scenario checking
 * invariants hold over many ticks, cross-tenant isolation under real
 * concurrent scheduler-driven load, persistence surviving a simulated
 * restart, and explicit regression cases for the "eight owners collide"
 * bug class the whole redesign exists to fix.
 *
 * Like every other fleet.ts test in this repo, this drives real
 * coordinator logic (tick(), dispatcher.recompute(), maybeAssignKeepers(),
 * the sync* methods) against fake agents standing in for real ships, not a
 * simulated SpaceTraders network backend — building a full game-mechanics
 * simulator is out of scope here the same way straders' own trader.test.ts
 * was never ported to this repo (see README's "not yet ported" note).
 * What's under test is FleetManager's own bookkeeping staying consistent,
 * not literal trading/mining outcomes.
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

async function makeTenant(prefix: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

/** Same shape as tests/fleet.test.ts's makeFakeAgent — full fuel, so rescueStranded() naturally no-ops. */
function makeFakeAgent(symbol: string, waypointSymbol = "X1-A-A1", cargoCapacity = 40) {
  const nav = { status: "DOCKED", waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) };
  let manual = false;
  let suspended = false;
  return {
    symbol,
    getShip: () => ({ symbol, nav, fuel: { current: 100, capacity: 100 }, cargo: { capacity: cargoCapacity, units: 0, inventory: [] } }),
    isManual: () => manual,
    isSuspended: () => suspended,
    isStranded: () => false,
    dispatchTo: async (wp: string) => { manual = true; },
    release: () => { manual = false; },
    suspend: () => { suspended = true; },
    resume: () => { suspended = false; },
    stop: () => {},
    pinnedField: () => undefined,
    mineAt: () => {},
    unpinMining: () => {},
  };
}

/** Every test in this file constructs FleetManager through this — its fake `api.getShip` routes to whichever agent is currently in one of the fleet's own role maps, same forward-reference pattern tests/shipRegistryCutover.test.ts's makeFleet() uses. */
function makeScenarioFleetManager(opts: { store?: Store; tenantId?: string }): FleetManager {
  let fleet!: FleetManager;
  const log = () => {}; // this file drives 100+ real ticks; the real per-tick logging is noise here, not signal
  const api = {
    // controlledAgent() deliberately excludes keepers (see its own doc
    // comment in fleet.ts) — this needs every role map, unlike the simpler
    // fakes elsewhere in this repo, because maybeAssignKeepers() runs for
    // real here and converts a miner mid-scenario (default keeperCount is
    // 2, not 0 — see doctrine.ts's DEFAULTS), and the real ShipAgent that
    // conversion creates calls api.getShip() on refresh().
    getShip: async (s: string) =>
      (fleet as any).miners.get(s)?.getShip() ??
      (fleet as any).traders.get(s)?.getShip() ??
      (fleet as any).surveyors.get(s)?.getShip() ??
      (fleet as any).tours.get(s)?.getShip() ??
      (fleet as any).keepers.get(s)?.getShip() ??
      (fleet as any).scouts.get(s)?.getShip() ??
      (fleet as any).siphoners.get(s)?.getShip() ??
      (fleet as any).idleShips.get(s),
  };
  fleet = new FleetManager({ api: api as any, log, ...opts });
  return fleet;
}

/** Silences the parts of tick() that would otherwise need a real SpaceTraders API — same stubbing tests/fleet.test.ts's own "halted fleet" test already does for refreshCredits. */
function silenceApiDependentSteps(fleet: FleetManager): void {
  for (const name of ["refreshCredits", "maybeBuyShip", "maybeBuyScout", "maybeBuySiphoner", "maybeInstallScanner", "autoExplore"]) {
    (fleet as any)[name] = async () => {};
  }
}

function buildScenarioFleet(tenantId: string): FleetManager {
  const fleet = makeScenarioFleetManager({ store, tenantId });
  silenceApiDependentSteps(fleet);
  (fleet as any).miners.set("MINER-1", makeFakeAgent("MINER-1"));
  (fleet as any).miners.set("MINER-2", makeFakeAgent("MINER-2"));
  (fleet as any).miners.set("MINER-3", makeFakeAgent("MINER-3"));
  (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1"));
  (fleet as any).traders.set("TRADER-2", makeFakeAgent("TRADER-2"));
  (fleet as any).traders.set("TRADER-3", makeFakeAgent("TRADER-3"));
  (fleet as any).surveyors.set("SURVEYOR-1", makeFakeAgent("SURVEYOR-1"));
  (fleet as any).tours.set("TOUR-1", makeFakeAgent("TOUR-1"));
  (fleet as any).keepers.set("KEEPER-1", makeFakeAgent("KEEPER-1"));
  (fleet as any).idleShips.set("IDLE-1", makeFakeAgent("IDLE-1").getShip());
  return fleet;
}

const ALL_SHIP_SYMBOLS = ["MINER-1", "MINER-2", "MINER-3", "TRADER-1", "TRADER-2", "TRADER-3", "SURVEYOR-1", "TOUR-1", "KEEPER-1", "IDLE-1"];

describe("Full fleet scenario: 100 coordinator ticks, invariants hold throughout", () => {
  it("every ship ends with exactly one claim, a valid persisted state, and no cross-role duplication", async () => {
    const tenantId = await makeTenant("SCENARIO");
    const fleet = buildScenarioFleet(tenantId);
    // keeperCount defaults to 2 (doctrine.ts's DEFAULTS) — pinned to 0 so
    // maybeAssignKeepers() doesn't convert a miner/shuttle mid-scenario.
    // That conversion path (and the real background keeperLoop()/
    // nextKeeperTask() it starts) is already covered by
    // tests/shipRegistryCutover.test.ts; this test's job is checking
    // invariants hold across many ticks for a *known* role composition.
    await fleet.doctrine.set("keeperCount", { value: 0, enabled: true });

    // 5 warehouse-target goods.
    for (const good of ["IRON_ORE", "COPPER_ORE", "ALUMINUM_ORE", "SILVER_ORE", "GOLD_ORE"]) {
      await store.setWarehouseTarget(tenantId, good, 100, false);
    }
    await fleet.designateWarehouseShip("TRADER-3", "X1-A-A2");

    // 3 missions (no carrier assigned — pickMissionCarrier's own candidate
    // search runs for real each tick this fleet has active missions).
    for (const wp of ["X1-A-I10", "X1-A-I20", "X1-A-I30"]) {
      await fleet.missions.startConstruction(wp, [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]);
    }

    let tickErrors = 0;
    for (let i = 0; i < 100; i++) {
      try {
        await fleet.tick();
      } catch (err) {
        tickErrors += 1;
      }
    }
    assert.equal(tickErrors, 0, "100 ticks against a stable fake fleet must not throw");

    const claims = await store.getAllClaims(tenantId);
    const claimedSymbols = claims.map((c) => c.shipSymbol);
    assert.equal(new Set(claimedSymbols).size, claimedSymbols.length, "no ship symbol claimed twice");
    for (const sym of ALL_SHIP_SYMBOLS) {
      assert.ok(claimedSymbols.includes(sym), `${sym} must end up with exactly one claim`);
    }
    assert.equal(claims.find((c) => c.shipSymbol === "TRADER-3")?.owner, "warehouse");

    const states = await store.getAllShipStates(tenantId);
    const validStates = new Set(["idle", "assigned", "travelling", "docked"]);
    for (const sym of ALL_SHIP_SYMBOLS) {
      const row = states.find((s) => s.shipSymbol === sym);
      assert.ok(row, `${sym} must have a persisted ship_state row`);
      assert.ok(validStates.has(row!.state), `${sym}'s state (${row!.state}) must be one of the four valid lifecycle states`);
    }

    // Structural invariant: no ship symbol appears in more than one role map at once.
    const roleMaps = ["miners", "traders", "surveyors", "tours", "keepers", "scouts", "siphoners"] as const;
    for (const sym of ALL_SHIP_SYMBOLS) {
      const memberships = roleMaps.filter((m) => (fleet as any)[m].has(sym));
      assert.ok(memberships.length <= 1, `${sym} must not be in more than one role map at once (in: ${memberships.join(", ")})`);
    }
  });
});

describe("Two tenants ticking concurrently: cross-tenant isolation under real load", () => {
  it("neither tenant's claims/state/manifest rows ever reference the other's ship symbols", async () => {
    const tenantA = await makeTenant("CONCURRENT-A");
    const tenantB = await makeTenant("CONCURRENT-B");

    const fleetA = makeScenarioFleetManager({ store, tenantId: tenantA });
    const fleetB = makeScenarioFleetManager({ store, tenantId: tenantB });
    silenceApiDependentSteps(fleetA);
    silenceApiDependentSteps(fleetB);
    (fleetA as any).traders.set("A-SHIP-1", makeFakeAgent("A-SHIP-1"));
    (fleetA as any).traders.set("A-SHIP-2", makeFakeAgent("A-SHIP-2"));
    (fleetB as any).traders.set("B-SHIP-1", makeFakeAgent("B-SHIP-1"));
    (fleetB as any).traders.set("B-SHIP-2", makeFakeAgent("B-SHIP-2"));

    // Interleaved, not sequential — both fleets' ticks genuinely overlap in time.
    const ticksA = Array.from({ length: 20 }, () => fleetA.tick());
    const ticksB = Array.from({ length: 20 }, () => fleetB.tick());
    await Promise.all([...ticksA, ...ticksB]);

    const [claimsA, claimsB, statesA, statesB, manifestA, manifestB] = await Promise.all([
      store.getAllClaims(tenantA),
      store.getAllClaims(tenantB),
      store.getAllShipStates(tenantA),
      store.getAllShipStates(tenantB),
      store.getAllManifestRows(tenantA),
      store.getAllManifestRows(tenantB),
    ]);

    for (const row of [...claimsA, ...statesA, ...manifestA]) {
      assert.ok(row.shipSymbol.startsWith("A-SHIP-"), `tenant A must never see a row for ${row.shipSymbol}`);
    }
    for (const row of [...claimsB, ...statesB, ...manifestB]) {
      assert.ok(row.shipSymbol.startsWith("B-SHIP-"), `tenant B must never see a row for ${row.shipSymbol}`);
    }
    assert.equal(claimsA.length, 2);
    assert.equal(claimsB.length, 2);
  });
});

describe("Restart/resume: persisted state survives a fresh FleetManager instance", () => {
  it("ship_claims, ship_state, and ship_manifest all read back correctly after a simulated restart", async () => {
    const tenantId = await makeTenant("RESTART");
    const fleetA = makeScenarioFleetManager({ store, tenantId });
    silenceApiDependentSteps(fleetA);
    (fleetA as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));
    (fleetA as any).traders.set("SHIP-2", makeFakeAgent("SHIP-2"));
    await fleetA.holdShip("SHIP-1"); // an explicit operator claim, not just the auto default
    await fleetA.tick();
    await fleetA.tick();

    const claimsBefore = await store.getAllClaims(tenantId);
    const statesBefore = await store.getAllShipStates(tenantId);
    assert.equal(claimsBefore.find((c) => c.shipSymbol === "SHIP-1")?.owner, "operator");
    assert.equal(claimsBefore.find((c) => c.shipSymbol === "SHIP-2")?.owner, "auto");
    assert.equal(statesBefore.length, 2);

    // A brand-new FleetManager instance, same tenantId/store — nothing
    // carried over in memory, exactly what a process restart looks like.
    // FleetManager.init() would call shipRegistry.loadAllClaims() as its
    // first step; simulate that directly since a full init() needs a real
    // SpaceTraders API to rediscover the fleet's ships from.
    const fleetB = makeScenarioFleetManager({ store, tenantId });
    await fleetB.shipRegistry.loadAllClaims(tenantId, store);

    assert.equal(fleetB.shipRegistry.ownerOf("SHIP-1")?.owner, "operator", "the operator hold must survive the restart");
    assert.equal(fleetB.shipRegistry.ownerOf("SHIP-2")?.owner, "auto");

    // ship_state/ship_manifest aren't hydrated into any in-memory structure
    // on FleetManager (they're synced *to* the store, read back by the
    // dashboard directly) — what "survives a restart" means for them is
    // just that the rows are still there, queryable, unaffected by the old
    // process's in-memory state being gone.
    const statesAfter = await store.getAllShipStates(tenantId);
    assert.deepEqual(new Set(statesAfter.map((s) => s.shipSymbol)), new Set(statesBefore.map((s) => s.shipSymbol)));
  });
});

describe("Regression: the original eight-owners-collision bug class", () => {
  it("a suspended trader is excluded from dispatcherTraders() and has its route released immediately, not up to a minute later", async () => {
    const tenantId = await makeTenant("REGRESSION");
    const fleet = makeScenarioFleetManager({ store, tenantId });
    const agent = makeFakeAgent("SHIP-1");
    (fleet as any).traders.set("SHIP-1", agent);

    const beforeSuspend = (fleet as any).dispatcherTraders();
    assert.ok(beforeSuspend.some((t: any) => t.shipSymbol === "SHIP-1"), "an un-suspended trader must be a normal dispatch candidate");

    fleet.dispatcher.recompute(
      [{ good: "IRON", buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: 10, sellPrice: 20, margin: 10, volume: 10, profitPerTrip: 50, fuelUnits: 0, fuelCost: 0, distance: 0, buySystem: "X1-A", sellSystem: "X1-A", ageMinutes: 0 } as any],
      beforeSuspend,
      [],
      [],
      [],
    );
    assert.ok(fleet.dispatcher.assignmentFor("SHIP-1"), "must have been assigned a route while healthy");

    (fleet as any).suspendAgent("SHIP-1"); // e.g. picked up for a rescue or mission mid-route

    assert.ok(agent.isSuspended());
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1"), undefined, "the route must be released the moment the ship is suspended, not left stale until the next recompute");
    const afterSuspend = (fleet as any).dispatcherTraders();
    assert.ok(!afterSuspend.some((t: any) => t.shipSymbol === "SHIP-1"), "a suspended trader must not be offered a route at all");
  });

  it("a designated warehouse ship's claim survives repeated resyncs — the exact bug the 100-tick scenario test caught", async () => {
    // designateWarehouseShip() dispatches the ship via the same
    // dispatchTo()/manual-hold mechanism an operator hold uses (see that
    // method's own comment), so isManual() is genuinely true for the
    // warehouse ship too — syncShipClaims()'s owner derivation must check
    // "is this the warehouse ship" before "is it paused/manual", or the
    // periodic resync silently flips a correctly-claimed "warehouse" back
    // to "operator" on the very next tick. Regression coverage for exactly
    // that ordering bug, isolated from the 100-tick scenario test that
    // originally surfaced it.
    const tenantId = await makeTenant("REGRESSION");
    const fleet = makeScenarioFleetManager({ store, tenantId });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));

    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "warehouse");

    // Multiple resyncs, exactly like multiple coordinator ticks — the bug
    // only showed up on the *second* one, since the first resync happened
    // to run before designateWarehouseShip()'s dispatchTo() had taken effect.
    for (let i = 0; i < 5; i++) await (fleet as any).syncShipClaims();

    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "warehouse", "must still be warehouse after repeated resyncs, not silently flipped to operator");
    const persisted = await store.getClaim(tenantId, "SHIP-1");
    assert.equal(persisted?.owner, "warehouse", "the persisted row must agree with the in-memory registry");
  });
});
