import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * The ShipRegistry cutover: fleet.ts's mutation methods now call
 * shipRegistry.claim()/release() for real, at the moment of mutation —
 * not just mirrored after the fact by syncShipClaims() at the next tick —
 * and actually reject the action when a stronger claim already exists.
 * These tests exercise the enforcement, not just the bookkeeping: Phase
 * 4's own tests (tests/shipRegistry.test.ts) already cover the registry
 * class and the tick-level mirror in isolation.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
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
    [`CUTOVER-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

/** Same shape as tests/fleet.test.ts's makeFakeAgent. */
function makeFakeAgent(symbol: string, waypointSymbol = "X1-A-A1", cargoCapacity = 40) {
  let nav = { status: "DOCKED", waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) };
  let manual = false;
  let suspended = false;
  return {
    symbol,
    getShip: () => ({ symbol, nav, cargo: { capacity: cargoCapacity, units: 0, inventory: [] } }),
    isManual: () => manual,
    isSuspended: () => suspended,
    dispatchTo: async (wp: string) => { nav = { ...nav, waypointSymbol: wp }; manual = true; },
    release: () => { manual = false; },
    suspend: () => { suspended = true; },
    resume: () => { suspended = false; },
    stop: () => {},
    pinnedField: () => undefined,
    mineAt: () => {},
    unpinMining: () => {},
  };
}

function makeFleet(store: Store, tenantId: string, apiOverrides: Record<string, unknown> = {}) {
  let fleet: FleetManager;
  const api = {
    getShip: async (s: string) => (fleet as any).controlledAgent(s)?.getShip() ?? (fleet as any).idleShips.get(s),
    navigateShip: async (s: string, wp: string) => ({ nav: { status: "IN_TRANSIT", waypointSymbol: wp } }),
    orbitShip: async () => ({}),
    dockShip: async () => ({}),
    ...apiOverrides,
  };
  fleet = new FleetManager({ api: api as any, store, tenantId });
  return fleet;
}

/** Same shape as makeFakeAgent, plus fuel — needed for reachability checks. */
function makeFakeAgentWithFuel(symbol: string, waypointSymbol: string, cargoCapacity: number, fuelCapacity: number) {
  const base = makeFakeAgent(symbol, waypointSymbol, cargoCapacity);
  return {
    ...base,
    getShip: () => ({ ...base.getShip(), fuel: { current: fuelCapacity, capacity: fuelCapacity } }),
  };
}

describe("holdShip / releaseShip claim the registry immediately", () => {
  it("holdShip claims operator; releaseShip releases it", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));

    await fleet.holdShip("SHIP-1");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "operator");

    await fleet.releaseShip("SHIP-1");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1"), undefined);
  });
});

describe("designateWarehouseShip enforces the claim, not just records it", () => {
  it("succeeds and claims warehouse for an unclaimed ship", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));

    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "warehouse");
  });

  it("rejects designating a ship an operator is already holding", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));
    await fleet.holdShip("SHIP-1");

    await assert.rejects(
      () => fleet.designateWarehouseShip("SHIP-1", "X1-A-A2"),
      /claimed by operator/,
    );
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "operator", "the operator claim must survive the rejected attempt");
  });

  it("releaseWarehouseShip releases the warehouse claim specifically, not an operator claim", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "warehouse");

    await fleet.releaseWarehouseShip();
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1"), undefined);
  });
});

describe("assignMissionCarrier enforces the claim", () => {
  it("rejects a ship an operator is already holding, before ever touching MissionManager", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1"));
    await fleet.holdShip("SHIP-1");

    // No active mission exists at this waypoint at all — proving the
    // rejection happens at the claim check, not deeper inside
    // MissionManager.assignCarrier() (which would instead throw "no active
    // mission").
    await assert.rejects(
      () => fleet.assignMissionCarrier("X1-A-I59", "SHIP-1"),
      /claimed by operator/,
    );
  });

  it("rejects a ship that cannot physically reach the mission target, instead of silently accepting it", async () => {
    // Confirmed live: stepCarrier() runs this exact reachability check on
    // every mission tick and silently releases the carrier back to autonomy
    // the instant it fails, with nothing but a log line — but the manual
    // assign path had no such check at all, only the auto-picker did. An
    // operator manually assigning a ship with too little fuel range saw the
    // assignment appear to succeed, then quietly get undone on the next
    // tick with zero visible feedback. This must reject up front instead.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId, {
      getConstruction: async () => ({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 10, fulfilled: 0 }] }),
    });
    // Two waypoints 1000 units apart — far beyond any fuel tank below.
    (fleet as any).positions = [
      { symbol: "X1-A-A1", x: 0, y: 0, type: "PLANET" },
      { symbol: "X1-A-FAR", x: 1000, y: 0, type: "JUMP_GATE" },
    ];
    (fleet as any).traders.set("SHORT-RANGE", makeFakeAgentWithFuel("SHORT-RANGE", "X1-A-A1", 40, 80));
    await fleet.startMission("X1-A-FAR");

    await assert.rejects(
      () => fleet.assignMissionCarrier("X1-A-FAR", "SHORT-RANGE"),
      /cannot reach/,
    );
    // The rejected assignment must not leave the ship stuck falsely claimed
    // by the mission it was never actually assigned to.
    assert.equal(fleet.shipRegistry.ownerOf("SHORT-RANGE"), undefined);
  });
});

describe("pickMissionCarrier (auto-pick) excludes operator-held ships and claims its pick", () => {
  it("skips an operator-held candidate in favor of an unclaimed one", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).traders.set("HELD-1", makeFakeAgent("HELD-1", "X1-A-A1", 50)); // larger cargo — would normally win
    (fleet as any).traders.set("FREE-1", makeFakeAgent("FREE-1", "X1-A-A1", 20));
    await fleet.holdShip("HELD-1");

    const picked = await (fleet as any).pickMissionCarrier(new Set());
    assert.equal(picked, "FREE-1", "the larger-cargo ship must be skipped because it's operator-held");
    assert.equal(fleet.shipRegistry.ownerOf("FREE-1")?.owner, "mission");
  });
});

describe("maybeAssignKeepers respects a claim the idle() filter alone would have missed", () => {
  it("skips a candidate the registry already shows claimed by a stronger owner", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    await fleet.doctrine.set("keeperCount", { value: 5, enabled: true });
    await store.setFleetFlag(tenantId, "keeperMarkets", JSON.stringify(["X1-A-D46"]));

    (fleet as any).miners.set("MINER-1", makeFakeAgent("MINER-1"));
    // Simulate a claim that arrived out-of-band since the last tick's sync —
    // isManual()/isSuspended() on the fake agent are both still false, so
    // only the registry check can catch this.
    fleet.shipRegistry.claim("MINER-1", "operator", "miner", {}, { preempt: true });

    await (fleet as any).maybeAssignKeepers();

    assert.ok(!(fleet as any).keepers.has("MINER-1"), "a registry-claimed ship must not be converted, even though the idle() filter alone would have allowed it");
    assert.equal(fleet.shipRegistry.ownerOf("MINER-1")?.owner, "operator", "the pre-existing claim must be untouched");
  });

  it("still converts an unclaimed candidate normally", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    await fleet.doctrine.set("keeperCount", { value: 5, enabled: true });
    await store.setFleetFlag(tenantId, "keeperMarkets", JSON.stringify(["X1-A-D46"]));

    (fleet as any).miners.set("MINER-1", makeFakeAgent("MINER-1"));

    await (fleet as any).maybeAssignKeepers();

    assert.ok((fleet as any).keepers.has("MINER-1"));
    assert.equal(fleet.shipRegistry.ownerOf("MINER-1")?.owner, "keeper");
    // maybeAssignKeepers() launches the new keeper's real keeperLoop() in
    // the background (void keeper.keeperLoop(1_000_000)) — same as
    // FleetManager.run() itself, this must be stopped or the loop's own
    // sleep()-chained iterations keep the test process alive indefinitely.
    (fleet as any).keepers.get("MINER-1")?.stop();
  });
});

describe("syncShipClaims recognizes an active rescue tender", () => {
  it("does not overwrite a rescue claim back to auto on the same tick it was made", async () => {
    // Confirmed by code review (docs/ship-control-state-audit.md, Phase 2):
    // makeRescuePlan() claims "rescue" the moment a tender is picked, but
    // syncShipClaims() runs later in the same tick and, before this fix,
    // had no way to know the ship was tendering — it derived "auto" (not
    // paused, not a mission carrier, not a keeper) and overwrote the fresh
    // "rescue" claim with preempt:true immediately.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    const tender = makeFakeAgent("TENDER-1");
    (fleet as any).traders.set("TENDER-1", tender);
    tender.suspend();
    fleet.shipRegistry.claim("TENDER-1", "rescue", "trader");
    (fleet as any).rescuePlans.set("STRANDED-1", {
      strandedSymbol: "STRANDED-1",
      strandedWaypoint: "X1-A-A1",
      tenderSymbol: "TENDER-1",
      market: "X1-A-A2",
      fuelUnits: 10,
      phase: "transit",
    });

    await (fleet as any).syncShipClaims();

    assert.equal(
      fleet.shipRegistry.ownerOf("TENDER-1")?.owner,
      "rescue",
      "an active tender's claim must survive the tick's own registry mirror, not be relabeled auto",
    );
  });
});
