import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { priceTopPerGood, type LegBound } from "../src/engine/routeTopK.js";

/** A deterministic pseudo-random generator, so a failure can be replayed. */
function rng(seed: number) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

describe("priceTopPerGood (issue #88 P4)", () => {
  it("keeps each good's exact top N by profit and by profit per hour, pricing far fewer legs", async () => {
    const r = rng(7);
    const goods = ["A", "B", "C", "D"];
    const legs = Array.from({ length: 4000 }, (_, i) => {
      const ceiling = Math.round(r() * 500_000) - 50_000;
      const seconds = 200 + Math.round(r() * 5000);
      // Pricing only ever cuts: actual profit is the ceiling less a random share (impact, thin market), sometimes unusable.
      const profit = Math.round(ceiling - Math.abs(ceiling) * r() * 0.6);
      return { good: goods[i % goods.length]!, ceiling, seconds, profit, usable: r() > 0.05 };
    });
    const bounds: LegBound[] = legs.map((l) => ({ good: l.good, ceiling: l.ceiling, seconds: l.seconds }));
    const REF = 600;
    const rate = (profit: number, seconds: number) => (profit * REF) / seconds;
    let pricedCalls = 0;
    const res = await priceTopPerGood(bounds, {
      perGood: 25,
      price: (i) => { pricedCalls++; const l = legs[i]!; return l.usable ? { i, profit: l.profit, seconds: l.seconds } : null; },
      profitOf: (x) => x.profit,
      rateOf: (x) => rate(x.profit, x.seconds),
      rateBound: (b) => rate(b.ceiling, b.seconds!),
    });
    const keptRoutes = [...res.priced.values()].filter((x): x is { i: number; profit: number; seconds: number } => x !== null && x.profit > 0);
    for (const g of goods) {
      const all = legs.map((l, i) => ({ ...l, i })).filter((l) => l.good === g && l.usable && l.profit > 0);
      const kept = keptRoutes.filter((k) => legs[k.i]!.good === g);
      const topBy = (xs: { i: number; profit: number; seconds: number }[], key: (x: { profit: number; seconds: number }) => number) =>
        [...xs].sort((a, b) => key(b) - key(a)).slice(0, 25).map((x) => x.i).sort((a, b) => a - b);
      assert.deepEqual(topBy(kept, (x) => x.profit), topBy(all, (x) => x.profit), `top by profit for ${g}`);
      assert.deepEqual(topBy(kept, (x) => rate(x.profit, x.seconds)), topBy(all, (x) => rate(x.profit, x.seconds)), `top by rate for ${g}`);
    }
    assert.ok(pricedCalls < legs.length / 3, `priced ${pricedCalls} of ${legs.length}`);
    assert.equal(res.skipped, legs.length - res.priced.size);
  });

  it("yields to the event loop while pricing", async () => {
    let pauses = 0;
    const bounds: LegBound[] = Array.from({ length: 100 }, (_, i) => ({ good: `G${i}`, ceiling: 10 }));
    await priceTopPerGood(bounds, { perGood: 1, price: () => ({ p: 5 }), profitOf: (x) => x.p, rateOf: (x) => x.p, rateBound: (b) => b.ceiling, yieldEvery: 10, pause: async () => { pauses++; } });
    assert.equal(pauses, 10);
  });
});
