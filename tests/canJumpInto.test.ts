import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas } from "../src/engine/galaxy.js";

/**
 * canJumpInto(): canJump() plus the far end. A trade leg into a system whose gate is known to be unfinished can't be
 * flown (2026-10-15: THEOREM-65 and THEOREM-25 bought cargo for X1-GX41 and sat at their gates). A far gate whose
 * status isn't known yet doesn't block.
 */
function atlas(farGate: boolean | undefined, nearGate = true) {
  const a = new GalaxyAtlas({} as any, {} as any) as any;
  a.gatesTo = (from: string, to: string) => (from === "X1-A" && to === "X1-B" ? ["X1-A-G"] : []);
  a.gateConstruction = new Map<string, boolean>([["X1-A-G", nearGate]]);
  if (farGate !== undefined) a.gateConstruction.set("X1-B-G", farGate);
  a.systems = new Map([["X1-B", { symbol: "X1-B", waypoints: [{ symbol: "X1-B-G", type: "JUMP_GATE" }], jumpGates: [] }]]);
  return a as GalaxyAtlas;
}

describe("canJumpInto", () => {
  it("refuses a jump into a system whose gate is known to be unfinished", () => {
    const a = atlas(false);
    assert.equal(a.canJump("X1-A", "X1-B"), true, "the near gate alone says yes");
    assert.equal(a.canJumpInto("X1-A", "X1-B"), false);
  });

  it("allows it when the far gate is finished, or its status isn't known yet", () => {
    assert.equal(atlas(true).canJumpInto("X1-A", "X1-B"), true);
    assert.equal(atlas(undefined).canJumpInto("X1-A", "X1-B"), true);
  });

  it("still needs the near gate finished", () => {
    assert.equal(atlas(true, false).canJumpInto("X1-A", "X1-B"), false);
  });
});
