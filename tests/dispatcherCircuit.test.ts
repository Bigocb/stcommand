import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Two-leg circuits (src/engine/circuit.ts) through the dispatcher. OUT (10 -> 100) pairs with BACK (102 -> 12), which
 * starts where OUT sells and ends where OUT began; SOLO (10 -> 900) is a slightly richer route with no partner.
 * Weight 0 must behave as before; weight > 0 prefers OUT, keeps BACK for that ship and serves it after the sale.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const OUT = route("OUT", "X1-A-10", "X1-A-100", 40_000);
const BACK = route("BACK", "X1-A-102", "X1-A-12", 42_000);
const SOLO = route("SOLO", "X1-A-10", "X1-A-900", 45_000);

const t1 = (over: Record<string, unknown> = {}) => ({ shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-10", fuelCapacity: 5000, ...over });
const t2 = (over: Record<string, unknown> = {}) => ({ shipSymbol: "T-2", capacity: 20, system: "X1-A", waypoint: "X1-A-102", fuelCapacity: 5000, ...over });

function run(d: RouteDispatcher, weight: number, routes: DispatchRoute[], traders: ReturnType<typeof t1>[], lines: string[] = [], circuitCash?: number) {
  d.recompute(routes, traders, [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, { circuitWeight: weight, circuitCash });
}

describe("dispatcher circuits", () => {
  it("with weight 0 the pick is exactly the old one and nothing is planned", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 0, [OUT, BACK, SOLO], [t1(), t2()], lines);
    assert.equal(d.assignmentFor("T-1")?.good, "SOLO");
    assert.equal(d.assignmentFor("T-1")?.circuit, undefined);
    assert.ok(!lines.some((l) => l.includes("dispatch circuit")));
    // control for the tests below: with the feature off, T-2 (standing at BACK's buy market) takes BACK
    assert.equal(d.assignmentFor("T-2")?.good, "BACK");
  });

  it("with weight > 0 it prefers the route with a return leg, records it, and keeps that leg from other ships", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2()], lines);
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "OUT");
    assert.equal(a?.circuit?.leg, 1);
    assert.equal(a?.circuit?.leg2.good, "BACK");
    assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 OUT")));
    // T-2 stands next to BACK's buy market and would take it, but it is kept for T-1.
    assert.notEqual(d.assignmentFor("T-2")?.good, "BACK");
  });

  it("serves the second leg once the first has been sold", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2()]);
    assert.equal(d.assignmentFor("T-1")?.good, "OUT");

    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]); // loaded: leg 1 under way
    assert.equal(d.assignmentFor("T-1")?.good, "OUT");
    assert.notEqual(d.assignmentFor("T-2")?.good, "BACK");

    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" }), t2()], lines); // sold, empty again at the sell market
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "BACK");
    assert.equal(a?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 leg 2")));
  });

  it("drops the second leg when its margin has collapsed, and picks like any idle trader", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    const weakBack = route("BACK", "X1-A-102", "X1-A-12", 10_000); // under half of the planned 42,000
    run(d, 1, [OUT, weakBack, SOLO], [t1({ waypoint: "X1-A-100" })], lines);
    assert.notEqual(d.assignmentFor("T-1")?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.includes("dropped leg 2") && l.includes("fell to")));
  });

  it("drops the second leg when the spendable cash would buy under half its load", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // BACK's buy price is 100 and a load is min(volume 40, hold 40) = 4,000; half of that is 2,000.
    const plan = (cashAfterSale: number) => {
      const d = new RouteDispatcher();
      run(d, 1, [OUT, BACK, SOLO], [t1()]);
      t.mock.timers.tick(60_001);
      run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
      t.mock.timers.tick(60_001);
      const lines: string[] = [];
      run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" })], lines, cashAfterSale);
      return { a: d.assignmentFor("T-1"), lines };
    };
    const rich = plan(10_000);
    assert.equal(rich.a?.good, "BACK");
    assert.equal(rich.a?.circuit?.leg, 2);
    const poor = plan(1_999);
    assert.notEqual(poor.a?.circuit?.leg, 2);
    assert.ok(poor.lines.some((l) => l.includes("dropped leg 2") && l.includes("cash:")));
  });

  it("keeps the second leg from a ship that shows up later, until the plan expires", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const early = new RouteDispatcher();
    run(early, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(10 * 60_000);
    run(early, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]);
    assert.equal(early.assignmentFor("T-2")?.good, "SOLO", "BACK is held for T-1 while its plan is fresh");

    const late = new RouteDispatcher();
    run(late, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(61 * 60_000);
    run(late, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]);
    assert.equal(late.assignmentFor("T-2")?.good, "BACK", "the held leg is released once the plan has expired");
  });

  it("switching the weight back to 0 releases every held leg", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 0, [OUT, BACK, SOLO], [t1({ busy: true }), t2()], lines);
    assert.deepEqual(lines.filter((l) => l.includes("dispatch circuit")).map((l) => l.includes("switched off")), [true], "one line saying the plan was forgotten");
    assert.equal(d.assignmentFor("T-2")?.good, "BACK", "BACK is no longer held for T-1");
  });

  it("a restart keeps the pending circuit: snapshot, restore, and the second leg is still served", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const before = new RouteDispatcher();
    assert.equal(before.circuitSnapshot(), undefined, "nothing planned, nothing to save");
    run(before, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(before, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    const saved = before.circuitSnapshot();
    assert.ok(saved && saved.includes("BACK"));
    assert.equal(before.circuitSnapshot(), undefined, "unchanged since the last save");

    // New process: fresh dispatcher, same saved plan. The ship is mid-leg-1; the fleet passes its held-route pin as inFlight.
    const after = new RouteDispatcher();
    after.restoreCircuits(saved!);
    assert.equal(after.circuitSnapshot(), undefined, "a restored plan is not re-saved");
    const pin = [{ shipSymbol: "T-1", good: "OUT", buyAt: "X1-A-10", sellAt: "X1-A-100", units: 40 }];
    const all = [OUT, BACK, SOLO];
    t.mock.timers.tick(60_001);
    after.recompute(all, [t1({ busy: true }), t2()], [], [], [], [], () => false, distance, undefined, undefined, undefined, { circuitWeight: 1 }, pin);
    assert.notEqual(after.assignmentFor("T-2")?.good, "BACK", "still held after the restart");
    t.mock.timers.tick(60_001);
    run(after, 1, all, [t1({ waypoint: "X1-A-100" }), t2()]); // sold
    assert.equal(after.assignmentFor("T-1")?.good, "BACK");
    assert.equal(after.assignmentFor("T-1")?.circuit?.leg, 2);
  });

  it("a restored plan whose first leg was never seen to run is dropped, not assumed", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const before = new RouteDispatcher();
    run(before, 1, [OUT, BACK, SOLO], [t1()]);
    const after = new RouteDispatcher();
    after.restoreCircuits(before.circuitSnapshot()!);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(after, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" })], lines);
    assert.notEqual(after.assignmentFor("T-1")?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.includes("leg 1 never ran")));
  });

  it("ignores a malformed saved plan", () => {
    const d = new RouteDispatcher();
    d.restoreCircuits("not json at all");
    d.restoreCircuits(JSON.stringify([["T-1", { nonsense: true }], 7, null]));
    assert.equal(d.circuitSnapshot(), undefined);
  });

  describe("a first leg in another system", () => {
    const inB = (good: string, buyAt: string, sellAt: string, profit: number, tripSeconds = 600): DispatchRoute =>
      ({ ...route(good, buyAt, sellAt, profit), buySystem: "X1-B", sellSystem: "X1-B", tripSeconds }) as DispatchRoute;
    const LOCAL = route("LOCAL", "X1-A-1", "X1-A-60", 50_000); // plain route right where the ship stands
    const pick = (out: number, back: number, tripSeconds: number, weight = 1) => {
      const XOUT = inB("XOUT", "X1-B-10", "X1-B-100", out, tripSeconds);
      const XBACK = inB("XBACK", "X1-B-102", "X1-B-12", back, tripSeconds);
      const d = new RouteDispatcher();
      d.recompute([XOUT, XBACK, LOCAL], [t1({ waypoint: "X1-A-1" })], [], [], [], [], () => true, distance, undefined, undefined, undefined, { circuitWeight: weight });
      return d.assignmentFor("T-1");
    };
    it("is not over-credited: the jump cooldown is charged as time", () => {
      // short trips: (40k + 42k) per cycle is ~81k, but a 600s wait halves it to ~41k, under the 50k route next door
      assert.equal(pick(40_000, 42_000, 600)?.good, "LOCAL");
      assert.equal(pick(40_000, 42_000, 600)?.circuit, undefined);
      assert.equal(pick(40_000, 42_000, 600, 0)?.good, "LOCAL");
    });
    it("is credited when the pair still earns enough after the wait", () => {
      // long trips make the same wait a small share of the cycle: ~82k a cycle, ~68k after the wait, over the 50k route
      const a = pick(200_000, 210_000, 3000);
      assert.equal(a?.circuit?.leg, 1, "the pair is planned as a circuit");
      assert.ok(a?.good === "XOUT" || a?.good === "XBACK");
      assert.equal(pick(200_000, 210_000, 3000, 0)?.good, "LOCAL", "with the feature off the pick is unchanged");
    });
  });

  it("still credits a circuit whose first leg starts in the ship's own system", () => {
    const d = new RouteDispatcher();
    d.recompute([OUT, BACK, SOLO], [t1()], [], [], [], [], () => true, distance, undefined, undefined, undefined, { circuitWeight: 1 });
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 1);
  });

  it("logs why a route got no circuit", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 1, [SOLO], [t1()], lines);
    assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 SOLO — no circuit (")), lines.join("\n"));
  });

  it("the return share admits a second leg that ends far from where the first began", () => {
    const FAR_END = route("FAR_END", "X1-A-102", "X1-A-900", 42_000);
    const pick = (share?: number) => {
      const d = new RouteDispatcher();
      d.recompute([OUT, FAR_END], [t1()], [], [], [], [], () => false, distance, undefined, undefined, undefined, { circuitWeight: 1, circuitReturnShare: share });
      return d.assignmentFor("T-1");
    };
    assert.equal(pick()?.circuit, undefined, "by default it must be a loop");
    assert.equal(pick(0)?.circuit?.leg, 1, "with the return share at 0 it is a circuit");
  });

  it("replaces the follow-on credit for a route that has a circuit", () => {
    const d = new RouteDispatcher();
    d.recompute([OUT, BACK, SOLO], [t1()], [], [], [], [], () => false, distance, undefined, undefined, undefined, { followOnWeight: 0.5, circuitWeight: 1 });
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "OUT");
    assert.equal(a?.circuit?.leg, 1);
    assert.equal(a?.followOn, undefined);
  });

  it("a declined or released first leg gives up its second leg", () => {
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 1);
    d.release("T-1");
    // nothing remembers T-1's plan any more, so a fresh cycle (past the throttle) can hand BACK to another ship
    (d as unknown as { lastComputed: number }).lastComputed = 0;
    run(d, 1, [BACK], [t2()]);
    assert.equal(d.assignmentFor("T-2")?.good, "BACK");
  });

  it("a trader refusing the leg it just sold keeps the second leg; a refusal before leg 1 ran drops it, with a log line", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]); // loaded
    d.decline("T-1"); // the trader re-checks its old assignment after the sale and refuses it
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" })], lines);
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 2, "the second leg is still served");

    const e = new RouteDispatcher();
    run(e, 1, [OUT, BACK, SOLO], [t1()]);
    e.decline("T-1"); // refused before any cargo was bought
    (e as unknown as { lastComputed: number }).lastComputed = 0;
    const lines2: string[] = [];
    run(e, 1, [OUT, BACK, SOLO], [t1()], lines2);
    assert.ok(lines2.some((l) => l.includes("dropped leg 2") && l.includes("refused before it ran")));
  });

  describe("across a gate", () => {
    // OUT buys in A and sells in B (one way: 840s, a jump); RET buys in B and sells back in A. canJump says every gate works.
    const cross = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
      ...route(good, buyAt, sellAt, profit),
      buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellSystem: sellAt.slice(0, sellAt.lastIndexOf("-")), tripSeconds: 840,
    } as DispatchRoute);
    const OUTX = cross("OUTX", "X1-A-10", "X1-B-100", 60_000);
    const RETX = cross("RETX", "X1-B-102", "X1-A-12", 50_000);
    const plan = (circuitCrossSystem: boolean) => {
      const d = new RouteDispatcher();
      const lines: string[] = [];
      d.recompute([OUTX, RETX], [t1()], [], [], [], [], () => true, distance, (m) => lines.push(m), undefined, undefined, { circuitWeight: 1, circuitCrossSystem });
      return { a: d.assignmentFor("T-1"), lines };
    };

    it("is planned only when the switch is on, and keeps the way back for the ship", () => {
      const off = plan(false);
      assert.equal(off.a?.good, "OUTX");
      assert.equal(off.a?.circuit, undefined);
      const on = plan(true);
      assert.equal(on.a?.good, "OUTX");
      assert.equal(on.a?.circuit?.leg, 1);
      assert.equal(on.a?.circuit?.leg2.good, "RETX");
      assert.ok(on.lines.some((l) => l.startsWith("dispatch circuit: T-1 OUTX") && l.includes("then RETX")));
    });

    it("serves the way back from the far system once the way out has been sold", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      const d = new RouteDispatcher();
      const tune = { circuitWeight: 1, circuitCrossSystem: true };
      const go = (tr: ReturnType<typeof t1>[], lines?: string[]) =>
        d.recompute([OUTX, RETX], tr, [], [], [], [], () => true, distance, lines ? (m) => lines.push(m) : undefined, undefined, undefined, tune);
      go([t1()]);
      assert.equal(d.assignmentFor("T-1")?.good, "OUTX");
      t.mock.timers.tick(60_001);
      go([t1({ busy: true })]);
      t.mock.timers.tick(60_001);
      const lines: string[] = [];
      go([t1({ system: "X1-B", waypoint: "X1-B-100" })], lines); // sold in B, empty again
      assert.equal(d.assignmentFor("T-1")?.good, "RETX");
      assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 2);
      assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 leg 2")));
    });
  });
});

