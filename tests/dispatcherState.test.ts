import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { exportDispatcherState, importDispatcherState, mergeDispatcherState, mergeValue, same } from "../src/engine/dispatcherState.js";

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);
const ROUTES = [route("OUT", "X1-A-10", "X1-A-100", 40_000), route("BACK", "X1-A-102", "X1-A-12", 38_000), route("SOLO", "X1-A-10", "X1-A-900", 45_000), route("GEM", "X1-A-50", "X1-A-60", 20_000)];
const trader = (ship: string, wp: string, capacity = 40) => ({ shipSymbol: ship, capacity, system: "X1-A", waypoint: wp, fuelCapacity: 5000 });
const TRADERS = [trader("T-1", "X1-A-10"), trader("T-2", "X1-A-102", 20), trader("T-3", "X1-A-50", 30)];
const run = (d: RouteDispatcher, lines: string[] = []) =>
  d.recompute(ROUTES, TRADERS, [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, { circuitWeight: 1 });

/** A dispatcher with something in every kind of field. */
function busy(): RouteDispatcher {
  const d = new RouteDispatcher();
  run(d);
  d.recordSale("OUT", "X1-A-100", 20, 200);
  d.recordBuy("OUT", "X1-A-10", 20, 100);
  d.recordTripStart("OUT", "X1-A-10", "T-1", 100);
  d.recordTrip({ good: "OUT", buyAt: "X1-A-10", sellAt: "X1-A-100", promised: 1000, made: 900 });
  d.reportDeadRoute("GEM", "X1-A-50", "X1-A-60", "no margin");
  d.setContractDuty("T-9", true);
  return d;
}

describe("dispatcher state export/import", () => {
  it("round-trips every field: a fresh dispatcher given the state exports the same state", () => {
    const d = busy();
    const state = exportDispatcherState(d);
    const copy = new RouteDispatcher();
    importDispatcherState(copy, structuredClone(state));
    assert.ok(same(exportDispatcherState(copy), state));
    // every non-function own field is carried
    for (const [k, v] of Object.entries(d)) if (typeof v !== "function") assert.ok(k in state, k);
  });

  it("a recompute on an imported copy decides exactly what the original decides", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const a = busy();
    const b = new RouteDispatcher();
    importDispatcherState(b, structuredClone(exportDispatcherState(a)));
    t.mock.timers.tick(120_000);
    const la: string[] = [], lb: string[] = [];
    run(a, la);
    run(b, lb);
    assert.deepEqual(b.list(), a.list());
    assert.deepEqual(lb, la);
    assert.ok(same(exportDispatcherState(b), exportDispatcherState(a)));
  });
});

describe("dispatcher state merge", () => {
  it("keeps main-thread changes to a key and the worker's changes to the others", () => {
    const before = new Map([["A", 1], ["B", 2], ["C", 3]]);
    const main = new Map([["A", 10], ["B", 2], ["C", 3], ["D", 4]]);
    const after = new Map([["A", 5], ["B", 20]]);
    assert.deepEqual(mergeValue(before, main, after), new Map([["A", 10], ["B", 20], ["D", 4]]));
  });

  it("appends main-thread log entries to the worker's array, and adds counters", () => {
    assert.deepEqual(mergeValue([1, 2], [1, 2, 3], [2, 9]), [2, 9, 3]);
    assert.deepEqual(mergeValue({ n: 1, d: { x: 1 } }, { n: 3, d: { x: 2 } }, { n: 2, d: { x: 1, y: 1 } }), { n: 4, d: { x: 2, y: 1 } });
    assert.equal(mergeValue(100, 200, 150), 200);
  });

  it("a decline and a sale made while the worker ran survive, the worker's other decisions install", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const live = busy();
    t.mock.timers.tick(120_000);
    const before = exportDispatcherState(live);
    // The worker: a copy, recomputed.
    const worker = new RouteDispatcher();
    importDispatcherState(worker, structuredClone(before));
    run(worker);
    const after = exportDispatcherState(worker);
    // Meanwhile on the main thread: T-3 declines its route, a sale lands.
    live.decline("T-3");
    live.recordSale("SOLO", "X1-A-900", 10, 300);
    const { state } = mergeDispatcherState(before, exportDispatcherState(live), after);
    importDispatcherState(live, state);
    assert.equal(live.assignmentFor("T-3"), undefined, "the decline is kept");
    assert.deepEqual(live.assignmentFor("T-1"), worker.assignmentFor("T-1"), "the recompute's pick for T-1 is installed");
    const sales = exportDispatcherState(live).recentSales as Map<string, unknown[]>;
    assert.ok([...sales.keys()].some((k) => k.includes("SOLO")), "the sale is kept");
  });

  it("drops a recompute assignment whose good a main-thread claim took meanwhile", () => {
    const a = (ship: string, good: string) => ({ shipSymbol: ship, good, role: "direct", source: "auto" });
    const before = { assignments: new Map([["T-1", a("T-1", "OLD")]]) };
    const main = { assignments: new Map([["T-1", a("T-1", "OLD")], ["T-2", a("T-2", "GEM")]]) };
    const after = { assignments: new Map([["T-1", a("T-1", "GEM")]]) };
    const { state, dropped } = mergeDispatcherState(before, main, after);
    assert.deepEqual([...(state.assignments as Map<string, unknown>).keys()], ["T-2"]);
    assert.deepEqual(dropped, ["T-1:GEM"]);
  });
});
