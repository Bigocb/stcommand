import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWaypointPage, summarizeUncharted, systemsToRead, type SystemChartState } from "../src/engine/chartCheck.js";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-03T22:00:00Z");
const state = (uncharted: number, agoMs: number): SystemChartState => ({ uncharted, checkedAtMs: now - agoMs });

describe("systemsToRead", () => {
  it("reads a never-read system first, the systems we are in before the rest", () => {
    const out = systemsToRead(["X1-C", "X1-A", "X1-B"], ["X1-B", "X1-A"], new Map(), now);
    assert.deepEqual(out, ["X1-B", "X1-A", "X1-C"]);
  });
  it("never rereads a system whose last read found nothing uncharted", () => {
    const known = new Map([["X1-A", state(0, 100 * HOUR)]]);
    assert.deepEqual(systemsToRead(["X1-A", "X1-B"], [], known, now), ["X1-B"]);
  });
  it("rereads a system with uncharted waypoints only once its read is older than the recheck time", () => {
    const known = new Map([["X1-A", state(3, 30 * 60_000)], ["X1-B", state(2, 2 * HOUR)]]);
    assert.deepEqual(systemsToRead(["X1-A", "X1-B"], [], known, now), ["X1-B"]);
  });
  it("puts never-read systems ahead of stale ones, and the oldest stale first within a group", () => {
    const known = new Map([["X1-A", state(1, 5 * HOUR)], ["X1-B", state(1, 9 * HOUR)]]);
    assert.deepEqual(systemsToRead(["X1-A", "X1-B", "X1-N"], [], known, now), ["X1-N", "X1-B", "X1-A"]);
  });
  it("lists a system once however often it appears", () => {
    assert.deepEqual(systemsToRead(["X1-A", "X1-A"], ["X1-A", "X1-A"], new Map(), now), ["X1-A"]);
  });
});

describe("parseWaypointPage", () => {
  it("marks a waypoint uncharted when its only trait is UNCHARTED", () => {
    const page = parseWaypointPage({
      data: [
        { symbol: "X1-A-1", type: "PLANET", traits: [{ symbol: "UNCHARTED" }] },
        { symbol: "X1-A-2", type: "ASTEROID", traits: [{ symbol: "COMMON_METAL_DEPOSITS" }] },
        { symbol: "X1-A-3", type: "GAS_GIANT" },
      ],
      meta: { total: 45, page: 1, limit: 20 },
    })!;
    assert.deepEqual(page.rows.map((r) => [r.symbol, r.uncharted]), [["X1-A-1", true], ["X1-A-2", false], ["X1-A-3", false]]);
    assert.equal(page.total, 45);
  });
  it("answers undefined for a reply that is not a waypoint list", () => {
    assert.equal(parseWaypointPage({ error: { message: "nope" } }), undefined);
    assert.equal(parseWaypointPage({ data: [{ type: "PLANET" }] }), undefined);
    assert.equal(parseWaypointPage(undefined), undefined);
  });
  it("falls back to the rows read when the reply carries no total", () => {
    assert.equal(parseWaypointPage({ data: [{ symbol: "X1-A-1", type: "PLANET", traits: [] }] })!.total, 1);
  });
});

describe("summarizeUncharted", () => {
  const at = "2026-11-03T21:30:00Z";
  const rows = [
    { waypointSymbol: "X1-B-1", systemSymbol: "X1-B", type: "PLANET", checkedAt: at },
    { waypointSymbol: "X1-A-1", systemSymbol: "X1-A", type: "MOON", checkedAt: at },
    { waypointSymbol: "X1-A-2", systemSymbol: "X1-A", type: "ASTEROID", checkedAt: at },
    { waypointSymbol: "X1-C-1", systemSymbol: "X1-C", type: "PLANET", checkedAt: at },
  ];
  it("groups by system, the systems we are in first, then the most uncharted", () => {
    const out = summarizeUncharted(rows, new Map([["X1-B", 0], ["X1-A", 1]]), now);
    assert.deepEqual(out.map((s) => [s.system, s.tier, s.uncharted]), [["X1-B", 0, 1], ["X1-A", 1, 2], ["X1-C", 9, 1]]);
    assert.deepEqual(out[1]!.waypoints.map((w) => w.waypoint), ["X1-A-1", "X1-A-2"]);
  });
  it("says how long ago it was read", () => {
    assert.equal(summarizeUncharted(rows, new Map(), now)[0]!.ageMinutes, 30);
  });
});