describe("dispatcher circuit lifecycle log", () => {
  it("counts a circuit through planned, leg 1 sold, leg 2 served, loaded and completed, with timestamps", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2()], lines);
    assert.equal(d.circuitLog().counts.planned, 1);
    assert.equal(d.circuitLog().open.length, 1);

    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()], lines); // leg 1 loaded
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" }), t2()], lines); // leg 1 sold, leg 2 served
    let c = d.circuitLog();
    assert.equal(c.counts.leg1Sold, 1);
    assert.equal(c.counts.leg2Served, 1);

    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true, waypoint: "X1-A-102" }), t2()], lines); // leg 2 bought, flying
    c = d.circuitLog();
    assert.equal(c.counts.leg2Loaded, 1);

    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-12" }), t2()], lines); // leg 2 sold
    c = d.circuitLog();
    assert.equal(c.counts.completed, 1);
    // The ship is idle again, so the same recompute plans its next circuit: the finished one is gone, a new one is open.
    assert.equal(c.counts.planned, 2);
    assert.equal(c.open.length, 1);
    assert.deepEqual(c.events.slice(0, 5).map((e) => e.event), ["planned", "leg1_sold", "leg2_served", "leg2_loaded", "completed"]);
    assert.ok(lines.some((l) => l.includes("leg 1 sold") && l.includes("is now eligible")));
    assert.ok(lines.some((l) => l.includes("circuit complete")));
  });

  it("a second leg that left the board is dropped as 'no longer on the board', and counted", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 1, [OUT, SOLO], [t1({ waypoint: "X1-A-100" })], lines); // BACK is gone from the board
    const drop = lines.find((l) => l.includes("dropped leg 2"));
    assert.ok(drop && drop.includes("no longer on the board"), drop);
    const c = d.circuitLog();
    assert.equal(c.counts.leg2Served, 0);
    assert.equal(Object.values(c.counts.dropped).reduce((a, b) => a + b, 0), 1);
    assert.equal(c.open.length, 0);
  });

  it("a second leg still on the board but refused for the ship says why", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    // The ship now stands far from BACK's buy market with a tiny tank: still listed, but it cannot reach it.
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-5000", fuelCapacity: 1 })], lines);
    const drop = lines.find((l) => l.includes("dropped leg 2"));
    assert.ok(drop && drop.includes("still on the board but refused for this ship"), drop);
  });

  it("a switched-off or expired circuit is counted too", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 0, [OUT, BACK, SOLO], [t1({ busy: true })]);
    assert.deepEqual(d.circuitLog().counts.dropped, { "circuits switched off": 1 });
  });
});

