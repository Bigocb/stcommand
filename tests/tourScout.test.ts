import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";

/**
 * Tour scouts pick their next market by distance, using the waypoint positions
 * seeded into the agent by withWorld(). That cache is filled once, when the
 * agent is constructed, from whatever the fleet knew at the time — which at
 * boot is the home system alone. A scout parked anywhere else therefore comes
 * back from a restart with no coordinates for the system it is standing in,
 * every candidate distance evaluates to Infinity, and it reports "no reachable
 * target" against a full target list forever without ever moving.
 */

function makeShip(waypointSymbol: string, systemSymbol: string): Ship {
  return {
    symbol: "TOUR-1",
    nav: { status: "IN_ORBIT", waypointSymbol, systemSymbol },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
  } as unknown as Ship;
}

/** A tour agent stranded in X1-REMOTE with only home-system positions cached. */
function makeStrandedTourAgent(opts: { ensureSystemCharted?: (sys: string) => Promise<void> } = {}) {
  const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
  const logs: string[] = [];
  const agent = new ShipAgent(ship, {
    api: { getShip: async () => ship } as any,
    log: (m) => logs.push(m),
    marketTourTargets: async () => ["X1-REMOTE-B2", "X1-REMOTE-C3"],
    ensureSystemCharted: opts.ensureSystemCharted,
  });
  // Seeded at construction with the home system only — nothing for X1-REMOTE.
  agent.withWorld([{ symbol: "X1-HOME-A1", x: 0, y: 0 }] as any, []);
  const navigated: string[] = [];
  (agent as any).refuelIfNeeded = async () => {};
  (agent as any).navigateTo = async (t: string) => { navigated.push(t); };
  (agent as any).ensureDocked = async () => {};
  return { agent, logs, navigated };
}

const remotePositions = [
  { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
  { symbol: "X1-REMOTE-B2", x: 10, y: 0 },
  { symbol: "X1-REMOTE-C3", x: 40, y: 0 },
];

describe("ShipAgent.tourScout: repairing a position cache that predates the current system", () => {
  it("charts the system it is standing in when it has no position for it, then tours the nearest market", async () => {
    let chartedSystem: string | undefined;
    const { agent, navigated, logs } = makeStrandedTourAgent({
      ensureSystemCharted: async (sys) => {
        chartedSystem = sys;
        agent.withWorld(remotePositions as any, []);
      },
    });

    const worked = await (agent as any).tourScout();

    assert.equal(chartedSystem, "X1-REMOTE", "must chart the system the ship is actually in");
    assert.equal(worked, true);
    assert.deepEqual(navigated, ["X1-REMOTE-B2"], "nearest of the two now-visible markets");
    assert.ok(!logs.some((l) => l.includes("no reachable target")));
  });

  it("without the repair hook it strands itself: a full target list, nothing reachable, no movement", async () => {
    const { agent, navigated, logs } = makeStrandedTourAgent();

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false);
    assert.deepEqual(navigated, []);
    assert.ok(
      logs.some((l) => l.includes("no reachable target from X1-REMOTE-A1 (2 known)")),
      "reproduces the observed live symptom: known targets, none of them usable",
    );
  });

  it("does not re-chart when the current waypoint is already in the cache", async () => {
    let charts = 0;
    const { agent, navigated } = makeStrandedTourAgent({
      ensureSystemCharted: async () => { charts += 1; },
    });
    agent.withWorld(remotePositions as any, []);

    await (agent as any).tourScout();

    assert.equal(charts, 0, "positions already known — no reason to spend the API call");
    assert.deepEqual(navigated, ["X1-REMOTE-B2"]);
  });
});
