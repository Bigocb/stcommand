import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActionEventRow, AnalysisLedgerRow } from "../src/db/store.js";
import { DEFAULT_FRESHNESS_POLICY, buildFreshness, coverageFromEvents, freshnessFindings, livePremium, systemOf } from "../src/engine/analysis/freshness.js";
import { buildAnalysisReport } from "../src/engine/analysis/report.js";

const H = 3_600_000;
const T0 = Date.parse("2026-10-23T11:40:16Z"); // X1-YB39 joined the keeper list (CHANGELOG / analysis, 2026-10-23)

const keeperChange = (atMs: number, added: string[]): ActionEventRow => ({
  at: new Date(atMs).toISOString(), universeKey: "THEOREM@2026-10-18", kind: "config_change", actor: "operator", subject: "keeper_markets",
  context: { before: { count: 500 }, after: { added, count: 500 + added.length, removed: [] } },
});

/** n sells of 50 units at `perUnit` profit, `afterH` hours after T0, spread over a few minutes. */
const sells = (wp: string, afterH: number, n: number, perUnit: number, ship = "S-1"): AnalysisLedgerRow[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(T0 + afterH * H + i * 60_000).toISOString(), shipSymbol: ship, type: "SELL", good: "FOOD", waypoint: wp,
    units: 50, pricePerUnit: 2000, total: 100_000, realizedPnl: 50 * perUnit, route: null,
  }));

const cover = coverageFromEvents([keeperChange(T0, ["X1-YB39-E14C", "X1-YB39-AD1D"]), keeperChange(T0 + 3 * H, ["X1-UF49-CD1F"])]);

describe("freshness: where the anchor comes from", () => {
  it("takes the earliest keeper-list addition per system and ignores other events", () => {
    assert.deepEqual(cover.map((c) => [c.system, c.atMs - T0, c.markets]), [["X1-YB39", 0, 2], ["X1-UF49", 3 * H, 1]]);
    const later = keeperChange(T0 + 9 * H, ["X1-YB39-ZZZZ"]);
    assert.equal(coverageFromEvents([later, keeperChange(T0, ["X1-YB39-E14C"])]).find((c) => c.system === "X1-YB39")!.atMs, T0, "an earlier change wins whatever the order");
    assert.deepEqual(coverageFromEvents([{ ...keeperChange(T0, ["X1-A-1"]), subject: "doctrine:foo" }, { ...keeperChange(T0, ["X1-A-1"]), kind: "trip_closed" }]), []);
    assert.deepEqual(coverageFromEvents([{ ...keeperChange(T0, []), context: { after: { added: [] } } }]), []);
    assert.equal(systemOf("X1-YB39-EA6F"), "X1-YB39");
  });
});

describe("freshness: the curve", () => {
  // THEOREM-152's profit per unit in YB39 on 2026-10-23: about 1,170, then 860, then 770, against 350-480 in older systems.
  const rows = [
    ...sells("X1-YB39-E14C", 0.5, 20, 1170), ...sells("X1-YB39-E14C", 2.5, 20, 860), ...sells("X1-YB39-E14C", 5, 20, 770),
    ...sells("X1-YB39-E14C", 20, 20, 420),
    ...sells("X1-HM42-A1", 1, 40, 400), ...sells("X1-HM42-A1", 6, 40, 440), // a system with no recorded coverage: mature
  ];
  const f = buildFreshness(rows, cover);

  it("buckets by age since coverage and compares each with the mature profit per unit", () => {
    assert.equal(f.mature.sells, 100, "uncovered systems plus covered ones past 16h");
    assert.equal(f.mature.profitPerUnit, 420, "(20 x 420 + 40 x 400 + 40 x 440) / 100");
    const by = Object.fromEntries(f.curve.map((b) => [b.label, b]));
    assert.deepEqual([by["0-2h"]!.profitPerUnit, by["2-4h"]!.profitPerUnit, by["4-8h"]!.profitPerUnit, by["16h+"]!.profitPerUnit], [1170, 860, 770, 420]);
    assert.ok(by["0-2h"]!.ratioToMature! > 2.5 && by["0-2h"]!.ratioToMature! > by["2-4h"]!.ratioToMature! && by["2-4h"]!.ratioToMature! > by["4-8h"]!.ratioToMature!, "the premium decays with age");
    assert.equal(by["8-16h"]!.sells, 0);
    assert.equal(by["8-16h"]!.ratioToMature, null);
  });

  it("says when the premium has faded", () => {
    assert.equal(f.premiumFadesByH, 16, "8-16h has no sells, so the first bucket with data and no premium after the premium ones is 16h+");
  });

  it("lists the systems with their own first and last bucket", () => {
    const yb = f.systems.find((s) => s.system === "X1-YB39")!;
    assert.equal(yb.firstBucketPerUnit, 1170);
    assert.equal(yb.lastBucketPerUnit, 420);
    assert.equal(yb.hoursToFirstSell, 0.5);
    assert.equal(f.systems.find((s) => s.system === "X1-HM42"), undefined, "an uncovered system has no coverage row");
  });

  it("keeps sells before the coverage time and sells with no cost basis out of the curve", () => {
    const early = buildFreshness([...sells("X1-UF49-CD1F", 0, 20, 900), { ...sells("X1-YB39-E14C", 1, 1, 0)[0]!, realizedPnl: null }], cover);
    assert.equal(early.beforeCoverage.sells, 20, "UF49 was listed at +3h, so +0h sells are before it");
    assert.equal(early.curve.reduce((s, b) => s + b.sells, 0), 0);
  });

  it("quotes no ratio from a handful of sells", () => {
    const few = buildFreshness([...sells("X1-YB39-E14C", 1, 5, 2000), ...sells("X1-HM42-A1", 1, 40, 400)], cover);
    assert.equal(few.curve[0]!.ratioToMature, null);
    assert.deepEqual(freshnessFindings(few), []);
  });
});

