import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countWaypoints, judgeSystem } from "../src/engine/systemWorth.js";

const policy = { minMarkets: 5, minShipyards: 1 };

describe("judgeSystem", () => {
  it("accepts at least five markets and a shipyard", () => assert.equal(judgeSystem({ markets: 5, shipyards: 1 }, policy).good, true));
  it("rejects no shipyard, however many markets", () => {
    const v = judgeSystem({ markets: 16, shipyards: 0 }, policy);
    assert.equal(v.good, false);
    assert.match(v.reason, /0 shipyard/);
  });
  it("rejects four markets even with a shipyard", () => assert.equal(judgeSystem({ markets: 4, shipyards: 2 }, policy).good, false));
  it("reports both failures", () => assert.match(judgeSystem({ markets: 2, shipyards: 0 }, policy).reason, /shipyard.*market/));
  it("a minimum of 0 switches that criterion off; both 0 accepts everything", () => {
    assert.equal(judgeSystem({ markets: 9, shipyards: 0 }, { minMarkets: 5, minShipyards: 0 }).good, true);
    assert.equal(judgeSystem({ markets: 0, shipyards: 0 }, { minMarkets: 0, minShipyards: 0 }).good, true);
  });
});

describe("countWaypoints", () => {
  it("counts by trait, and a waypoint with both counts for both", () => {
    const wps = [{ traits: [{ symbol: "MARKETPLACE" }, { symbol: "SHIPYARD" }] }, { traits: [{ symbol: "MARKETPLACE" }] }, { traits: [{ symbol: "ASTEROID" }] }, {}];
    assert.deepEqual(countWaypoints(wps), { markets: 2, shipyards: 1 });
  });
});
