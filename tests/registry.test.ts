import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/engine/registry.js";
import { GalaxyAtlas } from "../src/engine/galaxy.js";
import type { MarketSnapshot } from "../src/engine/market.js";

/**
 * Step 2 of docs/control-plane-data-plane.md: the registry every reader holds
 * by reference instead of copying. These tests pin the two properties the
 * per-agent `withWorld()` copies could not provide — liveness, and failing
 * closed on anything unmeasurable — plus the same-system rule that was
 * previously re-implemented by hand in four files.
 */

function atlasWith(systems: Record<string, { symbol: string; x: number; y: number; type?: string; traits?: string[] }[]>): GalaxyAtlas {
  const atlas = new GalaxyAtlas({ getAllSystemWaypoints: async () => [] } as any);
  for (const [sys, waypoints] of Object.entries(systems)) {
    (atlas as any).systems.set(sys, {
      symbol: sys,
      waypoints: waypoints.map((w) => ({
        symbol: w.symbol,
        systemSymbol: sys,
        x: w.x,
        y: w.y,
        type: w.type ?? "PLANET",
        orbitals: [],
        traits: (w.traits ?? []).map((t) => ({ symbol: t, name: t, description: "" })),
        isUnderConstruction: false,
      })),
      jumpGates: [],
      markets: [],
      shipyards: [],
    });
  }
  return atlas;
}

const snapshot = (symbol: string, systemSymbol: string): MarketSnapshot => ({
  symbol,
  systemSymbol,
  tradeGoods: {},
  imports: [],
  exports: [],
  exchange: [],
  fetchedAt: new Date().toISOString(),
});

describe("Registry: positions and distance", () => {
  it("reads positions live from the atlas, so a system charted later needs no re-seeding", () => {
    // The whole reason this class exists. Under withWorld(), an agent
    // constructed before the chart kept an empty map forever and computed
    // every distance as unknown — confirmed live on ships that came back
    // from a restart in a system nobody had charted yet.
    const atlas = atlasWith({ "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }] });
    const registry = new Registry(atlas);

    assert.equal(registry.position("X1-B-B1"), undefined, "not charted yet");

    (atlas as any).systems.set("X1-B", {
      symbol: "X1-B",
      waypoints: [{ symbol: "X1-B-B1", systemSymbol: "X1-B", x: 3, y: 4, type: "PLANET", orbitals: [], traits: [], isUnderConstruction: false }],
      jumpGates: [], markets: [], shipyards: [],
    });

    assert.deepEqual(registry.position("X1-B-B1"), { symbol: "X1-B-B1", x: 3, y: 4, type: "PLANET" });
  });

  it("measures distance within a system", () => {
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-B2", x: 3, y: 4 }] }));
    assert.equal(registry.distance("X1-A-A1", "X1-A-B2"), 5);
    assert.equal(registry.fuelFor("X1-A-A1", "X1-A-B2"), 5);
  });

  it("returns Infinity across a system boundary, however close the raw coordinates look", () => {
    // Coordinates are per-system, so two waypoints in different systems can
    // sit "12 units" apart by pure coincidence. Flying that needs a jump, not
    // a navigate — a tour scout picked exactly such a leg and failed on it
    // repeatedly before the same-system rule was added by hand in four files.
    const registry = new Registry(atlasWith({
      "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }],
      "X1-B": [{ symbol: "X1-B-B1", x: 12, y: 0 }],
    }));
    assert.equal(registry.distance("X1-A-A1", "X1-B-B1"), Infinity);
    assert.equal(registry.fuelFor("X1-A-A1", "X1-B-B1"), Infinity);
  });

  it("returns Infinity when either end is unknown, never 0", () => {
    // Returning 0 made the waypoints we knew least about score as the nearest
    // things in the galaxy: it picked refuel stops in other systems, sent
    // ships chasing sell markets they could not reach, and let a long leg
    // read as free at CRUISE — the live "requires 1048 more fuel" rejections.
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }] }));
    assert.equal(registry.distance("X1-A-A1", "X1-A-GHOST"), Infinity);
    assert.equal(registry.distance("X1-A-GHOST", "X1-A-A1"), Infinity);
  });

  it("fuelFor never reports a zero-cost leg between two distinct known waypoints", () => {
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-B2", x: 0, y: 0.2 }] }));
    assert.equal(registry.fuelFor("X1-A-A1", "X1-A-B2"), 1, "rounds up to a minimum of one unit");
  });
});

