import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { traderShouldRecord } from "../src/engine/traderRecord.js";

const MIN = 60_000;
describe("traderShouldRecord", () => {
  const covered = { keeperCovered: true, snapshotAgeMs: 3 * MIN, skipWithinMs: 10 * MIN };
  it("skips a recent snapshot at a keeper-covered market", () => {
    assert.equal(traderShouldRecord(covered).record, false);
  });
  it("records when the clause is off (0 window), whatever else is true", () => {
    assert.equal(traderShouldRecord({ ...covered, skipWithinMs: 0 }).record, true);
  });
  it("records at a market no keeper covers", () => {
    assert.equal(traderShouldRecord({ ...covered, keeperCovered: false }).record, true);
  });
  it("records when the snapshot is at or past the window, or missing", () => {
    assert.equal(traderShouldRecord({ ...covered, snapshotAgeMs: 10 * MIN }).record, true);
    assert.equal(traderShouldRecord({ ...covered, snapshotAgeMs: 40 * MIN }).record, true);
    assert.equal(traderShouldRecord({ ...covered, snapshotAgeMs: undefined }).record, true);
  });
  it("gives a reason either way", () => {
    assert.match(traderShouldRecord(covered).reason, /keeper covers it/);
    assert.match(traderShouldRecord({ ...covered, keeperCovered: false }).reason, /no keeper/);
  });
});
