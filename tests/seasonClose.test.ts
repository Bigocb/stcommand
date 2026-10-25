import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { metricsFromRunResult } from "../src/engine/season.js";
import { closeWeekFromResults, closeEndedWeek } from "../src/engine/seasonClose.js";
import { ResetWatcher, type ResetWatcherPorts } from "../src/engine/resetWatcher.js";

/**
 * 2026-10-25: season week 2 (opened 10-18) was still open after the reset. Closing it the normal way runs a live analysis, which sees
 * only the current universe, so it would have scored the new week's first hours as last week's. A week from an earlier universe is
 * now closed from the scoreboard row the reset saved for it, and the reset does that itself.
 */
const LAST_WEEK = {
  started_at: "2026-10-18T13:05:38.779Z", ended_at: "2026-10-25T12:58:47.245Z",
  trading_net: "658607834", sell_revenue: "2939951244", fuel_cost: "10479634", jump_cost: "41918458",
};

describe("metricsFromRunResult", () => {
  it("gives profit per hour, net profit and overhead from the saved row, and leaves the rest unmeasured", () => {
    const m = metricsFromRunResult(LAST_WEEK);
    assert.equal(m.netProfit, 658607834);
    assert.ok(Math.abs((m.profitPerHour ?? 0) - 3_940_000) < 30_000, `profit/h ${m.profitPerHour}`);
    assert.ok(Math.abs((m.overheadShare ?? 0) - 0.01783) < 0.0005, `overhead ${m.overheadShare}`);
    for (const k of ["positioningCosts", "trips", "estimateAccuracy", "growth"] as const) assert.equal(m[k], null);
  });

  it("has no overhead share when there was no revenue, instead of dividing by zero", () => {
    assert.equal(metricsFromRunResult({ ...LAST_WEEK, sell_revenue: "0" }).overheadShare, null);
  });
});

function fakeStore(opts: { universeKey: string | null; row?: Record<string, unknown>; open?: boolean }) {
  const closed: unknown[] = [];
  const week = {
    id: 7, seasonId: 1, weekNo: 2, universeKey: opts.universeKey, phase: "recover", notes: null, openedAt: "2026-10-18T14:44:00Z",
    closedAt: opts.open === false ? "2026-10-18T15:00:00Z" : null, record: null, findingsId: null,
    goals: [
      { id: "g1", text: "hourly profit 3M", metric: "profitPerHour", target: 3_000_000, comparator: ">=", status: "pending" },
      { id: "g2", text: "accuracy", metric: "estimateAccuracy", target: 1, comparator: ">=", status: "pending" },
      { id: "g3", text: "by hand", status: "pending" },
    ],
  };
  const store = {
    runResultFor: async (_a: string, resetDate: string) => (resetDate === "2026-10-18" ? opts.row : undefined),
    closeSeasonWeek: async (_t: string, _id: number, f: unknown) => { closed.push(f); return week; },
    activeSeason: async () => ({ id: 1, name: "Test Season" }),
    seasonWeeks: async () => [week],
  };
  return { store: store as never, week: week as never, closed };
}

describe("closeWeekFromResults", () => {
  it("scores the goals from the saved row: met, missed for an unmeasured metric, hand goals untouched", async () => {
    const { store, week, closed } = fakeStore({ universeKey: "THEOREM@2026-10-18", row: LAST_WEEK });
    await closeWeekFromResults(store, "t1", "THEOREM", week);
    const f = closed[0] as { goals: { id: string; status: string; measured?: number | null }[]; findingsId: number | null; record: { metrics: Record<string, number | null> } };
    assert.equal(f.findingsId, null, "no analysis report is saved for a past week");
    assert.equal(f.goals.find((g) => g.id === "g1")!.status, "met");
    assert.equal(f.goals.find((g) => g.id === "g2")!.status, "missed", "an unmeasured metric is missed at close, not guessed");
    assert.equal(f.goals.find((g) => g.id === "g3")!.status, "pending", "a hand-tracked goal keeps its status");
    assert.equal(f.record.metrics.netProfit, 658607834);
  });

  it("refuses, and closes nothing, when no results were saved for that universe", async () => {
    const { store, week, closed } = fakeStore({ universeKey: "THEOREM@2026-10-18" });
    await assert.rejects(() => closeWeekFromResults(store, "t1", "THEOREM", week), /no saved results for THEOREM in the 2026-10-18 universe/);
    assert.equal(closed.length, 0);
  });
});

describe("closeEndedWeek (the reset's call)", () => {
  it("closes the open week that belongs to the universe that ended", async () => {
    const { store, closed } = fakeStore({ universeKey: "THEOREM@2026-10-18", row: LAST_WEEK });
    assert.match(await closeEndedWeek(store, "t1", "THEOREM", "2026-10-18"), /closed season week 2/);
    assert.equal(closed.length, 1);
  });

  it("leaves a week alone that belongs to another universe", async () => {
    const { store, closed } = fakeStore({ universeKey: "THEOREM@2026-10-25", row: LAST_WEEK });
    assert.match(await closeEndedWeek(store, "t1", "THEOREM", "2026-10-18"), /belongs to THEOREM@2026-10-25/);
    assert.equal(closed.length, 0);
  });

  it("does nothing without an open week", async () => {
    const { store, closed } = fakeStore({ universeKey: "THEOREM@2026-10-18", row: LAST_WEEK, open: false });
    assert.match(await closeEndedWeek(store, "t1", "THEOREM", "2026-10-18"), /no open season week/);
    assert.equal(closed.length, 0);
  });
});

describe("the reset watcher", () => {
  function ports(calls: string[], close?: ResetWatcherPorts["closeSeasonWeek"]): ResetWatcherPorts {
    return {
      fetchStatus: async () => ({ resetDate: "2026-10-25", nextReset: "2026-11-01T13:00:00.000Z" }),
      getSeenResetDate: async () => "2026-10-18",
      setSeenResetDate: async () => {},
      listTenants: async () => [{ id: "t1", agentSymbol: "THEO" }],
      probeTenant: async () => "dead",
      isBooted: () => false,
      stopWorker: () => {},
      captureRunResult: async () => { calls.push("capture"); return true; },
      closeSeasonWeek: close,
      wipeTenantGameData: async () => { calls.push("wipe"); },
      truncateSharedGalaxy: async () => {},
      resetCrawler: () => {},
      beginUniverse: () => {},
      registerAndStore: async (s) => ({ tenantId: "t1", agentSymbol: s }),
      boot: async () => {},
    };
  }

  it("closes the season week after saving the results and before the wipe", async () => {
    const calls: string[] = [];
    await new ResetWatcher(ports(calls, async (_t, ended) => { calls.push(`close:${ended}`); return "ok"; }), { accountTokenConfigured: true }).tick();
    assert.deepEqual(calls.slice(0, 3), ["capture", "close:2026-10-18", "wipe"]);
  });

  it("a failing season close never holds the wipe", async () => {
    const calls: string[] = [];
    await new ResetWatcher(ports(calls, async () => { throw new Error("db boom"); }), { accountTokenConfigured: true }).tick();
    assert.ok(calls.includes("wipe"), "recovery must continue");
  });
});
