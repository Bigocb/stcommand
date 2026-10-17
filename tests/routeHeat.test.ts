import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coolOffReason, DEFAULT_HEAT_POLICY, disappointed, type RouteTrip } from "../src/engine/routeHeat.js";

const T0 = 1_000_000_000;
const trip = (over: Partial<RouteTrip> = {}): RouteTrip => ({ good: "FABRICS", buyAt: "A", sellAt: "B", promised: 100_000, made: -161_000, at: T0, ...over });

describe("routeHeat", () => {
  it("a losing trip rests its exact route for the policy minutes, then reopens", () => {
    assert.match(coolOffReason([trip()], "FABRICS", "A", "B", T0 + 60_000, DEFAULT_HEAT_POLICY) ?? "", /resting 29 more min/);
    assert.equal(coolOffReason([trip()], "FABRICS", "A", "B", T0 + 31 * 60_000, DEFAULT_HEAT_POLICY), undefined);
  });
  it("a different buy, sell or good is untouched", () => {
    assert.equal(coolOffReason([trip()], "FABRICS", "A", "C", T0, DEFAULT_HEAT_POLICY), undefined);
    assert.equal(coolOffReason([trip()], "FABRICS", "X", "B", T0, DEFAULT_HEAT_POLICY), undefined);
    assert.equal(coolOffReason([trip()], "IRON", "A", "B", T0, DEFAULT_HEAT_POLICY), undefined);
  });
  it("a trip near its promise does not rest the route; 40% of it is the line", () => {
    assert.equal(disappointed({ promised: 100, made: 39 }, DEFAULT_HEAT_POLICY), true);
    assert.equal(disappointed({ promised: 100, made: 40 }, DEFAULT_HEAT_POLICY), false);
    assert.equal(coolOffReason([trip({ made: 90_000 })], "FABRICS", "A", "B", T0, DEFAULT_HEAT_POLICY), undefined);
  });
  it("only the latest trip counts, so a recovered route reopens", () => {
    const trips = [trip(), trip({ made: 95_000, at: T0 + 1000 })];
    assert.equal(coolOffReason(trips, "FABRICS", "A", "B", T0 + 2000, DEFAULT_HEAT_POLICY), undefined);
  });
  it("minutes 0 reproduces today's behaviour; no promise on record never rests", () => {
    assert.equal(coolOffReason([trip()], "FABRICS", "A", "B", T0, { minutes: 0, minShare: 0.4 }), undefined);
    assert.equal(coolOffReason([trip({ promised: 0 })], "FABRICS", "A", "B", T0, DEFAULT_HEAT_POLICY), undefined);
  });
});
