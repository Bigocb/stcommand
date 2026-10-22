import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCoverage, buildExplorerReport, verdictOf } from "../src/engine/explorerReport.js";

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

describe("buildCoverage", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-10-22T12:00:00Z");
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();

  it("counts systems from their first trade, and those traded in within 24 hours", () => {
    const c = buildCoverage({
      nowMs: now,
      trades: [
        { system: "X1-A", firstAt: at(100), lastAt: at(1) },
        { system: "X1-B", firstAt: at(50), lastAt: at(30) },
        { system: "X1-C", firstAt: at(2), lastAt: at(1) },
      ],
      keeperSystems: [],
    });
    assert.equal(c.trading, 3);
    assert.equal(c.tradingLast24h, 2, "B was last traded 30h ago");
    assert.equal(c.series.at(-1)!.trading, 3, "the last point is now");
    assert.equal(c.series[0]!.trading <= c.series.at(-1)!.trading, true);
  });

  it("the series only ever grows, with at most maxPoints points ending now", () => {
    const trades = Array.from({ length: 20 }, (_, k) => ({ system: `X1-S${k}`, firstAt: at(200 - k * 9), lastAt: at(1) }));
    const c = buildCoverage({ nowMs: now, trades, keeperSystems: [], maxPoints: 10 });
    assert.ok(c.series.length <= 10);
    assert.equal(c.series.at(-1)!.at, new Date(now).toISOString());
    for (let k = 1; k < c.series.length; k++) assert.ok(c.series[k]!.trading >= c.series[k - 1]!.trading);
    assert.equal(c.series.at(-1)!.trading, 20);
  });

  it("counts a keeper system once, from its earliest keeper; a keeper with no purchase row counts from the start", () => {
    const c = buildCoverage({
      nowMs: now,
      trades: [{ system: "X1-A", firstAt: at(100), lastAt: at(1) }],
      keeperSystems: [{ system: "X1-A", at: at(10) }, { system: "X1-A", at: at(5) }, { system: "X1-OLD" }],
    });
    assert.equal(c.keepers, 2);
    assert.equal(c.series[0]!.keepers, 1, "X1-OLD has no purchase row, so it is there from the start");
    assert.equal(c.series.at(-1)!.keepers, 2);
  });

  it("is empty-safe", () => {
    const c = buildCoverage({ nowMs: now, trades: [], keeperSystems: [] });
    assert.deepEqual([c.trading, c.keepers, c.tradingLast24h], [0, 0, 0]);
    assert.equal(c.series.length, 1);
  });

  it("buildExplorerReport carries it, and its keeper list stays the window's while coverage uses every purchase", () => {
    const r = buildExplorerReport({ ...base, windowHours: 1, trades: [{ system: "X1-A", firstAt: "2026-10-20T00:00:00Z", lastAt: "2026-10-22T11:00:00Z" }], purchases: [
      { at: "2026-10-22T11:30:00Z", ship: "K-1", yard: "X1-A-Y1", hull: "SHIP_PROBE", price: 1 },
      { at: "2026-10-21T00:00:00Z", ship: "K-2", yard: "X1-A-Y1", hull: "SHIP_PROBE", price: 1 },
    ] });
    assert.equal(r.keepers.length, 1, "only the purchase inside the 1h window is listed");
    assert.equal(r.coverage.keepers, 1, "both keepers stand in X1-A: one system");
    assert.equal(r.coverage.trading, 1);
  });
});
