import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { Registry } from "../src/engine/registry.js";
import { ruleReasons, DEFAULT_RULES } from "../src/engine/attention.js";
import { classifyShips } from "../src/ops/classify.js";
import { shipsToRetire } from "../src/engine/windDownScrap.js";

/** Slice 2 and 3 of the parked-ships design: park/unpark operations and every place a parked hull must be left alone. No database. */

function ship(symbol: string, status: "DOCKED" | "IN_ORBIT" | "IN_TRANSIT", waypoint = "X1-P-M1", units = 0) {
  return {
    symbol, nav: { status, waypointSymbol: waypoint, systemSymbol: "X1-P" }, fuel: { current: 50, capacity: 100 },
    cargo: { units, capacity: 40, inventory: [] }, mounts: [], cooldown: { remainingSeconds: 0 },
  } as any;
}

function makeFleet() {
  const calls = { dock: [] as string[], getShip: 0, setFleetState: [] as unknown[][], setRole: [] as unknown[][] };
  const fleet: any = new FleetManager({
    api: {
      dockShip: async (s: string) => { calls.dock.push(s); },
      getShip: async (s: string) => { calls.getShip++; return ship(s, "IN_ORBIT"); },
    } as any,
  });
  fleet.tenantId = "t1";
  fleet.store = { setFleetState: async (...a: unknown[]) => { calls.setFleetState.push(a); }, setFleetFlag: async () => {}, getFleetFlag: async () => undefined };
  const registry = Registry.standalone();
  registry.seed([{ symbol: "X1-P-M1", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] }]);
  fleet.registry = registry;
  fleet.updateShipManualState = async () => {};
  fleet.setShipRole = async (...a: unknown[]) => { calls.setRole.push(a); };
  return { fleet, calls };
}

function asKeeper(fleet: any, symbol: string, market: string) {
  fleet.keepers.set(symbol, { stop() {}, getShip: () => ship(symbol, "DOCKED", market), isSuspended: () => false });
  fleet.keeperMarkets.set(symbol, market);
}

describe("parkShip", () => {
  it("parks a keeper: remembers its role and market, makes no call when docked, and the market stays covered", async () => {
    const { fleet, calls } = makeFleet();
    asKeeper(fleet, "K-1", "X1-P-M1");
    fleet.idleShips.set("K-1", ship("K-1", "DOCKED"));
    const r = await fleet.parkShip("K-1");
    assert.equal(r.from, "keeper");
    assert.equal(r.keeperMarket, "X1-P-M1");
    assert.equal(r.docked, true);
    assert.deepEqual(calls.dock, [], "already docked: parking makes no call");
    assert.equal(calls.getShip, 0);
    assert.equal(fleet.keepers.has("K-1"), false, "the agent is gone");
    assert.equal(fleet.roleOf("K-1"), "parked");
    assert.deepEqual(calls.setFleetState[0], ["t1", "K-1", "parked", "X1-P-M1", "keeper"]);
    assert.equal(fleet.coveredKeeperMarkets().has("X1-P-M1"), true, "a parked keeper still covers its market, so it is not bought again");
    assert.equal(fleet.keepers.size, 0, "and it no longer counts against the keeper budget");
  });

  it("docks a hull in orbit at a market with the one call parking makes, but not one in transit", async () => {
    const { fleet, calls } = makeFleet();
    fleet.idleShips.set("S-1", ship("S-1", "IN_ORBIT"));
    const r = await fleet.parkShip("S-1");
    assert.deepEqual(calls.dock, ["S-1"]);
    assert.equal(r.docked, true);
    fleet.idleShips.set("S-2", ship("S-2", "IN_TRANSIT"));
    const t = await fleet.parkShip("S-2");
    assert.equal(t.docked, false);
    assert.deepEqual(calls.dock, ["S-1"], "no call for a ship in transit: it lands and sits in orbit");
  });

  it("reports cargo frozen aboard and parks a second time as a no-op", async () => {
    const { fleet } = makeFleet();
    fleet.idleShips.set("S-1", ship("S-1", "DOCKED", "X1-P-M1", 22));
    assert.equal((await fleet.parkShip("S-1")).cargoUnits, 22);
    assert.equal((await fleet.parkShip("S-1")).alreadyParked, true);
  });

  it("refuses a live rescue tender and a suspended ship, and a role change cannot park", async () => {
    const { fleet } = makeFleet();
    fleet.idleShips.set("T-1", ship("T-1", "DOCKED"));
    fleet.rescuePlans.set("STRANDED", { tenderSymbol: "T-1" });
    await assert.rejects(() => fleet.parkShip("T-1"), /rescue tender/);
    const real = new FleetManager({ api: {} as any }) as any;
    await assert.rejects(() => real.setShipRole("X", "parked"), /use parkShip/);
  });
});

