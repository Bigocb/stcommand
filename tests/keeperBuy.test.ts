import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keeperAutoApprove, pickShipAtYard } from "../src/engine/keeperBuy.js";

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
