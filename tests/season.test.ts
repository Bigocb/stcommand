import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { carryForward, evaluateGoal, goalTarget, metricsFromReport, normalizeGoal, openingFor, startPhaseAfter, type Goal } from "../src/engine/season.js";

const goal = (g: Partial<Goal>): Goal => ({ id: "g1", text: "x", status: "pending", ...g });

describe("phases", () => {
  it("a week that ends in Cross-system starts the next at Recover; other phases carry over", () => {
    assert.equal(startPhaseAfter("cross_system"), "recover");
    assert.equal(startPhaseAfter("specialize"), "specialize");
    assert.equal(startPhaseAfter("build"), "build");
  });

  it("a first week opens at Recover with no goals", () => {
    assert.deepEqual(openingFor(undefined), { phase: "recover", goals: [] });
  });
});

describe("goals", () => {
  it("a relative goal's target is the baseline moved by the percent", () => {
    assert.equal(goalTarget(goal({ metric: "overheadShare", changePct: -5, baseline: 0.2 })), 0.19);
    assert.equal(goalTarget(goal({ metric: "overheadShare", changePct: -5 })), null);
  });

  it("is met when the measure clears the target, using the metric's better direction by default", () => {
    const m = { overheadShare: 0.18, profitPerHour: 1_500_000 };
    assert.equal(evaluateGoal(goal({ metric: "overheadShare", changePct: -5, baseline: 0.2 }), m, false).status, "met");
    assert.equal(evaluateGoal(goal({ metric: "profitPerHour", target: 2_000_000 }), m, false).status, "pending");
    assert.equal(evaluateGoal(goal({ metric: "profitPerHour", target: 2_000_000 }), m, true).status, "missed");
    assert.equal(evaluateGoal(goal({ metric: "profitPerHour", target: 1_000_000, comparator: "<=" }), m, false).status, "pending");
  });

  it("leaves hand-tracked and dropped goals alone", () => {
    assert.equal(evaluateGoal(goal({ status: "met" }), {}, true).status, "met");
    assert.equal(evaluateGoal(goal({ metric: "trips", target: 1, status: "dropped" }), { trips: 50 }, true).status, "dropped");
  });

  it("carries missed goals forward, pending again, rebased on last week's value", () => {
    const goals = [
      goal({ id: "a", metric: "overheadShare", changePct: -5, baseline: 0.2, status: "missed", measured: 0.21 }),
      goal({ id: "b", status: "met" }),
      goal({ id: "c", status: "dropped" }),
      goal({ id: "d", metric: "trips", target: 5, status: "pending" }), // measured and not missed: scored at close, not here
    ];
    const next = carryForward(goals, 2, { overheadShare: 0.21 });
    assert.equal(next.length, 1);
    assert.equal(next[0]!.status, "pending");
    assert.equal(next[0]!.fromWeek, 2);
    assert.equal(next[0]!.baseline, 0.21);
    assert.equal(next[0]!.measured, null);
  });

  it("carries a hand-tracked goal nobody marked met", () => {
    assert.equal(carryForward([goal({ id: "h", status: "pending" })], 1).length, 1);
  });

  it("opens the next week from the last week's record", () => {
    const o = openingFor({ weekNo: 3, phase: "cross_system", record: { phase: "cross_system", goals: [goal({ status: "missed" })], metrics: {}, closedAt: "t" } });
    assert.equal(o.phase, "recover");
    assert.equal(o.goals.length, 1);
    assert.equal(o.goals[0]!.fromWeek, 3);
  });

  it("validates a goal from the UI", () => {
    assert.throws(() => normalizeGoal({ text: "" }), /needs a description/);
    assert.throws(() => normalizeGoal({ text: "x", metric: "nope", target: 1 }), /unknown goal metric/);
    assert.throws(() => normalizeGoal({ text: "x", metric: "trips" }), /needs a target or a percent change/);
    const g = normalizeGoal({ text: "Cut overhead", metric: "overheadShare", changePct: "-5" });
    assert.equal(g.changePct, -5);
    assert.equal(g.status, "pending");
    assert.ok(g.id.length > 1);
    assert.equal(normalizeGoal({ text: "Keep it", id: "keep" }, goal({ id: "keep", fromWeek: 1, status: "met" })).fromWeek, 1);
  });

  it("reads the measures from an analysis report", () => {
    const m = metricsFromReport({ summary: { profitPerHour: 10, netProfit: 20, overheadShare: 0.1, positioningCosts: 5, trips: 3, growthPerDay: 2.5 }, calibration: { fleet: { factor: 0.8 } } });
    assert.deepEqual(m, { profitPerHour: 10, netProfit: 20, overheadShare: 0.1, positioningCosts: 5, trips: 3, estimateAccuracy: 0.8, growth: 2.5 });
  });

  it("scores a growth goal like any other: at least its target, higher is better", () => {
    const g = goal({ metric: "growth", comparator: ">=", target: 3 });
    assert.equal(evaluateGoal(g, { growth: 3.4 }, false).status, "met");
    assert.equal(evaluateGoal(g, { growth: 1.2 }, false).status, "pending");
    assert.equal(evaluateGoal(g, { growth: 1.2 }, true).status, "missed");
    assert.equal(evaluateGoal(g, { growth: null }, true).status, "missed", "no measure at close is a miss");
  });
});
