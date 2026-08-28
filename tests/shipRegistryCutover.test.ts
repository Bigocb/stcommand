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
function makeFakeAgent(symbol: string, waypointSymbol = "X1-A-A1", cargoCapacity = 40, fuelCurrent = 100, fuelCapacity = 100) {
  let nav = { status: "DOCKED", waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) };
  let manual = false;
  let suspended = false;
  return {
    symbol,
    getShip: () => ({ symbol, nav, cargo: { capacity: cargoCapacity, units: 0, inventory: [] }, fuel: { current: fuelCurrent, capacity: fuelCapacity } }),
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

describe("dispatchShipHop is non-blocking", () => {
  it("issues exactly one navigate call toward an unreachable-in-one-hop target and returns, instead of blocking for the whole multi-leg trip", async () => {
    // Confirmed live: this used to block synchronously (a real setTimeout
    // sleep) until the ship physically arrived, for every leg of the route.
    // Since it's called from stepCarrier(), itself awaited directly inside
    // the shared fleet coordinator's tick(), a mission carrier flying toward
    // a distant target froze the ENTIRE coordinator — every other ship's
    // dispatch, every other mission, contracts — for the full trip. This
    // proves the fix: one call does at most one hop and returns immediately,
    // relying on the caller re-checking ship status on a later tick to
    // continue the route.
    const navigateCalls: string[] = [];
    let shipState = { waypointSymbol: "X1-A-START", status: "IN_ORBIT" as string, fuelCurrent: 120, flightMode: "CRUISE" as string };
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId, {
      getShip: async () => ({
        symbol: "SHIP-1",
        nav: { status: shipState.status, waypointSymbol: shipState.waypointSymbol, systemSymbol: "X1-A", flightMode: shipState.flightMode },
        fuel: { current: shipState.fuelCurrent, capacity: 120 },
      }),
      orbitShip: async () => { shipState = { ...shipState, status: "IN_ORBIT" }; return {}; },
      dockShip: async () => { shipState = { ...shipState, status: "DOCKED" }; return {}; },
      refuelShip: async () => { shipState = { ...shipState, fuelCurrent: 120 }; return {}; },
      patchShipNav: async (_s: string, mode: string) => { shipState = { ...shipState, flightMode: mode }; return {}; },
      navigateShip: async (_s: string, wp: string) => {
        navigateCalls.push(wp);
        // Ship departs but is still IN_TRANSIT — must NOT resolve to arrived.
        shipState = { ...shipState, status: "IN_TRANSIT" };
        return { fuel: { current: shipState.fuelCurrent, capacity: 120 }, nav: { status: "IN_TRANSIT" } };
      },
    });
    // START -> TARGET is 200 units (beyond the 120 fuel cap) — unreachable
    // in one hop. HOP sits at 100 units from both, a valid fuel stop.
    (fleet as any).positions = [
      { symbol: "X1-A-START", x: 0, y: 0, type: "PLANET" },
      { symbol: "X1-A-HOP", x: 100, y: 0, type: "FUEL_STATION" },
      { symbol: "X1-A-TARGET", x: 200, y: 0, type: "JUMP_GATE" },
    ];
    (fleet as any).galaxy.systems.set("X1-A", {
      symbol: "X1-A",
      waypoints: [{ symbol: "X1-A-HOP", type: "FUEL_STATION" }],
      jumpGates: [],
      markets: [],
      shipyards: [],
    });

    await (fleet as any).dispatchShipHop("SHIP-1", "X1-A-TARGET");

    assert.deepEqual(navigateCalls, ["X1-A-HOP"], "must hop toward the reachable fuel stop, not attempt the unreachable direct route");
    assert.equal(shipState.status, "IN_TRANSIT", "the single hop must actually depart");
  });

  it("forces CRUISE before navigating, so estimatedFuelBetween()'s straight-line math stays accurate", async () => {
    // Confirmed live via server logs: "mission X1-CP51-I62 step error:
    // Navigate request failed. Ship FALCON-8 requires 338 more fuel for
    // navigation" — on a 600-fuel-capacity ship with a full tank, for a leg
    // estimatedFuelBetween() (straight-line distance, calibrated for
    // CRUISE) put at well under half that. The ship's flightMode had been
    // left at BURN from its own trading before the mission took over —
    // roughly double fuel cost for the same distance — and nothing here
    // ever reset it before issuing the real navigate call.
    let patchedTo: string | undefined;
    let shipState = { waypointSymbol: "X1-A-START", status: "IN_ORBIT" as string, fuelCurrent: 600, flightMode: "BURN" as string };
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId, {
      getShip: async () => ({
        symbol: "SHIP-1",
        nav: { status: shipState.status, waypointSymbol: shipState.waypointSymbol, systemSymbol: "X1-A", flightMode: shipState.flightMode },
        fuel: { current: shipState.fuelCurrent, capacity: 600 },
      }),
      orbitShip: async () => { shipState = { ...shipState, status: "IN_ORBIT" }; return {}; },
      dockShip: async () => { shipState = { ...shipState, status: "DOCKED" }; return {}; },
      refuelShip: async () => { shipState = { ...shipState, fuelCurrent: 600 }; return {}; },
      patchShipNav: async (_s: string, mode: string) => { patchedTo = mode; shipState = { ...shipState, flightMode: mode }; return {}; },
      navigateShip: async () => { shipState = { ...shipState, status: "IN_TRANSIT" }; return { fuel: { current: shipState.fuelCurrent, capacity: 600 }, nav: { status: "IN_TRANSIT" } }; },
    });
    (fleet as any).positions = [
      { symbol: "X1-A-START", x: 0, y: 0, type: "PLANET" },
      { symbol: "X1-A-TARGET", x: 469, y: 0, type: "JUMP_GATE" },
    ];
    (fleet as any).galaxy.systems.set("X1-A", { symbol: "X1-A", waypoints: [], jumpGates: [], markets: [], shipyards: [] });

    await (fleet as any).dispatchShipHop("SHIP-1", "X1-A-TARGET");

    assert.equal(patchedTo, "CRUISE", "must force the ship's flight mode to CRUISE before trusting the straight-line fuel estimate");
    assert.equal(shipState.status, "IN_TRANSIT", "must actually depart, not just patch the mode and stop");
  });
});

