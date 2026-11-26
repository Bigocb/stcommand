import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas, type GalaxyStore } from "../src/engine/galaxy.js";

/**
 * A load already in the hold may travel past the positioning-jumps setting (up to the ceiling): THEO-25F bought 300 MERITIUM
 * at X1-VQ16 for X1-MP5 on 2026-11-25; the setting went 7 -> 5 thirteen minutes later, MP5 fell out of reach and the load was
 * sold back for -1.66M. jumpPathWithin() is the search the trader's cargoPath() uses for a loaded ship.
 */
const chain = ["X1-A", "X1-B", "X1-C", "X1-D"];
const rows = chain.map((s, i) => ({
  systemSymbol: s, waypoints: [],
  jumpGates: [{ symbol: `${s}-G`, connections: [chain[i - 1], chain[i + 1]].filter(Boolean).map((n) => `${n}-G`) }],
}));
const store: GalaxyStore = {
  getSystemTopology: async () => undefined,
  setSystemTopology: async () => {},
  getAllGalaxyGateConstruction: async () => chain.map((s) => ({ gateSymbol: `${s}-G`, isComplete: true })),
};

describe("jumpPathWithin: a wider limit for cargo already aboard", () => {
  it("finds a path the positioning setting no longer allows, and leaves jumpPath on the setting", async () => {
    const a = new GalaxyAtlas({} as never, store);
    a.hydrateJumpGraph(rows);
    await a.loadGateConstruction();
    a.setPositioningHops(2);
    assert.equal(a.jumpPath("X1-A", "X1-D"), undefined, "3 jumps is over the setting of 2");
    assert.deepEqual(a.jumpPathWithin("X1-A", "X1-D", 10), ["X1-A", "X1-B", "X1-C", "X1-D"]);
    assert.equal(a.jumpPathWithin("X1-A", "X1-D", 2), undefined, "the same limit as the setting answers as jumpPath does");
    assert.equal(a.jumpPath("X1-A", "X1-D"), undefined, "the wider search does not leak into jumpPath's cache");
  });
});
