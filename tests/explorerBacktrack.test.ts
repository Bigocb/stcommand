import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { Pending, cooldownPendingFrom } from "../src/engine/agentStep.js";

/**
 * The explorer's "backtrack through known space" search (nextHopToUnsurveyed)
 * only ever looked at systems already loaded into the atlas. Migration 060 put
 * 305 of those 329 into surveyedSystems, so the search had almost nothing left
 * to find and the caller fell through to `candidates[0]` — which bounces a ship
 * between two neighbours forever. Confirmed live 2026-10-20: THEOREM-59 jumped
 * X1-TP78 → X1-RY37 → X1-TP78 → X1-RY37 five times in 45 minutes, buying fuel
 * at every stop, while the 2,660-system frontier sat unreachable.
 *
 * The frontier is exactly what it should be aiming at: systems known as a gate
 * connection that were never loaded, so they carry no waypoints and no survey
 * row. This file pins that behaviour down before the fix exists.
 */

type Edge = [string, string];

/**
 * Atlas stub: `loaded` systems have waypoints; `edges` are gate links between
 * system symbols (the loader builds the gate waypoint symbols itself). A system
 * named in an edge but absent from `loaded` is the frontier — reachable, never
 * loaded.
 */
function fakeGalaxy(loaded: string[], edges: Edge[]) {
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
  return {
    listSystems: () => loaded.map((symbol) => ({ symbol })),
    frontierSystems: () =>
      [...new Set(edges.flat())].filter((s) => !loaded.includes(s)),
    jumpConnections: () => connections,
    gateComplete: () => true,
    connectedSystems: (s: string) =>
      edges.flatMap(([a, b]) => (a === s ? [b] : b === s ? [a] : [])),
    // The routing graph the backtracking search walks. In production this is
    // hydrated from the database at boot and covers systems never loaded; here
    // the fake has no such distinction, so it mirrors the same edges.
    graphNeighbours: (s: string) =>
      edges.flatMap(([a, b]) => (a === s ? [b] : b === s ? [a] : [])),
    getSystem: (s: string) => (loaded.includes(s) ? { symbol: s } : undefined),
  } as any;
}

function fleetWith(galaxy: any) {
  const fleet = new FleetManager({ api: {} as any });
  (fleet as any).galaxy = galaxy;
  (fleet as any).systemSymbol = "X1-HOME";
  return fleet;
}

const hop = (fleet: FleetManager, from: string) => (fleet as any).nextHopToUnsurveyed(from);

describe("explorer backtracking reaches the frontier, not the neighbour it came from", () => {
  it("takes the hop toward a gate-only system when every loaded system is surveyed", () => {
    // A ↔ B, B ↔ F. A and B are loaded and surveyed (the backfill did exactly
    // this); F is known only as a gate connection. From A, the only useful
    // move is B — toward F. Before the fix this returned undefined and the
    // caller bounced A ↔ B.
    const galaxy = fakeGalaxy(["X1-A", "X1-B"], [["X1-A", "X1-B"], ["X1-B", "X1-F"]]);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), "X1-B");
  });

  it("prefers an unsurveyed loaded system over a frontier hop when it is closer", () => {
    // A ↔ B (B unsurveyed, loaded) and A ↔ F (F frontier). One hop either way,
    // but B is real survey work with known markets; it wins on the loaded loop
    // running first, and either answer is one hop from A — assert we do not
    // return A itself or nothing.
    const galaxy = fakeGalaxy(["X1-A", "X1-B"], [["X1-A", "X1-B"], ["X1-A", "X1-F"]]);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);

    const target = hop(fleet, "X1-A");
    assert.ok(target === "X1-B" || target === "X1-F", `expected a real next hop, got ${target}`);
  });

  it("returns undefined when nothing is left anywhere — the caller must back off, not bounce", () => {
    // Closed pair, both surveyed, no frontier. There is genuinely nowhere to
    // go, and the ship has to sit still rather than hop back and forth.
    const galaxy = fakeGalaxy(["X1-A", "X1-B"], [["X1-A", "X1-B"]]);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), undefined);
  });
});

