import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askDriftPct, parseSpaced, ruleFor, spaceRoute, spacingReason, unspaceRoute, type SpacedRoute } from "../src/engine/tripSpacing.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const NOW = 10_000_000;
const MIN = 60_000;
const start = (minAgo: number, over: Partial<{ good: string; buyAt: string; shipSymbol: string; price: number }> = {}) =>
  ({ good: "FABRICS", buyAt: "X1-A-E49", shipSymbol: "S1", at: NOW - minAgo * MIN, ...over });
const POLICY = { minGapMin: 30, autoPct: 0 };
const RULE: SpacedRoute = { good: "FABRICS", at: "" };

describe("trip spacing: the pure rule, per route", () => {
  it("spaces nothing without a rule: a start alone rests no one", () => {
    assert.equal(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, []), undefined);
  });

  it("rests the buy market for the gap after a trip started there, when a rule names the good", () => {
    const why = spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, [RULE]);
    assert.match(why ?? "", /spacing \(operator rule\)/);
    assert.match(why ?? "", /4 min ago/);
    assert.match(why ?? "", /next may start in 26 min/);
  });

  it("lets a trip start once the gap has passed", () => {
    assert.equal(spacingReason([start(31)], "FABRICS", "X1-A-E49", NOW, POLICY, [RULE]), undefined);
  });

  it("a rule is for its own good; another good at the same market is untouched", () => {
    assert.equal(spacingReason([start(4, { good: "CLOTHING" })], "CLOTHING", "X1-A-E49", NOW, POLICY, [RULE]), undefined);
  });

  it("a rule with a buy market covers only that market; one without covers every market for the good", () => {
    const here: SpacedRoute = { good: "FABRICS", buyAt: "X1-A-E49", at: "" };
    assert.match(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, [here]) ?? "", /spacing/);
    assert.equal(spacingReason([start(4, { buyAt: "X1-A-OTHER" })], "FABRICS", "X1-A-OTHER", NOW, POLICY, [here]), undefined);
    assert.match(spacingReason([start(4, { buyAt: "X1-A-OTHER" })], "FABRICS", "X1-A-OTHER", NOW, POLICY, [RULE]) ?? "", /spacing/);
  });

  it("a rule's own gap replaces the default", () => {
    const long: SpacedRoute = { good: "FABRICS", gapMin: 90, at: "" };
    assert.match(spacingReason([start(45)], "FABRICS", "X1-A-E49", NOW, POLICY, [long]) ?? "", /gap 90 min/);
    assert.equal(spacingReason([start(45)], "FABRICS", "X1-A-E49", NOW, POLICY, [RULE]), undefined, "the 30-minute default has passed");
  });

  it("never rests the ship that made the start", () => {
    assert.equal(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, [RULE], "S1"), undefined);
    assert.match(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, [RULE], "S2") ?? "", /spacing/);
  });

  it("is off at 0 minutes, whatever the rules say: today's behaviour", () => {
    assert.equal(spacingReason([start(1)], "FABRICS", "X1-A-E49", NOW, { minGapMin: 0, autoPct: 10 }, [RULE], undefined, 9_999), undefined);
  });
});

describe("trip spacing: the automatic trigger", () => {
  const AUTO = { minGapMin: 30, autoPct: 10 };
  const lowStart = start(120, { price: 2_000 });
  const recent = start(4, { price: 2_100, shipSymbol: "S2" });

  it("spaces a route whose live ask stands 10% or more above our lowest recent buy there", () => {
    const why = spacingReason([lowStart, recent], "FABRICS", "X1-A-E49", NOW, AUTO, [], undefined, 2_300);
    assert.match(why ?? "", /auto: the ask is 15% above/);
    assert.match(why ?? "", /4 min ago/);
  });

  it("lifts itself when the ask comes back down", () => {
    assert.equal(spacingReason([lowStart, recent], "FABRICS", "X1-A-E49", NOW, AUTO, [], undefined, 2_150), undefined);
  });

  it("needs history and a live ask: no start price, no ask, no spacing", () => {
    assert.equal(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, AUTO, [], undefined, 2_300), undefined, "starts carry no price");
    assert.equal(spacingReason([lowStart, recent], "FABRICS", "X1-A-E49", NOW, AUTO, [], undefined, undefined), undefined, "no live ask");
    assert.equal(askDriftPct([], "FABRICS", "X1-A-E49", 2_300), undefined);
  });

  it("is off at autoPct 0: only operator rules space", () => {
    assert.equal(spacingReason([lowStart, recent], "FABRICS", "X1-A-E49", NOW, { minGapMin: 30, autoPct: 0 }, [], undefined, 2_300), undefined);
  });

  it("an operator rule takes the place of the auto trigger", () => {
    const why = spacingReason([lowStart, recent], "FABRICS", "X1-A-E49", NOW, AUTO, [{ good: "FABRICS", gapMin: 60, at: "" }], undefined, 2_000);
    assert.match(why ?? "", /operator rule/, "the ask is at the low (no drift), the rule still spaces it");
    assert.match(why ?? "", /gap 60 min/);
  });
});

