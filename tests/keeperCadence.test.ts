import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keeperPollDelayMs } from "../src/engine/keeperCadence.js";

const MIN = 60_000;

describe("keeperPollDelayMs", () => {
  it("stays at 5 minutes for a market that moved recently", () => {
    assert.equal(keeperPollDelayMs(0), 5 * MIN);
    assert.equal(keeperPollDelayMs(10 * MIN), 5 * MIN);
    assert.equal(keeperPollDelayMs(15 * MIN), 5 * MIN);
  });
  it("relaxes to a third of the idle time", () => {
    assert.equal(keeperPollDelayMs(30 * MIN), 10 * MIN);
    assert.equal(keeperPollDelayMs(60 * MIN), 20 * MIN);
  });
  it("never waits more than 30 minutes", () => {
    assert.equal(keeperPollDelayMs(90 * MIN), 30 * MIN);
    assert.equal(keeperPollDelayMs(24 * 60 * MIN), 30 * MIN);
  });
});
