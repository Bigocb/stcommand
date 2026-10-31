import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { floorSaleAutoApprove, NO_FLOOR_AUTO_APPROVE } from "../src/engine/floorSaleApproval.js";

const on = { enabled: true, minSharePct: 40, maxLossCredits: 600_000 };

describe("floorSaleAutoApprove (pure)", () => {
  it("off reproduces today's behaviour: every below-floor sale asks", () => {
    assert.equal(floorSaleAutoApprove({ live: 14_727, cost: 28_380, units: 36 }, NO_FLOOR_AUTO_APPROVE).approve, false);
    assert.equal(floorSaleAutoApprove({ live: 14_727, cost: 28_380, units: 36 }, { ...on, enabled: false }).approve, false);
  });
  it("approves a real price within the caps (THEO-1AE: 52% of cost, 492k loss)", () => {
    const d = floorSaleAutoApprove({ live: 14_727, cost: 28_380.33, units: 36 }, on);
    assert.equal(d.approve, true);
  });
  it("refuses a market paying next to nothing (THEO-9E: 1c on 17,851c)", () => {
    const d = floorSaleAutoApprove({ live: 1, cost: 17_851, units: 30 }, on);
    assert.equal(d.approve, false);
    assert.match(d.reason, /minimum/);
  });
  it("refuses a loss over the credit cap even at a fair share", () => {
    const d = floorSaleAutoApprove({ live: 6_000, cost: 10_000, units: 200 }, on); // 60% but 800k loss
    assert.equal(d.approve, false);
    assert.match(d.reason, /cap/);
  });
  it("0 credit cap means no cap; unknown cost or a bad quote asks", () => {
    assert.equal(floorSaleAutoApprove({ live: 6_000, cost: 10_000, units: 200 }, { ...on, maxLossCredits: 0 }).approve, true);
    assert.equal(floorSaleAutoApprove({ live: 6_000, cost: undefined, units: 5 }, on).approve, false);
    assert.equal(floorSaleAutoApprove({ live: 0, cost: 10_000, units: 5 }, on).approve, false);
  });
});

import { readFileSync } from "node:fs";
it("traderOptions() hands every trader the floor-sale policy", () => {
  const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");
  const start = src.indexOf("private traderOptions(");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(body, /floorSalePolicy:/);
});