describe("materialBuyers is scoped to the mission's own system", () => {
  it("never returns a cheaper listing from an unrelated system with no route back to the mission's own", async () => {
    // Confirmed live: this was the actual root cause of a mission carrier
    // that got assigned, refueled, and then never went anywhere — logged
    // as "mission X1-CP51-I62 step error: no jump gate from X1-CP51 to
    // X1-TQ19". materialBuyers() searched the fleet's ENTIRE market cache,
    // built from every system any tour/scout ship has ever surveyed, not
    // just the mission's own system. A cheaper listing in a system with no
    // jump gate connection back sorted first, the mission picked it as the
    // market to buy from, and every tick failed identically trying to
    // route there — invisible to the operator, since a buyer was always
    // "found", just an unreachable one.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    await store.recordMarket({ systemSymbol: "X1-CP51", waypointSymbol: "X1-CP51-F55", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "ABUNDANT", purchasePrice: 1125, sellPrice: 555, tradeVolume: 20 });
    // Cheaper, but in a different, unreachable system.
    await store.recordMarket({ systemSymbol: "X1-TQ19", waypointSymbol: "X1-TQ19-B2", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "ABUNDANT", purchasePrice: 800, sellPrice: 400, tradeVolume: 20 });

    const buyers = await (fleet as any).materialBuyers("FAB_MATS", "X1-CP51");

    assert.equal(buyers.length, 1, "must not include the cheaper but unreachable listing from the other system");
    assert.equal(buyers[0].waypoint, "X1-CP51-F55");
  });
});

describe("assignContractCarrier — manual ship pinning for contract delivery", () => {
  it("rejects a ship with no cargo hold", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).systemSymbol = "X1-CP51";
    (fleet as any).traders.set("NO-HOLD", makeFakeAgent("NO-HOLD", "X1-CP51-A1", 0));

    await assert.rejects(
      () => fleet.assignContractCarrier("NO-HOLD", "SILVER"),
      /no cargo hold/,
    );
  });

  it("rejects a ship that isn't a trader at all", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    (fleet as any).systemSymbol = "X1-CP51";

    await assert.rejects(
      () => fleet.assignContractCarrier("GHOST", "SILVER"),
      /not a trader/,
    );
  });

  it("rejects when no known market sells the good", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    // A one-off system symbol, not shared with any other test — market_prices
    // isn't tenant-scoped (market data is global, not secret), so a
    // real waypoint/good pair reused across tests can be polluted by an
    // earlier run's leftover row and never actually exercise "no market".
    const sys = `X1-Q${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    (fleet as any).systemSymbol = sys;
    (fleet as any).traders.set("FALCON-D", makeFakeAgent("FALCON-D", `${sys}-H59`, 80));

    await assert.rejects(
      () => fleet.assignContractCarrier("FALCON-D", "SILVER"),
      /no known market sells SILVER/,
    );
  });

  it("pins a manual contractBuy assignment the dispatcher respects, same mechanism as the direct-route override", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet(store, tenantId);
    const sys = `X1-Q${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    (fleet as any).systemSymbol = sys;
    (fleet as any).traders.set("FALCON-D", makeFakeAgent("FALCON-D", `${sys}-H59`, 80));
    await store.recordMarket({ systemSymbol: sys, waypointSymbol: `${sys}-F55`, goodSymbol: "SILVER", type: "EXPORT", supply: "ABUNDANT", purchasePrice: 400, sellPrice: 200, tradeVolume: 20 });

    await fleet.assignContractCarrier("FALCON-D", "SILVER");

    const assignment = fleet.dispatcher.assignmentFor("FALCON-D");
    assert.equal(assignment?.role, "contractBuy");
    assert.equal(assignment?.good, "SILVER");
    assert.equal(assignment?.buyAt, `${sys}-F55`);
    assert.equal(assignment?.source, "manual");
  });
});
