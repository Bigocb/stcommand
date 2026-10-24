import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * The fresh-system gate at the FleetManager seam (systemQueue.ts, systemRelease.ts): queue, stage, park on arrival, release, and
 * the clause turning off. Game-facing calls (park, unpark, the keeper list) are replaced with recorders; the store is real.
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
    [`FRESHGATE-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

const MARKETS = Array.from({ length: 8 }, (_, i) => `X1-NEW-M${i}`);

async function rig() {
  const tenantId = await makeTenant();
  const fleet: any = new FleetManager({ api: { onMarket: () => {} } as any, store, tenantId });
  const calls = { parked: [] as string[], unparked: [] as string[], listed: [] as string[][] };
  fleet.keeperCandidatesForSystem = async () => ({ add: MARKETS, thin: [] });
  fleet.addKeeperPriorityMarkets = async (m: string[]) => { calls.listed.push(m); return m; };
  fleet.parkShip = async (ship: string) => { calls.parked.push(ship); fleet.parkedShips.set(ship, {}); fleet.parkedKeeperMarkets.set(ship, fleet.keeperMarkets.get(ship)); fleet.keeperMarkets.delete(ship); };
  fleet.unparkShip = async (ship: string) => { calls.unparked.push(ship); fleet.parkedShips.delete(ship); fleet.parkedKeeperMarkets.delete(ship); };
  const standing = new Map<string, string>();
  fleet.fleetStatusSummary = () => [...standing].map(([symbol, waypoint]) => ({ symbol, waypoint, nav: "DOCKED" }));
  const readSnapshots = new Set<string>();
  fleet.store = Object.assign(Object.create(store), { latestMarketSnapshots: async () => [...readSnapshots].map((waypointSymbol) => ({ waypointSymbol })) });
  /** A keeper arrives at a market, which has been read once. */
  const arrive = (market: string) => { const ship = `K-${market}`; fleet.keeperMarkets.set(ship, market); standing.set(ship, market); readSnapshots.add(market); return ship; };
  const on = async (value: 1 | 2 = 2) => { await fleet.doctrine.set("freshGate", { enabled: true, value }); };
  return { fleet, tenantId, calls, arrive, on };
}

describe("fresh-system gate at the fleet", () => {
  it("does nothing while the clause is off: an empty gate, nothing parked", async () => {
    const { fleet, calls } = await rig();
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    await fleet.maintainFreshGate();
    assert.deepEqual(fleet.dispatcher.gatedSystemList(), [], "queue entries are inert with the clause off");
    assert.deepEqual(calls.parked, []);
    await assert.rejects(fleet.stageSystem("X1-NEW"), /freshGate clause is off/);
  });

  it("queues behind the gate with the best markets only, stages, parks arrivals, then releases", async () => {
    const { fleet, tenantId, calls, arrive, on } = await rig();
    await on(2);
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    assert.deepEqual(fleet.systemQueue.get("X1-NEW").markets, MARKETS.slice(0, 6), "freshKeepersPerSystem (6) of the 8, best first");
    await fleet.maintainFreshGate();
    assert.deepEqual(fleet.dispatcher.gatedSystemList(), ["X1-NEW"], "scouted: gated");

    const r = await fleet.stageSystem("X1-NEW", "test");
    assert.equal(r.state, "staged");
    assert.deepEqual(calls.listed, [MARKETS.slice(0, 6)], "the keeper list gets only the staged markets, once");
    assert.match(await store.getFleetFlag(tenantId, "systemQueue") ?? "", /"state":"staged"/, "saved");

    // Keepers arrive at five of the six markets; one has not been read yet and one has not arrived.
    const ships = MARKETS.slice(0, 4).map(arrive);
    fleet.keeperMarkets.set("K-LATE", MARKETS[4]); // stationed, never read: not parked yet
    await fleet.maintainFreshGate();
    assert.deepEqual(calls.parked.sort(), ships.sort(), "parked only where it stands and the market has been read");
    assert.equal(fleet.freshGateState().queue[0].keepersInPlace, 4);

    await fleet.releaseSystem("X1-NEW", "test");
    assert.deepEqual(calls.unparked.sort(), ships.sort(), "release unparks what staging parked");
    assert.equal(fleet.systemQueue.get("X1-NEW").state, "live");
    await fleet.maintainFreshGate();
    assert.deepEqual(fleet.dispatcher.gatedSystemList(), [], "the gate is open");
    const saved = JSON.parse((await store.getFleetFlag(tenantId, "freshGate"))!);
    assert.deepEqual(saved.stagedParked, {});
    assert.ok(typeof saved.lastReleaseAt === "number");
  });

  it("releases a scouted system by hand by listing its markets then, and refuses a live or unknown one", async () => {
    const { fleet, calls, on } = await rig();
    await on(1);
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    await fleet.releaseSystem("X1-NEW", "test");
    assert.deepEqual(calls.listed, [MARKETS.slice(0, 6)]);
    await assert.rejects(fleet.releaseSystem("X1-NEW"), /already live/);
    await assert.rejects(fleet.releaseSystem("X1-ELSEWHERE"), /not in the queue/);
  });

  it("a hold pins a system and the rule's answer respects it; clearing it frees it", async () => {
    const { fleet, on } = await rig();
    await on(1);
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    await fleet.holdSystem("X1-NEW", true);
    fleet.lastFreshCheckAt = 0;
    await fleet.maybeManageFreshSystems();
    assert.deepEqual(fleet.freshGateState().lastCheck.decision.stage, [], "held: not staged");
    await fleet.holdSystem("X1-NEW", false);
    fleet.lastFreshCheckAt = 0;
    await fleet.maybeManageFreshSystems();
    assert.deepEqual(fleet.freshGateState().lastCheck.decision.stage.map((s: { system: string }) => s.system), ["X1-NEW"], "advisory: shown, and the system is still only scouted");
    assert.equal(fleet.systemQueue.get("X1-NEW").state, "scouted", "advisory mode never acts");
  });

  it("auto mode stages ahead of need on its own", async () => {
    const { fleet, calls, on } = await rig();
    await on(2);
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    fleet.lastFreshCheckAt = 0;
    await fleet.maybeManageFreshSystems();
    assert.equal(fleet.systemQueue.get("X1-NEW").state, "staged");
    assert.equal(calls.listed.length, 1);
  });

  it("turning the clause off unparks the staged keepers and opens every gate", async () => {
    const { fleet, calls, arrive, on } = await rig();
    await on(2);
    fleet.queueFreshSystem("X1-NEW", MARKETS);
    await fleet.stageSystem("X1-NEW", "test");
    const ships = MARKETS.slice(0, 3).map(arrive);
    await fleet.maintainFreshGate();
    assert.equal(calls.parked.length, 3);
    await fleet.doctrine.set("freshGate", { enabled: false });
    await fleet.maintainFreshGate();
    assert.deepEqual(calls.unparked.sort(), ships.sort());
    assert.deepEqual(fleet.dispatcher.gatedSystemList(), []);
  });
});
