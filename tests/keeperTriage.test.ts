import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OFF_POLICY, medianOf, reviewParked, triageKeepers, type KeeperFacts, type TriagePolicy } from "../src/engine/keeperTriage.js";
import { Reminders } from "../src/engine/reminders.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const H = 3_600_000;
const MIN = 60_000;
const on: TriagePolicy = { ...OFF_POLICY, maxParksPerRun: 3 };
const NOW = 100 * H;

const k = (ship: string, over: Partial<KeeperFacts> = {}): KeeperFacts => ({
  ship, market: `X1-A-${ship}`, score: 100, trades: 12, lastTradeAt: NOW - H, viableRoutes: 2, deadRoutes: 0, ...over,
});
const plan = (stationed: KeeperFacts[], over: Partial<Parameters<typeof triageKeepers>[0]> = {}) =>
  triageKeepers({ now: NOW, weekAgeMs: 48 * H, stationed, alreadyParked: 0, skip: new Set(), policy: on, ...over });

describe("reminders (pure)", () => {
  it("fires when due, keeps one per kind and subject, and survives a save", () => {
    const r = new Reminders();
    r.add({ kind: "keeper_recheck", subject: "T-1", dueAt: 1_000, note: "first" }, 0);
    r.add({ kind: "keeper_recheck", subject: "T-1", dueAt: 5_000, note: "second", data: { rechecks: 1 } }, 100);
    r.add({ kind: "keeper_recheck", subject: "T-2", dueAt: 2_000, note: "other" }, 100);
    assert.equal(r.size, 2, "the same kind and subject replaced the first");
    assert.deepEqual(r.due(2_500).map((x) => x.subject), ["T-2"]);
    assert.deepEqual(r.due(9_000, "keeper_recheck").map((x) => x.subject), ["T-2", "T-1"]);
    assert.deepEqual(r.due(9_000, "something_else"), []);
    const copy = new Reminders();
    assert.equal(copy.restore(r.toJson(), 3_000), 2);
    assert.deepEqual(copy.get("keeper_recheck", "T-1")?.data, { rechecks: 1 });
    assert.ok(copy.cancel("keeper_recheck", "T-2"));
    assert.equal(copy.has("keeper_recheck", "T-2"), false);
  });

  it("drops junk and long-overdue entries on restore", () => {
    const r = new Reminders();
    assert.equal(r.restore("not json", 0), 0);
    assert.equal(r.restore('{"a":1}', 0), 0);
    const old = JSON.stringify([{ kind: "k", subject: "s", dueAt: 0 }, { kind: "k", subject: "t", dueAt: 8 * 24 * H }, { kind: 1 }]);
    assert.equal(r.restore(old, 9 * 24 * H), 1, "the one due a day ago stays, the one due nine days ago goes, the malformed one goes");
  });
});

describe("keeper triage: who gets parked", () => {
  it("is off at maxParksPerRun 0: nothing is parked", () => {
    const dead = k("D", { trades: 0, score: 1, viableRoutes: 0 });
    assert.deepEqual(plan([k("A"), k("B"), dead], { policy: OFF_POLICY }).park, []);
  });

  it("parks a never-traded low scorer with no viable route, and says why", () => {
    const stationed = [...Array.from({ length: 9 }, (_, i) => k(`K${i}`)), k("LOW", { trades: 0, score: 10, viableRoutes: 0, lastTradeAt: undefined })];
    const out = plan(stationed);
    assert.deepEqual(out.park.map((p) => [p.ship, p.kind]), [["LOW", "low"]]);
    assert.match(out.park[0]!.reason, /no trade of ours here this week.*score of 10 against a median of 100/);
  });

  it("leaves a low scorer alone when a route runs through its market, and an unscored one with no trades", () => {
    const stationed = [...Array.from({ length: 9 }, (_, i) => k(`K${i}`)), k("USED", { trades: 0, score: 10, viableRoutes: 1 }), k("UNKNOWN", { trades: 0, score: undefined, viableRoutes: 0 })];
    assert.deepEqual(plan(stationed).park, []);
  });

  it("parks a market that went quiet, and calls it crashed when its routes are held back as dead", () => {
    const stationed = [...Array.from({ length: 12 }, (_, i) => k(`K${i}`)),
      k("QUIET", { viableRoutes: 0, lastTradeAt: NOW - 7 * H }),
      k("CRASH", { viableRoutes: 0, deadRoutes: 2, lastTradeAt: NOW - 8 * H }),
      k("RECENT", { viableRoutes: 0, lastTradeAt: NOW - 2 * H })];
    const out = plan(stationed);
    assert.deepEqual(out.park.map((p) => [p.ship, p.kind]).sort(), [["CRASH", "crashed"], ["QUIET", "quiet"]]);
    assert.match(out.park.find((p) => p.ship === "CRASH")!.reason, /held back as dead \(2\)/);
  });

  it("waits for the week to be old enough, and for a known start", () => {
    const stationed = [...Array.from({ length: 9 }, (_, i) => k(`K${i}`)), k("LOW", { trades: 0, score: 10, viableRoutes: 0 })];
    assert.deepEqual(plan(stationed, { weekAgeMs: 5 * H }).park, []);
    assert.match(plan(stationed, { weekAgeMs: 5 * H }).skipped, /week is 5h old/);
    assert.match(plan(stationed, { weekAgeMs: undefined }).skipped, /not known/);
  });

  it("never parks past the share cap or the per-pass cap, and skips ships it was told to", () => {
    const lows = Array.from({ length: 10 }, (_, i) => k(`L${i}`, { trades: 0, score: i, viableRoutes: 0 }));
    const stationed = [...Array.from({ length: 30 }, (_, i) => k(`K${i}`)), ...lows]; // 40 keepers, 15% = 6
    assert.equal(plan(stationed).park.length, 3, "per-pass cap");
    assert.deepEqual(plan(stationed).park.map((p) => p.ship), ["L0", "L1", "L2"], "lowest score first");
    assert.equal(plan(stationed, { alreadyParked: 5 }).park.length, 1, "room for one more under 15%");
    assert.equal(plan(stationed, { alreadyParked: 6 }).park.length, 0);
    assert.deepEqual(plan(stationed, { skip: new Set(["L0", "L1"]) }).park.map((p) => p.ship), ["L2", "L3", "L4"]);
  });
});

