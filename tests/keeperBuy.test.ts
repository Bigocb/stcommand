import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distinctGoods, hourlyNet, keeperAutoApprove, marketsNeedingKeepers, pickShipAtYard, splitThinMarkets, systemAlreadyLive } from "../src/engine/keeperBuy.js";

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

describe("keeperAutoApprove: hourly rate (keeperAutoApproveMinRate)", () => {
  it("no rate floor reproduces today's behaviour", () => {
    assert.equal(keeperAutoApprove({ ...base, ratePerHour: 0 }).approve, true);
    assert.equal(keeperAutoApprove({ ...base, minRatePerHour: 0, ratePerHour: 0 }).approve, true);
  });
  it("asks while the fleet earns under the floor, even with plenty of cash", () => {
    const r = keeperAutoApprove({ ...base, keepCash: 5_000_000, credits: 9_000_000, minRatePerHour: 500_000, ratePerHour: 0 });
    assert.equal(r.approve, false);
    assert.match(r.reason, /making 0c an hour, under the 500000c/);
  });
  it("asks when the rate is not known yet", () => {
    assert.match(keeperAutoApprove({ ...base, minRatePerHour: 500_000 }).reason, /not known yet/);
  });
  it("approves when both the cash and the rate are there", () => {
    assert.equal(keeperAutoApprove({ ...base, keepCash: 5_000_000, credits: 6_000_000, minRatePerHour: 500_000, ratePerHour: 3_000_000 }).approve, true);
  });
  it("the cash reserve still applies with a good rate", () => {
    assert.equal(keeperAutoApprove({ ...base, keepCash: 5_000_000, credits: 4_000_000, minRatePerHour: 500_000, ratePerHour: 3_000_000 }).approve, false);
  });
});

describe("hourlyNet", () => {
  const now = 10_000_000;
  it("sums sale profit and subtracts jump fees and fuel inside the last hour only", () => {
    const rows = [
      { ts: now - 1_000, type: "SELL", total: 100_000, pnl: 40_000 },
      { ts: now - 2_000, type: "JUMP", total: 6_500, pnl: null },
      { ts: now - 3_000, type: "REFUEL", total: 500, pnl: null },
      { ts: now - 4_000, type: "PURCHASE", total: 90_000, pnl: null },
      { ts: now - 3_700_000, type: "SELL", total: 1, pnl: 999_999 },
    ];
    assert.equal(hourlyNet(rows, now), 33_000);
  });
  it("is 0 with no rows", () => assert.equal(hourlyNet([], now), 0));
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
  it("never drops a shipyard, however few goods it trades (a keeper docked there reads its stock and prices)", () => {
    const r = splitThinMarkets(["X1-S-A", "X1-S-B", "X1-S-C"], (m) => goods[m], 4, (m) => m === "X1-S-B");
    assert.deepEqual(r.keep, ["X1-S-A", "X1-S-B"]);
    assert.deepEqual(r.thin, [{ market: "X1-S-C", goods: 3 }]);
  });
  it("without a yard test it behaves as before (the clause default)", () => {
    assert.deepEqual(splitThinMarkets(["X1-S-B"], (m) => goods[m], 4).thin, [{ market: "X1-S-B", goods: 2 }]);
  });
});

describe("systemAlreadyLive", () => {
  const wps = [{ symbol: "X1-PT36-D49" }, { symbol: "X1-PT36-F53" }];
  it("the home system is never queued, even with an unlisted market", () => {
    assert.equal(systemAlreadyLive("X1-PT36", "X1-PT36", wps, new Set()), true);
  });
  it("a system with a keeper already on one of its markets is live", () => {
    assert.equal(systemAlreadyLive("X1-PT36", "X1-HOME", wps, new Set(["X1-PT36-F53"])), true);
  });
  it("a new system with no keeper and not home is judged as before", () => {
    assert.equal(systemAlreadyLive("X1-NEW", "X1-PT36", [{ symbol: "X1-NEW-A1" }], new Set(["X1-PT36-D49"])), false);
    assert.equal(systemAlreadyLive("X1-NEW", "X1-PT36", [], new Set()), false);
  });
});
