import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findJumpPath, MAX_POSITIONING_HOPS } from "../src/engine/jumpGraph.js";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

const chain = (edges: [string, string][]) => (s: string) =>
  edges.flatMap(([a, b]) => (a === s ? [b] : b === s ? [a] : []));

describe("findJumpPath", () => {
  it("is just the origin for a zero-hop path", () => {
    assert.deepEqual(findJumpPath("A", "A", () => []), ["A"]);
  });

  it("finds the shortest path", () => {
    const n = chain([["A", "B"], ["B", "C"], ["A", "C"]]);
    assert.deepEqual(findJumpPath("A", "C", n), ["A", "C"]);
  });

  it("allows exactly MAX_POSITIONING_HOPS hops and refuses one more", () => {
    assert.equal(MAX_POSITIONING_HOPS, 3);
    const n = chain([["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]]);
    assert.deepEqual(findJumpPath("A", "D", n), ["A", "B", "C", "D"]);
    assert.equal(findJumpPath("A", "E", n), undefined, "4 hops is over the cap");
  });

  it("never honors a caller bound above the cap", () => {
    const n = chain([["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]]);
    assert.equal(findJumpPath("A", "E", n, 10), undefined);
  });

  it("terminates on cycles and returns undefined when unreachable", () => {
    const n = chain([["A", "B"], ["B", "A"], ["B", "C"], ["C", "B"]]);
    assert.equal(findJumpPath("A", "Z", n), undefined);
  });
});

// A - B - C line; gates seeded for all three systems.
function lineStore(): GalaxyStore {
  const wp = (sys: string) => [{ symbol: `X1-${sys}-GATE`, type: "JUMP_GATE" }];
  const topology: Record<string, { waypoints: unknown[]; jumpGates: unknown[] }> = {
    "X1-A": { waypoints: wp("A"), jumpGates: [{ symbol: "X1-A-GATE", connections: ["X1-B-GATE"] }] },
    "X1-B": { waypoints: wp("B"), jumpGates: [{ symbol: "X1-B-GATE", connections: ["X1-A-GATE", "X1-C-GATE"] }] },
    "X1-C": { waypoints: wp("C"), jumpGates: [{ symbol: "X1-C-GATE", connections: ["X1-B-GATE"] }] },
  };
  return { getSystemTopology: async (s) => topology[s], setSystemTopology: async () => {} };
}

describe("GalaxyAtlas.jumpPath / warmJumpPath", () => {
  async function atlasWith(complete: (gate: string) => boolean) {
    const api = {
      getConstruction: async (_s: string, gate: string) => ({ isComplete: complete(gate), materials: [] }),
    } as any;
    const atlas = new GalaxyAtlas(api, lineStore());
    for (const s of ["X1-A", "X1-B", "X1-C"]) await atlas.loadSystem(s);
    return atlas;
  }

  it("is unanswerable (undefined) until gates are checked, then finds A->C through B", async () => {
    const atlas = await atlasWith(() => true);
    assert.equal(atlas.jumpPath("X1-A", "X1-C"), undefined);
    assert.deepEqual(await atlas.warmJumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"]);
    assert.deepEqual(atlas.jumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"]);
  });

  it("an incomplete gate anywhere on the chain closes the path", async () => {
    const atlas = await atlasWith((g) => g !== "X1-C-GATE");
    assert.equal(await atlas.warmJumpPath("X1-A", "X1-C"), undefined);
  });

  it("recordGateNotComplete() reopens the question: the path disappears", async () => {
    const atlas = await atlasWith(() => true);
    await atlas.warmJumpPath("X1-A", "X1-C");
    atlas.recordGateNotComplete("X1-B-GATE");
    assert.equal(atlas.jumpPath("X1-A", "X1-C"), undefined);
  });

  it("answers a repeated pair from its cache (one search), hands out copies, and forgets when a gate changes", async () => {
    const atlas = await atlasWith(() => true);
    await atlas.warmJumpPath("X1-A", "X1-C");
    let searches = 0;
    const real = atlas.usableNeighbors.bind(atlas);
    atlas.usableNeighbors = (s: string) => { searches += 1; return real(s); };
    const first = atlas.jumpPath("X1-A", "X1-C");
    const afterFirst = searches;
    assert.ok(afterFirst > 0);
    for (let i = 0; i < 50; i++) atlas.jumpPath("X1-A", "X1-C");
    assert.equal(searches, afterFirst, "fifty more asks cost no more searching");
    first!.push("mutated");
    assert.deepEqual(atlas.jumpPath("X1-A", "X1-C"), ["X1-A", "X1-B", "X1-C"], "a caller changing its copy does not change the cache");
    atlas.recordGateNotComplete("X1-B-GATE");
    assert.equal(atlas.jumpPath("X1-A", "X1-C"), undefined, "a gate change drops the cached answer");
  });
});
