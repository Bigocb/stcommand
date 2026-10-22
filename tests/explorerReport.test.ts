import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExplorerReport, verdictOf } from "../src/engine/explorerReport.js";

const ship = { symbol: "E-1", waypoint: "X1-B-G1", nav: "DOCKED", fuel: 150, fuelCap: 300, cooldown: 0, doing: "docked" };
const base = {
  nowIso: "2026-10-22T12:00:00.000Z", windowHours: 72,
  explorers: [ship],
  jumps: [
    { at: "2026-10-22T10:00:00Z", ship: "E-1", from: "X1-A-G1", to: "X1-B-G1", cost: 5000 },
    { at: "2026-10-22T09:00:00Z", ship: "E-1", from: "X1-B-G2", to: "X1-A-G1", cost: 5200 },
    { at: "2026-10-22T08:00:00Z", ship: "E-1", from: "X1-A-G9", to: "X1-A-G1", cost: 5100 },
    { at: "2026-10-22T07:00:00Z", ship: "OTHER", from: "X1-Q-G1", to: "X1-R-G1", cost: 9999 },
  ],
  surveys: [
    { system: "X1-A", at: "2026-10-22T09:05:00Z", markets: 8, shipyards: 2, source: "explore" },
    { system: "X1-B", at: "2026-10-22T10:05:00Z", markets: 2, shipyards: 0, source: "rejected" },
    { system: "X1-OLD", at: "2026-10-20T00:00:00Z", markets: 5, shipyards: 1, source: "backfill" },
  ],
  stations: [{ ship: "K-1", market: "X1-A-M1" }, { ship: "K-2", market: "X1-A-M2" }],
  purchases: [
    { at: "2026-10-22T09:10:00Z", ship: "K-1", yard: "X1-A-Y1", hull: "SHIP_PROBE", price: 28_959 },
    { at: "2026-10-22T09:12:00Z", ship: "K-2", yard: "X1-A-Y1", hull: "SHIP_PROBE", price: 29_000 },
    { at: "2026-10-22T09:00:00Z", ship: "TRADER-9", yard: "X1-A-Y1", hull: "SHIP_LIGHT_HAULER", price: 300_000 },
  ],
};

describe("buildExplorerReport", () => {
  const r = buildExplorerReport(base);

  it("maps survey sources to verdicts", () => {
    assert.equal(verdictOf("rejected"), "rejected");
    assert.equal(verdictOf("backfill"), "atlas");
    assert.equal(verdictOf("explore"), "surveyed");
  });

  it("reports each explorer: where it is, its fuel and what it has spent on jumps (its own jumps only)", () => {
    const e = r.explorers[0]!;
    assert.equal(e.system, "X1-B");
    assert.equal(e.fuelPct, 50);
    assert.equal(e.jumps, 3);
    assert.equal(e.jumpSpend, 15_300);
  });

  it("lists visited systems newest first, collapsing consecutive repeats, with the survey verdict", () => {
    assert.deepEqual(r.explorers[0]!.visited.map((v) => [v.system, v.verdict]), [["X1-B", "rejected"], ["X1-A", "surveyed"]]);
  });

  it("counts only purchases of ships now stationed as keepers, with where they stand and what they cost", () => {
    assert.deepEqual(r.keepers.map((k) => [k.ship, k.market, k.system]), [["K-2", "X1-A-M2", "X1-A"], ["K-1", "X1-A-M1", "X1-A"]]);
    assert.equal(r.totals.keepersBought, 2);
    assert.equal(r.totals.keeperSpend, 57_959);
  });

  it("lists systems newest first with verdicts and per-system keeper counts", () => {
    assert.deepEqual(r.systems.map((s) => [s.system, s.verdict, s.keepersStationed, s.keepersBought]), [
      ["X1-B", "rejected", 0, 0], ["X1-A", "surveyed", 2, 2], ["X1-OLD", "atlas", 0, 0],
    ]);
    assert.equal(r.totals.systemsSurveyed, 1);
    assert.equal(r.totals.systemsRejected, 1);
  });

  it("keeps an interrupted tour on the explorer and handles a ship with no jumps or no tank", () => {
    const q = buildExplorerReport({ ...base, jumps: [], explorers: [{ ...ship, fuelCap: 0, tour: { system: "X1-B", stopsLeft: 4 } }] });
    assert.deepEqual(q.explorers[0]!.tour, { system: "X1-B", stopsLeft: 4 });
    assert.equal(q.explorers[0]!.fuelPct, 0);
    assert.deepEqual(q.explorers[0]!.visited, []);
  });

  it("limits the lists but not the totals", () => {
    const q = buildExplorerReport({ ...base, listLimit: 1 });
    assert.equal(q.systems.length, 1);
    assert.equal(q.keepers.length, 1);
    assert.equal(q.totals.keepersBought, 2);
  });
});
