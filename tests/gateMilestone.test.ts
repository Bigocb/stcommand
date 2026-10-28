import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gateOpenedEvent, GATE_OPEN_SUBJECT } from "../src/engine/actionEvents.js";
import { milestonesFromEvents } from "../src/engine/analysis/report.js";
import { metricsFromReport, evaluateGoal, GOAL_METRICS, type Goal } from "../src/engine/season.js";
import type { ActionEventRow } from "../src/db/store.js";

const row = (e: ReturnType<typeof gateOpenedEvent>): ActionEventRow => ({ ...e, universeKey: "THEO@2026-10-25" });

describe("the home gate opening is a week milestone", () => {
  it("the event carries hours into the week, wallet and fleet size, and says when the time is an upper bound", () => {
    const e = gateOpenedEvent({ atIso: "2026-10-28T04:00:00.000Z", hoursIntoWeek: 34.249, credits: 910_000, ships: 31, system: "X1-BT10" });
    assert.equal(e.kind, "milestone");
    assert.equal(e.subject, GATE_OPEN_SUBJECT);
    assert.deepEqual(e.observed, { hoursIntoWeek: 34.2, credits: 910_000, ships: 31 });
    assert.match(e.reason!, /after 34.2 h/);
    assert.match(gateOpenedEvent({ atIso: "x", hoursIntoWeek: 40, system: "X1-A", lateNotice: true }).reason!, /noticed late/);
  });

  it("the report lists the earliest gate_open only, so a restart cannot open the gate twice", () => {
    const first = row(gateOpenedEvent({ atIso: "2026-10-28T04:00:00.000Z", hoursIntoWeek: 34.2, system: "X1-BT10" }));
    const again = row(gateOpenedEvent({ atIso: "2026-10-28T09:00:00.000Z", hoursIntoWeek: 39.2, system: "X1-BT10", lateNotice: true }));
    const other = { ...first, kind: "config_change" };
    const ms = milestonesFromEvents([again, other, first]);
    assert.equal(ms.length, 1);
    assert.equal(ms[0]!.hoursIntoWeek, 34.2);
  });

  it("no milestone while the gate is closed", () => {
    assert.deepEqual(milestonesFromEvents([]), []);
  });

  it("a season goal can be set on it (lower is better) and is judged from the report", () => {
    assert.equal(GOAL_METRICS.gateOpenHours.better, "lower");
    const report = {
      summary: { profitPerHour: 0, netProfit: 0, overheadShare: null, positioningCosts: 0, trips: 0, growthPerWeek: null, gateOpenHours: 31.5 },
      calibration: { fleet: { factor: null } },
    };
    const metrics = metricsFromReport(report);
    assert.equal(metrics.gateOpenHours, 31.5);
    const goal: Goal = { id: "g", text: "Gate open inside 34 h (last week 34)", metric: "gateOpenHours", target: 34, status: "pending" };
    assert.equal(evaluateGoal(goal, metrics, false).status, "met");
    assert.equal(evaluateGoal({ ...goal, target: 30 }, metrics, true).status, "missed");
  });
});
