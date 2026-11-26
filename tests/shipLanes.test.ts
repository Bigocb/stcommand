import { test } from "node:test";
import assert from "node:assert/strict";
import { laneShips, tradeLaneFor, type TradeLanePolicy } from "../src/engine/tradeLanes.js";

test("laneShips: clause off = only the first N traders (today's behaviour)", () => {
  const s = laneShips(["T-3", "T-1", "T-2"], 2, ["K-1", "K-2"], false);
  assert.deepEqual([...s].sort(), ["T-1", "T-2"]);
});

test("laneShips: clause on adds keepers, tour ships and the rest", () => {
  const s = laneShips(["T-1"], 5, ["K-1", "TOUR-1"], true);
  assert.deepEqual([...s].sort(), ["K-1", "T-1", "TOUR-1"]);
});

test("laneShips: shipLanes on with trader lanes off enrols only the other ships", () => {
  const s = laneShips(["T-1", "T-2"], 0, ["K-1"], true);
  assert.deepEqual([...s], ["K-1"]);
});

test("a keeper enrolled by shipLanes gets a pinned proxy; many ships share the slots", () => {
  const keepers = Array.from({ length: 300 }, (_, i) => `K-${i}`);
  const policy: TradeLanePolicy = { enabled: true, ships: laneShips([], 0, keepers, true), firstSlot: 2 };
  const slots = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const pick = (ship: string) => tradeLaneFor({ ship, priority: 2 }, policy, slots, () => true);
  const a = pick("K-7")!;
  assert.ok(a.slotIndex >= 2, "never a read-lane slot");
  assert.equal(pick("K-7")!.slotIndex, a.slotIndex, "same ship, same proxy");
  const used = new Set(keepers.map((k) => pick(k)!.slotIndex));
  assert.equal(used.size, 8, "300 ships spread over all 8 trade slots");
  assert.equal(tradeLaneFor({ ship: "K-7", priority: 0 }, policy, slots, () => true), undefined, "boot never moves");
  assert.equal(tradeLaneFor({ ship: undefined, priority: 2 }, policy, slots, () => true), undefined, "fleet loops stay on the box");
});
