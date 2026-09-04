import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

/**
 * Covers the gate-construction cache added to GalaxyAtlas so route-scoring
 * (trader.ts's viableRoute()/freeChoice(), fleet.ts's computeDispatchRoutes())
 * can ask "is this gate open" synchronously instead of making a live
 * getConstruction() call per candidate route. See canJump()'s own comment
 * for why an unchecked gate reads as not-jumpable (the safe default), and
 * refreshGateConstruction()'s for why a confirmed-complete gate is never
 * re-fetched.
 */

// Seeds two systems, each with one gate connecting to the other, via the
// GalaxyStore cache-injection path — bypasses getAllSystemWaypoints()/
// getJumpGate() entirely, so tests don't need to simulate a full scan.
function seededStore(): GalaxyStore {
  const topology: Record<string, { waypoints: unknown[]; jumpGates: unknown[] }> = {
    "X1-A": { waypoints: [{ symbol: "X1-A-GATE", type: "JUMP_GATE" }], jumpGates: [{ symbol: "X1-A-GATE", connections: ["X1-B-GATE"] }] },
    "X1-B": { waypoints: [{ symbol: "X1-B-GATE", type: "JUMP_GATE" }], jumpGates: [{ symbol: "X1-B-GATE", connections: ["X1-A-GATE"] }] },
  };
  return {
    getSystemTopology: async (sys) => topology[sys],
    setSystemTopology: async () => {},
  };
}

async function makeSeededAtlas(getConstruction: (systemSymbol: string, waypointSymbol: string) => Promise<{ isComplete: boolean; materials: never[] }>) {
  const calls: { systemSymbol: string; waypointSymbol: string }[] = [];
  const api = {
    getConstruction: async (systemSymbol: string, waypointSymbol: string) => {
      calls.push({ systemSymbol, waypointSymbol });
      return getConstruction(systemSymbol, waypointSymbol);
    },
  } as any;
  const atlas = new GalaxyAtlas(api, seededStore());
  await atlas.loadSystem("X1-A");
  await atlas.loadSystem("X1-B");
  return { atlas, calls };
}

describe("GalaxyAtlas: gate-construction cache", () => {
  it("gateComplete() is undefined and canJump() is false before anything has been checked", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    assert.equal(atlas.gateComplete("X1-A-GATE"), undefined);
    assert.equal(atlas.canJump("X1-A", "X1-B"), false, "unchecked reads as not-jumpable, not as open");
  });

  it("refreshGateConstruction() populates the cache from a live isComplete:true result, and canJump() then agrees", async () => {
    const { atlas, calls } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    const result = await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.equal(result, true);
    assert.equal(atlas.gateComplete("X1-A-GATE"), true);
    assert.equal(atlas.canJump("X1-A", "X1-B"), true);
    assert.equal(calls.length, 1);
  });

  it("refreshGateConstruction() caches isComplete:false too, and canJump() stays false", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: false, materials: [] }));

    const result = await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.equal(result, false);
    assert.equal(atlas.gateComplete("X1-A-GATE"), false);
    assert.equal(atlas.canJump("X1-A", "X1-B"), false);
  });

  it("a failed getConstruction() fetch is treated as 'already built' (no construction record for a pre-existing gate)", async () => {
    const { atlas } = await makeSeededAtlas(async () => { throw new Error("404: no construction record"); });

    const result = await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.equal(result, true);
    assert.equal(atlas.canJump("X1-A", "X1-B"), true);
  });

  it("never re-fetches a gate once confirmed complete", async () => {
    const { atlas, calls } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");
    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");
    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.equal(calls.length, 1, "construction never reverts to incomplete, so a confirmed-complete gate should only ever be fetched once");
  });

  it("does re-fetch a gate still cached incomplete — construction can finish between checks", async () => {
    let complete = false;
    const { atlas, calls } = await makeSeededAtlas(async () => ({ isComplete: complete, materials: [] }));

    assert.equal(await atlas.refreshGateConstruction("X1-A", "X1-A-GATE"), false);
    complete = true;
    assert.equal(await atlas.refreshGateConstruction("X1-A", "X1-A-GATE"), true);

    assert.equal(calls.length, 2);
    assert.equal(atlas.canJump("X1-A", "X1-B"), true);
  });

  it("refreshAllGateConstruction() refreshes every known gate not yet confirmed complete, and skips ones already confirmed", async () => {
    // Both gates are actually complete — the point of this test is call
    // accounting (which gates get fetched), not reachability outcomes.
    const { atlas, calls } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));
    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE"); // pre-confirm X1-A's gate
    calls.length = 0; // only count calls made by refreshAllGateConstruction() itself

    await atlas.refreshAllGateConstruction();

    assert.equal(calls.length, 1, "the already-confirmed-complete gate must not be re-fetched");
    assert.equal(calls[0]?.waypointSymbol, "X1-B-GATE");
    assert.equal(atlas.canJump("X1-A", "X1-B"), true);
    assert.equal(atlas.canJump("X1-B", "X1-A"), true);
  });
});

describe("GalaxyAtlas: learned jump cost", () => {
  it("learnedJumpCost() is undefined for a gate/destination pair that has never been jumped", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), undefined);
  });

  it("recordJumpCost() makes a single real jump immediately usable as the estimate", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_800);

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 4_800);
  });

  it("averages multiple real jumps over the same gate/destination pair", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_000);
    atlas.recordJumpCost("X1-A-GATE", "X1-B", 6_000);

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 5_000);
  });

  it("keeps costs separate per destination system, even from the same departure gate", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));

    atlas.recordJumpCost("X1-A-GATE", "X1-B", 5_000);
    atlas.recordJumpCost("X1-A-GATE", "X1-C", 9_000);

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 5_000);
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-C"), 9_000);
  });
});
