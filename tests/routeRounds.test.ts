import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROUNDS_WINDOW_MIN, buyMarketRoundsReason, roundsReason } from "../src/engine/routeRounds.js";
import { Doctrine } from "../src/engine/doctrine.js";
import type { RouteTrip } from "../src/engine/routeHeat.js";

/**
 * THEOREM-5, 2026-10-18: MEDICINE E52 > G58 four times in six minutes. Rounds one and two beat their promise, so the
 * cool-off had nothing to say; the market takes a median of 124 minutes to recover. The round limit counts trips on the
 * route itself, because the market does not care which ship ran them.
 */
const NOW = 2_000_000_000;   // ms
const MIN = 60_000;
const trip = (over: Partial<RouteTrip> = {}): RouteTrip =>
  ({ good: "MEDICINE", buyAt: "X1-E52", sellAt: "X1-G58", promised: 24_000, made: 24_000, at: NOW - 10 * MIN, ...over });
const POLICY = { maxRounds: 2, windowMin: ROUNDS_WINDOW_MIN };

describe("roundsReason: trips per route in a window, whoever runs them", () => {
  it("lets a route run while it is under the limit", () => {
    assert.equal(roundsReason([], "MEDICINE", "X1-E52", "X1-G58", NOW, POLICY), undefined);
    assert.equal(roundsReason([trip()], "MEDICINE", "X1-E52", "X1-G58", NOW, POLICY), undefined);
  });

  it("rests the route once the limit is reached, until the oldest counted trip leaves the window", () => {
    const trips = [trip({ at: NOW - 30 * MIN }), trip({ at: NOW - 10 * MIN })];
    const why = roundsReason(trips, "MEDICINE", "X1-E52", "X1-G58", NOW, POLICY) ?? "";
    assert.match(why, /resting/);
    assert.match(why, /2 trips/);
    assert.match(why, /resting 30 more min/);
  });

  it("reopens the route when the older trip has left the window", () => {
    const trips = [trip({ at: NOW - 61 * MIN }), trip({ at: NOW - 10 * MIN })];
    assert.equal(roundsReason(trips, "MEDICINE", "X1-E52", "X1-G58", NOW, POLICY), undefined);
  });

  it("counts only this good and this exact buy-to-sell route", () => {
    const trips = [trip({ at: NOW - 30 * MIN }), trip({ at: NOW - 10 * MIN })];
    assert.equal(roundsReason(trips, "MEDICINE", "X1-E52", "X1-H60", NOW, POLICY), undefined, "different sell market");
    assert.equal(roundsReason(trips, "MEDICINE", "X1-E51", "X1-G58", NOW, POLICY), undefined, "different buy market");
    assert.equal(roundsReason(trips, "FOOD", "X1-E52", "X1-G58", NOW, POLICY), undefined, "different good");
  });

  it("counts trips by different ships as the same route", () => {
    const trips = [trip({ at: NOW - 40 * MIN }), trip({ at: NOW - 20 * MIN }), trip({ at: NOW - 5 * MIN })];
    assert.match(roundsReason(trips, "MEDICINE", "X1-E52", "X1-G58", NOW, POLICY) ?? "", /3 trips/);
  });

  it("is off at maxRounds 0, and with no window", () => {
    const trips = [trip({ at: NOW - 30 * MIN }), trip({ at: NOW - 10 * MIN })];
    assert.equal(roundsReason(trips, "MEDICINE", "X1-E52", "X1-G58", NOW, { maxRounds: 0, windowMin: ROUNDS_WINDOW_MIN }), undefined);
    assert.equal(roundsReason(trips, "MEDICINE", "X1-E52", "X1-G58", NOW, { maxRounds: 2, windowMin: 0 }), undefined);
  });
});

describe("the two buy-guard clauses", () => {
  it("exist in the catalog, shipped off, with the plan's first values", async () => {
    const d = new Doctrine();   // no store: reads the code defaults, needs no database
    await d.reload();
    for (const key of ["buyGuardImpactPct", "routeRoundsMax"]) {
      const rule = d.list().find((r) => r.key === key);
      assert.ok(rule, `${key} missing from the catalog`);
      assert.equal(rule.enabled, false, `${key} must ship off`);
    }
    assert.equal(d.value("buyGuardImpactPct", 0), 0, "off means off whatever the value says");
    assert.equal(d.value("routeRoundsMax", 0), 0);
    assert.equal(d.isEnabledOr("buyGuardImpactPct", false), false);
    assert.equal(d.isEnabledOr("routeRoundsMax", false), false);
  });
});

describe("buyMarketRoundsReason: trips per BUY market, whatever they sell into", () => {
  const policy = { maxRounds: 3, windowMin: ROUNDS_WINDOW_MIN };
  const three = [trip({ sellAt: "X1-S1", at: NOW - 40 * MIN }), trip({ sellAt: "X1-S2", at: NOW - 20 * MIN }), trip({ sellAt: "X1-S3", at: NOW - 5 * MIN })];

  it("rests the buy market once trips on different sell markets reach the limit, which the route limit never sees", () => {
    const why = buyMarketRoundsReason(three, "MEDICINE", "X1-E52", NOW, policy) ?? "";
    assert.match(why, /buy market resting 20 more min/);
    assert.match(why, /3 trips bought MEDICINE at X1-E52/);
    assert.equal(roundsReason(three, "MEDICINE", "X1-E52", "X1-S1", NOW, { maxRounds: 2, windowMin: ROUNDS_WINDOW_MIN }), undefined, "every route is under its own limit");
  });

  it("lets the market run under the limit, once the oldest trip has left the hour, and for other goods and buy markets", () => {
    assert.equal(buyMarketRoundsReason(three.slice(1), "MEDICINE", "X1-E52", NOW, policy), undefined);
    assert.equal(buyMarketRoundsReason([{ ...three[0]!, at: NOW - 61 * MIN }, three[1]!, three[2]!], "MEDICINE", "X1-E52", NOW, policy), undefined);
    assert.equal(buyMarketRoundsReason(three, "FOOD", "X1-E52", NOW, policy), undefined);
    assert.equal(buyMarketRoundsReason(three, "MEDICINE", "X1-E51", NOW, policy), undefined);
  });

  it("is off at 0", () => {
    assert.equal(buyMarketRoundsReason(three, "MEDICINE", "X1-E52", NOW, { maxRounds: 0, windowMin: ROUNDS_WINDOW_MIN }), undefined);
  });
});
