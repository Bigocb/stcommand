import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

/**
 * Proven edges: a jump that went through proves its gates are open, whatever this process has loaded.
 * 2026-10-23, THEOREM-BE jumped AR93 -> QK51 -> JM61 -> ZR49 and was then told "no verified gate path" from ZR49,
 * because the edge check wanted each far system loaded and its gate confirmed in memory.
 */
const store = (rows: { fromGate: string; toSystem: string; totalPrice: number; jumpCount: number }[] = []): GalaxyStore => ({
  getSystemTopology: async () => undefined,
  setSystemTopology: async () => {},
  getAllGalaxyJumpCosts: async () => rows,
  recordGalaxyJumpCost: async () => {},
  recordGalaxyGateConstruction: async () => {},
});
const atlas = (s: GalaxyStore = store()) => new GalaxyAtlas({} as never, s);

describe("proven jump edges", () => {
  it("know nothing before a jump, so an unloaded chain reads as no path", () => {
    const a = atlas();
    assert.equal(a.canJump("X1-AR93", "X1-QK51"), false);
    assert.equal(a.jumpPath("X1-AR93", "X1-ZR49"), undefined);
  });

  it("make a real jump usable both ways, and chain into a multi-hop path through systems never loaded", () => {
    const a = atlas();
    a.recordJumpCost("X1-AR93-F25C", "X1-QK51", 5091);
    a.recordJumpCost("X1-QK51-DX9B", "X1-JM61", 5713);
    a.recordJumpCost("X1-JM61-C11C", "X1-ZR49", 6195);
    assert.equal(a.canJump("X1-AR93", "X1-QK51"), true);
    assert.equal(a.edgeUsable("X1-QK51", "X1-AR93"), true, "gates are paired, so the way back is open too");
    assert.deepEqual(a.jumpPath("X1-ZR49", "X1-AR93"), ["X1-ZR49", "X1-JM61", "X1-QK51", "X1-AR93"]);
    assert.deepEqual(a.jumpPath("X1-AR93", "X1-ZR49"), ["X1-AR93", "X1-QK51", "X1-JM61", "X1-ZR49"]);
  });

  it("still respects the hop limit", () => {
    const a = atlas();
    a.setPositioningHops(2);
    a.recordJumpCost("X1-A-G", "X1-B", 1);
    a.recordJumpCost("X1-B-G", "X1-C", 1);
    a.recordJumpCost("X1-C-G", "X1-D", 1);
    assert.deepEqual(a.jumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"]);
    assert.equal(a.jumpPath("X1-A", "X1-D"), undefined, "three hops is past the limit of two");
  });

  it("are rebuilt from the persisted jump ledger at boot", async () => {
    const a = atlas(store([{ fromGate: "X1-AR93-F25C", toSystem: "X1-QK51", totalPrice: 10_000, jumpCount: 2 }]));
    assert.equal(a.canJump("X1-AR93", "X1-QK51"), false);
    await a.loadJumpCosts();
    assert.equal(a.canJump("X1-AR93", "X1-QK51"), true);
    assert.deepEqual(a.jumpPath("X1-QK51", "X1-AR93"), ["X1-QK51", "X1-AR93"]);
  });

  it("are withdrawn when a live jump is rejected as under construction", () => {
    const a = atlas();
    a.recordJumpCost("X1-AR93-F25C", "X1-QK51", 5000);
    a.recordJumpCost("X1-QK51-DX9B", "X1-JM61", 5000);
    a.recordGateNotComplete("X1-QK51-DX9B");
    assert.equal(a.canJump("X1-AR93", "X1-QK51"), false, "everything touching the rejected gate's system is forgotten");
    assert.equal(a.jumpPath("X1-AR93", "X1-JM61"), undefined);
  });
});
