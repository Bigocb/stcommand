import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRIP_HISTORY_KEEP_MS, mergeTripHistory, packTripHistory, unpackTripHistory } from "../src/engine/tripHistory.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const NOW = 1_800_000_000_000;
const trip = (at: number, good = "IRON") => ({ good, buyAt: "X1-UU52-EX7A", sellAt: "X1-UU52-F12C", promised: 1500, made: 1400, at });
const start = (at: number, good = "IRON") => ({ good, buyAt: "X1-UU52-EX7A", shipSymbol: "THEO-33", at, price: 106 });

describe("tripHistory (pure)", () => {
  it("round-trips trips and starts", () => {
    const h = { trips: [trip(NOW - 60_000)], starts: [start(NOW - 90_000)] };
    const back = unpackTripHistory(packTripHistory(h, NOW), NOW);
    assert.deepEqual({ trips: back.trips, starts: back.starts }, h);
  });
  it("drops rows outside the keep window, from the future, and malformed ones", () => {
    const json = JSON.stringify({
      trips: [trip(NOW - TRIP_HISTORY_KEEP_MS - 1), trip(NOW + 1), { good: "IRON" }, trip(NOW - 1000)],
      starts: [start(NOW - TRIP_HISTORY_KEEP_MS - 1), { ...start(NOW - 10), shipSymbol: "" }, start(NOW - 5)],
    });
    const h = unpackTripHistory(json, NOW);
    assert.equal(h.trips.length, 1);
    assert.equal(h.starts.length, 1);
  });
  it("bad JSON gives an empty history", () => {
    assert.deepEqual(unpackTripHistory("{not json", NOW), { trips: [], starts: [] });
  });
  it("merge keeps saved rows older than the first live row, then the live rows, in time order", () => {
    const a = trip(NOW - 3000), b = trip(NOW - 2000), c = trip(NOW - 1000);
    const m = mergeTripHistory({ trips: [a, b], starts: [] }, { trips: [b, c], starts: [] });
    assert.deepEqual(m.trips.map((t) => t.at), [a.at, b.at, c.at]);
  });
  it("two trips closed in the same millisecond both count", () => {
    const m = mergeTripHistory({ trips: [trip(NOW), trip(NOW)], starts: [] }, { trips: [], starts: [] });
    assert.equal(m.trips.length, 2);
  });
});

describe("the dispatcher keeps its route rests across a restart (2026-11-19, THEO-33 IRON after the 13:33 deploy)", () => {
  it("two trips, a restart, and the route is still resting under the round limit", () => {
    const tuning = { roundsMax: 2 };
    const before = new RouteDispatcher();
    before.recompute([], [], [], [], [], [], () => true, () => 0, undefined, undefined, undefined, tuning);
    before.recordTrip({ good: "IRON", buyAt: "X1-UU52-EX7A", sellAt: "X1-UU52-F12C", promised: 1500, made: 1400 });
    before.recordTrip({ good: "IRON", buyAt: "X1-UU52-EX7A", sellAt: "X1-UU52-F12C", promised: 1500, made: 1400 });
    assert.match(before.routeCoolOff("IRON", "X1-UU52-EX7A", "X1-UU52-F12C", 0) ?? "", /resting/);
    const saved = before.tripHistorySnapshot();
    assert.ok(saved, "a snapshot after trips");
    assert.equal(before.tripHistorySnapshot(), undefined, "nothing new: no write");

    const without = new RouteDispatcher();
    without.recompute([], [], [], [], [], [], () => true, () => 0, undefined, undefined, undefined, tuning);
    assert.equal(without.routeCoolOff("IRON", "X1-UU52-EX7A", "X1-UU52-F12C", 0), undefined, "the old behaviour: a restart forgets");

    const after = new RouteDispatcher();
    after.recompute([], [], [], [], [], [], () => true, () => 0, undefined, undefined, undefined, tuning);
    assert.equal(after.restoreTripHistory(saved!), 2);
    assert.match(after.routeCoolOff("IRON", "X1-UU52-EX7A", "X1-UU52-F12C", 0) ?? "", /resting \d+ more min: 2 trips/);
  });
});

describe("the rest of the dispatcher's decision memory survives a restart (operator rule 2026-11-19)", () => {
  it("recent sales and declined legs round-trip; expired declines and old sales are dropped", () => {
    const h = {
      trips: [], starts: [],
      sales: [["IRON@X1-UU52-F12C", [{ units: 40, at: NOW - 60_000 }, { units: 40, at: NOW - TRIP_HISTORY_KEEP_MS - 1 }]]] as [string, { units: number; at: number }[]][],
      declined: [["THEO-33", { good: "IRON", buyAt: "A", sellAt: "B", wholeGood: false, until: NOW + 60_000 }], ["THEO-1", { good: "FOOD", wholeGood: true, until: NOW - 1 }]] as [string, { good: string; buyAt?: string; sellAt?: string; wholeGood: boolean; until: number }][],
    };
    const back = unpackTripHistory(packTripHistory(h, NOW), NOW);
    assert.deepEqual(back.sales, [["IRON@X1-UU52-F12C", [{ units: 40, at: NOW - 60_000 }]]]);
    assert.deepEqual(back.declined?.map(([s]) => s), ["THEO-33"]);
  });
  it("a saved flag from before sales/declines were kept still loads", () => {
    const back = unpackTripHistory(JSON.stringify({ trips: [trip(NOW - 10)], starts: [] }), NOW);
    assert.equal(back.trips.length, 1);
    assert.deepEqual(back.sales, []);
    assert.deepEqual(back.declined, []);
  });
  it("every change calls the save hook at once, and a failed save stays pending", () => {
    const d = new RouteDispatcher();
    let calls = 0;
    d.setOnMemoryChange(() => { calls++; });
    d.recordTrip({ good: "IRON", buyAt: "A", sellAt: "B", promised: 1, made: 1 });
    d.recordTripStart("IRON", "A", "S1", 100);
    d.recordSale("IRON", "B", 40, 145);
    assert.equal(calls, 3);
    assert.ok(d.tripHistorySnapshot());
    assert.equal(d.tripHistorySnapshot(), undefined);
    d.markMemoryUnsaved();
    assert.ok(d.tripHistorySnapshot(), "after a failed save the next attempt writes again");
  });
  it("recent sales come back after a restart, merged with sales since the boot", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW - 120_000 });
    const a = new RouteDispatcher();
    a.recordSale("IRON", "B", 40, 145);
    t.mock.timers.tick(60_000);
    const saved = a.tripHistorySnapshot()!;
    const b = new RouteDispatcher();
    b.recordSale("IRON", "B", 30, 144);
    assert.ok(b.restoreTripHistory(saved) >= 1);
    const json = JSON.parse(b.tripHistorySnapshot()!);
    assert.equal(json.sales[0][1].length, 2);
  });
});
