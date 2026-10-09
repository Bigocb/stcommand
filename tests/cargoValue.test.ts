import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cargoValue } from "../src/engine/cargoValue.js";
import type { MarketSnapshot } from "../src/engine/market.js";

const market = (symbol: string, goods: Record<string, { sellPrice: number; tradeVolume: number }>): MarketSnapshot =>
  ({
    symbol,
    systemSymbol: "X1-AA",
    tradeGoods: Object.fromEntries(Object.entries(goods).map(([k, v]) => [k, { symbol: k, purchasePrice: v.sellPrice + 100, ...v }])),
    imports: [],
    exports: [],
    exchange: [],
    fetchedAt: "2026-10-09T00:00:00Z",
  }) as unknown as MarketSnapshot;

describe("cargoValue", () => {
  const dest = market("X1-AA-D", { ANTIMATTER: { sellPrice: 5000, tradeVolume: 18 } });
  const other = market("X1-AA-O", { ANTIMATTER: { sellPrice: 4000, tradeVolume: 18 }, IRON: { sellPrice: 150, tradeVolume: 60 } });
  const marketAt = (w: string) => [dest, other].find((m) => m.symbol === w);

  it("prices a load at its route's sell market, net of price impact", () => {
    const v = cargoValue({ cargo: [{ symbol: "ANTIMATTER", units: 18 }], assignment: { good: "ANTIMATTER", sellAt: "X1-AA-D", sellPrice: 4800 }, marketAt, marketsHere: [dest, other] });
    assert.equal(v.gross, 90_000); // live 5,000, not the route's stale 4,800
    assert.ok(v.value < v.gross && v.value > v.gross * 0.97, `one lot costs ~2.25%: ${v.value}`);
    assert.equal(v.items[0]!.source, "route");
  });

  it("charges more impact for a bigger load", () => {
    const small = cargoValue({ cargo: [{ symbol: "ANTIMATTER", units: 18 }], assignment: { good: "ANTIMATTER", sellAt: "X1-AA-D" }, marketAt, marketsHere: [] });
    const big = cargoValue({ cargo: [{ symbol: "ANTIMATTER", units: 72 }], assignment: { good: "ANTIMATTER", sellAt: "X1-AA-D" }, marketAt, marketsHere: [] });
    assert.ok(big.value / big.gross < small.value / small.gross);
  });

  it("falls back to the route's quoted price when the market has no snapshot", () => {
    const v = cargoValue({ cargo: [{ symbol: "ANTIMATTER", units: 10 }], assignment: { good: "ANTIMATTER", sellAt: "X1-AA-GONE", sellPrice: 4800 }, marketAt, marketsHere: [] });
    assert.equal(v.gross, 48_000);
  });

  it("uses the best price in the system for goods outside the route, and flags unknown goods", () => {
    const v = cargoValue({ cargo: [{ symbol: "IRON", units: 20 }, { symbol: "MYSTERY", units: 5 }], marketAt, marketsHere: [dest, other] });
    assert.equal(v.items[0]!.source, "best");
    assert.equal(v.items[0]!.sellAt, "X1-AA-O");
    assert.equal(v.gross, 3000);
    assert.equal(v.unpricedUnits, 5);
    assert.equal(v.items[1]!.source, "none");
  });

  it("adds up cost from the per-unit basis", () => {
    const v = cargoValue({ cargo: [{ symbol: "IRON", units: 20 }], marketAt, marketsHere: [other], costPerUnit: new Map([["IRON", 120]]) });
    assert.equal(v.cost, 2400);
  });

  it("an empty hold is worth nothing", () => {
    const v = cargoValue({ cargo: [], marketAt, marketsHere: [] });
    assert.deepEqual([v.value, v.gross, v.cost, v.unpricedUnits, v.items.length], [0, 0, 0, 0, 0]);
  });
});

import { cargoSignature } from "../src/engine/cargoValue.js";

describe("cargoSignature", () => {
  const ship = (symbol: string, inv: [string, number][]) => ({ symbol, cargo: { inventory: inv.map(([s, u]) => ({ symbol: s, units: u })) } });
  it("changes the moment any hold changes, and ignores empty holds and ordering", () => {
    const a = cargoSignature([ship("A", [["FOOD", 80]]), ship("B", []), ship("C", [["IRON", 5], ["COPPER", 2]])]);
    assert.equal(a, cargoSignature([ship("C", [["COPPER", 2], ["IRON", 5]]), ship("A", [["FOOD", 80]])]));
    assert.notEqual(a, cargoSignature([ship("A", [["FOOD", 60]]), ship("C", [["IRON", 5], ["COPPER", 2]])]));
    assert.equal(cargoSignature([ship("A", [])]), "");
  });
});
