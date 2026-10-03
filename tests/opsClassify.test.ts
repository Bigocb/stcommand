import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyShips, keeperReport, hopsWithin } from "../src/ops/classify.js";
import { LogBuffer } from "../src/core/logBuffer.js";

const ship = (o: any = {}) => ({ symbol: "S1", role: "trader", waypoint: "X1-A-1", nav: "DOCKED", fuel: 100, fuelCap: 100, ...o });

describe("classifyShips", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");

  it("flags stranded as critical and sorts it first", () => {
    const f = classifyShips([ship({ symbol: "A" }), ship({ symbol: "B", fuel: 0, nav: "IN_ORBIT" })], [], new Set(["A"]), now);
    assert.equal(f[0]!.ship, "A");
    assert.equal(f[0]!.kind, "stranded");
    assert.equal(f.find((x) => x.ship === "B")!.kind, "out_of_fuel");
  });

  it("does not double-report a stranded ship as out of fuel, and exempts zero-tank keepers", () => {
    const f = classifyShips([ship({ symbol: "A", fuel: 0 }), ship({ symbol: "K", role: "keeper", fuel: 0, fuelCap: 0 })], [], new Set(["A"]), now);
    assert.deepEqual(f.map((x) => x.kind), ["stranded"]);
  });

  it("reports an agent snapshot that trails the polled state", () => {
    const f = classifyShips(
      [ship({ symbol: "T", nav: "IN_TRANSIT", waypoint: "X1-A-OLD" })],
      [{ symbol: "T", nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-NEW" }, fuel: { current: 50, capacity: 100 } }],
      new Set(), now,
    );
    assert.equal(f.length, 1);
    assert.equal(f[0]!.kind, "agent_behind");
    assert.match(f[0]!.detail, /X1-A-NEW/);
  });

  it("flags a transit whose arrival has long passed", () => {
    const f = classifyShips(
      [ship({ symbol: "T", nav: "IN_TRANSIT" })],
      [{ symbol: "T", nav: { status: "IN_TRANSIT", route: { arrival: "2026-10-03T11:55:00Z" } }, fuel: { current: 90, capacity: 100 } }],
      new Set(), now,
    );
    assert.equal(f[0]!.kind, "transit_overdue");
  });

  it("warns on low fuel but only info-level noise for a healthy ship", () => {
    assert.equal(classifyShips([ship({ fuel: 5 })], [], new Set(), now)[0]!.kind, "low_fuel");
    assert.deepEqual(classifyShips([ship({})], [], new Set(), now), []);
  });
});

describe("keeperReport", () => {
  const at = (symbol: string, waypointSymbol: string, status = "IN_ORBIT") => ({ symbol, nav: { status, waypointSymbol } });

  it("covered only once a pinned keeper is at the market and not in transit", () => {
    const r = keeperReport(
      [{ shipSymbol: "K1", market: "M1" }, { shipSymbol: "K2", market: "M2" }],
      [at("K1", "M1"), at("K2", "M2", "IN_TRANSIT")],
      ["M1", "M2", "M3"],
    );
    const by = Object.fromEntries(r.markets.map((m) => [m.market, m.status]));
    assert.deepEqual(by, { M1: "covered", M2: "enroute", M3: "pending" });
    assert.deepEqual(r.uncoveredPriority, ["M3"]);
  });

  it("surfaces duplicate keepers on one market", () => {
    const r = keeperReport([{ shipSymbol: "K1", market: "M1" }, { shipSymbol: "K2", market: "M1" }], [at("K1", "M1"), at("K2", "M1")], []);
    assert.deepEqual(r.duplicates, ["M1"]);
  });

  it("treats a pin on a ship missing from state as arrived rather than falsely pending", () => {
    assert.equal(keeperReport([{ shipSymbol: "GHOST", market: "M1" }], [], []).markets[0]!.status, "covered");
  });
});

describe("hopsWithin", () => {
  it("returns hop counts up to the limit", () => {
    const adj = new Map([["A", ["B"]], ["B", ["A", "C"]], ["C", ["B", "D"]], ["D", ["C"]]]);
    const d = hopsWithin(adj, "A", 2);
    assert.deepEqual([...d.entries()], [["A", 0], ["B", 1], ["C", 2]]);
  });
});

describe("LogBuffer", () => {
  it("filters by ship as a whole token, hides fleet/keeper noise by default, and is bounded", () => {
    let t = 1000;
    const b = new LogBuffer(5, () => t++);
    b.push("T1", "THEO-1: jumping");
    b.push("T1", "THEO-1A: other ship");
    b.push("T1", "fleet: THEO-1(tour)@X ...");
    b.push("T1", "THEO-2: keeper: snapshot X (0/0 fuel)");
    b.push("T2", "THEO-1: someone else's tenant");
    assert.deepEqual(b.query({ tenantId: "T1", ship: "THEO-1" }).map((l) => l.msg), ["THEO-1: jumping"]);
    assert.equal(b.query({ tenantId: "T1", noise: true }).length, 4);
    b.push("T1", "x"); b.push("T1", "y"); b.push("T1", "z");
    assert.equal(b.size(), 5, "ring buffer drops the oldest beyond capacity");
  });

  it("includes tenant-less global lines and honours the time window", () => {
    let t = 0;
    const b = new LogBuffer(10, () => t);
    t = 100; b.push("?", "rate limited");
    t = 5000; b.push("T1", "recent");
    assert.deepEqual(b.query({ tenantId: "T1", sinceMs: 1000 }).map((l) => l.msg), ["recent"]);
    assert.deepEqual(b.query({ tenantId: "T1" }).map((l) => l.msg), ["rate limited", "recent"]);
  });
});
