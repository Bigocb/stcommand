import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUEUED, SystemQueue as SQ } from "../src/engine/systemQueue.js";
describe("queue cap evicts scouted entries, never a live system", () => {
  it("keeps every live and staged system when the queue is over its cap", () => {
    const q = new SQ();
    for (let i = 0; i < 40; i++) { q.scout(`X1-L${i}`, ["m"], i); q.stage(`X1-L${i}`, i); q.release(`X1-L${i}`, i, "t"); }
    for (let i = 0; i < MAX_QUEUED + 25; i++) q.scout(`X1-S${i}`, ["m"], 1000 + i);
    assert.equal(q.list().filter((x) => x.state === "live").length, 40);
    assert.ok(q.list().length <= MAX_QUEUED + 1);
    assert.equal(q.get("X1-S0"), undefined, "the oldest scouted entry went first");
  });
});
