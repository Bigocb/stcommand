import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { overProbeCap, withinProbeCap } from "../src/engine/keeperPriceCap.js";

describe("keeper probe price cap (pure)", () => {
  it("over the cap only when on (cap > 0) and strictly above it", () => {
    assert.equal(overProbeCap(161_774, 60_000), true);
    assert.equal(overProbeCap(60_000, 60_000), false);
    assert.equal(overProbeCap(161_774, 0), false, "off = any price, as before");
  });
  it("drops only keeper hulls over the cap; other hulls and cheap probes stay", () => {
    const rows = [
      { waypointSymbol: "X1-TU72-C40", shipType: "SHIP_PROBE", purchasePrice: 161_774 },
      { waypointSymbol: "X1-RS9-C13X", shipType: "SHIP_PROBE", purchasePrice: 23_097 },
      { waypointSymbol: "X1-TU72-C40", shipType: "SHIP_HEAVY_FREIGHTER", purchasePrice: 2_500_000 },
    ];
    assert.deepEqual(withinProbeCap(rows, 60_000, ["SHIP_PROBE"]).map((r) => r.purchasePrice), [23_097, 2_500_000]);
    assert.equal(withinProbeCap(rows, 0, ["SHIP_PROBE"]).length, 3);
  });
});