describe("circuits do not share a buy market", () => {
  it("a second leg buying where another circuit's second leg buys is not offered", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // Two ships, each with an outbound leg whose best partner buys the same good at the same market (X1-A-102) but sells
    // somewhere different. Without the buy-side hold both circuits would plan it.
    const BACK_A = route("BACK", "X1-A-102", "X1-A-12", 42_000);
    const BACK_B = route("BACK", "X1-A-102", "X1-A-14", 41_500);
    const OUT2 = route("OUT2", "X1-A-11", "X1-A-101", 40_000);
    const d = new RouteDispatcher();
    run(d, 1, [OUT, OUT2, BACK_A, BACK_B, SOLO], [t1(), t2({ shipSymbol: "T-3", waypoint: "X1-A-11", capacity: 40 })]);
    const held = [...d.circuitLog().open];
    const buyers = d.circuitSnapshot() ?? "[]";
    const plans = JSON.parse(buyers) as [string, { leg2: { good: string; buyAt: string } }][];
    const buyKeys = plans.map(([, p]) => `${p.leg2.good}|${p.leg2.buyAt}`);
    assert.equal(new Set(buyKeys).size, buyKeys.length, "no two planned second legs buy the same good at the same market");
    assert.ok(held.length <= 2);
  });
});

describe("circuits and ships already buying the second leg's good", () => {
  it("a second leg another ship is already heading to buy is not offered, so no circuit is planned on it", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // T-2 is committed to a route that buys BACK's good at BACK's buy market (and sells it somewhere else).
    const T2_ROUTE = route("BACK", "X1-A-102", "X1-A-14", 41_500);
    const d = new RouteDispatcher();
    run(d, 1, [T2_ROUTE], [t2()]);
    assert.equal(d.assignmentFor("T-2")?.good, "BACK");
    t.mock.timers.tick(60_001);
    // T-1 could circuit OUT -> BACK (102 -> 12), but T-2 is already on its way to buy BACK at X1-A-102.
    const lines: string[] = [];
    // T-1 has a small tank, so BACK's buy market (92 away) is out of its reach as a first leg: it can only be a second leg.
    run(d, 1, [OUT, BACK, T2_ROUTE, SOLO], [t1({ fuelCapacity: 91 }), t2({ busy: true })], lines);
    assert.ok(d.assignmentFor("T-1"), "T-1 was served this cycle");
    assert.equal(d.assignmentFor("T-1")?.circuit, undefined, lines.join("\n"));
    assert.equal(d.assignmentFor("T-2")?.good, "BACK", "T-2 keeps its route");
  });

  it("without another buyer the same circuit is planned (control)", () => {
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2({ waypoint: "X1-A-500" })]);
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 1);
  });
});
