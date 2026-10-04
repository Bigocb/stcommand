import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickKeeperHull } from "../src/engine/fleet.js";

describe("pickKeeperHull: keeper purchase fallback", () => {
  it("prefers a probe when the yard sells one", () => {
    const hit = pickKeeperHull([
      { type: "SHIP_MINING_DRONE", price: 40000 },
      { type: "SHIP_PROBE", price: 23000 },
      { type: "SHIP_SURVEYOR", price: 27000 },
    ]);
    assert.equal(hit?.type, "SHIP_PROBE");
  });

  it("falls back to a surveyor, then a mining drone", () => {
    assert.equal(pickKeeperHull([{ type: "SHIP_MINING_DRONE", price: 1 }, { type: "SHIP_SURVEYOR", price: 2 }])?.type, "SHIP_SURVEYOR");
    assert.equal(pickKeeperHull([{ type: "SHIP_EXPLORER", price: 9 }, { type: "SHIP_MINING_DRONE", price: 1 }])?.type, "SHIP_MINING_DRONE");
  });

  it("returns nothing when no keeper-capable hull is sold", () => {
    assert.equal(pickKeeperHull([{ type: "SHIP_EXPLORER", price: 9 }, { type: "SHIP_ORE_HOUND", price: 5 }]), undefined);
  });
});

import { keeperRequestTargets } from "../src/engine/fleet.js";

describe("keeperRequestTargets — cross-kind duplicate keeper requests", () => {
  it("matches the target market packed as shipyard|target|hull", () => {
    assert.equal(keeperRequestTargets("X1-A-H56|X1-A-A1|SHIP_SURVEYOR", "X1-A-A1"), true);
  });
  it("does not match a different target, or the shipyard half", () => {
    assert.equal(keeperRequestTargets("X1-A-H56|X1-A-A1|SHIP_SURVEYOR", "X1-A-B2"), false);
    assert.equal(keeperRequestTargets("X1-A-H56|X1-A-A1|SHIP_SURVEYOR", "X1-A-H56"), false);
  });
  it("is false when there is no open request", () => {
    assert.equal(keeperRequestTargets(undefined, "X1-A-A1"), false);
  });
});
