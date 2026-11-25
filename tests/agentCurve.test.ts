import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentCurve } from "../src/engine/agentCurve.js";
import { rivalBySystem } from "../src/engine/rivalActivity.js";

const H = 3_600_000;
const T0 = Date.parse("2026-11-25T00:00:00Z");
const s = (agent: string, h: number, credits: number, ships = 10) => ({ agent, at: T0 + h * H, credits, ships });

describe("agentCurve", () => {
  it("gives hourly credit changes and the before/after rate around a pivot", () => {
    // A earns 100/h until hour 6, then 20/h. B earns 50/h throughout.
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((h) => [s("A", h, h <= 6 ? h * 100 : 600 + (h - 6) * 20), s("B", h, h * 50)]);
    const c = agentCurve(samples, { fromMs: T0, toMs: T0 + 12 * H, pivotMs: T0 + 6 * H });
    const a = c.rows.find((r) => r.agent === "A")!;
    assert.equal(a.deltas[0], 100);
    assert.equal(a.deltas[11], 20);
    assert.equal(a.beforePerHour, 100);
    assert.equal(a.afterPerHour, 20);
    assert.equal(a.ratio, 0.2);
    assert.equal(c.rows.find((r) => r.agent === "B")!.ratio, 1);
    assert.deepEqual(c.summary, { compared: 2, fellOverHalf: 1, medianRatio: 0.2 });
  });

  it("ranks by credits now, keeps the top N, filters by name, and leaves gaps as null", () => {
    const samples = [s("BIG", 0, 1000), s("BIG", 2, 3000), s("SMALL", 0, 10), s("SMALL", 2, 20)];
    const c = agentCurve(samples, { fromMs: T0, toMs: T0 + 2 * H, top: 1 });
    assert.deepEqual(c.rows.map((r) => r.agent), ["BIG"]);
    assert.equal(c.rows[0]!.deltas[0], null, "no sample at hour 1");
    assert.equal(agentCurve(samples, { fromMs: T0, toMs: T0 + 2 * H, agentFilter: "sma" }).rows[0]!.agent, "SMALL");
    assert.equal(c.summary, null, "no pivot, no summary");
  });
});

describe("rivalBySystem", () => {
  it("groups rival fills by system with value, agents and top goods; fuel left out", () => {
    const f = (wp: string, ship: string, good: string, units: number, price: number) => ({ timestamp: "2026-11-25T10:00:00Z", waypoint: wp, good, shipSymbol: ship, type: "SELL", units, pricePerUnit: price });
    const out = rivalBySystem([f("X1-AA-1", "JEAN-1", "FOOD", 100, 2000), f("X1-AA-2", "TIP-3", "IRON", 300, 100), f("X1-BB-1", "TIP-4", "FOOD", 10, 2000), f("X1-AA-1", "JEAN-1", "FUEL", 500, 70)]);
    assert.deepEqual(out.map((x) => [x.system, x.units, x.value, x.agents]), [["X1-AA", 400, 230000, 2], ["X1-BB", 10, 20000, 1]]);
    assert.equal(out[0]!.topGoods[0]!.good, "FOOD");
    assert.equal(out[0]!.topAgents[0]!.agent, "JEAN");
  });
});
