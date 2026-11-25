import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advanceLoop, decodeLoops, DEFAULT_LOOP_POLICY as P, encodeLoops, planLoops, planLoopSeeds, shareOf, type LoopKeeper } from "../src/engine/keeperLoop.js";

const M = 60_000;
const tour = (sys: string, n: number) => Array.from({ length: n }, (_, i) => `${sys}-M${i}`);

describe("planLoops", () => {
  it("makes one loop keeper from an idle keeper in a system with enough tour-only markets", () => {
    const d = planLoops({ nowMs: 0, tourMarkets: new Map([["X1-A", tour("X1-A", 4)], ["X1-B", tour("X1-B", 2)]]), free: [{ ship: "S-1", system: "X1-A", market: "X1-A-K" }, { ship: "S-2", system: "X1-B", market: "X1-B-K" }], loops: [] });
    assert.deepEqual(d.created.map((c) => [c.ship, c.start]), [["S-1", "X1-A-M0"]]);
    assert.deepEqual(d.loops.map((l) => [l.ship, l.markets.length]), [["S-1", 4]]);
  });

  it("adds a second loop keeper only when the last lap was slower than the target, and splits the markets", () => {
    const one: LoopKeeper = { ship: "S-1", system: "X1-A", markets: tour("X1-A", 6), idx: 2, lapStartMs: 0, lastLapMs: 20 * M };
    const free = [{ ship: "S-2", system: "X1-A", market: "X1-A-K" }];
    const fast = planLoops({ nowMs: 0, tourMarkets: new Map([["X1-A", tour("X1-A", 6)]]), free, loops: [one] });
    assert.equal(fast.created.length, 0);
    const slow = planLoops({ nowMs: 0, tourMarkets: new Map([["X1-A", tour("X1-A", 6)]]), free, loops: [{ ...one, lastLapMs: 45 * M }] });
    assert.deepEqual(slow.created.map((c) => c.ship), ["S-2"]);
    assert.deepEqual(slow.loops.map((l) => l.markets), [["X1-A-M0", "X1-A-M2", "X1-A-M4"], ["X1-A-M1", "X1-A-M3", "X1-A-M5"]]);
    assert.equal(slow.loops[0]!.idx, 1, "S-1 stays on the market it was at (M2)");
    const capped = planLoops({ nowMs: 0, tourMarkets: new Map([["X1-A", tour("X1-A", 6)]]), free, loops: slow.loops.map((l) => ({ ...l, lastLapMs: 90 * M })) });
    assert.equal(capped.created.length, 0, "never more than maxPerSystem");
  });

  it("ends a loop whose system no longer has enough tour-only markets", () => {
    const d = planLoops({ nowMs: 0, tourMarkets: new Map([["X1-A", tour("X1-A", 2)]]), free: [], loops: [{ ship: "S-1", system: "X1-A", markets: tour("X1-A", 4), idx: 0, lapStartMs: 0 }] });
    assert.deepEqual(d.ended.map((e) => e.ship), ["S-1"]);
    assert.deepEqual(d.loops, []);
  });

  it("caps new loops per pass", () => {
    const tm = new Map(["X1-A", "X1-B", "X1-C", "X1-D"].map((s) => [s, tour(s, 3)] as [string, string[]]));
    const free = [...tm.keys()].map((s, i) => ({ ship: `S-${i}`, system: s, market: `${s}-K` }));
    assert.equal(planLoops({ nowMs: 0, tourMarkets: tm, free, loops: [] }, { ...P, maxNewPerPass: 2 }).created.length, 2);
  });
});

describe("advanceLoop", () => {
  it("steps to the next market and times each lap", () => {
    let l: LoopKeeper = { ship: "S-1", system: "X1-A", markets: ["A", "B", "C"], idx: 0, lapStartMs: 0 };
    const seen: string[] = [];
    for (let t = 1; t <= 3; t++) { const s = advanceLoop(l, t * M)!; seen.push(s.next); l = s.loop; }
    assert.deepEqual(seen, ["B", "C", "A"]);
    assert.equal(l.lastLapMs, 3 * M);
    assert.equal(l.lapStartMs, 3 * M);
    assert.equal(advanceLoop({ ...l, markets: [] }, 0), undefined);
  });
  it("shareOf covers every market exactly once", () => {
    const all = tour("X1-A", 7);
    assert.deepEqual([...shareOf(all, 0, 2), ...shareOf(all, 1, 2)].sort(), [...all].sort());
  });
});

describe("loops survive a restart", () => {
  it("round-trips, and a bad flag gives no loops", () => {
    const l: LoopKeeper = { ship: "S-1", system: "X1-A", markets: ["A", "B"], idx: 1, lapStartMs: 5, lastLapMs: 9 };
    assert.deepEqual(decodeLoops(encodeLoops([l])), [l]);
    assert.deepEqual(decodeLoops("{nope"), []);
    assert.deepEqual(decodeLoops(undefined), []);
  });
});

describe("planLoopSeeds (operator 2026-11-25: no unread tour-only markets)", () => {
  const tour = new Map<string, string[]>([["X1-A", ["X1-A-1", "X1-A-2", "X1-A-3", "X1-A-4"]], ["X1-B", ["X1-B-1", "X1-B-2", "X1-B-3"]], ["X1-C", ["X1-C-1", "X1-C-2"]]]);
  const base = { tourMarkets: tour, loops: [], freeSystems: new Set<string>(), seededSystems: new Set<string>(), taken: new Set<string>() };

  it("seeds a system with enough tour-only markets and no loop, most markets first; never one under the minimum", () => {
    const out = planLoopSeeds(base, 5);
    assert.deepEqual(out.map((x) => [x.system, x.market]), [["X1-A", "X1-A-1"], ["X1-B", "X1-B-1"]]);
  });

  it("skips systems with a loop, a free hull or a pending seed, and markets already taken", () => {
    const loop = { ship: "S1", system: "X1-A", markets: ["X1-A-1"], idx: 0, lapStartMs: 0 };
    assert.deepEqual(planLoopSeeds({ ...base, loops: [loop] }, 5).map((x) => x.system), ["X1-B"]);
    assert.deepEqual(planLoopSeeds({ ...base, freeSystems: new Set(["X1-B"]) }, 5).map((x) => x.system), ["X1-A"]);
    assert.deepEqual(planLoopSeeds({ ...base, seededSystems: new Set(["X1-A", "X1-B"]) }, 5), []);
    assert.equal(planLoopSeeds({ ...base, taken: new Set(["X1-A-1"]) }, 1)[0]!.market, "X1-A-2");
  });

  it("respects the per-pass limit; 0 picks nothing", () => {
    assert.equal(planLoopSeeds(base, 1).length, 1);
    assert.equal(planLoopSeeds(base, 0).length, 0);
  });
});
