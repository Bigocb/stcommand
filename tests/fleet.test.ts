import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager, DEFAULT_KEEPER_MARKETS } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Ported from straders' tests/fleet.test.ts. Same assertions and scenarios;
 * every method fleet.ts made async now gets `await`, and every store-backed
 * test creates a real tenant against Postgres instead of a temp SQLite file
 * (`tempDb()` is gone — `makeTenant()` below is its replacement). One test
 * ("setPaused ... restores it immediately") is rewritten rather than just
 * `await`-ed: the synchronous constructor-time restore it exercised no
 * longer exists (Postgres reads are async, so restoration moved to
 * `init()` — see FleetManager's constructor comment) — see the note on that
 * test below for what changed and why.
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
    [`FLEET-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

/** A minimal stand-in for the agent classes FleetManager holds in its role maps. */
function makeFakeAgent(symbol: string, waypointSymbol: string, cargoCapacity = 40, cargoUnits = 0, fuelCurrent = 100, fuelCapacity = 100) {
  let nav = { status: "DOCKED", waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) };
  let manual = false;
  let suspended = false;
  let pinned: string | undefined;
  return {
    symbol,
    getShip: () => ({ symbol, nav, cargo: { capacity: cargoCapacity, units: cargoUnits, inventory: [] }, fuel: { current: fuelCurrent, capacity: fuelCapacity } }),
    isManual: () => manual,
    isSuspended: () => suspended,
    dispatchTo: async (wp: string) => {
      nav = { ...nav, waypointSymbol: wp };
      manual = true;
    },
    release: () => {
      manual = false;
      pinned = undefined;
    },
    suspend: () => {
      suspended = true;
    },
    resume: () => {
      suspended = false;
    },
    stop: () => {},
    pinnedField: () => pinned,
    mineAt: (wp: string) => {
      pinned = wp;
    },
    unpinMining: () => {
      pinned = undefined;
    },
  };
}

/** Helper for rescue tests: inject known markets and positions into fleet state. */
function stubMarketSystem(fleet: FleetManager, systemSymbol: string, waypointCoords: Record<string, { x: number; y: number }>) {
  const waypoints = Object.keys(waypointCoords);
  (fleet as any).markets = waypoints.map((symbol) => ({ symbol, systemSymbol, tradeGoods: {} }));
  (fleet as any).positions = waypoints.map((symbol) => ({ symbol, ...waypointCoords[symbol], type: "MOON" }));
  (fleet as any).galaxy = {
    getSystem: (sys: string) =>
      sys === systemSymbol
        ? {
            symbol: systemSymbol,
            waypoints: waypoints.map((symbol) => ({ symbol, type: "MOON", traits: [{ symbol: "MARKETPLACE" }] })),
          }
        : undefined,
  };
}

function makeFleet(agents: ReturnType<typeof makeFakeAgent>[], store?: Store, tenantId?: string) {
  const fleet = new FleetManager({
    api: {
      getShip: async (s: string) => agents.find((a) => a.symbol === s)!.getShip(),
    } as any,
    store,
    tenantId,
  });
  for (const a of agents) (fleet as any).traders.set(a.symbol, a);
  return fleet;
}

describe("FleetManager warehouse ship", () => {
  it("designates a ship and parks it via dispatchTo", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.deepEqual(fleet.getWarehouseShip(), { shipSymbol: "SHIP-1", waypointSymbol: "X1-A-A2" });
    assert.equal(agent.getShip().nav.waypointSymbol, "X1-A-A2");
    assert.equal(agent.isManual(), true);
  });

  it("refuses a ship with no cargo hold", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1", 0);
    const fleet = makeFleet([agent]);
    await assert.rejects(() => fleet.designateWarehouseShip("SHIP-1", "X1-A-A2"), /cargo hold/);
    assert.equal(fleet.getWarehouseShip(), undefined);
  });

  it("refuses a ship not under fleet control", async () => {
    const fleet = makeFleet([]);
    await assert.rejects(() => fleet.designateWarehouseShip("GHOST-1", "X1-A-A2"), /not under fleet control/);
  });

  it("re-designating releases the previous warehouse ship", async () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    await fleet.designateWarehouseShip("SHIP-2", "X1-A-A3");
    assert.deepEqual(fleet.getWarehouseShip(), { shipSymbol: "SHIP-2", waypointSymbol: "X1-A-A3" });
    assert.equal(a.isManual(), false, "the old warehouse ship must be handed back to auto duty");
  });

  it("releaseWarehouseShip clears the designation and releases the ship", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    await fleet.releaseWarehouseShip();
    assert.equal(fleet.getWarehouseShip(), undefined);
    assert.equal(agent.isManual(), false);
  });

  it("releaseWarehouseShip is a no-op when nothing is designated", async () => {
    const fleet = makeFleet([]);
    await assert.doesNotReject(() => fleet.releaseWarehouseShip());
  });

  it("scrapping the warehouse ship clears the designation", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    await (fleet as any).removeShip("SHIP-1");
    assert.equal(fleet.getWarehouseShip(), undefined);
  });

  it("getShipStatuses reports the warehouse ship once, tagged as warehouse", async () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    const statuses = fleet.getShipStatuses();
    const forShip1 = statuses.filter((s) => s.symbol === "SHIP-1");
    assert.equal(forShip1.length, 1, "the warehouse ship must not appear twice");
    assert.equal(forShip1[0]?.role, "warehouse");
    const forShip2 = statuses.filter((s) => s.symbol === "SHIP-2");
    assert.equal(forShip2.length, 1);
    assert.equal(forShip2[0]?.role, "trader");
  });
});

describe("FleetManager.jettisonCargo", () => {
  function makeAgentWithCargo(symbol: string, inventory: { symbol: string; units: number }[]) {
    const units = inventory.reduce((sum, i) => sum + i.units, 0);
    return {
      symbol,
      getShip: () => ({ symbol, nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units, inventory } }),
      isManual: () => false,
      isSuspended: () => false,
      dispatchTo: async () => {},
      release: () => {},
      suspend: () => {},
      resume: () => {},
      stop: () => {},
      pinnedField: () => undefined,
    };
  }

  it("jettisons cargo without requiring a market or dock", async () => {
    const agent = makeAgentWithCargo("SHIP-1", [{ symbol: "IRON_ORE", units: 10 }]);
    let jettisoned: { shipSymbol: string; symbol: string; units: number } | undefined;
    const fleet = new FleetManager({
      api: {
        getShip: async () => agent.getShip(),
        jettisonCargo: async (shipSymbol: string, symbol: string, units: number) => {
          jettisoned = { shipSymbol, symbol, units };
          return { cargo: { capacity: 40, units: 0, inventory: [] } };
        },
      } as any,
    });
    (fleet as any).traders.set("SHIP-1", agent);

    await fleet.jettisonCargo("SHIP-1", "IRON_ORE", 10);

    assert.deepEqual(jettisoned, { shipSymbol: "SHIP-1", symbol: "IRON_ORE", units: 10 });
  });

  it("caps units jettisoned at what's actually held, not the requested amount", async () => {
    const agent = makeAgentWithCargo("SHIP-1", [{ symbol: "IRON_ORE", units: 5 }]);
    let jettisonedUnits: number | undefined;
    const fleet = new FleetManager({
      api: {
        getShip: async () => agent.getShip(),
        jettisonCargo: async (_s: string, _g: string, units: number) => {
          jettisonedUnits = units;
          return { cargo: { capacity: 40, units: 0, inventory: [] } };
        },
      } as any,
    });
    (fleet as any).traders.set("SHIP-1", agent);

    await fleet.jettisonCargo("SHIP-1", "IRON_ORE", 999);

    assert.equal(jettisonedUnits, 5);
  });

  it("refuses to jettison a good the ship isn't carrying", async () => {
    const agent = makeAgentWithCargo("SHIP-1", []);
    const fleet = new FleetManager({ api: { getShip: async () => agent.getShip() } as any });
    (fleet as any).traders.set("SHIP-1", agent);

    await assert.rejects(() => fleet.jettisonCargo("SHIP-1", "IRON_ORE", 5), /no IRON_ORE in cargo/);
  });
});

describe("FleetManager.getIntel", () => {
  // Confirmed live: shipyard_inventory/module_catalog are shared,
  // tenant-unscoped tables (intentionally, so a user's own multiple agents
  // on the same live reset benefit from each other's scans) — but an
  // operator switching between agents from different SpaceTraders server
  // resets saw the old agent's stale scans listed forever alongside the
  // new one's, with no way to tell which was still real. getIntel() now
  // filters both to systems this fleet's own galaxy atlas has actually
  // loaded — the natural boundary, since loadSystem() only succeeds
  // against the live API for systems that exist in the *current* reset.
  it("only returns shipyards/modules in systems this fleet's galaxy atlas actually knows about", async () => {
    const fakeStore = {
      shipyardInventory: async () => [
        { systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", shipType: "SHIP_PROBE", shipTypeName: "Probe", purchasePrice: 100, fuelCapacity: 0, cargoCapacity: 0, moduleSlots: 0, mountingPoints: 0, frameSymbol: "FRAME_PROBE", timestamp: new Date().toISOString() },
        { systemSymbol: "X1-STALE", waypointSymbol: "X1-STALE-B1", shipType: "SHIP_MINER", shipTypeName: "Miner", purchasePrice: 200, fuelCapacity: 80, cargoCapacity: 40, moduleSlots: 0, mountingPoints: 0, frameSymbol: "FRAME_MINER", timestamp: new Date().toISOString() },
      ],
      moduleCatalog: async () => [
        { systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", symbol: "MODULE_CARGO_HOLD_I", kind: "module", name: "Cargo Hold I", category: "cargo", purchasePrice: 5000, timestamp: new Date().toISOString() },
        { systemSymbol: "X1-STALE", waypointSymbol: "X1-STALE-B2", symbol: "MODULE_CARGO_HOLD_I", kind: "module", name: "Cargo Hold I", category: "cargo", purchasePrice: 5000, timestamp: new Date().toISOString() },
      ],
    };
    const fleet = new FleetManager({ api: {} as any, store: fakeStore as any });
    (fleet as any).galaxy = { listSystems: () => [{ symbol: "X1-A" }], getSystem: () => undefined };

    const intel = await fleet.getIntel();

    assert.deepEqual(intel.shipyards.map((s) => s.systemSymbol), ["X1-A"], "the stale reset's shipyard must be dropped");
    assert.deepEqual(intel.modules.map((m) => m.systemSymbol), ["X1-A"], "the stale reset's module must be dropped");
  });
});

describe("FleetManager dispatcher eligibility", () => {
  it("a suspended trader stops reserving its good for the whole fleet", () => {
    // An assignment reserves its good against the entire rest of the fleet.
    // A trader suspended as a mission carrier still received one, so a long
    // construction mission could lock the fleet's best route away for hours
    // behind a ship parked at a building site.
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);

    assert.deepEqual(
      (fleet as any).dispatcherTraders().map((t: any) => t.shipSymbol).sort(),
      ["SHIP-1", "SHIP-2"],
    );

    (fleet as any).suspendAgent("SHIP-1");
    assert.deepEqual(
      (fleet as any).dispatcherTraders().map((t: any) => t.shipSymbol),
      ["SHIP-2"],
      "a suspended carrier must not be handed a route it cannot fly",
    );
  });

  it("a held trader stops reserving its good too", async () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);
    await fleet.holdShip("SHIP-1");
    assert.deepEqual(
      (fleet as any).dispatcherTraders().map((t: any) => t.shipSymbol),
      ["SHIP-2"],
      "an operator hold must not withdraw a route from the rest of the fleet",
    );
  });

  it("suspending releases the live claim immediately, not at the next recompute", () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([a]);
    fleet.dispatcher.setManual("SHIP-1", undefined);
    fleet.dispatcher.claim("SHIP-1");
    (fleet as any).suspendAgent("SHIP-1");
    assert.equal(
      fleet.dispatcher.assignmentFor("SHIP-1"),
      undefined,
      "the good should be free the moment the ship stops trading",
    );
  });

  it("resuming makes the trader eligible again", () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([a]);
    (fleet as any).suspendAgent("SHIP-1");
    assert.deepEqual((fleet as any).dispatcherTraders(), []);
    (fleet as any).resumeAgent("SHIP-1");
    assert.deepEqual(
      (fleet as any).dispatcherTraders().map((t: any) => t.shipSymbol),
      ["SHIP-1"],
    );
  });

  it("resuming also clears a manual-dispatch goal, not just suspension", async () => {
    // resumeAgent() is MissionManager's `resume` callback — its only
    // caller — fired when a carrier is released back to autonomy. A carrier
    // is routed around mid-mission via dispatchShip() (source market ->
    // target waypoint, repeated), which sets the same manual-dispatch goal
    // an operator's own hold/dispatch would. Confirmed live: resume() alone
    // only cleared isSuspended(), so a ship dropped as carrier stayed stuck
    // reporting "manual hold" forever afterward with no operator action —
    // isManual() never went back to false.
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([a]);
    await a.dispatchTo("X1-A-A2"); // stand-in for a mid-mission dispatchShip() call
    assert.equal(a.isManual(), true, "sanity check: dispatchTo sets the manual goal");
    (fleet as any).resumeAgent("SHIP-1");
    assert.equal(a.isManual(), false, "resuming a carrier must release its manual-dispatch goal too");
  });
});

describe("FleetManager restart persistence", () => {
  it("holdShip persists the hold, so a restart doesn't lose it", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([agent], store, tenantId);
    await fleet.holdShip("SHIP-1");
    const raw = await store.getFleetFlag(tenantId, "shipManualState");
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { holdWaypoint: "X1-A-A1" } });
  });

  it("releaseShip clears the persisted hold", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([agent], store, tenantId);
    await fleet.holdShip("SHIP-1");
    await fleet.releaseShip("SHIP-1");
    assert.equal(await store.getFleetFlag(tenantId, "shipManualState"), undefined);
  });

  it("mineAt persists the pin independently of any hold on the same ship", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    (fleet as any).miners.set("SHIP-1", agent);
    await fleet.mineAt("SHIP-1", "X1-A-E5");
    const raw = await store.getFleetFlag(tenantId, "shipManualState");
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { minePin: "X1-A-E5" } });
  });

  it("unpinMining clears only the pin, not a coexisting hold", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    (fleet as any).miners.set("SHIP-1", agent);
    await fleet.mineAt("SHIP-1", "X1-A-E5");
    // holdShip goes through controlledAgent, which only looks at
    // miners/traders/surveyors/tours/scouts/siphoners — SHIP-1 is already a
    // registered miner above, so this reaches the same agent.
    await fleet.holdShip("SHIP-1");
    await fleet.unpinMining("SHIP-1");
    const raw = await store.getFleetFlag(tenantId, "shipManualState");
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { holdWaypoint: "X1-A-A1" } });
  });

  it("designateWarehouseShip persists the binding; releaseWarehouseShip clears it", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([agent], store, tenantId);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.deepEqual(JSON.parse((await store.getFleetFlag(tenantId, "warehouseShip"))!), { shipSymbol: "SHIP-1", waypointSymbol: "X1-A-A2" });
    await fleet.releaseWarehouseShip();
    assert.equal(await store.getFleetFlag(tenantId, "warehouseShip"), undefined);
  });

  it("scrapping a ship drops its persisted hold/pin, warehouse binding, and dispatch override", async () => {
    const tenantId = await makeTenant();
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(pool);
    const fleet = makeFleet([agent], store, tenantId);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    await fleet.setManualDispatch("SHIP-1", {
      shipSymbol: "SHIP-1", good: "IRON", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A2",
      buyPrice: 10, sellPrice: 20, profitPerTrip: 100, source: "manual",
    } as any);
    await (fleet as any).removeShip("SHIP-1");
    assert.equal(await store.getFleetFlag(tenantId, "warehouseShip"), undefined);
    assert.equal(await store.getFleetFlag(tenantId, "shipManualState"), undefined);
    assert.equal(await store.getFleetFlag(tenantId, "dispatchManual"), undefined);
  });

  it("setManualDispatch persists the override and updates the live assignment together", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    const assignment = {
      shipSymbol: "SHIP-1", good: "IRON", role: "direct" as const, buyAt: "X1-A-A1", sellAt: "X1-A-A2",
      buyPrice: 10, sellPrice: 20, profitPerTrip: 100, source: "auto" as const,
    };
    await fleet.setManualDispatch("SHIP-1", assignment);
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1")?.good, "IRON");
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1")?.source, "manual", "setManualDispatch always tags the assignment manual");
    const persisted = JSON.parse((await store.getFleetFlag(tenantId, "dispatchManual"))!);
    assert.equal(persisted["SHIP-1"].good, "IRON");

    await fleet.setManualDispatch("SHIP-1", undefined);
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1"), undefined);
    assert.equal(await store.getFleetFlag(tenantId, "dispatchManual"), undefined);
  });

  it("a halted fleet still runs rescue, but nothing else", async () => {
    // Halt stops automation, not recovery. Previously pausing switched off
    // rescueStranded() — the only thing that recovers a 0-fuel ship — while
    // leaving every ship loop running, so a Halt made stranding *more* likely.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    let rescues = 0;
    let creditRefreshes = 0;
    (fleet as any).rescueStranded = async () => { rescues += 1; };
    (fleet as any).refreshCredits = async () => { creditRefreshes += 1; };

    await fleet.setPaused(true);
    await fleet.tick();

    assert.equal(rescues, 1, "rescue must keep running while halted");
    assert.equal(creditRefreshes, 0, "ordinary coordination must not run while halted");
  });

  it("halting the fleet stops the ship agents too", async () => {
    // The predicate handed to every agent is what makes Halt real; agents own
    // their own loops and would otherwise keep trading straight through it.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    const opts = (fleet as any).traderOptions("SHIP-1");
    assert.equal(typeof opts.shouldRun, "function", "traders must receive a halt predicate");
    assert.equal(opts.shouldRun(), true, "an unpaused fleet lets ships run");
    await fleet.setPaused(true);
    assert.equal(opts.shouldRun(), false, "a halted fleet stops ships acting");
  });

  it("setPaused persists the halt state to the store", async () => {
    // The original straders test also asserted that a *fresh* FleetManager on
    // the same store came back paused immediately after construction —
    // better-sqlite3 could restore that synchronously in the constructor.
    // Postgres reads are inherently async, so that restore moved to init()
    // (see FleetManager's constructor comment): a freshly constructed
    // instance now starts unpaused until init() runs, by design — narrower
    // than before, but honest about where the async boundary actually is.
    // What's unchanged and still tested here: setPaused's write, and that the
    // persisted value is readable back from a completely fresh Store/pool
    // connection, not just in-memory state.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    assert.equal(fleet.isPaused(), false, "starts unpaused by default");
    await fleet.setPaused(true);
    assert.equal(await store.getFleetFlag(tenantId, "paused"), "true");

    const restarted = makeFleet([], store, tenantId);
    assert.equal(restarted.isPaused(), false, "not restored yet — only init() reads it back, per the async boundary above");
    if (tenantId) assert.equal((await store.getFleetFlag(tenantId, "paused")), "true", "but the persisted value itself is still there, waiting for init()");

    await fleet.setPaused(false);
    assert.equal(await store.getFleetFlag(tenantId, "paused"), "false");
  });
});

const sampleRoutes = [
  { good: "IRON", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 10, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 20, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 100, ageMinutes: 1 },
  { good: "GOLD", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 5, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 15, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 50, ageMinutes: 1 },
] as any[];

describe("FleetManager warehouse targets", () => {
  it("produces no targets while warehousing is disabled (the default)", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    await store.setWarehouseTarget(tenantId, "IRON", 300, false);
    const fleet = makeFleet([], store, tenantId);
    const targets = await (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("produces no targets when the curated list is empty, even though warehousing is enabled", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    const targets = await (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, [], "only goods an operator explicitly added are ever warehoused");
  });

  it("only a curated good with a real route gets a target — uncurated goods stay direct", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await fleet.doctrine.set("warehouseMax", { value: 200, enabled: true });
    await store.setWarehouseTarget(tenantId, "IRON", 300, false);
    // GOLD has a real route but was never added to the curated list.
    await store.warehouseDeposit(tenantId, "IRON", 50, 10, undefined, "buy");

    const targets = (await (fleet as any).computeWarehouseTargets(sampleRoutes)) as { good: string; target: number; balance: number }[];

    assert.deepEqual(targets.map((t) => t.good), ["IRON"]);
    assert.equal(targets[0]!.target, 200, "target is capped by warehouseMax even though the curated target is set higher");
    assert.equal(targets[0]!.balance, 50);
  });

  it("a curated good with no real route right now is skipped this cycle", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "SILVER", 100, false); // not in sampleRoutes

    const targets = await (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("a good flagged forMission is excluded — it goes through computeMissionBuyTargets instead", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "IRON", 300, true);

    const targets = await (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("disabling warehouseMax removes the cap", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await fleet.doctrine.set("warehouseMax", { value: 200, enabled: false });
    await store.setWarehouseTarget(tenantId, "IRON", 300, false);

    const targets = (await (fleet as any).computeWarehouseTargets(sampleRoutes)) as { good: string; target: number; balance: number }[];

    assert.equal(targets[0]!.target, 300);
  });
});

describe("FleetManager haul targets", () => {
  it("produces no haul targets while warehousing is disabled (the default)", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    await store.warehouseDeposit(tenantId, "FAB_MATS", 30, 61, undefined, "adjust");

    assert.deepEqual(await (fleet as any).computeHaulTargets(), []);
  });

  it("once enabled, a mission-needed good the warehouse holds becomes a haul target", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    await store.warehouseDeposit(tenantId, "FAB_MATS", 30, 61, undefined, "adjust");

    const targets = await (fleet as any).computeHaulTargets();

    assert.deepEqual(targets, [{ good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 80, balance: 30 }]);
  });

  it("no haul target when the warehouse holds none of the needed good", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual(await (fleet as any).computeHaulTargets(), []);
  });

  it("no haul target for a material that's already fully supplied", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 100 }]);
    await store.warehouseDeposit(tenantId, "FAB_MATS", 30, 61, undefined, "adjust");

    assert.deepEqual(await (fleet as any).computeHaulTargets(), []);
  });

  it("a paused mission produces no haul target", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    await store.warehouseDeposit(tenantId, "FAB_MATS", 30, 61, undefined, "adjust");
    await fleet.missions.pause("X1-A-I59");

    assert.deepEqual(await (fleet as any).computeHaulTargets(), []);
  });
});

describe("FleetManager mission buy targets", () => {
  // market_snapshots is a shared, ungated galaxy table (no tenant_id) — unlike
  // the original SQLite tests, which each got a fresh throwaway db file, every
  // test in this process shares one Postgres instance, so a FAB_MATS row one
  // test records here is still visible to the next one unless cleared. Same
  // for market_latest (Greenfield Phase 1's read-model projection of the
  // same data, keyed the same way) — computeMissionBuyTargets reads that
  // projection now, so a leftover row there is just as visible as one in the
  // history table would have been.
  beforeEach(async () => {
    await pool.query(`DELETE FROM market_snapshots WHERE good_symbol = 'FAB_MATS'`);
    await pool.query(`DELETE FROM market_latest WHERE good_symbol = 'FAB_MATS'`);
  });

  it("produces no mission-buy targets while warehousing is disabled (the default)", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 0, true);
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 } as any);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual(await (fleet as any).computeMissionBuyTargets(), []);
  });

  it("produces no mission-buy targets when nothing is flagged forMission", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 100, false); // curated, but not flagged for mission buying
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 } as any);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual(await (fleet as any).computeMissionBuyTargets(), []);
  });

  it("a good flagged forMission with an active mission short of it sources the cheapest known market", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 0, true);
    // Two markets sell it — the cheaper one should win.
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 } as any);
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-E12", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "MODERATE", purchasePrice: 70, sellPrice: 60, tradeVolume: 30 } as any);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    const targets = await (fleet as any).computeMissionBuyTargets();

    assert.deepEqual(targets, [{ good: "FAB_MATS", buyAt: "X1-A-D46", buyPrice: 61, needed: 80, balance: 0 }]);
  });

  it("a good with no known market yet produces no mission-buy target", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 0, true);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual(await (fleet as any).computeMissionBuyTargets(), []);
  });

  it("a material that's already fully supplied produces no mission-buy target", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 0, true);
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 } as any);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 100 }]);

    assert.deepEqual(await (fleet as any).computeMissionBuyTargets(), []);
  });

  it("a paused mission produces no mission-buy target", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.doctrine.set("warehouseTarget", { enabled: true });
    await store.setWarehouseTarget(tenantId, "FAB_MATS", 0, true);
    await store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 } as any);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    await fleet.missions.pause("X1-A-I59");

    assert.deepEqual(await (fleet as any).computeMissionBuyTargets(), []);
  });
});

describe("FleetManager warehouse target list", () => {
  it("starts empty", async () => {
    const tenantId = await makeTenant();
    const fleet = makeFleet([], new Store(pool), tenantId);
    assert.deepEqual(await fleet.warehouseTargetList(), []);
  });

  it("setWarehouseTarget adds a good, removeWarehouseTarget drops it", async () => {
    const tenantId = await makeTenant();
    const fleet = makeFleet([], new Store(pool), tenantId);
    await fleet.setWarehouseTarget("IRON_ORE", 100, false);
    await fleet.setWarehouseTarget("FAB_MATS", 50, true);
    assert.deepEqual(await fleet.warehouseTargetList(), [
      { goodSymbol: "FAB_MATS", target: 50, forMission: true },
      { goodSymbol: "IRON_ORE", target: 100, forMission: false },
    ]);
    await fleet.removeWarehouseTarget("IRON_ORE");
    assert.deepEqual(await fleet.warehouseTargetList(), [{ goodSymbol: "FAB_MATS", target: 50, forMission: true }]);
  });

  it("rejects a non-positive target", async () => {
    const tenantId = await makeTenant();
    const fleet = makeFleet([], new Store(pool), tenantId);
    await assert.rejects(() => fleet.setWarehouseTarget("IRON_ORE", 0, false), /positive/);
    await assert.rejects(() => fleet.setWarehouseTarget("IRON_ORE", -5, false), /positive/);
  });

  it("throws with no store attached", async () => {
    const fleet = makeFleet([]);
    await assert.rejects(() => fleet.setWarehouseTarget("IRON_ORE", 100, false), /store not available/);
  });

  it("removeWarehouseTarget with no store attached is a safe no-op", async () => {
    const fleet = makeFleet([]);
    await assert.doesNotReject(() => fleet.removeWarehouseTarget("IRON_ORE"));
  });
});

describe("FleetManager dispatcherTraders", () => {
  it("excludes the warehouse ship so it can never lock a good away from a real trader", async () => {
    const warehouse = makeFakeAgent("WH-1", "X1-A-A1");
    const trader = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([warehouse, trader]);
    await fleet.designateWarehouseShip("WH-1", "X1-A-A2");

    const eligible = (fleet as any).dispatcherTraders() as { shipSymbol: string }[];

    assert.deepEqual(eligible.map((t) => t.shipSymbol), ["SHIP-1"]);
  });

  it("marks a trader busy when it's holding cargo", () => {
    const trader = makeFakeAgent("SHIP-1", "X1-A-A1", 40, 12);
    const fleet = makeFleet([trader]);

    const eligible = (fleet as any).dispatcherTraders() as { shipSymbol: string; busy: boolean }[];

    assert.equal(eligible[0]?.busy, true);
  });
});

describe("FleetManager.availableFor", () => {
  // The one shared availability check that replaced three independent
  // isManual()/isSuspended() checks in dispatcherTraders(), pickMissionCarrier(),
  // and maybeAssignKeepers() — see docs/ship-control-state-audit.md, Phase 1.
  // None of these ships have gone through syncShipClaims() (no tenant/store
  // wired up here), so this specifically exercises the "no claim recorded
  // yet" fallback path, not the registry-claim path — see the other
  // describe blocks above/below for the registry-backed callers still
  // behaving correctly through that fallback.
  it("excludes a manually-held ship and a suspended ship, includes a free one", async () => {
    const free = makeFakeAgent("FREE-1", "X1-A-A1");
    const held = makeFakeAgent("HELD-1", "X1-A-A1");
    const suspended = makeFakeAgent("SUSP-1", "X1-A-A1");
    const fleet = makeFleet([free, held, suspended]);
    await held.dispatchTo("X1-A-A2");
    suspended.suspend();

    const available = (fleet as any).availableFor("auto") as Set<string>;

    assert.equal(available.has("FREE-1"), true);
    assert.equal(available.has("HELD-1"), false);
    assert.equal(available.has("SUSP-1"), false);
  });

  it("a claim recorded in the registry overrides the direct fallback check", () => {
    const ship = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([ship]);
    // Ship is free by isManual()/isSuspended(), but explicitly claimed by a
    // stronger owner (operator) in the registry — mission must not treat it
    // as available even though the fallback path alone would say yes.
    (fleet as any).shipRegistry.claim("SHIP-1", "operator", "trader");

    const available = (fleet as any).availableFor("mission") as Set<string>;

    assert.equal(available.has("SHIP-1"), false, "an operator claim in the registry must win over the direct fallback check");
  });
});

describe("FleetManager.releaseTo (unified handback path)", () => {
  // Phase 3 of docs/ship-control-state-audit.md: releaseShip(), resumeAgent()
  // (mission handback), and both tenderRescueStep() resume paths (rescue
  // handback) used to each hand-roll their own
  // resume()/release()/dispatcher.release()/registry.release() sequence —
  // three near-identical copies that had already drifted (one missed
  // dispatcher.release(), another missed the registry call entirely, which
  // was the root cause of both live bugs this audit started from). This
  // exercises the single method they all now call through.
  it("resumes, un-holds, and drops the registry claim together, regardless of which owner is releasing", () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    agent.suspend();
    (fleet as any).shipRegistry.claim("SHIP-1", "rescue", "trader");

    (fleet as any).releaseTo("SHIP-1", "rescue");

    assert.equal(agent.isSuspended(), false, "a rescue-suspended ship must be resumed on handback");
    assert.equal(agent.isManual(), false, "any manual-dispatch goal picked up mid-rescue must be released too");
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1"), undefined, "the registry claim must be dropped, not left to the next tick's sync to clean up");
  });

  it("only releases a claim actually held by the given owner, matching ShipRegistry.release semantics", () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    (fleet as any).shipRegistry.claim("SHIP-1", "operator", "trader");

    (fleet as any).releaseTo("SHIP-1", "mission");

    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "operator", "a mission handback must not be able to release someone else's (operator's) claim");
  });
});

describe("FleetManager warehouse API surface", () => {
  it("warehouseGoods and warehouseValue reflect the store", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await store.warehouseDeposit(tenantId, "IRON", 40, 10, undefined, "buy");

    assert.deepEqual(await fleet.warehouseGoods(), [{ goodSymbol: "IRON", units: 40, avgCost: 10, value: 400 }]);
    assert.equal(await fleet.warehouseValue(), 400);
  });

  it("warehouseGoods/Value are empty with no store attached", async () => {
    const fleet = makeFleet([]);
    assert.deepEqual(await fleet.warehouseGoods(), []);
    assert.equal(await fleet.warehouseValue(), 0);
  });

  it("adjustWarehouse deposit and withdraw update the store and are tagged 'adjust'", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);

    const deposited = await fleet.adjustWarehouse("IRON", 40, "deposit", 10);
    assert.deepEqual(deposited, { units: 40, avgCost: 10 });

    const withdrawn = await fleet.adjustWarehouse("IRON", 15, "withdraw", 0);
    assert.deepEqual(withdrawn, { units: 15, avgCost: 10 });
    assert.equal((await fleet.warehouseGoods()).find((g) => g.goodSymbol === "IRON")?.units, 25);

    const ledger = await fleet.warehouseLedger(10);
    assert.ok(ledger.every((row) => row.reason === "adjust"), `expected every ledger row tagged "adjust", got ${JSON.stringify(ledger)}`);
  });

  it("adjustWarehouse withdraw clamps to what's actually held, same as the store", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);
    await fleet.adjustWarehouse("IRON", 10, "deposit", 5);

    const withdrawn = await fleet.adjustWarehouse("IRON", 999, "withdraw", 0);

    assert.equal(withdrawn.units, 10);
  });

  it("adjustWarehouse throws with no store attached", async () => {
    const fleet = makeFleet([]);
    await assert.rejects(() => fleet.adjustWarehouse("IRON", 10, "deposit", 5), /store not available/);
  });
});

describe("Keeper markets: no cross-tenant data leakage, command ship excluded", () => {
  // Regression coverage for a real bug shipped to production: this default
  // used to be a hardcoded set of waypoints (X1-BY69-*) left over from
  // straders' own single-tenant deployment's home system, and
  // keeperPriorityMarkets() persists whatever it falls back to into the
  // *calling tenant's own* fleet_flags row on first read — so every new
  // tenant that ever hit this path got another deployment's fixture data
  // written into their own account as if they'd configured it themselves.
  it("DEFAULT_KEEPER_MARKETS is empty — no fixture data from any prior deployment", () => {
    assert.deepEqual(DEFAULT_KEEPER_MARKETS, []);
  });

  it("a fresh tenant's keeperPriorityMarkets() is empty, not seeded with another tenant's/deployment's waypoints", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const fleet = makeFleet([], store, tenantId);

    const markets = await fleet.keeperPriorityMarkets();

    assert.deepEqual(markets, []);
    // And confirm it's really persisted as empty, not left unset to
    // silently re-derive a non-empty default on a later read.
    const persisted = await store.getFleetFlag(tenantId, "keeperMarkets");
    assert.deepEqual(JSON.parse(persisted!), []);
  });

  it("maybeAssignKeepers converts nothing for a fresh tenant with no configured keeper markets", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const agent = makeFakeAgent("MINER-1", "X1-A-A1");
    const fleet = makeFleet([], store, tenantId);
    (fleet as any).miners.set("MINER-1", agent);
    await fleet.doctrine.set("keeperCount", { value: 5, enabled: true });

    await (fleet as any).maybeAssignKeepers();

    assert.ok(!(fleet as any).keepers.has("MINER-1"), "a brand-new tenant must not have ships auto-converted to keepers with no curated list configured");
  });

  it("the command ship is never converted to a keeper, even if it's mining-equipped and would otherwise be picked first", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1");
    (command as any).getShip = () => ({ symbol: "COMMAND-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] }, registration: { role: "COMMAND" } });
    const miner = makeFakeAgent("MINER-1", "X1-A-A1");
    const fleet = makeFleet([], store, tenantId);
    (fleet as any).miners.set("COMMAND-1", command);
    (fleet as any).miners.set("MINER-1", miner);
    await fleet.doctrine.set("keeperCount", { value: 5, enabled: true });
    await store.setFleetFlag(tenantId, "keeperMarkets", JSON.stringify(["X1-A-D46"]));

    await (fleet as any).maybeAssignKeepers();

    assert.ok(!(fleet as any).keepers.has("COMMAND-1"), "the command ship must never be an auto-keeper candidate");
    assert.ok((fleet as any).keepers.has("MINER-1"), "a normal miner must still be convertible");
    // maybeAssignKeepers() launches the new keeper's real keeperLoop() in
    // the background (no scheduler on this fleet) — must be stopped or its
    // own error-backoff retries keep the test process alive indefinitely.
    (fleet as any).keepers.get("MINER-1")?.stop();
  });
});

describe("FleetManager.setShipRole", () => {
  it("converts the command ship to keeper, given an explicit market, and persists it as fleet_state", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1");
    const fleet = makeFleet([command], store, tenantId);
    assert.ok((fleet as any).traders.has("COMMAND-1"));

    await fleet.setShipRole("COMMAND-1", "keeper", "X1-A-D46");

    assert.ok(!(fleet as any).traders.has("COMMAND-1"), "must be removed from its old role map");
    assert.ok((fleet as any).keepers.has("COMMAND-1"), "must land in the keepers map");
    assert.equal((fleet as any).keeperMarkets.get("COMMAND-1"), "X1-A-D46");
    const rows = await store.getFleetState(tenantId);
    const row = rows.find((r) => r.shipSymbol === "COMMAND-1");
    assert.equal(row?.role, "keeper");
    assert.equal(row?.keeperMarket, "X1-A-D46");
    (fleet as any).keepers.get("COMMAND-1")?.stop();
  });

  it("rejects converting to keeper with no market given and the ship not already at one", async () => {
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1"); // not a marketplace waypoint from the galaxy atlas's POV
    const fleet = makeFleet([command]);
    await assert.rejects(() => fleet.setShipRole("COMMAND-1", "keeper"), /no keeper market/);
  });

  it("switching to a non-keeper role stops and clears the previous role's agent", async () => {
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1");
    let stopped = false;
    command.stop = () => { stopped = true; };
    const fleet = makeFleet([command]);

    await fleet.setShipRole("COMMAND-1", "scout");

    assert.ok(stopped, "the old trader agent must be stopped before the new role takes over");
    assert.ok(!(fleet as any).traders.has("COMMAND-1"));
    assert.ok((fleet as any).scouts.has("COMMAND-1"));
  });

  it("refuses to change the role of a suspended ship", async () => {
    // Confirmed live: clearRoleMaps() stops and drops the current agent, and
    // installRoleAgent() builds a brand-new one that starts with
    // suspended=false — silently discarding a live suspension (set by a
    // mission or rescue tender that's mid-flight controlling this ship via
    // raw API calls, not through the agent). That reintroduces the exact
    // "not currently docked" race suspend() exists to prevent.
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1");
    const fleet = makeFleet([command]);
    command.suspend();

    await assert.rejects(() => fleet.setShipRole("COMMAND-1", "scout"), /suspended/);

    assert.ok((fleet as any).traders.has("COMMAND-1"), "the ship must stay under its current agent, untouched");
    assert.ok(!(fleet as any).scouts.has("COMMAND-1"));
  });
});

describe("FleetManager.restorePersistedManualRoles (setShipRole surviving a restart)", () => {
  it("re-applies a persisted manual role that disagrees with what assignRole() just derived", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    // Simulate: an earlier setShipRole("COMMAND-1", "miner") was persisted,
    // but this "restart" 's assignRole() pass (simulated here by seeding
    // the trader map directly, the way makeFleet's helper already does)
    // put it back in traders — same as a real init() would for a
    // cargo-capable, non-mining-equipped hull.
    await store.setFleetState(tenantId, "COMMAND-1", "miner");
    const command = makeFakeAgent("COMMAND-1", "X1-A-A1");
    const fleet = makeFleet([command], store, tenantId);
    assert.ok((fleet as any).traders.has("COMMAND-1"), "sanity: assignRole's simulated result disagrees with the persisted role");

    await (fleet as any).restorePersistedManualRoles([command.getShip()]);

    assert.ok(!(fleet as any).traders.has("COMMAND-1"), "the disagreeing derived role must be replaced");
    assert.ok((fleet as any).miners.has("COMMAND-1"), "the persisted manual override must win");
  });

  it("is a no-op when the persisted role already matches what's currently assigned", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    await store.setFleetState(tenantId, "SHIP-1", "trader");
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    let reconstructed = false;
    agent.stop = () => { reconstructed = true; };
    const fleet = makeFleet([agent], store, tenantId); // seeded into traders — already agrees with the persisted role

    await (fleet as any).restorePersistedManualRoles([agent.getShip()]);

    assert.ok(!reconstructed, "an already-agreeing role must not be torn down and rebuilt");
    assert.ok((fleet as any).traders.has("SHIP-1"));
  });

  it("leaves the derived role in place, rather than throwing, when a persisted keeper row has no resolvable market", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    await store.setFleetState(tenantId, "SHIP-1", "keeper"); // no keeperMarket column, and not at a known market
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent], store, tenantId);

    await assert.doesNotReject(() => (fleet as any).restorePersistedManualRoles([agent.getShip()]));

    assert.ok((fleet as any).traders.has("SHIP-1"), "assignRole's derived role must survive when the override can't be applied");
  });
});

describe("FleetManager.init: promotion respects manual role overrides", () => {
  function makeRawShip(symbol: string, opts: { cargoCapacity: number; mining?: boolean; frame?: string }): any {
    return {
      symbol,
      registration: { role: "HAULER" },
      nav: { status: "DOCKED", waypointSymbol: "X1-TEST-A1", systemSymbol: "X1-TEST" },
      cargo: { capacity: opts.cargoCapacity, units: 0, inventory: [] },
      fuel: { current: 100, capacity: 100 },
      frame: { symbol: opts.frame ?? "FRAME_FRIGATE" },
      mounts: opts.mining ? [{ symbol: "MOUNT_MINING_LASER_I" }] : [],
      modules: [],
    };
  }

  function makeInitApi(ships: any[]) {
    return {
      getCallCount: () => 0,
      getMyAgent: async () => ({ credits: 100_000, headquarters: "X1-TEST-A1", symbol: "TEST", shipCount: ships.length }),
      getSystem: async () => ({}),
      getAllSystemWaypoints: async () => [],
      listAllShips: async () => ships,
    } as any;
  }

  it("does not pull a manually-overridden ship back into trader on the next restart's largest-cargo promotion", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);
    // The operator's explicit choice, made before this "restart".
    await store.setFleetState(tenantId, "SHIP-BIG", "tour");

    const miners = [
      makeRawShip("SHIP-M1", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
      makeRawShip("SHIP-M2", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
      makeRawShip("SHIP-M3", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
    ];
    // Largest cargo in the fleet — assignRole() derives "trader" for it
    // naturally (no mining mount, big hold), which disagrees with the
    // persisted "tour" override; restorePersistedManualRoles() corrects
    // that. The bug: promotion ran afterward and picked it right back
    // up purely by cargo size, ignoring that a decision had already been
    // made for it.
    const big = makeRawShip("SHIP-BIG", { cargoCapacity: 200 });
    const ships = [...miners, big];

    const fleet = new FleetManager({ api: makeInitApi(ships), store, tenantId });
    await fleet.init();

    assert.ok((fleet as any).tours.has("SHIP-BIG"), "the persisted override must hold");
    assert.ok(!(fleet as any).traders.has("SHIP-BIG"), "largest-cargo promotion must not override a manually-set role");
  });

  it("still promotes the largest-cargo ship when nothing has a manual override (unaffected by the guard)", async () => {
    const tenantId = await makeTenant();
    const store = new Store(pool);

    const miners = [
      makeRawShip("SHIP-M1", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
      makeRawShip("SHIP-M2", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
      makeRawShip("SHIP-M3", { cargoCapacity: 20, mining: true, frame: "FRAME_DRONE" }),
    ];
    const big = makeRawShip("SHIP-BIG", { cargoCapacity: 200 });
    const ships = [...miners, big];

    const fleet = new FleetManager({ api: makeInitApi(ships), store, tenantId });
    await fleet.init();

    assert.ok((fleet as any).traders.has("SHIP-BIG"), "with no override, largest-cargo promotion must still work exactly as before");
  });

  it("a role reassigned away from a stale hold does not get re-held on the next restart", async () => {
    // Confirmed live (reported after Phase 3 shipped): an operator holdShip()'d
    // a ship, then later setShipRole()'d it to "tour" — which took effect
    // immediately (isManual() false on the freshly-installed agent) but, before
    // this fix, never cleared the persisted shipManualState.holdWaypoint flag.
    // On Render that flag gets replayed by init()'s restore loop on every idle
    // spin-down/cold-start, not just deploys, so the ship kept silently
    // reverting to "manual hold" with no operator action in between.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const ship = makeRawShip("SHIP-TOUR", { cargoCapacity: 40 });

    const firstBoot = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await firstBoot.init();
    await firstBoot.holdShip("SHIP-TOUR");
    await firstBoot.setShipRole("SHIP-TOUR", "tour");

    const restarted = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await restarted.init();

    assert.ok((restarted as any).tours.has("SHIP-TOUR"), "the tour role must survive the restart");
    const status = restarted.getShipStatuses().find((s) => s.symbol === "SHIP-TOUR");
    assert.equal(status?.paused, false, "the stale hold must not be replayed on top of the reassigned role");
  });

  it("a paused mission stays paused across a restart instead of quietly resuming", async () => {
    // Confirmed live: nothing in init() ever called missions.startConstruction()
    // again for a mission that existed before the restart, so
    // MissionManager's in-memory active/paused state — and everything gated
    // on it, including tick()'s own sourcing loop — came back completely
    // empty. An operator's explicit pause looked identical to "the fleet
    // forgot this mission ever existed" and the mission just resumed
    // sourcing on its own, with the dashboard unable to even show it as
    // paused.
    const tenantId = await makeTenant();
    const store = new Store(pool);
    const ship = makeRawShip("SHIP-CARRIER", { cargoCapacity: 40 });

    const firstBoot = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await firstBoot.init();
    await firstBoot.missions.startConstruction("X1-TEST-I55", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 10 }]);
    await firstBoot.missions.pause("X1-TEST-I55");

    const restarted = new FleetManager({ api: makeInitApi([ship]), store, tenantId });
    await restarted.init();

    const found = (await restarted.missions.list()).find((m) => m.targetWaypoint === "X1-TEST-I55");
    assert.equal(found?.paused, true, "the mission must still exist and still be paused after the restart, with no operator action needed to keep it that way");
  });
});

describe("FleetManager.rescueStatusFor: surfacing real rescue status", () => {
  it("reports an active tender's phase when a plan exists", () => {
    const fleet = makeFleet([]);
    (fleet as any).rescuePlans.set("SHIP-1", { strandedSymbol: "SHIP-1", strandedWaypoint: "X1-A-A1", tenderSymbol: "SHIP-2", market: "X1-A-A2", fuelUnits: 10, phase: "transit" });

    const status = (fleet as any).rescueStatusFor("SHIP-1");

    assert.equal(status.rescueActive, true);
    assert.match(status.rescueDetail, /SHIP-2/);
    assert.match(status.rescueDetail, /en route/);
  });

  it("reports the recorded failure reason when rescue planning couldn't find a tender", () => {
    const fleet = makeFleet([]);
    (fleet as any).rescueFailures.set("SHIP-1", "no other ship free to tender");

    const status = (fleet as any).rescueStatusFor("SHIP-1");

    assert.equal(status.rescueActive, false);
    assert.match(status.rescueDetail, /no rescue possible/);
    assert.match(status.rescueDetail, /no other ship free to tender/);
  });

  it("defaults to 'evaluating' when rescue hasn't been attempted yet this tick", () => {
    const fleet = makeFleet([]);

    const status = (fleet as any).rescueStatusFor("SHIP-1");

    assert.equal(status.rescueActive, false);
    assert.equal(status.rescueDetail, "evaluating rescue options");
  });
});

describe("FleetManager.makeRescuePlan: full-cargo tender exclusion", () => {
  it("never picks a ship with a full cargo hold as a fuel tender", async () => {
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const fullTender = makeFakeAgent("FULL", "X1-A-A3", 15, 15, 100, 100);
    const freeTender = makeFakeAgent("FREE", "X1-A-A3", 40, 0, 100, 100);
    const fleet = makeFleet([stranded, fullTender, freeTender]);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
      "X1-A-A3": { x: 10, y: 0 },
    });

    const plan = await (fleet as any).makeRescuePlan({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });

    assert.ok(plan, "a rescue plan should be possible because a free tender exists");
    assert.equal(plan.tenderSymbol, "FREE", "a full-cargo ship must never be selected as a fuel tender");
  });

  it("returns undefined and records a failure when every candidate has a full cargo hold", async () => {
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const fullA = makeFakeAgent("FULL-A", "X1-A-A3", 15, 15, 100, 100);
    const fullB = makeFakeAgent("FULL-B", "X1-A-A4", 40, 40, 100, 100);
    const fleet = makeFleet([stranded, fullA, fullB]);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
      "X1-A-A3": { x: 10, y: 0 },
      "X1-A-A4": { x: 15, y: 0 },
    });

    const plan = await (fleet as any).makeRescuePlan({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });

    assert.equal(plan, undefined, "no viable tender exists when every candidate's cargo is full");
    const failure = (fleet as any).rescueFailures.get("STRANDED");
    assert.ok(failure, "a failure reason must be recorded");
    assert.match(failure, /full.*cargo|cargo.*full|no other ship free/i, "the recorded reason must point at the cargo-full problem");
  });

  it("never picks an already-suspended ship (e.g. tendering elsewhere) and claims the one it does pick", async () => {
    // Confirmed live-adjacent by code review (docs/ship-control-state-audit.md,
    // Phase 2): candidate selection here used to check only !isManual(),
    // never isSuspended() — a ship already committed as a mission carrier or
    // a rescue tender for a *different* stranded ship could be picked again.
    // availableFor("rescue") now excludes it the same way it excludes a
    // manually-held ship.
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const busy = makeFakeAgent("BUSY", "X1-A-A3", 40, 0, 100, 100);
    const free = makeFakeAgent("FREE", "X1-A-A3", 40, 0, 100, 100);
    const fleet = makeFleet([stranded, busy, free]);
    busy.suspend();
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
      "X1-A-A3": { x: 10, y: 0 },
    });

    const plan = await (fleet as any).makeRescuePlan({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });

    assert.equal(plan?.tenderSymbol, "FREE", "a suspended ship must never be selected as a fuel tender");
    assert.equal(
      (fleet as any).shipRegistry.ownerOf("FREE")?.owner,
      "rescue",
      "the chosen tender must be claimed through the registry, not just suspended",
    );
  });
});

describe("FleetManager.tenderRescueStep: abandon stuck plans after repeated failures", () => {
  it("keeps the plan and increments the failure counter on the first two stepRescue failures", async () => {
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const tender = makeFakeAgent("TENDER", "X1-A-A2", 40, 0, 100, 100);
    const fleet = makeFleet([stranded, tender]);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
    });
    tender.suspend();
    const plan = { strandedSymbol: "STRANDED", strandedWaypoint: "X1-A-A1", tenderSymbol: "TENDER", market: "X1-A-A2", fuelUnits: 10, phase: "buy" };
    (fleet as any).rescuePlans.set("STRANDED", plan);

    let failures = 0;
    (fleet as any).stepRescue = async () => {
      failures += 1;
      throw new Error("cargo full");
    };

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    assert.equal((fleet as any).rescuePlans.has("STRANDED"), true, "plan must survive the first failure");
    assert.equal((fleet as any).rescueStepFailures.get("STRANDED"), 1);
    assert.equal(tender.isSuspended(), true, "tender stays suspended while the plan is live");

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    assert.equal((fleet as any).rescuePlans.has("STRANDED"), true, "plan must survive the second failure");
    assert.equal((fleet as any).rescueStepFailures.get("STRANDED"), 2);
    assert.equal(tender.isSuspended(), true, "tender still suspended after two failures");
    assert.equal(failures, 2);
  });

  it("abandons the plan and resumes the tender after three stepRescue failures", async () => {
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const tender = makeFakeAgent("TENDER", "X1-A-A2", 40, 0, 100, 100);
    const fleet = makeFleet([stranded, tender]);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
    });
    tender.suspend();
    const plan = { strandedSymbol: "STRANDED", strandedWaypoint: "X1-A-A1", tenderSymbol: "TENDER", market: "X1-A-A2", fuelUnits: 10, phase: "buy" };
    (fleet as any).rescuePlans.set("STRANDED", plan);

    (fleet as any).stepRescue = async () => {
      throw new Error("cargo full");
    };

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });

    assert.equal((fleet as any).rescuePlans.has("STRANDED"), false, "plan must be deleted after three failures");
    assert.equal((fleet as any).rescueStepFailures.has("STRANDED"), false, "failure counter must be cleared after abandonment");
    assert.equal(tender.isSuspended(), false, "tender must be resumed when the plan is abandoned");
    const failure = (fleet as any).rescueFailures.get("STRANDED");
    assert.ok(failure, "a persistent failure reason must be recorded");
    assert.match(failure, /cargo full/);
  });

  it("resets the failure counter after a successful stepRescue", async () => {
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const tender = makeFakeAgent("TENDER", "X1-A-A2", 40, 0, 100, 100);
    const fleet = makeFleet([stranded, tender]);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
    });
    tender.suspend();
    const plan = { strandedSymbol: "STRANDED", strandedWaypoint: "X1-A-A1", tenderSymbol: "TENDER", market: "X1-A-A2", fuelUnits: 10, phase: "buy" };
    (fleet as any).rescuePlans.set("STRANDED", plan);

    let calls = 0;
    (fleet as any).stepRescue = async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
    };

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    assert.equal((fleet as any).rescueStepFailures.get("STRANDED"), 1);

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });
    assert.equal((fleet as any).rescueStepFailures.has("STRANDED"), false, "failure counter must reset on success");
    assert.equal((fleet as any).rescuePlans.has("STRANDED"), true, "plan must remain after a successful recovery step");
  });

  it("resumes and releases a tender parked in a non-default role map when the rescue completes", async () => {
    // Confirmed live: a ship suspended as a rescue tender while it was a
    // miner, then reassigned to trader duty by the dispatcher before the
    // rescue finished, was found in neither role map by the old miner-or-
    // trader lookup — it never got resumed at all, leaving it permanently
    // suspended (stuck reporting stale cached state and not ticking, since
    // TraderAgent/ShipAgent.tick() bail out immediately while suspended).
    // Parking the tender in `surveyors` here stands in for "some role map
    // the old lookup never checked".
    const stranded = makeFakeAgent("STRANDED", "X1-A-A1", 40, 0, 0, 100);
    const tender = makeFakeAgent("TENDER", "X1-A-A2", 40, 0, 100, 100);
    const fleet = makeFleet([stranded]);
    (fleet as any).surveyors.set("TENDER", tender);
    stubMarketSystem(fleet, "X1-A", {
      "X1-A-A1": { x: 0, y: 0 },
      "X1-A-A2": { x: 5, y: 0 },
    });
    tender.suspend();
    await tender.dispatchTo("X1-A-A1"); // stand-in for navigation the rescue itself drove
    assert.equal(tender.isManual(), true, "sanity check: dispatchTo set the manual goal");

    const plan = { strandedSymbol: "STRANDED", strandedWaypoint: "X1-A-A1", tenderSymbol: "TENDER", market: "X1-A-A2", fuelUnits: 10, phase: "done" };
    (fleet as any).rescuePlans.set("STRANDED", plan);
    (fleet as any).stepRescue = async () => {};

    await (fleet as any).tenderRescueStep({ symbol: "STRANDED", waypointSymbol: "X1-A-A1", fuel: 10 });

    assert.equal(tender.isSuspended(), false, "a tender in any role map must be resumed when the rescue completes");
    assert.equal(tender.isManual(), false, "release() must also clear a manual-dispatch goal picked up mid-rescue");
  });
});