describe("keeper triage: the look-again", () => {
  const f = { ship: "T-1", market: "X1-A-T1", rechecks: 0, parkedAt: NOW - 2 * H, probed: false, viableRoutes: 0, snapshotAgeMs: 10 * MIN };

  it("brings the keeper back when a route is viable again or we traded there since", () => {
    assert.equal(reviewParked({ ...f, viableRoutes: 2 }, on, NOW).kind, "unpark");
    assert.equal(reviewParked({ ...f, lastTradeAt: NOW - MIN }, on, NOW).kind, "unpark");
    assert.equal(reviewParked({ ...f, lastTradeAt: NOW - 5 * H }, on, NOW).kind, "extend", "a trade from before it was parked proves nothing");
  });

  it("looks again with a doubling wait, then settles after the last look", () => {
    const first = reviewParked(f, on, NOW);
    assert.deepEqual([first.kind, (first as { remindInMs: number }).remindInMs, (first as { rechecks: number }).rechecks], ["extend", 180 * MIN, 1]);
    const second = reviewParked({ ...f, rechecks: 1 }, on, NOW);
    assert.equal((second as { remindInMs: number }).remindInMs, 360 * MIN);
    const last = reviewParked({ ...f, rechecks: 2 }, on, NOW);
    assert.equal(last.kind, "settle");
    assert.match(last.reason, /candidate to scrap/);
  });

  it("probes when there is no fresh read to judge by, once", () => {
    const stale = reviewParked({ ...f, snapshotAgeMs: 3 * H }, on, NOW);
    assert.deepEqual([stale.kind, (stale as { remindInMs: number }).remindInMs], ["probe", 30 * MIN]);
    assert.equal(reviewParked({ ...f, snapshotAgeMs: undefined }, on, NOW).kind, "probe");
    assert.equal(reviewParked({ ...f, snapshotAgeMs: 3 * H, probed: true }, on, NOW).kind, "extend", "after a probe the read is what it is");
  });

  it("medianOf", () => {
    assert.equal(medianOf([]), undefined);
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([1, 2, 3, 10]), 2.5);
  });
});

describe("what the dispatcher tells triage (marketRouteUse)", () => {
  const route = (good: string, buyAt: string, sellAt: string) => ({
    good, buyAt, buySystem: "X1-KG7", buyPrice: 2000, sellAt, sellSystem: "X1-KG7", sellPrice: 3000,
    volume: 100, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: 60_000, ageMinutes: 5,
    profitByHold: { "100": 60_000 } as Record<string, number>,
  });

  it("counts the viable routes touching each market, and the dead ones separately", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    const run = () => d.recompute([route("EQUIPMENT", "X1-KG7-OK1", "X1-KG7-AA8B"), route("FOOD", "X1-KG7-OK1", "X1-KG7-ZZ9")], [{ shipSymbol: "T1", capacity: 100 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, { routeBlockMin: 30 });
    run();
    t.mock.timers.tick(61_000);
    d.reportDeadRoute("MACHINERY", "X1-KG7-DEAD", "X1-KG7-AA8B", "bid refused");
    run();
    const use = d.marketRouteUse();
    assert.deepEqual(use.get("X1-KG7-OK1"), { viable: 2, dead: 0 });
    assert.deepEqual(use.get("X1-KG7-AA8B"), { viable: 1, dead: 1 }, "a dead pair touches its destination too");
    assert.deepEqual(use.get("X1-KG7-DEAD"), { viable: 0, dead: 1 });
    assert.equal(use.get("X1-KG7-NOBODY"), undefined);
  });
});
