import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listedFirstTargets } from "../src/engine/listedFirstTour.js";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { Registry } from "../src/engine/registry.js";
import { GalaxyAtlas } from "../src/engine/galaxy.js";

/** Clause stagedTourListedFirst (operator idea 2026-11-19): a tour in a staged system visits its listed, unpriced markets first. */

describe("listedFirstTargets (pure)", () => {
  it("returns the listed unpriced markets in this system, not counting where the ship stands", () => {
    const pick = listedFirstTargets("X1-ZU90", "X1-ZU90-CC7Z", ["X1-ZU90-E10F", "X1-ZU90-CC7Z", "X1-ZU90-BD4Z"]);
    assert.deepEqual(pick?.targets, ["X1-ZU90-BD4Z", "X1-ZU90-E10F"]);
    assert.match(pick!.reason, /listed-first: 2 listed market\(s\) in X1-ZU90 not yet priced/);
  });

  it("nothing listed left = undefined, so the normal tour runs (the clause off passes an empty list too)", () => {
    assert.equal(listedFirstTargets("X1-ZU90", "X1-ZU90-CC7Z", []), undefined);
    assert.equal(listedFirstTargets("X1-ZU90", "X1-ZU90-CC7Z", ["X1-ZU90-CC7Z"]), undefined, "only the market it stands on");
  });

  it("ignores markets in another system: a tour leg never crosses a gate", () => {
    assert.equal(listedFirstTargets("X1-ZU90", "X1-ZU90-CC7Z", ["X1-RZ24-F29F"]), undefined);
  });
});

function atlasWith(systems: Record<string, { symbol: string; x: number; y: number }[]>): GalaxyAtlas {
  const atlas = new GalaxyAtlas({ getAllSystemWaypoints: async () => [] } as any);
  for (const [sys, waypoints] of Object.entries(systems)) {
    (atlas as any).systems.set(sys, {
      symbol: sys,
      waypoints: waypoints.map((w) => ({ symbol: w.symbol, systemSymbol: sys, x: w.x, y: w.y, type: "PLANET", orbitals: [], traits: [{ symbol: "MARKETPLACE", name: "", description: "" }], isUnderConstruction: false })),
      jumpGates: [], markets: [], shipyards: [],
    });
  }
  return atlas;
}

function probe(): Ship {
  return {
    symbol: "PROBE-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity: 0, units: 0, inventory: [] },
    fuel: { current: 0, capacity: 0 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
}

async function firstLeg(listed: string[] | undefined): Promise<{ went: string[]; logs: string[] }> {
  const went: string[] = [];
  const logs: string[] = [];
  const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-NEAR", x: 1, y: 0 }, { symbol: "X1-A-LIST", x: 50, y: 0 }] }));
  const agent = new ShipAgent(probe(), {
    api: { getCallCount: () => 0, getShip: async () => probe() } as any,
    log: (m) => logs.push(m),
    marketTourTargets: async () => ["X1-A-NEAR", "X1-A-LIST"],
    staleMarketTargets: async () => ["X1-A-NEAR", "X1-A-LIST"],
    ...(listed ? { listedFirstMarkets: async () => listed } : {}),
  }).withRegistry(registry);
  const a = agent as any;
  a.refresh = async () => {};
  a.ensureDocked = async () => {};
  a.refuelIfNeeded = async () => true;
  a.navigateTo = async (t: string) => { went.push(t); };
  await agent.tourScout();
  return { went, logs };
}

describe("tourScout seam: listed-first", () => {
  it("goes to the listed market even though another market is nearer", async () => {
    const { went, logs } = await firstLeg(["X1-A-LIST"]);
    assert.deepEqual(went, ["X1-A-LIST"]);
    assert.ok(logs.some((l) => /touring X1-A-LIST \(listed-first/.test(l)), logs.join("\n"));
  });

  it("with no listed markets (clause off, or all priced) it tours the nearest as before", async () => {
    assert.deepEqual((await firstLeg(undefined)).went, ["X1-A-NEAR"]);
    assert.deepEqual((await firstLeg([])).went, ["X1-A-NEAR"]);
  });
});
