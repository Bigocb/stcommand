import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeUnreachableReason } from "../src/engine/routeReach.js";
import { sortRoutes } from "../public/shared/domain.js";

const home = new Set(["X1-BT10"]);
const never = () => false;

describe("a route no trader can reach is not a route on the board", () => {
  it("a route in a system our traders are in is reachable", () => {
    assert.equal(routeUnreachableReason({ buySystem: "X1-BT10", sellSystem: "X1-BT10" }, home, never), null);
  });

  it("a route whose buy system has no finished gate path from any trader is unreachable, and says why (the 2026-10-28 PK42 case)", () => {
    const why = routeUnreachableReason({ buySystem: "X1-PK42", sellSystem: "X1-PK42" }, home, never);
    assert.match(why!, /no trader can reach X1-PK42: no finished gate path from X1-BT10/);
  });

  it("one trader that can fly there is enough", () => {
    const traders = new Set(["X1-BT10", "X1-TV37"]);
    assert.equal(routeUnreachableReason({ buySystem: "X1-PK42", sellSystem: "X1-PK42" }, traders, (from, to) => from === "X1-TV37" && to === "X1-PK42"), null);
  });

  it("with no trader position known it judges nothing", () => {
    assert.equal(routeUnreachableReason({ buySystem: "X1-PK42", sellSystem: "X1-PK42" }, new Set(), never), null);
  });
});

describe("the board sorts an unreachable route last, whatever its rate", () => {
  it("by hour and by trip", () => {
    const routes = [
      { goodSymbol: "JEWELRY", ratePerHour: 4_162_228, profitPerTrip: 99_431, unreachable: true },
      { goodSymbol: "SHIP_PLATING", ratePerHour: 130_347, profitPerTrip: 3_838, unreachable: false },
      { goodSymbol: "FUEL", ratePerHour: 58_725, profitPerTrip: 522 },
    ];
    assert.deepEqual(sortRoutes(routes, "hour").map((r) => r.goodSymbol), ["SHIP_PLATING", "FUEL", "JEWELRY"]);
    assert.deepEqual(sortRoutes(routes, "trip").map((r) => r.goodSymbol), ["SHIP_PLATING", "FUEL", "JEWELRY"]);
  });
});
