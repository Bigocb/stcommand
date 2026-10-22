import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKeeperReview, goodsFromRows, keeperBudget, marketKeeperScore, median, orderForBuying } from "../src/engine/keeperValue.js";

const prices: Record<string, number> = { ADVANCED_CIRCUITRY: 3800, FUEL: 90, IRON_ORE: 60, DIAMONDS: 90_000 };
const ctx = { priceOf: (g: string) => prices[g], defaultPrice: 500 };

describe("marketKeeperScore", () => {
  it("weights exports over imports over exchanges, by price in thousands", () => {
    const exp = marketKeeperScore({ exports: ["ADVANCED_CIRCUITRY"] }, ctx).score;
    const imp = marketKeeperScore({ imports: ["ADVANCED_CIRCUITRY"] }, ctx).score;
    const exc = marketKeeperScore({ exchange: ["ADVANCED_CIRCUITRY"] }, ctx).score;
    assert.equal(exp, 3.8);
    assert.ok(exp > imp && imp > exc);
  });
  it("a rich market outscores a market of cheap goods, and counts each good once at its strongest role", () => {
    const rich = marketKeeperScore({ exports: ["ADVANCED_CIRCUITRY"], imports: ["ADVANCED_CIRCUITRY", "FUEL"] }, ctx);
    const poor = marketKeeperScore({ exports: ["FUEL", "IRON_ORE"] }, ctx);
    assert.ok(rich.score > poor.score);
    assert.equal(rich.goods, 2);
    assert.deepEqual(rich.top, ["ADVANCED_CIRCUITRY", "FUEL"]);
  });
  it("caps a very dear good, uses the default for an unknown price, and boosts goods we have a route for", () => {
    assert.equal(marketKeeperScore({ exports: ["DIAMONDS"] }, ctx).score, 20, "capped at 20k");
    assert.equal(marketKeeperScore({ exports: ["MYSTERY"] }, ctx).score, 0.5);
    assert.equal(marketKeeperScore({ exports: ["ADVANCED_CIRCUITRY"] }, { ...ctx, routeGoods: new Set(["ADVANCED_CIRCUITRY"]) }).score, 5.7, "3.8 x 1.5");
  });
  it("an empty market scores 0", () => assert.deepEqual(marketKeeperScore({}, ctx), { score: 0, goods: 0, top: [] }));
});

describe("goodsFromRows and median", () => {
  it("splits stored price rows by type", () => {
    const g = goodsFromRows([{ goodSymbol: "A", type: "EXPORT" }, { goodSymbol: "B", type: "import" }, { goodSymbol: "C", type: "EXCHANGE" }]);
    assert.deepEqual(g, { exports: ["A"], imports: ["B"], exchange: ["C"] });
  });
  it("median handles odd, even and empty", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 10]), 2.5);
    assert.equal(median([]), undefined);
  });
});

describe("keeperBudget", () => {
  it("allows under the limit, refuses at it, and 0 means no limit", () => {
    assert.equal(keeperBudget({ keepers: 299, max: 300 }).allow, true);
    assert.equal(keeperBudget({ keepers: 300, max: 300 }).allow, false);
    assert.equal(keeperBudget({ keepers: 9999, max: 0 }).allow, true);
  });
});

describe("orderForBuying", () => {
  it("puts operator-listed (unscored) markets first, then best score first, ties by list order", () => {
    const score: Record<string, number | undefined> = { A: 5, B: 9, C: undefined, D: 9 };
    assert.deepEqual(orderForBuying(["A", "B", "C", "D"], (m) => score[m]), ["C", "B", "D", "A"]);
  });
});

describe("buildKeeperReview", () => {
  const stationed = [
    { ship: "K-1", market: "X1-A-M1", score: 1.2, goods: 3, pollMs: 30 * 60_000 },
    { ship: "K-2", market: "X1-A-M2", score: 9, goods: 8, pollMs: 5 * 60_000 },
    { ship: "K-3", market: "X1-A-M3", pollMs: 5 * 60_000 },
  ];
  const uncovered = [{ market: "X1-B-M1", score: 14, goods: 9 }, { market: "X1-B-M2", score: 2 }, { market: "X1-B-M3" }];
  const r = buildKeeperReview({ nowIso: "2026-10-22T12:00:00Z", stationed, uncovered, max: 10 });

  it("lists the weakest scored keepers first and skips unscored ones", () => {
    assert.deepEqual(r.weakest.map((k) => k.ship), ["K-1", "K-2"]);
  });
  it("orders what would be bought next by score, unscored last", () => {
    assert.deepEqual(r.next.map((n) => n.market), ["X1-B-M1", "X1-B-M2", "X1-B-M3"]);
  });
  it("suggests a swap only where an uncovered market clearly beats a keeper", () => {
    assert.deepEqual(r.swaps.map((s) => [s.scrapShip, s.instead]), [["K-1", "X1-B-M1"]]);
  });
  it("estimates polling cost and room under the limit", () => {
    assert.equal(r.budget.keepers, 3);
    assert.equal(r.budget.room, 7);
    assert.equal(r.budget.callsPerMinNow, 0.4, "one at 30 min and two at 5 min: 1/30 + 2/5");
  });
  it("no limit means no room figure", () => assert.equal(buildKeeperReview({ nowIso: "x", stationed, uncovered, max: 0 }).budget.room, null));
});
