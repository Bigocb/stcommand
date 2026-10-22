import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentOf, rivalActivity, type RivalFill } from "../src/engine/rivalActivity.js";

const T0 = Date.parse("2026-10-22T10:00:00Z");
const fill = (sec: number, ship: string, units: number, extra: Partial<RivalFill> = {}): RivalFill =>
  ({ timestamp: new Date(T0 + sec * 1000).toISOString(), waypoint: "X1-A-1", good: "CLOTHING", shipSymbol: ship, type: "PURCHASE", units, pricePerUnit: 100, ...extra });

describe("rivalActivity", () => {
  it("names an agent by dropping the last suffix, hyphenated agents included", () => {
    assert.equal(agentOf("TIPTAP-AD"), "TIPTAP");
    assert.equal(agentOf("CHAMLIS-DEV-1F"), "CHAMLIS-DEV");
    assert.equal(agentOf("SOLO"), "SOLO");
  });

  it("joins one ship's close fills at a market into one visit and reads the load from it", () => {
    const r = rivalActivity([fill(0, "TIP-1", 75), fill(2, "TIP-1", 75), fill(4, "TIP-1", 75), fill(3600, "TIP-1", 60)]);
    const a = r.agents[0]!;
    assert.equal(a.agent, "TIP");
    assert.equal(a.visits, 2);
    assert.equal(a.fills, 4);
    assert.equal(a.maxVisitUnits, 225);
    assert.equal(a.medianVisitUnits, 143); // median of 225 and 60, rounded
    assert.equal(a.units, 285);
  });

  it("keeps different ships and different markets apart, and counts ships and markets", () => {
    const r = rivalActivity([
      fill(0, "TIP-1", 40), fill(1, "TIP-2", 40), fill(2, "TIP-1", 40, { waypoint: "X1-A-2" }),
    ]);
    const a = r.agents[0]!;
    assert.equal(a.visits, 3);
    assert.equal(a.ships, 2);
    assert.equal(a.markets, 2);
  });

  it("splits bought from sold units, ranks goods and markets, and ignores fuel", () => {
    const r = rivalActivity([
      fill(0, "POP-1", 80, { good: "FOOD", type: "PURCHASE" }),
      fill(600, "POP-1", 50, { good: "FOOD", type: "SELL", waypoint: "X1-A-2" }),
      fill(1200, "POP-1", 30, { good: "IRON", type: "SELL", waypoint: "X1-A-2" }),
      fill(1300, "POP-1", 9, { good: "FUEL" }),
    ]);
    const a = r.agents[0]!;
    assert.equal(a.boughtUnits, 80);
    assert.equal(a.soldUnits, 80);
    assert.equal(a.units, 160);
    assert.deepEqual(a.topGoods[0], { good: "FOOD", units: 130 });
    assert.deepEqual(a.topMarkets[0], { waypoint: "X1-A-1", units: 80 });
    assert.equal(r.fills, 3);
  });

  it("ranks agents by units and filters by name and minimum units", () => {
    const fills = [fill(0, "BIG-1", 500), fill(0, "MID-1", 200), fill(0, "TIPTAP-1", 20)];
    assert.deepEqual(rivalActivity(fills).agents.map((a) => a.agent), ["BIG", "MID", "TIPTAP"]);
    assert.deepEqual(rivalActivity(fills, { agentFilter: "tip" }).agents.map((a) => a.agent), ["TIPTAP"]);
    assert.deepEqual(rivalActivity(fills, { minUnits: 100 }).agents.map((a) => a.agent), ["BIG", "MID"]);
    assert.equal(rivalActivity(fills, { limit: 1 }).agents.length, 1);
  });
});
