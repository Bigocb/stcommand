import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";
import { classifyTrader, formatTraderStates, summarizeTraderStates } from "../src/engine/traderStates.js";

const t = (shipSymbol: string, busy = false) => ({ shipSymbol, busy });

describe("traderStates", () => {
  it("separates carrying, en route, waiting and manual", () => {
    assert.equal(classifyTrader(t("A", true), true, false), "carrying");
    assert.equal(classifyTrader(t("B"), true, false), "en route", "empty hold with an assignment is flying to its buy, not idle");
    assert.equal(classifyTrader(t("C"), false, false), "waiting");
    assert.equal(classifyTrader(t("D"), true, true), "manual");
  });

  it("counts a fleet and names the ships with nothing to do", () => {
    const s = summarizeTraderStates([t("A", true), t("B"), t("C"), t("D"), t("E")], new Set(["A", "B"]), new Set(["E"]));
    assert.deepEqual({ carrying: s.carrying, enRoute: s.enRoute, waiting: s.waiting, manual: s.manual }, { carrying: 1, enRoute: 1, waiting: 2, manual: 1 });
    assert.deepEqual(s.waitingShips, ["C", "D"]);
    assert.equal(formatTraderStates(5, s), "5 traders (carrying 1, en route 1, waiting 2 [C, D], manual 1)");
  });

  it("limits the names listed", () => {
    const ships = ["A", "B", "C", "D"].map((x) => t(x));
    const line = formatTraderStates(4, summarizeTraderStates(ships, new Set(), new Set()), 2);
    assert.equal(line, "4 traders (carrying 0, en route 0, waiting 4 [A, B, …], manual 0)");
  });
});

describe("the dispatch recompute line", () => {
  const route = {
    good: "MEDICINE", buyAt: "X1-A-BUY", buySystem: "X1-A", buyPrice: 100, sellAt: "X1-A-SELL", sellSystem: "X1-A", sellPrice: 900,
    volume: 40, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: 800, ageMinutes: 1,
  };

  it("reports an empty ship that holds a route as en route, not idle", (ctx) => {
    ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    const lines: string[] = [];
    d.recompute([route], [{ shipSymbol: "T1", capacity: 40 }, { shipSymbol: "T2", capacity: 40, busy: true }], [], [], [], [], undefined, undefined, (m) => lines.push(m));
    const line = lines.find((l) => l.startsWith("dispatch recompute:")) ?? "";
    assert.match(line, /2 traders \(carrying 1, en route 1, waiting 0, manual 0\)/);
    assert.doesNotMatch(line, /idle/);
  });

  it("names a ship with an empty hold and no route as waiting", (ctx) => {
    ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    const lines: string[] = [];
    d.recompute([], [{ shipSymbol: "T1", capacity: 40 }], [], [], [], [], undefined, undefined, (m) => lines.push(m));
    assert.match(lines.find((l) => l.startsWith("dispatch recompute:")) ?? "", /1 traders \(carrying 0, en route 0, waiting 1 \[T1\], manual 0\)/);
  });
});