describe("unparkShip", () => {
  it("resumes the remembered role, and a keeper goes back to its market", async () => {
    const { fleet, calls } = makeFleet();
    asKeeper(fleet, "K-1", "X1-P-M1");
    fleet.idleShips.set("K-1", ship("K-1", "DOCKED"));
    await fleet.parkShip("K-1");
    const r = await fleet.unparkShip("K-1");
    assert.equal(r.role, "keeper");
    assert.deepEqual(calls.setRole[0], ["K-1", "keeper", "X1-P-M1"]);
    assert.equal(fleet.parkedShips.has("K-1"), false);
    assert.equal(fleet.coveredKeeperMarkets().has("X1-P-M1"), false, "the parked cover is dropped; the restored agent covers it");
  });

  it("an explicit role wins; with nothing remembered the hull decides; a keeper with no market falls back with a note", async () => {
    const { fleet, calls } = makeFleet();
    fleet.idleShips.set("S-1", ship("S-1", "DOCKED"));            // roleOf = idle: nothing worth remembering
    await fleet.parkShip("S-1");
    assert.equal((await fleet.unparkShip("S-1")).role, "trader", "a 40-unit hold and no mining or survey mounts: the hull says trader");
    fleet.idleShips.set("S-2", ship("S-2", "DOCKED"));
    await fleet.parkShip("S-2");
    assert.equal((await fleet.unparkShip("S-2", "miner")).role, "miner");
    fleet.parkedShips.set("K-9", ship("K-9", "DOCKED")); fleet.parkedFrom.set("K-9", "keeper");   // a keeper whose market was lost
    const r = await fleet.unparkShip("K-9");
    assert.ok(r.note && r.role !== "keeper");
    assert.equal(calls.setRole.length, 3);
    await assert.rejects(() => fleet.unparkShip("NOPE"), /not parked/);
  });
});

describe("exclusions", () => {
  it("the reset wind-down never queues a parked hull", () => {
    assert.deepEqual(shipsToRetire([{ symbol: "A", role: "parked" }, { symbol: "B", role: "keeper" }], new Set(), 10, true), ["B"]);
  });

  it("attention gives a parked hull one info line, never quiet, low fuel or overdue", () => {
    const facts: any = { symbol: "P", role: "parked", nav: "IN_TRANSIT", secondsPastArrival: 9999, fuelPercent: 2, minutesSinceLastLogLine: 500, cooldownSeconds: 0, held: false, stranded: false, mostRepeatedLogLine: null, timesRepeated: 0 };
    const r = ruleReasons(facts, DEFAULT_RULES);
    assert.deepEqual(r.map((x) => [x.code, x.severity]), [["parked", "info"]]);
  });

  it("the stuck classifier does not warn about a parked hull's low tank", () => {
    const summary: any[] = [{ symbol: "P", role: "parked", waypoint: "X1-P-M1", nav: "DOCKED", fuel: 1, fuelCap: 100 }];
    assert.deepEqual(classifyShips(summary, [], new Set(), Date.now()), []);
    summary[0].role = "trader";
    assert.equal(classifyShips(summary, [], new Set(), Date.now()).length, 1, "the same tank on a working ship is still flagged");
  });
});
