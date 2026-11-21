import { test } from "node:test";
import assert from "node:assert/strict";
import { needFleetList } from "../src/engine/fleetListPolicy.js";

const on = { enabled: true, safetyMs: 30 * 60_000 };
const now = 10_000_000;

test("clause off lists every time (today's behaviour)", () => {
  assert.equal(needFleetList({ agentShipCount: 5, knownShips: 5, lastListAt: now - 1000, now }, { ...on, enabled: false }).list, true);
});

test("skips when the counts match and the list is recent", () => {
  const d = needFleetList({ agentShipCount: 2470, knownShips: 2470, lastListAt: now - 2 * 60_000, now }, on);
  assert.equal(d.list, false);
  assert.match(d.reason, /matches/);
});

test("lists when the game has a ship the fleet does not know", () => {
  const d = needFleetList({ agentShipCount: 2471, knownShips: 2470, lastListAt: now - 60_000, now }, on);
  assert.equal(d.list, true);
  assert.match(d.reason, /2471/);
});

test("lists after the safety window", () => {
  assert.equal(needFleetList({ agentShipCount: 3, knownShips: 3, lastListAt: now - 31 * 60_000, now }, on).list, true);
});

test("lists when never listed or the count is missing", () => {
  assert.equal(needFleetList({ agentShipCount: 3, knownShips: 3, lastListAt: 0, now }, on).list, true);
  assert.equal(needFleetList({ agentShipCount: undefined, knownShips: 3, lastListAt: now - 1000, now }, on).list, true);
});
