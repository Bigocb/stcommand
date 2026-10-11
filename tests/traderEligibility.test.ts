import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchExclusion, type TraderFacts } from "../src/engine/traderEligibility.js";

const base: TraderFacts = {
  symbol: "T-1", isWarehouse: false, held: false, restoredHold: false, suspended: false,
  scrapping: false, cargoUnits: 0, availableForAuto: true,
};

test("a free trader is considered", () => assert.equal(dispatchExclusion(base), undefined));
test("warehouse ship", () => assert.match(dispatchExclusion({ ...base, isWarehouse: true })!, /warehouse/));
test("operator hold", () => assert.match(dispatchExclusion({ ...base, held: true, availableForAuto: false })!, /held by the operator/));
test("restored hold is named as such", () =>
  assert.match(dispatchExclusion({ ...base, held: true, restoredHold: true, availableForAuto: false })!, /replayed when the server booted/));
test("suspended", () => assert.match(dispatchExclusion({ ...base, suspended: true, availableForAuto: false })!, /suspended/));
test("claimed by another owner names it and the intent", () =>
  assert.equal(dispatchExclusion({ ...base, claimOwner: "mission", claimIntent: "supply X", availableForAuto: false }), "claimed by mission (supply X)"));
test("a loaded trader claimed as trading stays in", () =>
  assert.equal(dispatchExclusion({ ...base, claimOwner: "trading", cargoUnits: 5, availableForAuto: false }), undefined));
test("scrapping with an empty hold is out, loaded stays", () => {
  assert.match(dispatchExclusion({ ...base, scrapping: true })!, /scrapped/);
  assert.equal(dispatchExclusion({ ...base, scrapping: true, cargoUnits: 3 }), undefined);
});
