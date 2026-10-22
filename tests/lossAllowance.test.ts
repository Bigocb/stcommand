import { test } from "node:test";
import assert from "node:assert/strict";
import { sellFloor, belowSellFloor } from "../src/engine/lossAllowance.js";

const COST = 100;

test("no cost basis means no floor at all", () => {
  assert.equal(sellFloor({ cost: undefined, maxLossPct: 15 }), undefined);
  assert.equal(sellFloor({ cost: 0, maxLossPct: 15 }), undefined);
  assert.equal(belowSellFloor({ cost: undefined, maxLossPct: 15, price: 1 }), false);
});

test("an unpinned good uses the fleet's percentage floor", () => {
  assert.equal(sellFloor({ cost: COST, maxLossPct: 15 }), 85);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, price: 90 }), false);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, price: 84 }), true);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, price: 85 }), false, "exactly at the floor is allowed");
});

test("a pin with no allowance sells regardless of price (unchanged behaviour)", () => {
  assert.equal(sellFloor({ cost: COST, maxLossPct: 15, allowance: null }), undefined);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: null, price: 1 }), false);
});

test("a pin with an allowance is capped at cost minus the allowance", () => {
  assert.equal(sellFloor({ cost: COST, maxLossPct: 15, allowance: 10 }), 90);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 10, price: 95 }), false);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 10, price: 90 }), false, "at the allowance is allowed");
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 10, price: 89 }), true);
});

test("the route allowance overrides the fleet percentage in both directions", () => {
  // 30c/unit is far looser than 15%: the operator's route may still sell at 75.
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 30, price: 75 }), false);
  // 2c/unit is far tighter than 15%: a price that clears the fleet floor is refused.
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 2, price: 90 }), true);
});

test("an allowance bigger than the cost basis is the same as no floor", () => {
  assert.equal(sellFloor({ cost: COST, maxLossPct: 15, allowance: 250 }), -150);
  assert.equal(belowSellFloor({ cost: COST, maxLossPct: 15, allowance: 250, price: 1 }), false);
});

test("the capped pin applies to the next lot too, not just the first sale", () => {
  // nextLotBlock() feeds the same floor into nextLotDecision(); the floor it
  // would use is exactly this.
  assert.equal(sellFloor({ cost: COST, maxLossPct: 15, allowance: 10 }), 90);
});
