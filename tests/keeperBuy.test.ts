import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distinctGoods, keeperAutoApprove, marketsNeedingKeepers, pickShipAtYard, splitThinMarkets } from "../src/engine/keeperBuy.js";

const base = { clauseOn: true, capCredits: 60_000, price: 28_959, spendable: true };

describe("keeperAutoApprove", () => {
  it("approves a quote within the cap when the clause is on and the credits are there", () => {
    assert.equal(keeperAutoApprove(base).approve, true);
    assert.equal(keeperAutoApprove({ ...base, price: 60_000 }).approve, true); // the cap itself is allowed
  });
  it("clause off reproduces today's behaviour: always ask", () => {
    assert.equal(keeperAutoApprove({ ...base, clauseOn: false }).approve, false);
  });
  it("asks when the price is over the cap, unaffordable, or not a real quote", () => {
    assert.equal(keeperAutoApprove({ ...base, price: 60_001 }).approve, false);
    assert.equal(keeperAutoApprove({ ...base, spendable: false }).approve, false);
    assert.equal(keeperAutoApprove({ ...base, price: 0 }).approve, false);
    assert.equal(keeperAutoApprove({ ...base, price: NaN }).approve, false);
  });
  it("says why", () => {
    assert.match(keeperAutoApprove({ ...base, price: 70_000 }).reason, /over the 60000c/);
  });
});

describe("pickShipAtYard", () => {
  const ships = [
    { symbol: "T-1", role: "trader", waypoint: "X1-A-Y", nav: "DOCKED" },
    { symbol: "K-1", role: "keeper", waypoint: "X1-A-Y", nav: "DOCKED" },
    { symbol: "T-2", role: "trader", waypoint: "X1-A-Z", nav: "DOCKED" },
    { symbol: "T-3", role: "trader", waypoint: "X1-A-Y", nav: "IN_TRANSIT" },
  ];
  it("prefers the keeper stationed at the yard", () => assert.equal(pickShipAtYard(ships, "X1-A-Y"), "K-1"));
  it("falls back to another ship that is there", () => assert.equal(pickShipAtYard(ships.filter((s) => s.symbol !== "K-1"), "X1-A-Y"), "T-1"));
  it("ignores ships in transit and ships elsewhere", () => {
    assert.equal(pickShipAtYard(ships.filter((s) => s.symbol === "T-3"), "X1-A-Y"), undefined);
    assert.equal(pickShipAtYard(ships, "X1-NOPE"), undefined);
  });
});

describe("marketsNeedingKeepers", () => {
  const wps = [
    { symbol: "X1-S-A1", traits: [{ symbol: "MARKETPLACE" }, { symbol: "SHIPYARD" }] },
    { symbol: "X1-S-B2", traits: [{ symbol: "MARKETPLACE" }] },
    { symbol: "X1-S-C3", traits: [{ symbol: "ASTEROID" }] },
    { symbol: "X1-S-D4" },
  ];
  it("returns the marketplaces not yet listed, in waypoint order", () => {
    assert.deepEqual(marketsNeedingKeepers(wps, []), ["X1-S-A1", "X1-S-B2"]);
    assert.deepEqual(marketsNeedingKeepers(wps, ["X1-S-A1"]), ["X1-S-B2"]);
  });
  it("returns nothing when all are listed or none are markets", () => {
    assert.deepEqual(marketsNeedingKeepers(wps, ["X1-S-A1", "X1-S-B2"]), []);
    assert.deepEqual(marketsNeedingKeepers([wps[2]!, wps[3]!], []), []);
  });
});

describe("distinctGoods", () => {
  it("counts the union of imports, exports, exchange and priced goods once each", () => {
    assert.equal(distinctGoods({ imports: ["A", "B"], exports: ["C"], exchange: ["A", "D"], tradeGoods: { C: {}, E: {} } }), 5);
    assert.equal(distinctGoods({}), 0);
  });
});

describe("splitThinMarkets", () => {
  const goods: Record<string, number> = { "X1-S-A": 6, "X1-S-B": 2, "X1-S-C": 3 };
  it("drops markets under the minimum and keeps the rest in order", () => {
    const r = splitThinMarkets(["X1-S-A", "X1-S-B", "X1-S-C"], (m) => goods[m], 3);
    assert.deepEqual(r.keep, ["X1-S-A", "X1-S-C"]);
    assert.deepEqual(r.thin, [{ market: "X1-S-B", goods: 2 }]);
  });
  it("keeps a market whose count is unknown, rather than dropping it on a guess", () => {
    assert.deepEqual(splitThinMarkets(["X1-S-Z"], () => undefined, 3).keep, ["X1-S-Z"]);
  });
  it("a minimum of 0 keeps everything (the clause off)", () => {
    assert.deepEqual(splitThinMarkets(["X1-S-B"], (m) => goods[m], 0).keep, ["X1-S-B"]);
  });
});
