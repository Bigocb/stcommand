import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

/**
 * The round limit at its seam: the real dispatcher, two routes on separate sink markets, and trips recorded exactly as a
 * trader reports them. 2026-10-18, THEOREM-5 ran MEDICINE E52 > G58 four times in six minutes; rounds one and two beat
 * their promise, so only a count of trips (not a look at how they went) can hold that route back.
 */
const route = (good: string, sellAt: string, profit: number, buyAt = "X1-A-BUY") => ({
  good, buyAt, buySystem: "X1-A", buyPrice: 100,
  sellAt, sellSystem: "X1-A", sellPrice: 100 + profit,
  volume: 40, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0,
  profitPerTrip: profit, ageMinutes: 1,
});
const A = route("MEDICINE", "X1-A-M1", 900);
const B = route("MEDICINE", "X1-A-M2", 700);
const C = route("MEDICINE", "X1-A-M3", 500);
const tripOn = (r: ReturnType<typeof route>) => ({ good: r.good, buyAt: r.buyAt, sellAt: r.sellAt, promised: 1_000, made: 1_000 });

/** recompute's tuning is the 12th argument; everything between is an optional hook this case does not need. */
function run(d: RouteDispatcher, routes: ReturnType<typeof route>[], tuning?: { coolOffMin?: number; roundsMax?: number; buyRoundsMax?: number }) {
  d.recompute(routes, [{ shipSymbol: "T1", capacity: 40 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, tuning);
}

describe("the round limit rests a route that has run its trips", () => {
  it("stops offering route A after two trips and keeps offering the other route", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip(tripOn(A));
    d.recordTrip(tripOn(A));
    run(d, [A, B], { roundsMax: 2 });
    assert.deepEqual(d.routeList().map((r) => r.sellAt), ["X1-A-M2"], "A is resting, B is offered");
    assert.match(d.routeCoolOff(A.good, A.buyAt, A.sellAt) ?? "", /resting/);
    assert.match(d.routeCoolOff(A.good, A.buyAt, A.sellAt) ?? "", /2 trips/);
  });

  it("leaves routes with a trip left alone", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip(tripOn(A));
    d.recordTrip(tripOn(A));
    d.recordTrip(tripOn(B));
    run(d, [A, B, C], { roundsMax: 2 });
    assert.deepEqual(d.routeList().map((r) => r.sellAt), ["X1-A-M2", "X1-A-M3"], "B has one trip and C none: both still offered");
  });

  it("reopens the route once the oldest trip leaves the hour", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip(tripOn(A));
    t.mock.timers.tick(30 * 60_000);
    d.recordTrip(tripOn(A));
    run(d, [A, B], { roundsMax: 2 });
    assert.deepEqual(d.routeList().map((r) => r.sellAt), ["X1-A-M2"], "two trips inside the hour: resting");
    t.mock.timers.tick(31 * 60_000 + 1_000);   // the first trip is now older than 60 min; also passes recompute's throttle
    run(d, [A, B], { roundsMax: 2 });
    assert.equal(d.routeList()[0]!.sellAt, "X1-A-M1", "the hour has moved past the first trip: A is offered again");
    assert.equal(d.routeCoolOff(A.good, A.buyAt, A.sellAt), undefined);
  });
});

describe("with the clause off the dispatcher behaves exactly as before", () => {
  it("offers the same two-trip route it always did", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip(tripOn(A));
    d.recordTrip(tripOn(A));
    run(d, [A, B], { roundsMax: 0 });
    assert.equal(d.routeList()[0]!.sellAt, "X1-A-M1", "the higher-profit route is offered, as today");
    assert.equal(d.routeCoolOff(A.good, A.buyAt, A.sellAt), undefined);
  });

  it("still rests a disappointing route on the plain cool-off alone", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip({ ...tripOn(A), promised: 1_000, made: -500 });
    run(d, [A, B], { coolOffMin: 30, roundsMax: 0 });
    assert.deepEqual(d.routeList().map((r) => r.sellAt), ["X1-A-M2"]);
    assert.match(d.routeCoolOff(A.good, A.buyAt, A.sellAt) ?? "", /last trip made/);
  });

  it("names the cool-off, not the round limit, when a route is rested for both reasons", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTrip({ ...tripOn(A), promised: 1_000, made: -500 });
    d.recordTrip(tripOn(A));
    run(d, [A, B], { coolOffMin: 30, roundsMax: 2 });
    assert.match(d.routeCoolOff(A.good, A.buyAt, A.sellAt) ?? "", /last trip made/, "the cool-off is the first-defined reason");
  });
});

describe("the buy market limit rests a worn-down buy market whatever the sell market", () => {
  it("drops every route out of the buy market after trips on three different sell markets, and leaves another buy market open", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    const other = route("MEDICINE", "X1-A-M1", 800, "X1-A-OTHER");
    for (const r of [A, B, C]) d.recordTrip(tripOn(r));
    run(d, [A, B, C, other], { roundsMax: 2, buyRoundsMax: 3 });
    assert.deepEqual(d.routeList().map((r) => r.buyAt), ["X1-A-OTHER"], "no route has two trips, yet the shared buy market is resting");
    assert.match(d.routeCoolOff(A.good, A.buyAt, "X1-A-NEW") ?? "", /buy market resting/);
  });

  it("changes nothing at 0", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    for (const r of [A, B, C]) d.recordTrip(tripOn(r));
    run(d, [A, B, C], { roundsMax: 2, buyRoundsMax: 0 });
    assert.equal(d.routeList().length, 3);
  });
});
