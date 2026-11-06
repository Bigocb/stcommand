import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDLE_POLICY, boundLoadedBySystem, decideIdleParking, runsIdleParking, systemUse, useSince, type IdleFacts, type UseRow } from "../src/engine/idleSystems.js";

const H = 3_600_000;
const NOW = 100 * H;
const f = (system: string, ageH: number, sells: number, parked = false, buys = 0): IdleFacts => ({ system, releasedAt: NOW - ageH * H, sells, buys, parked });
const on = { hours: 6 };

describe("idle system parking (pure)", () => {
  it("off (hours 0, the default) parks nothing and unparks what was parked", () => {
    const d = decideIdleParking([f("X1-A", 20, 0), f("X1-B", 20, 0, true)], NOW, DEFAULT_IDLE_POLICY);
    assert.deepEqual(d.park, []);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-B"]);
  });
  it("parks only a system old enough with zero sells in the window", () => {
    const d = decideIdleParking([f("X1-OLD0", 7, 0), f("X1-OLD1", 7, 1), f("X1-NEW0", 3, 0)], NOW, on);
    assert.deepEqual(d.park.map((x) => x.system), ["X1-OLD0"]);
    assert.match(d.park[0]!.reason, /no sells or purchases in the last 6 h/);
  });
  it("does not park a system traders only buy from, and unparks one that gets bought from again", () => {
    const d = decideIdleParking([f("X1-SUPPLY", 9, 0, false, 4), f("X1-QUIET", 9, 0), f("X1-P", 9, 0, true, 2), f("X1-P2", 9, 0, true)], NOW, on);
    assert.deepEqual(d.park.map((x) => x.system), ["X1-QUIET"]);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-P"]);
    assert.match(d.unpark[0]!.reason, /2 purchase\(s\)/);
  });
  it("at three hours parks a system idle for three, not one idle for two", () => {
    const d = decideIdleParking([f("X1-A", 3.5, 0), f("X1-B", 2.5, 0)], NOW, { hours: 3 });
    assert.deepEqual(d.park.map((x) => x.system), ["X1-A"]);
  });
  it("unparks a parked system as soon as it sells, and leaves a still-idle one parked", () => {
    const d = decideIdleParking([f("X1-A", 9, 2, true), f("X1-B", 9, 0, true)], NOW, on);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-A"]);
    assert.deepEqual(d.park, []);
  });
  it("opens a system that has stayed parked for the window, even with no sells", () => {
    const d = decideIdleParking([{ ...f("X1-A", 20, 0, true), parkedAt: NOW - 7 * H }, { ...f("X1-B", 20, 0, true), parkedAt: NOW - 2 * H }], NOW, on);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-A"]);
    assert.match(d.unpark[0]!.reason, /re-check/);
  });
  it("does not park a system again until a window has passed since its re-check", () => {
    const d = decideIdleParking([{ ...f("X1-A", 20, 0), checkedAt: NOW - 2 * H }, { ...f("X1-B", 20, 0), checkedAt: NOW - 7 * H }], NOW, on);
    assert.deepEqual(d.park.map((x) => x.system), ["X1-B"]);
  });

  describe("short re-check (recheckMin)", () => {
    const r = { hours: 3, recheckMin: 45 };
    const checked = (minAgo: number, used: number, ageH = 20): IdleFacts => ({ ...f("X1-A", ageH, 0, false, 0), checkedAt: NOW - minAgo * 60_000, usedSinceCheck: used });
    it("parks a reopened system again after 45 minutes with nothing sold or bought since the reopen", () => {
      const d = decideIdleParking([checked(50, 0)], NOW, r);
      assert.deepEqual(d.park.map((x) => x.system), ["X1-A"]);
      assert.match(d.park[0]!.reason, /re-check: reopened 50 min ago/);
    });
    it("leaves it open before 45 minutes, and when anything was sold or bought since the reopen", () => {
      assert.deepEqual(decideIdleParking([checked(30, 0)], NOW, r).park, []);
      assert.deepEqual(decideIdleParking([checked(50, 2)], NOW, r).park, []);
    });
    it("after a re-check that found trading, falls back to the whole-window rule", () => {
      assert.deepEqual(decideIdleParking([checked(100, 3)], NOW, r).park, []);
      const later = { ...checked(4 * 60, 3), sells: 0, buys: 0 };
      assert.deepEqual(decideIdleParking([later], NOW, r).park.map((x) => x.system), ["X1-A"]);
    });
    it("with recheckMin 0 or unset it is the single-window behaviour of before", () => {
      for (const p of [{ hours: 3 }, { hours: 3, recheckMin: 0 }]) {
        assert.deepEqual(decideIdleParking([checked(50, 0)], NOW, p).park, []);
        assert.deepEqual(decideIdleParking([checked(4 * 60, 0)], NOW, p).park.map((x) => x.system), ["X1-A"]);
      }
    });
    it("never parks a system younger than the park window", () => {
      assert.deepEqual(decideIdleParking([checked(50, 0, 2)], NOW, r).park, []);
    });
  });

  it("runs whenever the fresh-system gate is on, advisory included, and only stops when the gate is off", () => {
    assert.equal(runsIdleParking("advisory"), true);
    assert.equal(runsIdleParking("auto"), true);
    assert.equal(runsIdleParking("off"), false);
  });

  describe("profit mode (minHourlyProfit)", () => {
    const m = { hours: 3, minHourlyProfit: 50_000 };
    const pf = (system: string, hourly: number[] | undefined, over: Partial<IdleFacts> = {}): IdleFacts => ({ ...f(system, 20, 5, false, 5), hourly, ...over });
    it("parks a system whose every hour is under the bar even though it still sells and buys a little", () => {
      const d = decideIdleParking([pf("X1-SMALL", [20_000, 10_000, 40_000])], NOW, m);
      assert.deepEqual(d.park.map((x) => x.system), ["X1-SMALL"]);
      assert.match(d.park[0]!.reason, /no hour above 50,000 profit in the last 3 h \(best 40,000\)/);
    });
    it("keeps a system polled when any one hour reaches the bar", () => {
      assert.deepEqual(decideIdleParking([pf("X1-A", [0, 0, 50_000]), pf("X1-B", [120_000, 0, 0])], NOW, m).park, []);
    });
    it("treats a missing profit figure as in use, so nothing is parked on a failed read", () => {
      assert.deepEqual(decideIdleParking([pf("X1-A", undefined)], NOW, m).park, []);
    });
    it("unparks a parked system once an hour reaches the bar, and not for small trades", () => {
      const d = decideIdleParking([pf("X1-BACK", [60_000, 0, 0], { parked: true }), pf("X1-SMALL", [5_000, 0, 0], { parked: true })], NOW, m);
      assert.deepEqual(d.unpark.map((x) => x.system), ["X1-BACK"]);
      assert.match(d.unpark[0]!.reason, /an hour with 60,000 profit/);
    });
    it("a short re-check is judged on profit pro rata: 50 minutes with 20,000 is under the 41,667 bar, 60,000 is over", () => {
      const r = { ...m, recheckMin: 45 };
      const at = (profit: number): IdleFacts => ({ ...pf("X1-A", [10_000, 0, 0]), checkedAt: NOW - 50 * 60_000, profitSinceCheck: profit });
      assert.deepEqual(decideIdleParking([at(20_000)], NOW, r).park.map((x) => x.system), ["X1-A"]);
      assert.deepEqual(decideIdleParking([at(60_000)], NOW, r).park, []);
    });
    it("minHourlyProfit 0 or unset is the count mode of before", () => {
      assert.deepEqual(decideIdleParking([{ ...f("X1-A", 20, 3, false, 0), hourly: [0, 0, 0] }], NOW, { hours: 3, minHourlyProfit: 0 }).park, []);
    });
  });

  describe("systemUse / useSince", () => {
    const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
    const rows: UseRow[] = [
      { timestamp: iso(10), type: "SELL", waypoint: "X1-BUY-A1", realizedPnl: 80_000, route: "X1-SRC-B2>X1-BUY-A1 auto" },
      { timestamp: iso(70), type: "SELL", waypoint: "X1-BUY-A1", realizedPnl: 30_000, route: "X1-BUY-C3>X1-BUY-A1 auto" },
      { timestamp: iso(130), type: "SELL", waypoint: "X1-OTH-A1", realizedPnl: 5_000, route: null },
      { timestamp: iso(20), type: "PURCHASE", waypoint: "X1-SRC-B2", realizedPnl: null, route: null },
      { timestamp: iso(400), type: "SELL", waypoint: "X1-BUY-A1", realizedPnl: 999_999, route: "X1-SRC-B2>X1-BUY-A1 auto" },
    ];
    it("credits a sale's profit to the system it sold in and the system its trip started in, by hour, inside the window only", () => {
      const u = systemUse(rows, NOW, 3);
      assert.deepEqual(u.get("X1-BUY")!.hourly, [80_000, 30_000, 0]);
      assert.deepEqual(u.get("X1-SRC")!.hourly, [80_000, 0, 0]);
      assert.deepEqual(u.get("X1-OTH")!.hourly, [0, 0, 5_000]);
      assert.equal(u.get("X1-BUY")!.sells, 2);
      assert.equal(u.get("X1-SRC")!.buys, 1);
    });
    it("counts events and profit involving one system since a time", () => {
      assert.deepEqual(useSince(rows, "X1-SRC", NOW - 60 * 60_000), { events: 1, profit: 80_000 });
      assert.deepEqual(useSince(rows, "X1-BUY", NOW - 60 * 60_000), { events: 1, profit: 80_000 });
    });
  });

  describe("parked systems are judged since they were parked", () => {
    const m = { hours: 3, minHourlyProfit: 50_000 };
    const parked = (over: Partial<IdleFacts>): IdleFacts => ({ ...f("X1-P", 20, 0, true, 0), parkedAt: NOW - 20 * 60_000, hourly: [0, 116_000, 0], ...over });
    it("does not unpark on profit from before it was parked, which the 3-hour window still holds", () => {
      const d = decideIdleParking([parked({ parkedUse: { events: 0, profit: 0 } })], NOW, m);
      assert.deepEqual(d.unpark, []);
    });
    it("unparks when it earns the bar since it was parked", () => {
      const d = decideIdleParking([parked({ parkedUse: { events: 3, profit: 60_000 } })], NOW, m);
      assert.deepEqual(d.unpark.map((x) => x.system), ["X1-P"]);
      assert.match(d.unpark[0]!.reason, /60,000 profit since it was parked/);
    });
    it("count mode: any trade since it was parked unparks, none does not", () => {
      const c = { hours: 3 };
      assert.deepEqual(decideIdleParking([parked({ hourly: undefined, parkedUse: { events: 0, profit: 0 }, sells: 4 })], NOW, c).unpark, []);
      assert.deepEqual(decideIdleParking([parked({ hourly: undefined, parkedUse: { events: 2, profit: 0 }, sells: 4 })], NOW, c).unpark.map((x) => x.system), ["X1-P"]);
    });
    it("without a since-parked figure the whole-window reading applies, as before", () => {
      const d = decideIdleParking([parked({ parkedUse: undefined })], NOW, m);
      assert.deepEqual(d.unpark.map((x) => x.system), ["X1-P"]);
    });
  });
  describe("a loaded ship bound for a system holds its keepers polling (holdBound)", () => {
    const m = { hours: 3, minHourlyProfit: 20_000, holdBound: true };
    const quiet = (over: Partial<IdleFacts> = {}): IdleFacts => ({ ...f("X1-TN50", 20, 3), hourly: [0, 0, 0], ...over });
    it("off (the default) reproduces today: a quiet system with a bound ship is still parked", () => {
      const d = decideIdleParking([quiet({ boundLoaded: 1 })], NOW, { hours: 3, minHourlyProfit: 20_000 });
      assert.deepEqual(d.park.map((x) => x.system), ["X1-TN50"]);
    });
    it("on: does not park a quiet system while a loaded ship is bound for it, and parks it once none is", () => {
      assert.deepEqual(decideIdleParking([quiet({ boundLoaded: 1 })], NOW, m).park, []);
      assert.deepEqual(decideIdleParking([quiet({ boundLoaded: 0 })], NOW, m).park.map((x) => x.system), ["X1-TN50"]);
    });
    it("on: does not re-check park a reopened system with a bound ship", () => {
      const re = quiet({ checkedAt: NOW - 60 * 60_000, profitSinceCheck: 0, boundLoaded: 2 });
      assert.deepEqual(decideIdleParking([re], NOW, { ...m, recheckMin: 45 }).park, []);
      assert.deepEqual(decideIdleParking([{ ...re, boundLoaded: 0 }], NOW, { ...m, recheckMin: 45 }).park.map((x) => x.system), ["X1-TN50"]);
    });
    it("on: unparks a parked system a loaded ship is bound for, with the reason", () => {
      const d = decideIdleParking([{ ...quiet({ boundLoaded: 1 }), parked: true, parkedAt: NOW - 20 * 60_000, parkedUse: { events: 0, profit: 0 } }], NOW, m);
      assert.deepEqual(d.unpark.map((x) => x.system), ["X1-TN50"]);
      assert.match(d.unpark[0]!.reason, /1 loaded ship\(s\) bound for it/);
    });
  });

  describe("boundLoadedBySystem", () => {
    it("counts loaded ships by the system of their sell market, ignoring empty holds and ships without a route", () => {
      const m = boundLoadedBySystem([
        { loaded: true, sellAt: "X1-TN50-A1" }, { loaded: true, sellAt: "X1-TN50-J67" }, { loaded: false, sellAt: "X1-TN50-A1" },
        { loaded: true, sellAt: undefined }, { loaded: true, sellAt: "X1-SR93-A1" },
      ]);
      assert.equal(m.get("X1-TN50"), 2);
      assert.equal(m.get("X1-SR93"), 1);
      assert.equal(m.size, 2);
    });
  });
});