describe("trip spacing: the rule list", () => {
  it("adds, replaces, finds and removes rules, validating names", () => {
    let list = spaceRoute([], "clothing", "t1", { reason: "chain rest" });
    assert.deepEqual(list.map((r) => [r.good, r.buyAt, r.reason]), [["CLOTHING", undefined, "chain rest"]]);
    list = spaceRoute(list, "CLOTHING", "t2", { buyAt: "x1-uz49-k88", gapMin: 45 });
    assert.equal(list.length, 2, "a market-specific rule sits beside the good-wide one");
    assert.equal(ruleFor(list, "CLOTHING", "X1-UZ49-K88")?.gapMin, 45, "the market rule wins at its market");
    assert.equal(ruleFor(list, "CLOTHING", "X1-UZ49-A1")?.gapMin, undefined, "elsewhere the good-wide rule applies");
    list = spaceRoute(list, "CLOTHING", "t3", { buyAt: "X1-UZ49-K88", gapMin: 20 });
    assert.equal(list.length, 2, "same good and market replaces");
    list = unspaceRoute(list, "CLOTHING", "X1-UZ49-K88");
    assert.deepEqual(list.map((r) => r.buyAt), [undefined]);
    assert.deepEqual(unspaceRoute(list, "CLOTHING"), []);
    assert.throws(() => spaceRoute([], "not a good!", "t"), /not a trade symbol/);
    assert.throws(() => spaceRoute([], "CLOTHING", "t", { gapMin: 0 }), /gapMin/);
  });

  it("round-trips through the saved JSON and drops junk", () => {
    const saved = JSON.stringify(spaceRoute([], "FABRICS", "t", { buyAt: "X1-UZ49-E49", gapMin: 40 }));
    assert.deepEqual(parseSpaced(saved).map((r) => [r.good, r.buyAt, r.gapMin]), [["FABRICS", "X1-UZ49-E49", 40]]);
    assert.deepEqual(parseSpaced("not json"), []);
    assert.deepEqual(parseSpaced(JSON.stringify([{ good: 5 }, { good: "lower case ok" }])).map((r) => r.good), ["LOWER_CASE_OK"]);
  });
});

const route = (good: string, sellAt: string, profit: number, buyPrice = 100) => ({
  good, buyAt: "X1-A-E49", buySystem: "X1-A", buyPrice,
  sellAt, sellSystem: "X1-A", sellPrice: buyPrice + profit,
  volume: 40, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0,
  profitPerTrip: profit, ageMinutes: 1,
});

describe("trip spacing at the dispatcher seam", () => {
  const F1 = route("FABRICS", "X1-A-S1", 900);
  const F2 = route("FABRICS", "X1-A-S2", 700);
  const C = route("CLOTHING", "X1-A-S3", 500);
  function run(d: RouteDispatcher, routes: ReturnType<typeof route>[], tuning?: { spacingMin?: number; spacingAutoPct?: number }) {
    d.recompute(routes, [{ shipSymbol: "T1", capacity: 40 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, tuning);
  }

  it("spaces only the routes with a rule: FABRICS rests, CLOTHING from the same market does not", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.setSpacedRoutes([{ good: "FABRICS", at: "" }]);
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    d.recordTripStart("CLOTHING", "X1-A-E49", "T9", 100);
    run(d, [F1, F2, C], { spacingMin: 30 });
    assert.deepEqual(d.routeList().map((r) => r.good), ["CLOTHING"]);
  });

  it("with the clause on and no rule nothing is spaced, however many trips just started", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    run(d, [F1, F2, C], { spacingMin: 30 });
    assert.equal(d.routeList().length, 3);
  });

  it("the automatic trigger spaces a route whose ask our buying has lifted, and lets go when it falls", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    t.mock.timers.tick(10 * MIN);
    d.recordTripStart("FABRICS", "X1-A-E49", "T8", 112);
    t.mock.timers.tick(MIN);
    run(d, [route("FABRICS", "X1-A-S1", 900, 114), C], { spacingMin: 30, spacingAutoPct: 10 });
    assert.deepEqual(d.routeList().map((r) => r.good), ["CLOTHING"], "ask 114 is 14% above our low of 100");
    assert.deepEqual(d.spacingView().auto.map((a) => [a.good, a.driftPct]), [["FABRICS", 14]]);
    t.mock.timers.tick(MIN);
    run(d, [route("FABRICS", "X1-A-S1", 900, 105), C], { spacingMin: 30, spacingAutoPct: 10 });
    assert.deepEqual(d.routeList().map((r) => r.good).sort(), ["CLOTHING", "FABRICS"], "ask 105 is only 5% above: let go");
    assert.deepEqual(d.spacingView().auto, []);
  });

  it("leaves the starting ship's own check alone but rests everyone else", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.setSpacedRoutes([{ good: "FABRICS", at: "" }]);
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    run(d, [F1], { spacingMin: 30 });
    assert.equal(d.routeCoolOff("FABRICS", "X1-A-E49", "X1-A-S1", undefined, "T9"), undefined);
    assert.match(d.routeCoolOff("FABRICS", "X1-A-E49", "X1-A-S1", undefined, "T2") ?? "", /spacing/);
  });

  it("reopens after the gap", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.setSpacedRoutes([{ good: "FABRICS", at: "" }]);
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    t.mock.timers.tick(31 * MIN);
    run(d, [F1], { spacingMin: 30 });
    assert.deepEqual(d.routeList().map((r) => r.good), ["FABRICS"]);
  });

  it("with the clause off (0 or no tuning) the list is exactly as before, rules or not", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.setSpacedRoutes([{ good: "FABRICS", at: "" }]);
    d.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    run(d, [F1, F2, C], { spacingMin: 0, spacingAutoPct: 10 });
    assert.equal(d.routeList().length, 3);
    const e = new RouteDispatcher();
    e.setSpacedRoutes([{ good: "FABRICS", at: "" }]);
    e.recordTripStart("FABRICS", "X1-A-E49", "T9", 100);
    run(e, [F1, F2, C]);
    assert.equal(e.routeList().length, 3);
  });
});
