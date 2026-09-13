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

async function makeSeededAtlas(
  getConstruction: (systemSymbol: string, waypointSymbol: string) => Promise<{ isComplete: boolean; materials: never[] }>,
  storeOverrides: Partial<GalaxyStore> = {},
) {
  const calls: { systemSymbol: string; waypointSymbol: string }[] = [];
  const api = {
    getConstruction: async (systemSymbol: string, waypointSymbol: string) => {
      calls.push({ systemSymbol, waypointSymbol });
      return getConstruction(systemSymbol, waypointSymbol);
    },
  } as any;
  const atlas = new GalaxyAtlas(api, { ...seededStore(), ...storeOverrides });
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

describe("GalaxyAtlas: jump-cost persistence", () => {
  // Covers the live bug this closes: the learned average lived only in this
  // Map, wiped on every process restart, so with deploys happening several
  // times a day a learned cost never survived long enough to replace
  // CROSS_SYSTEM_JUMP_COST_ESTIMATE's flat placeholder — see
  // migrations/017_galaxy_jump_costs.sql's own comment.
  it("recordJumpCost() also persists to the store, fire-and-forget", async () => {
    const recorded: { fromGate: string; toSystem: string; price: number }[] = [];
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      recordGalaxyJumpCost: async (fromGate, toSystem, price) => { recorded.push({ fromGate, toSystem, price }); },
    });

    atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_800);

    assert.deepEqual(recorded, [{ fromGate: "X1-A-GATE", toSystem: "X1-B", price: 4_800 }]);
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 4_800, "the in-memory value updates regardless of the persistence call's own timing");
  });

  it("recordJumpCost() does not throw when the store's persistence call rejects", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      recordGalaxyJumpCost: async () => { throw new Error("db down"); },
    });

    assert.doesNotThrow(() => atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_800));
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 4_800, "the in-memory value is still updated even if the durable write fails");
  });

  it("recordJumpCost() works fine when the store doesn't implement persistence at all", async () => {
    // The GalaxyStore interface's two new methods are optional specifically
    // so an older/simpler fake store (like this file's own seededStore(),
    // used throughout every other test here) doesn't need updating.
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));
    assert.doesNotThrow(() => atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_800));
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 4_800);
  });

  it("loadJumpCosts() seeds the in-memory average from every jump recorded so far", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      getAllGalaxyJumpCosts: async () => [
        { fromGate: "X1-A-GATE", toSystem: "X1-B", totalPrice: 10_000, jumpCount: 2 },
        { fromGate: "X1-A-GATE", toSystem: "X1-C", totalPrice: 9_000, jumpCount: 1 },
      ],
    });

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), undefined, "cold before loadJumpCosts() runs");
    await atlas.loadJumpCosts();

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 5_000, "10,000 / 2 jumps");
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-C"), 9_000);
  });

  it("loadJumpCosts() merges with, rather than resets, jumps recorded before it runs", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      getAllGalaxyJumpCosts: async () => [{ fromGate: "X1-A-GATE", toSystem: "X1-C", totalPrice: 9_000, jumpCount: 1 }],
    });

    atlas.recordJumpCost("X1-A-GATE", "X1-B", 4_800);
    await atlas.loadJumpCosts();

    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-B"), 4_800, "unaffected — the loaded rows don't mention this pair");
    assert.equal(atlas.learnedJumpCost("X1-A-GATE", "X1-C"), 9_000);
  });

  it("loadJumpCosts() is a no-op when the store doesn't implement it", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));
    await assert.doesNotReject(() => atlas.loadJumpCosts());
  });
});

describe("GalaxyAtlas: gate-construction persistence", () => {
  // Covers the live bug this closes: the cache backing canJump() lived only
  // in this Map, wiped on every restart, so RouteDispatcher.recompute()
  // silently dropped every cross-system "direct" route until some ship
  // happened to freshly re-confirm that exact gate pair again this process
  // lifetime — confirmed live: DRAGOM-1 stuck on a 286c/trip same-system
  // fallback while a 44,976c/trip cross-system route sat unassignable, on a
  // gate pair its own explorers had already jumped through successfully
  // before the last restart. See migrations/018_galaxy_gate_construction.sql.
  it("refreshGateConstruction() also persists a confirmed-complete result to the store, fire-and-forget", async () => {
    const recorded: { gateSymbol: string; isComplete: boolean }[] = [];
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      recordGalaxyGateConstruction: async (gateSymbol, isComplete) => { recorded.push({ gateSymbol, isComplete }); },
    });

    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.deepEqual(recorded, [{ gateSymbol: "X1-A-GATE", isComplete: true }]);
    assert.equal(atlas.gateComplete("X1-A-GATE"), true);
  });

  it("refreshGateConstruction() also persists a confirmed-incomplete result", async () => {
    const recorded: { gateSymbol: string; isComplete: boolean }[] = [];
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: false, materials: [] }), {
      recordGalaxyGateConstruction: async (gateSymbol, isComplete) => { recorded.push({ gateSymbol, isComplete }); },
    });

    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE");

    assert.deepEqual(recorded, [{ gateSymbol: "X1-A-GATE", isComplete: false }]);
  });

  it("refreshGateConstruction() does not throw when the store's persistence call rejects", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      recordGalaxyGateConstruction: async () => { throw new Error("db down"); },
    });

    await assert.doesNotReject(() => atlas.refreshGateConstruction("X1-A", "X1-A-GATE"));
    assert.equal(atlas.gateComplete("X1-A-GATE"), true, "the in-memory value is still updated even if the durable write fails");
  });

  it("loadGateConstruction() seeds the in-memory cache from every check recorded so far", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      getAllGalaxyGateConstruction: async () => [
        { gateSymbol: "X1-A-GATE", isComplete: true },
        { gateSymbol: "X1-B-GATE", isComplete: false },
      ],
    });

    assert.equal(atlas.gateComplete("X1-A-GATE"), undefined, "cold before loadGateConstruction() runs");
    await atlas.loadGateConstruction();

    assert.equal(atlas.gateComplete("X1-A-GATE"), true);
    assert.equal(atlas.gateComplete("X1-B-GATE"), false);
    assert.equal(atlas.canJump("X1-A", "X1-B"), true, "loaded rows are exactly what canJump() reads");
  });

  it("loadGateConstruction() never downgrades a gate this process already confirmed complete", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }), {
      getAllGalaxyGateConstruction: async () => [{ gateSymbol: "X1-A-GATE", isComplete: false }],
    });

    await atlas.refreshGateConstruction("X1-A", "X1-A-GATE"); // confirms true, live, this process
    await atlas.loadGateConstruction(); // a stale "false" row must not win

    assert.equal(atlas.gateComplete("X1-A-GATE"), true, "one-way — never reverts to incomplete");
  });

  it("loadGateConstruction() is a no-op when the store doesn't implement it", async () => {
    const { atlas } = await makeSeededAtlas(async () => ({ isComplete: true, materials: [] }));
    await assert.doesNotReject(() => atlas.loadGateConstruction());
  });
});
