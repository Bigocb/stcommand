import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { steppingStone } from "../src/engine/agent.js";

// X1-XJ90, 2026-10-07: from the I59 gate corner every stale market was out of one 300-fuel leg, so the tour flew
// I59 <-> J61 for hours. Coordinates are the real ones, rounded.
const pos: Record<string, [number, number]> = { I59: [0, 0], J61: [-150, -25], I60: [-120, 185], K92: [-300, 170], E48: [-260, 315] };
const fuel = (a: string, b: string) => Math.hypot(pos[a]![0] - pos[b]![0], pos[a]![1] - pos[b]![1]);

describe("tour stepping stone", () => {
  it("hops toward the stale markets instead of to the nearest fresh one", () => {
    const reachable = [{ t: "J61", stale: false }, { t: "I60", stale: false }]; // sorted nearest-first, as the tour does
    assert.equal(steppingStone(reachable, ["K92", "E48"], "I59", fuel), "I60");
  });

  it("leaves the normal pick alone when a stale market is in range", () => {
    assert.equal(steppingStone([{ t: "K92", stale: true }, { t: "J61", stale: false }], ["K92"], "I60", fuel), undefined);
  });

  it("does nothing when nothing is stale, or when no hop gets closer", () => {
    assert.equal(steppingStone([{ t: "J61", stale: false }], [], "I59", fuel), undefined);
    assert.equal(steppingStone([{ t: "J61", stale: false }], ["E48"], "I60", fuel), undefined);
  });
});
