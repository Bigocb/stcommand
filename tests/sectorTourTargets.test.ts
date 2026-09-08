import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * Four tour ships in the same system converged on the exact same next
 * target every tick, seen live in X1-S84: sectorTourTargets()'s "never
 * slice away this ship's own system" guard (added to fix a lone ship in a
 * remote system losing its only reachable market to another shuttle's
 * slice) meant *every* ship touring the same system saw the identical full
 * local market list. The round-robin split only ever differentiated other
 * systems' markets, which is moot when the whole tour fleet lives in one
 * system — so every ship independently sorted the same shared "most stale,
 * nearest" candidates and picked the same one, tick after tick, and just
 * kept re-agreeing on the same next stop instead of splitting up.
 */

function makeFleetWithGalaxy(systemWaypoints: Record<string, string[]>) {
  const fleet = new FleetManager({ api: {} as any });
  (fleet as any).galaxy = {
    listSystems: () => Object.keys(systemWaypoints).map((symbol) => ({ symbol })),
    getSystem: (sys: string) =>
      systemWaypoints[sys] === undefined
        ? undefined
        : { symbol: sys, waypoints: systemWaypoints[sys]!.map((symbol) => ({ symbol, traits: [{ symbol: "MARKETPLACE" }] })) },
  };
  return fleet;
}

function addTourShip(fleet: FleetManager, symbol: string, systemSymbol: string) {
  (fleet as any).tours.set(symbol, {
    getShip: () => ({ nav: { systemSymbol } }),
  });
}

describe("FleetManager.sectorTourTargets", () => {
  it("splits one system's own markets across the ships actually touring it", async () => {
    const fleet = makeFleetWithGalaxy({ "X1-S84": ["X1-S84-A1", "X1-S84-B2", "X1-S84-C3", "X1-S84-D4"] });
    addTourShip(fleet, "TOUR-1", "X1-S84");
    addTourShip(fleet, "TOUR-2", "X1-S84");

    const t1 = await (fleet as any).sectorTourTargets("TOUR-1");
    const t2 = await (fleet as any).sectorTourTargets("TOUR-2");

    assert.notDeepEqual(t1, t2, "two ships in the same system must not see the identical candidate list");
    // Full coverage: nothing left permanently untoured.
    assert.deepEqual(new Set([...t1, ...t2]), new Set(["X1-S84-A1", "X1-S84-B2", "X1-S84-C3", "X1-S84-D4"]));
    // No market assigned to both — the actual mechanism that let them
    // converge on the same target every tick.
    const overlap = t1.filter((w: string) => t2.includes(w));
    assert.deepEqual(overlap, []);
  });

  it("a lone ship in its system still gets every local market — the original fix this guards", async () => {
    const fleet = makeFleetWithGalaxy({
      "X1-S84": ["X1-S84-A1", "X1-S84-B2"],
      "X1-TP98": ["X1-TP98-Z9"],
    });
    addTourShip(fleet, "TOUR-1", "X1-S84");
    addTourShip(fleet, "TOUR-2", "X1-S84");
    addTourShip(fleet, "TOUR-3", "X1-TP98"); // alone in its system, same scenario the guard exists for

    const targets = await (fleet as any).sectorTourTargets("TOUR-3");
    assert.ok(targets.includes("X1-TP98-Z9"), "the system's only market must not be dealt to another shuttle's slice");
  });

  it("cross-system splitting is unchanged: a ship still gets its round-robin slice of other systems' markets", async () => {
    // Two ships, both alone in their own systems, so the local-system branch
    // (now different) never applies to either — only the untouched
    // cross-system `i % tourShips.length === idx` path is exercised, exactly
    // as before this fix.
    const fleet = makeFleetWithGalaxy({
      "X1-HOME": ["X1-HOME-A1"],
      "X1-OTHER": ["X1-OTHER-B1", "X1-OTHER-B2"],
    });
    addTourShip(fleet, "TOUR-1", "X1-HOME");
    addTourShip(fleet, "TOUR-2", "X1-ELSEWHERE"); // not in the galaxy stub — never touches X1-OTHER locally

    const before = await (fleet as any).sectorTourTargets("TOUR-1");
    // All of X1-HOME (this ship's own system) plus this ship's round-robin
    // slice of X1-OTHER, same formula as prior to this change.
    const all = ["X1-HOME-A1", "X1-OTHER-B1", "X1-OTHER-B2"]; // marketTourTargets() sorts its output
    const tourShips = ["TOUR-1", "TOUR-2"]; // Map insertion order, already sorted
    const idx = tourShips.indexOf("TOUR-1");
    const expectedCrossSystem = all.filter((w: string, i: number) => w.startsWith("X1-HOME") || i % tourShips.length === idx);
    assert.deepEqual(before, expectedCrossSystem);
  });
});
