import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

/** usableNeighbors() is cached (2026-11-21 SEV0); the cache must still follow every change a path depends on. */
function store(): GalaxyStore {
  const topology: Record<string, { waypoints: unknown[]; jumpGates: unknown[] }> = {
    "X1-A": { waypoints: [{ symbol: "X1-A-GATE", type: "JUMP_GATE" }], jumpGates: [{ symbol: "X1-A-GATE", connections: ["X1-B-GATE"] }] },
    "X1-B": { waypoints: [{ symbol: "X1-B-GATE", type: "JUMP_GATE" }], jumpGates: [{ symbol: "X1-B-GATE", connections: ["X1-A-GATE"] }] },
  };
  return { getSystemTopology: async (sys) => topology[sys], setSystemTopology: async () => {} };
}

async function atlas(complete: Record<string, boolean>) {
  const api = { getConstruction: async (_s: string, wp: string) => ({ isComplete: complete[wp] ?? false, materials: [] }) } as any;
  const a = new GalaxyAtlas(api, store());
  await a.loadSystem("X1-A");
  await a.loadSystem("X1-B");
  return a;
}

describe("GalaxyAtlas neighbour cache", () => {
  it("opens the edge once both gates are read complete, though the closed answer was cached", async () => {
    const a = await atlas({ "X1-A-GATE": true, "X1-B-GATE": true });
    assert.deepEqual(a.usableNeighbors("X1-A"), [], "nothing read yet");
    assert.equal(a.jumpPath("X1-A", "X1-B"), undefined);
    await a.refreshGateConstruction("X1-A", "X1-A-GATE");
    await a.refreshGateConstruction("X1-B", "X1-B-GATE");
    assert.deepEqual(a.usableNeighbors("X1-A"), ["X1-B"]);
    assert.deepEqual(a.jumpPath("X1-A", "X1-B"), ["X1-A", "X1-B"]);
  });

  it("closes it again when a gate is reported unfinished", async () => {
    const a = await atlas({ "X1-A-GATE": true, "X1-B-GATE": true });
    await a.refreshGateConstruction("X1-A", "X1-A-GATE");
    await a.refreshGateConstruction("X1-B", "X1-B-GATE");
    assert.deepEqual(a.usableNeighbors("X1-A"), ["X1-B"]);
    a.recordGateNotComplete("X1-B-GATE");
    assert.deepEqual(a.usableNeighbors("X1-A"), []);
  });

  it("reloading a system with the same gates keeps the cache; a caller cannot corrupt it", async () => {
    const a = await atlas({ "X1-A-GATE": true, "X1-B-GATE": true });
    await a.refreshGateConstruction("X1-A", "X1-A-GATE");
    await a.refreshGateConstruction("X1-B", "X1-B-GATE");
    const first = a.usableNeighbors("X1-A");
    first.push("X1-JUNK");
    assert.deepEqual(a.usableNeighbors("X1-A"), ["X1-B"]);
    await a.loadSystem("X1-A");
    assert.deepEqual(a.usableNeighbors("X1-A"), ["X1-B"]);
  });
});
