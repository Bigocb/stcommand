import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROUNDS_WINDOW_MIN, roundsReason } from "../src/engine/routeRounds.js";
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
