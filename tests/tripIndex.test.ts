import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTripIndex } from "../src/engine/tripIndex.js";
import { coolOffReason, DEFAULT_HEAT_POLICY, type RouteTrip } from "../src/engine/routeHeat.js";
import { buyMarketRoundsReason, roundsReason } from "../src/engine/routeRounds.js";
import { spacingReason, type TripStart } from "../src/engine/tripSpacing.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

/** 2026-11-28: the route rest checks read an index built once per pass. Every check must answer as it did on the full list. */
const GOODS = ["FOOD", "CLOTHING", "MEDICINE"];
const MKTS = ["X1-A-1", "X1-A-2", "X1-B-1", "X1-B-2"];
const NOW = 10_000_000;

function rng(seed: number) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}
const pick = <T,>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)]!;

function data(seed: number) {
  const r = rng(seed);
  const trips: RouteTrip[] = [];
  const starts: TripStart[] = [];
  for (let i = 0; i < 200; i++) {
    trips.push({ good: pick(r, GOODS), buyAt: pick(r, MKTS), sellAt: pick(r, MKTS), promised: 1_000, made: Math.round(r() * 1_500), at: NOW - Math.round(r() * 3 * 3_600_000) });
    starts.push({ good: pick(r, GOODS), buyAt: pick(r, MKTS), shipSymbol: `T${Math.floor(r() * 5)}`, at: NOW - Math.round(r() * 3 * 3_600_000), price: 100 + Math.round(r() * 50) });
  }
  return { trips, starts };
}

describe("trip index", () => {
  it("gives every rest check the same answer as the full lists", () => {
    for (const seed of [1, 7, 42, 99]) {
      const { trips, starts } = data(seed);
      const idx = buildTripIndex(trips, starts);
      let resting = 0;
      for (const good of GOODS) for (const buyAt of MKTS) {
        for (const sellAt of MKTS) {
          for (const minutes of [0, 30, 120]) {
            const a = coolOffReason(trips, good, buyAt, sellAt, NOW, { ...DEFAULT_HEAT_POLICY, minutes });
            assert.equal(coolOffReason(idx.route(good, buyAt, sellAt), good, buyAt, sellAt, NOW, { ...DEFAULT_HEAT_POLICY, minutes }), a);
            if (a) resting++;
          }
          for (const maxRounds of [0, 2, 5]) {
            const pol = { maxRounds, windowMin: 60 };
            assert.equal(roundsReason(idx.route(good, buyAt, sellAt), good, buyAt, sellAt, NOW, pol), roundsReason(trips, good, buyAt, sellAt, NOW, pol));
          }
        }
        for (const maxRounds of [0, 3, 6]) {
          const pol = { maxRounds, windowMin: 60 };
          assert.equal(buyMarketRoundsReason(idx.buy(good, buyAt), good, buyAt, NOW, pol), buyMarketRoundsReason(trips, good, buyAt, NOW, pol));
        }
        for (const policy of [{ minGapMin: 0, autoPct: 0 }, { minGapMin: 30, autoPct: 10 }, { minGapMin: 90, autoPct: 1 }]) {
          for (const ask of [undefined, 120, 200]) {
            const rules = [{ good: "FOOD", at: "2026-11-28T00:00:00Z", buyAt: "X1-A-1", gapMin: 45 }];
            assert.equal(
              spacingReason(idx.starts(good, buyAt), good, buyAt, NOW, policy, rules, "T1", ask),
              spacingReason(starts, good, buyAt, NOW, policy, rules, "T1", ask),
            );
          }
        }
      }
      assert.ok(resting > 0, "the data should rest some routes, or the test proves nothing");
    }
  });

  it("returns an empty list for a route with no history", () => {
    const idx = buildTripIndex([], []);
    assert.deepEqual([...idx.route("FOOD", "X1-A-1", "X1-A-2")], []);
    assert.deepEqual([...idx.buy("FOOD", "X1-A-1")], []);
    assert.deepEqual([...idx.starts("FOOD", "X1-A-1")], []);
  });

  it("at the seam: the dispatcher's routeCoolOff answers the same with and without the index", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const d = new RouteDispatcher();
    const { trips } = data(5);
    for (const tr of trips.slice(0, 150)) d.recordTrip({ good: tr.good, buyAt: tr.buyAt, sellAt: tr.sellAt, promised: tr.promised, made: tr.made });
    for (let i = 0; i < 40; i++) d.recordTripStart(GOODS[i % 3]!, MKTS[i % 4]!, `T${i % 5}`, 100 + i);
    const dd = d as unknown as { coolOffMin: number; roundsMax: number; buyRoundsMax: number; spacingMin: number; spacingAutoPct: number; closedTrips: RouteTrip[]; tripStarts: TripStart[] };
    dd.coolOffMin = 60; dd.roundsMax = 4; dd.buyRoundsMax = 8; dd.spacingMin = 20; dd.spacingAutoPct = 0;
    const idx = buildTripIndex(dd.closedTrips, dd.tripStarts);
    let resting = 0;
    for (const good of GOODS) for (const buyAt of MKTS) for (const sellAt of MKTS) {
      const a = d.routeCoolOff(good, buyAt, sellAt);
      assert.equal(d.routeCoolOff(good, buyAt, sellAt, 60, undefined, idx), a);
      if (a) resting++;
    }
    assert.ok(resting > 0);
  });
});
