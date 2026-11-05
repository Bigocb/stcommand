import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeFit, NO_FIT_RULE } from "../src/engine/routeFit.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { selectExplain } from "../src/engine/dispatchExplain.js";

const policy = { bigHold: 150, minTrip: 10_000 };

describe("routeFit", () => {
  it("lets a big hull take a route that pays the minimum", () => {
    assert.equal(routeFit(10_000, 225, policy).ok, true);
  });
  it("refuses a big hull a route below the minimum, with the reason", () => {
    const v = routeFit(4_344, 225, policy);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /too small a prize for a 225-unit hull: 4344 a trip, needs 10000/);
  });
  it("never restricts a hull under the big-hold size", () => {
    assert.equal(routeFit(500, 80, policy).ok, true);
  });
  it("a minimum of 0 (clause off) restricts nothing", () => {
    assert.equal(routeFit(1, 225, { bigHold: 150, minTrip: 0 }).ok, true);
    assert.equal(routeFit(1, 225, NO_FIT_RULE).ok, true);
  });
});

/** The seam: the dispatcher hands a heavy the route that fits, falls back when none does, and says why. */
const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt,
  buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 10, sellPrice: 100, profitPerTrip: profit,
} as unknown as DispatchRoute);

function run(routes: DispatchRoute[], capacity: number, fit: { fitMinTrip: number; fitBigHold: number }) {
  const d = new RouteDispatcher();
  d.recompute(routes, [{ shipSymbol: "T-1", capacity, system: "X1-A" }], [], [], [], [], () => false, () => 0, undefined, undefined, undefined, fit);
  return d;
}

describe("route fit in the dispatcher", () => {
  const on = { fitMinTrip: 10_000, fitBigHold: 150 };
  const small = route("ORE", "X1-A-B1", "X1-A-C2", 4_000);
  const rich = route("DRUGS", "X1-A-D3", "X1-A-E4", 30_000);

  it("gives a heavy the route that fits even when a smaller one is nearer or scores higher", () => {
    // The small route is listed first; without the rule the best score wins, with it only the 30k route is eligible.
    const d = run([small, rich], 225, on);
    assert.equal(d.assignmentFor("T-1")?.good, "DRUGS");
  });

  it("falls back to the best route that does not fit, rather than idling the hull, and says so", () => {
    const d = run([small], 225, on);
    assert.equal(d.assignmentFor("T-1")?.good, "ORE");
    const t = selectExplain(d.explain()!, { ship: "T-1" }).traders[0]!;
    assert.match(t.fitFallback ?? "", /no route met the minimum for this hull; took ORE/);
  });

  it("shows the refusal for each route that did not fit", () => {
    const d = run([small, rich], 225, on);
    const t = selectExplain(d.explain()!, { ship: "T-1" }).traders[0]!;
    assert.ok(t.rejected.some((r) => r.good === "ORE" && /too small a prize for a 225-unit hull/.test(r.reason)));
    assert.equal(t.fitFallback, undefined);
  });

  it("does not touch a small hull", () => {
    const d = run([small], 80, on);
    assert.equal(d.assignmentFor("T-1")?.good, "ORE");
    assert.equal(selectExplain(d.explain()!, { ship: "T-1" }).traders[0]!.fitFallback, undefined);
  });

  it("with the clause off (minimum 0) behaves as before", () => {
    const d = run([small], 225, { fitMinTrip: 0, fitBigHold: 150 });
    assert.equal(d.assignmentFor("T-1")?.good, "ORE");
  });
});
