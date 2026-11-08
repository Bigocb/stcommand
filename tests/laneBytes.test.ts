import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ByteLedger, billingPeriod, periodReport, planFromEnv, type LaneByteRow } from "../src/engine/laneBytes.js";
import { ApiCallLog } from "../src/core/apiCallLog.js";

const T = (s: string): number => Date.parse(s);

describe("ByteLedger", () => {
  it("adds bytes and calls by UTC day, lane and call kind, and drain clears it", () => {
    const l = new ByteLedger();
    l.record(T("2026-11-08T23:59:59Z"), "a:1", "market", 5000);
    l.record(T("2026-11-08T12:00:00Z"), "a:1", "market", 7000);
    l.record(T("2026-11-09T00:00:01Z"), "a:1", "market", 1000);
    l.record(T("2026-11-08T12:00:00Z"), "box", "navigate", 300);
    const rows = l.drain();
    const by = Object.fromEntries(rows.map((r) => [`${r.day}|${r.label}|${r.kind}`, r]));
    assert.deepEqual(by["2026-11-08|a:1|market"], { day: "2026-11-08", label: "a:1", kind: "market", calls: 2, bytes: 12000 });
    assert.equal(by["2026-11-09|a:1|market"]!.bytes, 1000);
    assert.equal(by["2026-11-08|box|navigate"]!.calls, 1);
    assert.deepEqual(l.drain(), [], "drained");
  });
  it("a failed write is put back and merged with what was counted since, so nothing is lost", () => {
    const l = new ByteLedger();
    l.record(T("2026-11-08T12:00:00Z"), "a:1", "market", 4000);
    const rows = l.drain();
    l.record(T("2026-11-08T12:00:30Z"), "a:1", "market", 6000);
    l.restore(rows);
    assert.deepEqual(l.drain(), [{ day: "2026-11-08", label: "a:1", kind: "market", calls: 2, bytes: 10000 }]);
  });
  it("peek shows what is waiting without clearing it; bad sizes are ignored", () => {
    const l = new ByteLedger();
    l.record(T("2026-11-08T12:00:00Z"), "a:1", "market", 4000);
    l.record(T("2026-11-08T12:00:00Z"), "a:1", "market", NaN);
    l.record(T("2026-11-08T12:00:00Z"), "a:1", "market", -5);
    assert.equal(l.peek()[0]!.bytes, 4000);
    assert.equal(l.peek().length, 1);
    assert.equal(l.drain()[0]!.calls, 1);
  });
  it("ApiCallLog.recordBytes feeds it under the proxy's label, or the lane name without one", () => {
    const log = new ApiCallLog();
    log.recordBytes({ at: T("2026-11-08T12:00:00Z"), role: "keeper", kind: "market", lane: "proxy", label: "h.example:1", bytes: 5000 });
    log.recordBytes({ at: T("2026-11-08T12:00:00Z"), role: "trader", kind: "navigate", bytes: 300 });
    const rows = log.pendingBytes();
    assert.deepEqual(rows.map((r) => r.label).sort(), ["box", "h.example:1"]);
    assert.equal(log.drainBytes().length, 2);
    assert.equal(log.pendingBytes().length, 0);
  });
});

