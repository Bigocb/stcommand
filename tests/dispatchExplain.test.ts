import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goodOfKey, selectExplain, type DispatchExplainSnapshot } from "../src/engine/dispatchExplain.js";

const snap: DispatchExplainSnapshot = {
  at: 1,
  routes: [
    { key: "FUEL", good: "FUEL", profitPerTrip: 6601, score: 6601, claimedBy: "T-1" },
    { key: "COPPER@X1-B-SELL", good: "COPPER", sellAt: "X1-B-SELL", profitPerTrip: 1005, score: 1005 },
  ],
  floorDropped: [{ key: "DUD", good: "DUD", profitPerTrip: 0, score: 0 }],
  traders: [
    { ship: "T-1", busy: false, assigned: "FUEL", rejected: [{ key: "COPPER@X1-B-SELL", good: "COPPER", reason: "outscored by FUEL" }] },
    { ship: "T-2", busy: true, assigned: "COPPER@X1-B-SELL", rejected: [] },
  ],
};

describe("goodOfKey", () => {
  it("strips the market or side qualifier from a work key", () => {
    assert.equal(goodOfKey("FUEL"), "FUEL");
    assert.equal(goodOfKey("FUEL@X1-A-B"), "FUEL");
    assert.equal(goodOfKey("FUEL:buy"), "FUEL");
  });
});

describe("selectExplain", () => {
  it("with no filter returns the routes and per-trader counts, not the rejection detail", () => {
    const out = selectExplain(snap);
    assert.equal(out.routes.length, 2);
    assert.equal(out.traders[0]!.rejectedCount, 1);
    assert.deepEqual(out.traders[0]!.rejected, []);
  });

  it("filters to one ship and shows its rejections", () => {
    const out = selectExplain(snap, { ship: "T-1" });
    assert.deepEqual(out.traders.map((t) => t.ship), ["T-1"]);
    assert.equal(out.traders[0]!.rejected[0]!.reason, "outscored by FUEL");
  });

  it("filters to one good across routes, floor drops and traders", () => {
    const out = selectExplain(snap, { good: "COPPER" });
    assert.deepEqual(out.routes.map((r) => r.key), ["COPPER@X1-B-SELL"]);
    assert.deepEqual(out.floorDropped, []);
    assert.deepEqual(out.traders.map((t) => t.ship), ["T-1", "T-2"], "T-1 was refused COPPER, T-2 is busy on it");
    assert.equal(out.traders[0]!.rejected.length, 1);
  });

  it("returns an empty trader list for an unknown ship", () => {
    assert.deepEqual(selectExplain(snap, { ship: "NOPE" }).traders, []);
  });

  it("honours the limit", () => {
    assert.equal(selectExplain(snap, { limit: 1 }).routes.length, 1);
  });
});
