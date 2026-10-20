import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The explorer's target rule is "any loaded system with no survey row".
 * That conflates "nobody has catalogued this system's markets" with
 * "this system has markets to catalogue", and the difference is provable
 * from the atlas alone: surveySystem() only ever fetches waypoints carrying
 * the MARKETPLACE or SHIPYARD trait (GalaxyAtlas.surveyMarkets /
 * surveyShipyards), so a system whose cached waypoints carry neither will
 * survey to exactly `0 markets, 0 shipyards` — a guaranteed no-op.
 *
 * Confirmed live 2026-10-20 19:38: THEOREM-59 was five jumps into a trip to
 * X1-MV21 — an asteroid field with 71 asteroids, 2 fuel stations, an
 * asteroid base and one gate, and not a single MARKETPLACE waypoint — because
 * it was the nearest loaded system without a survey row. Nine such systems
 * sat in the target set ahead of the real frontier, 13 hops away.
 *
 * A *frontier* system (known only as a gate connection, never loaded) stays a
 * valid target: nothing about it is known, so it is genuinely worth a visit.
 */

type Edge = [string, string];

/**
 * Atlas stub. `loaded` systems have cached waypoints; `markets[sys]` is how
 * many of those waypoints carry the MARKETPLACE trait (default 0 — a system
 * with nothing to survey, like X1-MV21). Systems named in `edges` but absent
 * from `loaded` are the frontier.
 */
function fakeGalaxy(loaded: string[], edges: Edge[], markets: Record<string, number> = {}) {
  const gate = (sys: string, i: number) => `${sys}-G${i}`;
  const gateOf: Record<string, string[]> = {};
  const connections: { from: string; to: string; complete: boolean }[] = [];
  for (const [a, b] of edges) {
    gateOf[a] ??= [];
    gateOf[b] ??= [];
    const ga = gate(a, gateOf[a].length);
    const gb = gate(b, gateOf[b].length);
    gateOf[a].push(ga);
    gateOf[b].push(gb);
    connections.push({ from: ga, to: gb, complete: true });
    connections.push({ from: gb, to: ga, complete: true });
  }
  const waypointsOf = (sys: string) => {
    const out = [{ symbol: `${sys}-A1`, type: "ASTEROID", traits: [{ symbol: "COMMON_METAL_DEPOSITS" }] }];
    for (let i = 0; i < (markets[sys] ?? 0); i++) {
      out.push({ symbol: `${sys}-M${i}`, type: "ORBITAL_STATION", traits: [{ symbol: "MARKETPLACE" }] });
    }
    return out;
  };
  return {
    listSystems: () => loaded.map((symbol) => ({ symbol })),
    frontierSystems: () => [...new Set(edges.flat())].filter((s) => !loaded.includes(s)),
    jumpConnections: () => connections,
    gateComplete: () => true,
    connectedSystems: (s: string) =>
      edges.flatMap(([a, b]) => (a === s ? [b] : b === s ? [a] : [])),
    graphNeighbours: (s: string) =>
      edges.flatMap(([a, b]) => (a === s ? [b] : b === s ? [a] : [])),
    getSystem: (s: string) =>
      loaded.includes(s)
        ? { symbol: s, waypoints: waypointsOf(s), jumpGates: [], markets: [], shipyards: [] }
        : undefined,
  } as any;
}

function fleetWith(galaxy: any) {
  const fleet = new FleetManager({ api: {} as any });
  (fleet as any).galaxy = galaxy;
  (fleet as any).systemSymbol = "X1-HOME";
  return fleet;
}

const hop = (fleet: FleetManager, from: string) => (fleet as any).nextHopToUnsurveyed(from);

describe("the explorer does not fly to systems that provably have nothing to survey", () => {
  it("prefers a two-hop route to unknown space over a one-hop trip to a barren loaded system", () => {
    // A -- B -- F  and A -- E.
    //   B: loaded, already surveyed, leads to the frontier F.
    //   E: loaded, never surveyed, but its atlas waypoints carry no
    //      MARKETPLACE and no SHIPYARD — surveying it records 0 and 0.
    // Nearest-target-first picks E today (one hop). It must pick B.
    const galaxy = fakeGalaxy(
      ["X1-A", "X1-B", "X1-E"],
      [["X1-A", "X1-B"], ["X1-B", "X1-F"], ["X1-A", "X1-E"]],
      { "X1-B": 4 },
    );
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), "X1-B");
  });

  it("still targets a loaded, unsurveyed system that has a marketplace", () => {
    // The inverse guard: the fix must not throw away real survey work.
    const galaxy = fakeGalaxy(["X1-A", "X1-B", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 6 });
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);

    assert.equal(hop(fleet, "X1-A"), "X1-M");
  });

  it("still targets a frontier system, which has no waypoints to judge", () => {
    const galaxy = fakeGalaxy(["X1-A"], [["X1-A", "X1-F"]]);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);

    assert.equal(hop(fleet, "X1-A"), "X1-F");
  });

  it("returns undefined when every reachable system is either surveyed or barren", () => {
    // Nothing left worth a jump: the caller backs off instead of flying a
    // pointless route. This is the state known space is actually in.
    const galaxy = fakeGalaxy(["X1-A", "X1-B", "X1-E"], [["X1-A", "X1-B"], ["X1-A", "X1-E"]]);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), undefined);
  });
});