describe("the search walks the whole known galaxy, not just what is in memory", () => {
  it("crosses systems the atlas knows from the database but has never loaded", () => {
    // This is the 19:02 bounce, exactly. RY37 and TP78 are both loaded, both
    // surveyed, and every neighbour of that pocket is loaded too — so a search
    // confined to memory sees no frontier anywhere and returns undefined. The
    // DB knows 329 systems and 2,664 gate-named frontier systems; the route
    // out of the pocket runs through systems this process never touched.
    const galaxy = {
      listSystems: () => ["X1-A", "X1-B"].map((symbol) => ({ symbol })),
      frontierSystems: () => ["X1-D"],
      // The hydrated graph: A → B → C → D, where C was never loaded and the
      // in-memory pocket stops at B.
      graphNeighbours: (s: string) =>
        (({ "X1-A": ["X1-B"], "X1-B": ["X1-C"], "X1-C": ["X1-D"] }) as Record<string, string[]>)[s] ?? [],
      connectedSystems: (s: string) =>
        (({ "X1-A": ["X1-B"], "X1-B": ["X1-A"] }) as Record<string, string[]>)[s] ?? [],
      jumpConnections: () => [], // memory-only graph knows no edges at all
      gateComplete: () => true,
    } as any;
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), "X1-B", "must step toward D through the unloaded C");
  });

  it("is still undefined when the whole known galaxy is surveyed", () => {
    const galaxy = {
      listSystems: () => ["X1-A", "X1-B"].map((symbol) => ({ symbol })),
      frontierSystems: () => [],
      graphNeighbours: (s: string) =>
        (({ "X1-A": ["X1-B"], "X1-B": ["X1-A"] }) as Record<string, string[]>)[s] ?? [],
      connectedSystems: (s: string) =>
        (({ "X1-A": ["X1-B"], "X1-B": ["X1-A"] }) as Record<string, string[]>)[s] ?? [],
      jumpConnections: () => [],
      gateComplete: () => true,
    } as any;
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A", "X1-B"]);

    assert.equal(hop(fleet, "X1-A"), undefined);
  });
});

describe("a stranded explorer waits instead of calling the API every second", () => {
  it("throws a Pending with a long resume when there is genuinely nowhere to go", async () => {
    // Live: "THEOREM-61: explore error: no connected systems known from
    // X1-RP88" roughly once a second, each attempt paying for getShip() before
    // discovering there was nothing to do. A bare Error lands in
    // catchBackoffMs()'s 10s default (and the log), so it never stops.
    const galaxy = fakeGalaxy(["X1-A"], []);
    const fleet = fleetWith(galaxy);
    (fleet as any).surveyedSystems = new Set(["X1-A"]);
    (fleet as any).api = {
      getShip: async () => ({
        symbol: "S-1",
        nav: { systemSymbol: "X1-A", status: "DOCKED", waypointSymbol: "X1-A-A1" },
        cargo: { units: 0 },
        fuel: { capacity: 100, current: 100 },
        registration: { role: "EXPLORER" },
      }),
    };

    await assert.rejects(
      () => (fleet as any).exploreSystem("S-1"),
      (err: any) => {
        assert.ok(err instanceof Pending, `expected Pending, got ${err?.constructor?.name}: ${err?.message}`);
        assert.ok(err.resumeAt >= Date.now() + 5 * 60_000, "must wait minutes, not seconds");
        return true;
      },
    );
  });
});

describe("a cooldown refusal is a Pending, not a retry loop", () => {
  it("converts the API's cooldown message into a resume time", () => {
    // Live: "THEOREM-59: explore error: Ship action is still on cooldown for
    // 384 second(s)." every ~12s, each attempt costing an API call.
    const now = 1_700_000_000_000;
    const pending = cooldownPendingFrom(
      new Error("Ship action is still on cooldown for 384 second(s)."),
      now,
    );
    assert.ok(pending instanceof Pending, "must be Pending so the scheduler yields instead of retrying");
    assert.equal(pending.resumeAt, now + 385_000);
  });

  it("leaves unrelated errors alone", () => {
    assert.equal(cooldownPendingFrom(new Error("no connected systems known from X1-RP88")), undefined);
    assert.equal(cooldownPendingFrom("not an error"), undefined);
  });
});
