import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEEPER_PLAN_POLICY as P, fixedReason, noteRouteEnds, planKeepers, type PlanMarket } from "../src/engine/keeperPlan.js";

const H = 3_600_000;
const NOW = 100 * H;
const m = (market: string, over: Partial<PlanMarket> = {}): PlanMarket => ({ market, system: market.split("-").slice(0, 2).join("-"), yard: false, goods: 9, ...over });

describe("fixedReason", () => {
  it("keeps yards, 13+ goods and 7-goods markets fixed", () => {
    assert.equal(fixedReason(m("X1-A-Y", { yard: true, goods: 3 }), P, new Map(), NOW, 0), "yard");
    assert.equal(fixedReason(m("X1-A-B", { goods: 14 }), P, new Map(), NOW, 0), "goods");
    assert.equal(fixedReason(m("X1-A-C", { goods: 7 }), P, new Map(), NOW, 0), "goods");
    assert.equal(fixedReason(m("X1-A-D", { goods: 9 }), P, new Map(), NOW, 0), undefined);
  });
  it("keeps a market fixed while it was on a good route within the demote window", () => {
    assert.equal(fixedReason(m("X1-A-D"), P, new Map([["X1-A-D", NOW - 2 * H]]), NOW, 0), "route");
    assert.equal(fixedReason(m("X1-A-D"), P, new Map([["X1-A-D", NOW - 7 * H]]), NOW, 0), undefined);
  });
  it("does not judge a keeper before tracking has run for the demote window", () => {
    assert.equal(fixedReason(m("X1-A-D", { keeper: "S-1" }), P, new Map(), NOW, NOW - H), "route");
    assert.equal(fixedReason(m("X1-A-D", { keeper: "S-1" }), P, new Map(), NOW, NOW - 7 * H), undefined);
  });
});

describe("planKeepers", () => {
  it("promotes an uncovered route end and demotes an idle keeper", () => {
    const plan = planKeepers({
      nowMs: NOW, trackedSinceMs: 0,
      markets: [m("X1-A-R"), m("X1-B-K", { keeper: "S-1" }), m("X1-A-T")],
      routeSeenAt: new Map([["X1-A-R", NOW - 10 * 60_000]]),
    });
    assert.deepEqual(plan.promote.map((x) => x.market), ["X1-A-R"]);
    assert.deepEqual(plan.demote.map((x) => x.ship), ["S-1"]);
    assert.deepEqual(plan.moves, [], "different systems: no move");
    const a = plan.systems.find((s) => s.system === "X1-A")!;
    assert.deepEqual(a.tourMarkets, ["X1-A-T"]);
  });

  it("moves a demoted hull to a promoted market in the same system instead of buying", () => {
    const plan = planKeepers({
      nowMs: NOW, trackedSinceMs: 0,
      markets: [m("X1-A-R"), m("X1-A-K", { keeper: "S-1" })],
      routeSeenAt: new Map([["X1-A-R", NOW]]),
    });
    assert.equal(plan.moves.length, 1);
    assert.deepEqual({ ship: plan.moves[0]!.ship, from: plan.moves[0]!.from, to: plan.moves[0]!.to }, { ship: "S-1", from: "X1-A-K", to: "X1-A-R" });
    assert.deepEqual(plan.promote, [], "the moved-to market is not also bought");
  });

  it("never promotes a market already listed or covered, and caps promotions per pass", () => {
    const seen = new Map(["X1-A-1", "X1-A-2", "X1-A-3", "X1-A-4"].map((k) => [k, NOW] as [string, number]));
    const plan = planKeepers({
      nowMs: NOW, trackedSinceMs: 0, routeSeenAt: seen,
      markets: [m("X1-A-1", { listed: true }), m("X1-A-2", { keeper: "S-9" }), m("X1-A-3"), m("X1-A-4")],
    });
    assert.deepEqual(plan.promote.map((x) => x.market), ["X1-A-3", "X1-A-4"]);
    const capped = planKeepers({ nowMs: NOW, trackedSinceMs: 0, routeSeenAt: seen, markets: [m("X1-A-3"), m("X1-A-4")] }, { ...P, maxPromotionsPerPass: 1 });
    assert.equal(capped.promote.length, 1);
  });

  it("never demotes a yard or a goods-rule market", () => {
    const plan = planKeepers({ nowMs: NOW, trackedSinceMs: 0, routeSeenAt: new Map(), markets: [m("X1-A-Y", { yard: true, keeper: "S-1" }), m("X1-A-G", { goods: 15, keeper: "S-2" })] });
    assert.deepEqual(plan.demote, []);
  });
});

describe("noteRouteEnds", () => {
  it("marks both ends of good routes, ignores thin ones and drops markets unseen for two days", () => {
    const r = noteRouteEnds(new Map([["OLD", NOW - 49 * H]]), [
      { buyAt: "B1", sellAt: "S1", profitPerTrip: 80_000 },
      { buyAt: "B2", sellAt: "S2", profitPerTrip: 10_000 },
    ], 50_000, NOW);
    assert.deepEqual([...r.seen.keys()].sort(), ["B1", "S1"]);
    assert.equal(r.changed, true);
    const again = noteRouteEnds(r.seen, [{ buyAt: "B1", sellAt: "S1", profitPerTrip: 80_000 }], 50_000, NOW + 30_000);
    assert.equal(again.changed, false, "refreshed at most once a minute");
  });
});

import { decodeRouteSeen, encodeRouteSeen } from "../src/engine/keeperPlan.js";

describe("route tracking survives a restart", () => {
  it("round-trips through the saved flag, and a bad flag starts afresh", () => {
    const state = { trackedSinceMs: 5, seen: new Map([["X1-A-1", 7]]) };
    const back = decodeRouteSeen(encodeRouteSeen(state), 99);
    assert.equal(back.trackedSinceMs, 5);
    assert.deepEqual([...back.seen], [["X1-A-1", 7]]);
    assert.deepEqual(decodeRouteSeen("{not json", 99), { trackedSinceMs: 99, seen: new Map() });
    assert.equal(decodeRouteSeen(undefined, 42).trackedSinceMs, 42);
  });
});

import { resumeTracking } from "../src/engine/keeperPlan.js";

describe("a gap in route tracking does not demote keepers", () => {
  it("restarts judging after a gap, and keeps the start while recording is continuous", () => {
    const s = { trackedSinceMs: 0, seen: new Map<string, number>(), lastNotedMs: 1_000 };
    assert.equal(resumeTracking(s, 1_000 + 60_000), false, "one minute later: no gap");
    assert.equal(s.trackedSinceMs, 0);
    assert.equal(resumeTracking(s, 1_000 + 60_000 + 3_600_000), true, "an hour unrecorded: judging restarts");
    assert.equal(s.trackedSinceMs, 1_000 + 60_000 + 3_600_000);
    const never = { trackedSinceMs: 5, seen: new Map<string, number>() };
    assert.equal(resumeTracking(never, 9_000_000), true, "never recorded (plan was off): restart");
    const back = decodeRouteSeen(encodeRouteSeen({ ...s }), 0);
    assert.equal(back.lastNotedMs, s.lastNotedMs, "the last recording time survives a restart");
  });
});