describe("Registry: traits are authoritative, snapshots are separate", () => {
  it("reports a marketplace by trait even with no prices ever recorded", () => {
    // DAGGER-13 sat at 27/300 fuel reporting "no reachable market" while
    // parked on an unsnapshotted fuel station. `markets` only ever listed
    // waypoints already snapshotted; the trait is what actually matters.
    const registry = new Registry(atlasWith({
      "X1-A": [{ symbol: "X1-A-FUEL", x: 0, y: 0, type: "FUEL_STATION", traits: ["MARKETPLACE"] }],
    }));
    assert.equal(registry.isMarket("X1-A-FUEL"), true);
    assert.equal(registry.market("X1-A-FUEL"), undefined, "no prices recorded yet, and that is fine");
  });

  it("does not treat a snapshot as evidence of the trait, or vice versa", () => {
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-P1", x: 0, y: 0 }] }));
    registry.recordMarket(snapshot("X1-A-P1", "X1-A"));
    assert.equal(registry.isMarket("X1-A-P1"), false, "trait is the authority, not the presence of a snapshot");
    assert.ok(registry.market("X1-A-P1"), "the snapshot is still readable");
  });

  it("separates trait-based market waypoints from priced markets, per system", () => {
    const registry = new Registry(atlasWith({
      "X1-A": [
        { symbol: "X1-A-M1", x: 0, y: 0, traits: ["MARKETPLACE"] },
        { symbol: "X1-A-M2", x: 1, y: 1, traits: ["MARKETPLACE"] },
        { symbol: "X1-A-P3", x: 2, y: 2 },
      ],
      "X1-B": [{ symbol: "X1-B-M9", x: 0, y: 0, traits: ["MARKETPLACE"] }],
    }));
    registry.recordMarket(snapshot("X1-A-M1", "X1-A"));
    registry.recordMarket(snapshot("X1-B-M9", "X1-B"));

    assert.deepEqual(registry.marketWaypointsIn("X1-A").map((w) => w.symbol).sort(), ["X1-A-M1", "X1-A-M2"]);
    assert.deepEqual(registry.markets("X1-A").map((m) => m.symbol), ["X1-A-M1"], "priced markets in one system only");
    assert.equal(registry.markets().length, 2, "unfiltered returns every priced market");
  });

  it("recordMarket replaces rather than appends, so prices never accumulate duplicates", () => {
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-M1", x: 0, y: 0, traits: ["MARKETPLACE"] }] }));
    const first = snapshot("X1-A-M1", "X1-A");
    const second = { ...snapshot("X1-A-M1", "X1-A"), exports: ["IRON"] };
    registry.recordMarket(first);
    registry.recordMarket(second);
    assert.equal(registry.markets().length, 1);
    assert.deepEqual(registry.market("X1-A-M1")!.exports, ["IRON"], "latest wins");
  });
});

describe("Registry: systemOf", () => {
  it("derives the system from the symbol, including for waypoints no scan has reached", () => {
    const registry = new Registry(atlasWith({}));
    assert.equal(registry.systemOf("X1-KU72-C44"), "X1-KU72");
    assert.equal(registry.systemOf("X1-TV75-X20F"), "X1-TV75");
  });
});

describe("Registry: version", () => {
  it("advances when the world changes, so a decision can quote what it could see", () => {
    const registry = new Registry(atlasWith({ "X1-A": [{ symbol: "X1-A-M1", x: 0, y: 0 }] }));
    const start = registry.version;
    registry.recordMarket(snapshot("X1-A-M1", "X1-A"));
    registry.noteTopologyChanged();
    assert.ok(registry.version > start);
  });

  it("does not advance on an empty batch", () => {
    const registry = new Registry(atlasWith({}));
    const start = registry.version;
    registry.recordMarkets([]);
    assert.equal(registry.version, start);
  });
});