describe("billingPeriod", () => {
  it("a plan renewing on the 8th: the period holding 'now' runs from the 8th to the next 8th", () => {
    const p = billingPeriod(T("2026-11-08T03:00:00Z"), 8);
    assert.equal(p.start.toISOString(), "2026-11-08T00:00:00.000Z");
    assert.equal(p.end.toISOString(), "2026-12-08T00:00:00.000Z");
  });
  it("before the reset day it is still last month's period; the year turns over correctly", () => {
    const p = billingPeriod(T("2026-11-07T23:59:00Z"), 8);
    assert.deepEqual([p.start.toISOString(), p.end.toISOString()], ["2026-10-08T00:00:00.000Z", "2026-11-08T00:00:00.000Z"]);
    const q = billingPeriod(T("2026-01-03T00:00:00Z"), 8);
    assert.deepEqual([q.start.toISOString(), q.end.toISOString()], ["2025-12-08T00:00:00.000Z", "2026-01-08T00:00:00.000Z"]);
    const r = billingPeriod(T("2026-12-20T00:00:00Z"), 8);
    assert.equal(r.end.toISOString(), "2027-01-08T00:00:00.000Z");
  });
  it("a reset day after the month's end is clamped (the 31st in February is the 28th)", () => {
    const p = billingPeriod(T("2026-02-15T00:00:00Z"), 31);
    assert.deepEqual([p.start.toISOString(), p.end.toISOString()], ["2026-01-31T00:00:00.000Z", "2026-02-28T00:00:00.000Z"]);
  });
});

describe("periodReport", () => {
  const period = billingPeriod(T("2026-11-18T00:00:00Z"), 8); // 10 of 30 days gone
  const rows: LaneByteRow[] = [
    { day: "2026-11-09", label: "a:1", kind: "market", calls: 1000, bytes: 5_000_000_000 },
    { day: "2026-11-09", label: "a:1", kind: "ships", calls: 100, bytes: 3_000_000_000 },
    { day: "2026-11-10", label: "b:2", kind: "market", calls: 500, bytes: 2_000_000_000 },
    { day: "2026-11-10", label: "box", kind: "navigate", calls: 9000, bytes: 1_000_000_000 },
    { day: "2026-10-30", label: "a:1", kind: "market", calls: 1, bytes: 99_000_000_000 }, // last period: ignored
  ];
  it("sums the proxies' bytes for the period, projects the month at the average so far, and shows the share of the plan", () => {
    const r = periodReport(rows, period, T("2026-11-18T00:00:00Z"), 256);
    assert.equal(r.usedGB, 10);
    assert.equal(r.daysElapsed, 10);
    assert.equal(r.daysInPeriod, 30);
    assert.equal(r.projectedGB, 30);
    assert.equal(r.usedShare, 0.039);
    assert.equal(r.projectedShare, 0.117);
  });
  it("the box's own bytes are listed but kept out of the plan figures; other periods are ignored", () => {
    const r = periodReport(rows, period, T("2026-11-18T00:00:00Z"), 256);
    assert.deepEqual(r.byLabel.map((l) => l.label), ["a:1", "b:2", "box"]);
    assert.equal(r.byLabel.find((l) => l.label === "box")!.gb, 1);
    assert.deepEqual(r.byDay, [{ day: "2026-11-09", proxyGB: 8, boxGB: 0 }, { day: "2026-11-10", proxyGB: 2, boxGB: 1 }]);
    assert.equal(r.byKind.find((k) => k.kind === "ships")!.avgBytes, 30_000_000);
  });
  it("almost none of the period gone: no projection rather than a wild one", () => {
    const early = periodReport([{ day: "2026-11-08", label: "a:1", kind: "market", calls: 10, bytes: 50_000 }], billingPeriod(T("2026-11-08T00:30:00Z"), 8), T("2026-11-08T00:30:00Z"), 256);
    assert.equal(early.projectedGB, 0);
  });
});

describe("planFromEnv", () => {
  it("defaults to 250 GB renewing on the 7th; takes sane overrides and ignores nonsense", () => {
    assert.deepEqual(planFromEnv({}), { planGB: 250, resetDay: 7 });
    assert.deepEqual(planFromEnv({ API_LANE_PLAN_GB: "512", API_LANE_PLAN_RESET_DAY: "15" }), { planGB: 512, resetDay: 15 });
    assert.deepEqual(planFromEnv({ API_LANE_PLAN_GB: "-3", API_LANE_PLAN_RESET_DAY: "40" }), { planGB: 250, resetDay: 7 });
  });
});
