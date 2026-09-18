import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScoutAgent, type Ship } from "../src/engine/scout.js";

/**
 * A chart scout that has fully charted its current system (every waypoint
 * already has a `chart`, whether charted by this scout or someone else —
 * confirmed live: X1-B48 was fully charted by a rival fleet before THEO-A's
 * scout task ever got there) used to just sit reporting "no uncharted
 * waypoints to chart" forever. It should instead ask the fleet to jump it
 * to a connected system that might still have work.
 */

function makeShip(waypointSymbol: string, systemSymbol: string): Ship {
  return {
    symbol: "SCOUT-1",
    nav: { status: "IN_ORBIT", waypointSymbol, systemSymbol },
    cargo: { capacity: 0, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
    mounts: [],
  } as unknown as Ship;
}

function makeScout(opts: { jumpToUnchartedSystem?: (sym: string) => Promise<boolean> } = {}) {
  const ship = makeShip("X1-HOME-A1", "X1-HOME");
  const logs: string[] = [];
  const agent = new ScoutAgent(ship, {
    api: { getShip: async () => ship } as any,
    log: (m) => logs.push(m),
    jumpToUnchartedSystem: opts.jumpToUnchartedSystem,
  });
  // Nothing left uncharted in the seeded system.
  agent.withWorld([{ symbol: "X1-HOME-A1", x: 0, y: 0 }] as any, []);
  agent.withCharted(["X1-HOME-A1"]);
  return { agent, logs };
}

describe("ScoutAgent.tick: jumping to a new system once the current one is fully charted", () => {
  it("calls jumpToUnchartedSystem and reports progress when it jumps", async () => {
    let called: string | undefined;
    const { agent, logs } = makeScout({
      jumpToUnchartedSystem: async (sym) => {
        called = sym;
        return true;
      },
    });

    const worked = await agent.tick();

    assert.equal(called, "SCOUT-1");
    assert.equal(worked, true);
    assert.ok(!logs.some((l) => l.includes("no uncharted waypoints to chart")));
  });

  it("falls back to the old 'nothing to chart' report when the jump finds nowhere to go", async () => {
    const { agent, logs } = makeScout({
      jumpToUnchartedSystem: async () => false,
    });

    const worked = await agent.tick();

    assert.equal(worked, false);
    assert.ok(logs.some((l) => l.includes("no uncharted waypoints to chart")));
  });

  it("without the hook wired at all, behaves exactly as before", async () => {
    const { agent, logs } = makeScout();

    const worked = await agent.tick();

    assert.equal(worked, false);
    assert.ok(logs.some((l) => l.includes("no uncharted waypoints to chart")));
  });

  it("propagates a Pending thrown by the jump hook untouched, not swallowed as a failure", async () => {
    const { Pending, NavigationPending } = await import("../src/engine/agentStep.js");
    const { agent } = makeScout({
      jumpToUnchartedSystem: async () => {
        throw new NavigationPending(Date.now() + 1000);
      },
    });

    await assert.rejects(() => agent.tick(), (err: unknown) => err instanceof Pending);
  });
});
