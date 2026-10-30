import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reachableSystems } from "../src/engine/jumpGraph.js";

const graph: Record<string, string[]> = {
  "X1-HOME": ["X1-A"], "X1-A": ["X1-HOME", "X1-B"], "X1-B": ["X1-A", "X1-C"], "X1-C": ["X1-B"],
  "X1-PK42": ["X1-PK43"], "X1-PK43": ["X1-PK42"], // another agent's cluster: no gate to ours
};
const nb = (s: string): string[] => graph[s] ?? [];

describe("reachableSystems", () => {
  it("finds every system gated to from the starts, however far, and none outside the cluster", () => {
    const net = reachableSystems(["X1-HOME"], nb);
    assert.deepEqual([...net].sort(), ["X1-A", "X1-B", "X1-C", "X1-HOME"]);
    assert.equal(net.has("X1-PK42"), false);
  });
  it("joins the networks of several starts (a trader standing in a second cluster)", () => {
    const net = reachableSystems(["X1-HOME", "X1-PK42"], nb);
    assert.equal(net.has("X1-PK43"), true);
    assert.equal(net.has("X1-C"), true);
  });
  it("stops at the limit", () => {
    const wide = (s: string): string[] => [`${s}a`, `${s}b`];
    assert.ok(reachableSystems(["X"], wide, 50).size <= 52);
  });
});
