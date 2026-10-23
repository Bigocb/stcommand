import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

/**
 * An edge is judged from the hydrated graph and the construction cache alone, so a system this process never loaded is
 * not "no gate". 2026-10-23: THEOREM-BE was told "no verified gate path" from X1-ZR49 for 2h50m because the edge check
 * wanted each far system in memory. The galaxy crawler now fills the construction cache for every gate.
 */
const rows = [
  { systemSymbol: "X1-A", waypoints: [], jumpGates: [{ symbol: "X1-A-G", connections: ["X1-B-G"] }] },
  { systemSymbol: "X1-B", waypoints: [], jumpGates: [{ symbol: "X1-B-G", connections: ["X1-A-G", "X1-C-G"] }] },
  { systemSymbol: "X1-C", waypoints: [], jumpGates: [{ symbol: "X1-C-G", connections: ["X1-B-G"] }] },
];
const stored = (done: Record<string, boolean>): GalaxyStore => ({
  getSystemTopology: async () => undefined,
  setSystemTopology: async () => {},
  getAllGalaxyGateConstruction: async () => Object.entries(done).map(([gateSymbol, isComplete]) => ({ gateSymbol, isComplete })),
});
async function atlas(done: Record<string, boolean>): Promise<GalaxyAtlas> {
  const a = new GalaxyAtlas({} as never, stored(done));
  a.hydrateJumpGraph(rows);
  await a.loadGateConstruction();
  return a;
}

describe("edges from the hydrated graph and the construction cache", () => {
  it("find a multi-hop path through systems that were never loaded, once every gate is known built", async () => {
    const a = await atlas({ "X1-A-G": true, "X1-B-G": true, "X1-C-G": true });
    assert.deepEqual(a.jumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"]);
    assert.deepEqual(a.jumpPath("X1-C", "X1-A"), ["X1-C", "X1-B", "X1-A"]);
    assert.equal(a.edgeUsable("X1-A", "X1-B"), true);
    assert.equal(a.canJump("X1-A", "X1-B"), false, "canJump still speaks only for loaded systems; the edge check is what reads the graph");
  });

  it("do not guess: a gate not known built, or known unfinished, blocks the edge", async () => {
    const unknown = await atlas({ "X1-A-G": true, "X1-B-G": true });
    assert.equal(unknown.jumpPath("X1-A", "X1-C"), undefined, "C's gate was never read");
    assert.deepEqual(unknown.jumpPath("X1-A", "X1-B"), ["X1-A", "X1-B"]);
    const unfinished = await atlas({ "X1-A-G": true, "X1-B-G": true, "X1-C-G": false });
    assert.equal(unfinished.jumpPath("X1-A", "X1-C"), undefined);
  });

  it("learn a gate the crawler finished after the atlas started, on the next reload", async () => {
    const state: Record<string, boolean> = { "X1-A-G": true, "X1-B-G": true, "X1-C-G": false };
    const a = new GalaxyAtlas({} as never, { ...stored(state), getAllGalaxyGateConstruction: async () => Object.entries(state).map(([gateSymbol, isComplete]) => ({ gateSymbol, isComplete })) });
    a.hydrateJumpGraph(rows);
    await a.loadGateConstruction();
    assert.equal(a.jumpPath("X1-A", "X1-C"), undefined);
    state["X1-C-G"] = true; // the crawler read it
    await a.loadGateConstruction();
    assert.deepEqual(a.jumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"]);
  });

  it("without a hydrated graph behave exactly as before", () => {
    const a = new GalaxyAtlas({} as never, stored({ "X1-A-G": true, "X1-B-G": true }));
    assert.equal(a.jumpPath("X1-A", "X1-B"), undefined);
  });
});
