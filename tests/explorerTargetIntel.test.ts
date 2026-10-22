import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { CooldownPending } from "../src/engine/agentStep.js";

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
function fakeGalaxy(loaded: string[], edges: Edge[], markets: Record<string, number> = {}, yards: Record<string, number> = {}) {
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
      // Shipyards default to one on the first market; `yards[sys]` overrides it (0 = a system with markets but no yard).
      const yard = i < (yards[sys] ?? 1);
      out.push({ symbol: `${sys}-M${i}`, type: "ORBITAL_STATION", traits: [{ symbol: "MARKETPLACE" }, ...(yard ? [{ symbol: "SHIPYARD" }] : [])] });
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

describe("the explorer's worth threshold (operator, 2026-10-22): fewer than five markets or no shipyard is not touring material", () => {
  it("does not target a loaded system with only four markets, or with five and no shipyard", () => {
    const four = fakeGalaxy(["X1-A", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 4 });
    const f1 = fleetWith(four);
    (f1 as any).surveyedSystems = new Set(["X1-A"]);
    assert.equal(hop(f1, "X1-A"), undefined, "four markets is under the minimum of five");

    const noYard = fakeGalaxy(["X1-A", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 12 }, { "X1-M": 0 });
    const f2 = fleetWith(noYard);
    (f2 as any).surveyedSystems = new Set(["X1-A"]);
    assert.equal(hop(f2, "X1-A"), undefined, "no shipyard, however many markets");
  });

  it("targets a system at exactly five markets with a shipyard", () => {
    const galaxy = fakeGalaxy(["X1-A", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 5 });
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);
    assert.equal(hop(fleet, "X1-A"), "X1-M");
  });

  it("switching both clauses off reproduces the old rule: any system with a market is a target", () => {
    const galaxy = fakeGalaxy(["X1-A", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 2 }, { "X1-M": 0 });
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);
    (fleet as any).doctrine = { isEnabledOr: () => false, value: (_k: string, d?: number) => d ?? 0 };
    assert.equal(hop(fleet, "X1-A"), "X1-M");
  });
});

describe("only a finished tour or a worth verdict counts as toured", () => {
  it("still targets a good system whose mark is not a finished tour, but not one an explorer toured", () => {
    const galaxy = fakeGalaxy(["X1-A", "X1-M", "X1-N"], [["X1-A", "X1-M"], ["X1-A", "X1-N"]], { "X1-M": 9, "X1-N": 9 });
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-M", "X1-N"]);
    (fleet as any).untouredMarks = new Set(["X1-M"]);
    assert.equal(hop(fleet, "X1-A"), "X1-M", "M was only surveyed in passing; N was toured");
  });

  it("an untoured system that fails the worth threshold is still not worth a flight", () => {
    const galaxy = fakeGalaxy(["X1-A", "X1-M"], [["X1-A", "X1-M"]], { "X1-M": 3 });
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-M"]);
    (fleet as any).untouredMarks = new Set(["X1-M"]);
    assert.equal(hop(fleet, "X1-A"), undefined);
  });

  it("marks: a passing survey starts the debt, a finished tour or a verdict clears it, and a later plain mark does not undo it", async () => {
    const fleet: any = fleetWith(fakeGalaxy(["X1-A"], []));
    await fleet.markSystemSurveyed("X1-M", "explore");
    assert.equal(fleet.isToured("X1-M"), false, "a first survey is not a tour");
    await fleet.markSystemSurveyed("X1-M", "toured");
    assert.equal(fleet.isToured("X1-M"), true);
    await fleet.markSystemSurveyed("X1-M", "scout");
    assert.equal(fleet.isToured("X1-M"), true, "another ship passing through must not undo a finished tour");
    await fleet.markSystemSurveyed("X1-R", "survey");
    await fleet.markSystemSurveyed("X1-R", "rejected");
    assert.equal(fleet.isToured("X1-R"), true, "a worth verdict ends the explorer's interest too");
  });

  it("forgetting a system clears the state with the mark", async () => {
    const fleet: any = fleetWith(fakeGalaxy(["X1-A"], []));
    fleet.surveyedSystems.add("X1-Q");
    fleet.untouredMarks.add("X1-Q");
    await fleet.forgetSurveys("X1-Q");
    assert.equal(fleet.untouredMarks.has("X1-Q"), false);
    assert.equal(fleet.isToured("X1-Q"), false);
  });
});

describe("an explorer's tour marks the system toured only when it runs to the end", () => {
  function tourFleet(dispatch: () => Promise<void>) {
    const fleet: any = fleetWith(fakeGalaxy(["X1-T"], [], { "X1-T": 6 }));
    const marks: unknown[][] = [];
    fleet.markSystemSurveyed = async (...a: unknown[]) => { marks.push(a); };
    fleet.dispatchShip = dispatch;
    fleet.recordMarketSnapshot = async () => {};
    fleet.recordShipyardSnapshot = async () => {};
    return { fleet, marks };
  }
  const stops = [{ symbol: "X1-T-M0", market: true, yard: true }, { symbol: "X1-T-M1", market: true, yard: false }];

  it("a finished tour writes a toured mark with the system's counts", async () => {
    const { fleet, marks } = tourFleet(async () => {});
    await fleet.runTourStops("S-1", "X1-T", stops, undefined);
    assert.deepEqual(marks, [["X1-T", "toured", { markets: 6, shipyards: 1 }]]);
  });

  it("a stop that fails on its own does not stop the tour from finishing", async () => {
    let n = 0;
    const { fleet, marks } = tourFleet(async () => { if (n++ === 0) throw new Error("unreachable"); });
    await fleet.runTourStops("S-1", "X1-T", stops, undefined);
    assert.equal(marks.length, 1);
  });

  it("a cooldown pauses the tour: no toured mark, and the rest is kept to resume", async () => {
    const { fleet, marks } = tourFleet(async () => { throw new CooldownPending(Date.now() + 60_000, "cooldown"); });
    await assert.rejects(() => fleet.runTourStops("S-1", "X1-T", stops, undefined));
    assert.deepEqual(marks, []);
    assert.equal(fleet.pendingTourStops.get("S-1").stops.length, 2);
  });
});
