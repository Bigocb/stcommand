import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_CATALOG } from "../src/engine/doctrine.js";
import { MAX_LOTS_PER_TRIP } from "../src/engine/dispatcher.js";

// The per-trip lot cap used to be a hard-coded 3; it is now a doctrine rule so it can grow with hold size
// (a hull with 150 cargo needs 7+ lots on an 18-unit market) and shows in the dashboard like any other rule.
describe("maxLotsPerTrip doctrine rule", () => {
  const rule = DOCTRINE_CATALOG.find((d) => d.key === "maxLotsPerTrip");

  it("exists, adopted by default, and defaults to the old constant so nothing changes until it is edited", () => {
    assert.ok(rule, "maxLotsPerTrip is in the catalog");
    assert.equal(rule!.value, MAX_LOTS_PER_TRIP);
    assert.equal(rule!.defaultAdopted, true);
    assert.equal(rule!.enabled, true);
  });

  it("allows whole lots from 1 up to a hold-sized ceiling", () => {
    assert.equal(rule!.min, 1);
    assert.equal(rule!.step, 1);
    assert.ok(rule!.max >= 8, "room for a 150-unit hull on small lots");
  });
});
