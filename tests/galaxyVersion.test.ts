import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { galaxyVersion } from "../src/engine/galaxyVersion.js";

const galaxy = () => ({
  systems: [
    { symbol: "X1-A", waypoints: [{ symbol: "X1-A-1", x: 0, y: 0, type: "PLANET", traits: ["MARKETPLACE"] }], jumpGates: ["X1-A-G"] },
    { symbol: "X1-B", waypoints: [{ symbol: "X1-B-1", x: 5, y: 5, type: "MOON", traits: [] }], jumpGates: ["X1-B-G"] },
  ],
  jumpConnections: [{ from: "X1-A", to: "X1-B", complete: false }],
});

describe("galaxy version", () => {
  it("is the same for the same galaxy", () => {
    assert.equal(galaxyVersion(galaxy()), galaxyVersion(galaxy()));
  });

  it("changes when a gate finishes during the week", () => {
    const g = galaxy();
    const opened = { ...g, jumpConnections: [{ from: "X1-A", to: "X1-B", complete: true }] };
    assert.notEqual(galaxyVersion(g), galaxyVersion(opened));
  });

  it("changes when a new system is discovered", () => {
    const g = galaxy();
    const more = { ...g, systems: [...g.systems, { symbol: "X1-C", waypoints: [], jumpGates: [] }] };
    assert.notEqual(galaxyVersion(g), galaxyVersion(more));
  });

  it("changes when a waypoint is charted (its traits become known)", () => {
    const g = galaxy();
    const charted = { ...g, systems: g.systems.map((s) => s.symbol === "X1-B" ? { ...s, waypoints: [{ ...s.waypoints[0]!, traits: ["SHIPYARD"] }] } : s) };
    assert.notEqual(galaxyVersion(g), galaxyVersion(charted));
  });
});