describe("freshness: findings", () => {
  it("reports the premium with its evidence, the sample size and a correlation caveat", () => {
    const f = buildFreshness([...sells("X1-YB39-E14C", 0.5, 20, 1170), ...sells("X1-YB39-E14C", 2.5, 20, 860), ...sells("X1-HM42-A1", 1, 60, 400)], cover);
    const [finding] = freshnessFindings(f);
    assert.ok(finding);
    assert.equal(finding!.kind, "freshness");
    assert.match(finding!.headline, /earned 2\.93x the mature profit per unit at best \(1170c against 400c\)/);
    assert.equal(finding!.sampleSize, 40);
    assert.equal(finding!.weight, Math.round(20 * 50 * (1170 - 400) + 20 * 50 * (860 - 400)));
    assert.match(finding!.suggestion!.why, /correlation/);
  });

  it("finds nothing when new systems earn no more than old ones", () => {
    const f = buildFreshness([...sells("X1-YB39-E14C", 0.5, 20, 400), ...sells("X1-HM42-A1", 1, 60, 400)], cover);
    assert.deepEqual(freshnessFindings(f), []);
    assert.equal(f.premiumFadesByH, null);
  });
});

describe("freshness in the report", () => {
  it("appears in the analysis report, fed by the week's keeper changes rather than the window's events", () => {
    const rows = [...sells("X1-YB39-E14C", 0.5, 20, 1170), ...sells("X1-HM42-A1", 1, 60, 400)];
    const r = buildAnalysisReport({ fromMs: T0, nowMs: T0 + 6 * H, ledger: rows, events: [], coverageEvents: [keeperChange(T0 - 30 * 60_000, ["X1-YB39-E14C"])], snapshots: [], marketTrades: [], ourShips: new Set(["S-1"]) });
    assert.equal(r.freshness.curve[0]!.sells, 20);
    assert.ok(r.findings.some((x) => x.kind === "freshness"));
    const none = buildAnalysisReport({ fromMs: T0, nowMs: T0 + 6 * H, ledger: rows, events: [], snapshots: [], marketTrades: [], ourShips: new Set(["S-1"]) });
    assert.equal(none.freshness.curve.reduce((s, b) => s + b.sells, 0), 0);
    assert.match(none.notes.join(" "), /No keeper-list change is recorded/);
  });

  it("policy defaults are the documented ones", () => {
    assert.deepEqual([DEFAULT_FRESHNESS_POLICY.bucketEdgesH, DEFAULT_FRESHNESS_POLICY.matureAfterH, DEFAULT_FRESHNESS_POLICY.premiumRatio], [[2, 4, 8, 16], 16, 1.25]);
  });
});

describe("freshness: the release anchor and the live premium", () => {
  const releaseEvent = (atMs: number, system: string): ActionEventRow => ({
    at: new Date(atMs).toISOString(), universeKey: "THEOREM@2026-10-25", kind: "config_change", actor: "operator", subject: "system_release",
    context: { before: { system, state: "staged" }, after: { system, markets: 6 } },
  });

  it("anchors a system at its release, not at the earlier keeper-list change", () => {
    const c = coverageFromEvents([keeperChange(T0, ["X1-YB39-E14C"]), releaseEvent(T0 + 5 * H, "X1-YB39")]);
    assert.deepEqual(c.map((x) => [x.system, x.atMs - T0, x.markets]), [["X1-YB39", 5 * H, 6]]);
    // a release for a system with no keeper-list change still makes an anchor
    assert.equal(coverageFromEvents([releaseEvent(T0, "X1-NEW")]).length, 1);
  });

  it("reads the premium now: profit per unit over the recent sells against the mature rate, null on few sells", () => {
    const recent = [...sells("X1-YB39-E14C", 0, 20, 840), ...sells("X1-UF49-CD1F", 0, 5, 2000), ...sells("X1-HM42-A1", 0, 30, 400)];
    const p = livePremium(recent, ["X1-YB39", "X1-UF49", "X1-NONE"], 420);
    assert.deepEqual(p.get("X1-YB39"), { ratio: 2, sells: 20 });
    assert.deepEqual(p.get("X1-UF49"), { ratio: null, sells: 5 }, "5 sells is under the minimum");
    assert.deepEqual(p.get("X1-NONE"), { ratio: null, sells: 0 });
    assert.equal(livePremium(recent, ["X1-YB39"], null).get("X1-YB39")!.ratio, null, "no mature rate, no ratio");
  });
});
