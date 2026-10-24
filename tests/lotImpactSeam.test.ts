import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";
import { DEFAULT_IMPACT_POLICY } from "../src/engine/lotImpact.js";
import { PRICE_IMPACT_PER_LOT } from "../src/engine/routeEconomics.js";

/** The dispatcher keeps our lots as traders report them; impactFor() turns them into the per-lot move to plan with. */
describe("learned price impact at the dispatcher", () => {
  const on = { ...DEFAULT_IMPACT_POLICY, maxFactor: 3, maxAgeMs: 4 * 3_600_000 };
  function neuralSales(d: RouteDispatcher) {
    // THEOREM-38, X1-X48-A1, 2026-10-23: five 15-unit lots, 31,832c down to 19,464c.
    for (const p of [31832, 29492, 26709, 23399, 19464]) d.recordSale("NEURAL_CHIPS", "X1-X48-A1", 15, p);
  }

  it("is the flat default for a market we have not traded in, and with the policy off", () => {
    const d = new RouteDispatcher();
    assert.equal(d.impactFor("sell", "NEURAL_CHIPS", "X1-X48-A1", 15, on).perLot, PRICE_IMPACT_PER_LOT);
    neuralSales(d);
    assert.equal(d.impactFor("sell", "NEURAL_CHIPS", "X1-X48-A1", 15, DEFAULT_IMPACT_POLICY).perLot, PRICE_IMPACT_PER_LOT);
  });

  it("reads the move our own run measured, on the side it happened", () => {
    const d = new RouteDispatcher();
    neuralSales(d);
    const sell = d.impactFor("sell", "NEURAL_CHIPS", "X1-X48-A1", 15, on);
    assert.ok(sell.perLot > 0.1, `sell ${sell.perLot}`);
    assert.equal(d.impactFor("buy", "NEURAL_CHIPS", "X1-X48-A1", 15, on).perLot, PRICE_IMPACT_PER_LOT);
    assert.equal(d.impactFor("sell", "NEURAL_CHIPS", "X1-OTHER", 15, on).perLot, PRICE_IMPACT_PER_LOT);
    for (const p of [21677, 22758, 24089, 25727, 27745]) d.recordBuy("NEURAL_CHIPS", "X1-YM69-A4", 15, p);
    const buy = d.impactFor("buy", "NEURAL_CHIPS", "X1-YM69-A4", 15, on);
    assert.ok(buy.perLot > 0.055 && buy.perLot < 0.08, `buy ${buy.perLot}`);
  });
});
