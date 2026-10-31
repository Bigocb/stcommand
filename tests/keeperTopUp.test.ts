import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOPUP_POLICY, pickTopUp, type TopUpContext, type TopUpSystem } from "../src/engine/keeperTopUp.js";

const policy = { ...DEFAULT_TOPUP_POLICY, perHour: 2 };
const ctx: TopUpContext = { nowMs: 10_000_000, keepers: 100, max: 300, keeperCallsPerMin: 40, callsPerKeeper: 0.2, pending: 0 };
const systems: TopUpSystem[] = [
  { system: "X1-AA", covered: 6, candidates: ["X1-AA-1", "X1-AA-2"] },
  { system: "X1-BB", covered: 6, candidates: ["X1-BB-1", "X1-BB-2", "X1-BB-3", "X1-BB-4", "X1-BB-5", "X1-BB-6"] },
];

test("off by default: perHour 0 picks nothing", () => {
  assert.equal(pickTopUp(systems, ctx, DEFAULT_TOPUP_POLICY).market, undefined);
});

test("picks the best market of the least-covered system", () => {
  const d = pickTopUp(systems, ctx, policy);
  assert.equal(d.market, "X1-BB-1");
  assert.equal(d.system, "X1-BB");
});

test("waits out the gap since the last top-up, then goes", () => {
  assert.equal(pickTopUp(systems, { ...ctx, lastAddMs: ctx.nowMs - 10 * 60_000 }, policy).market, undefined);
  assert.equal(pickTopUp(systems, { ...ctx, lastAddMs: ctx.nowMs - 31 * 60_000 }, policy).market, "X1-BB-1");
});

test("holds while listed markets still wait for keepers", () => {
  assert.match(pickTopUp(systems, { ...ctx, pending: 3 }, policy).reason, /still wait/);
});

test("holds at the keeper limit, and 0 means no limit", () => {
  assert.equal(pickTopUp(systems, { ...ctx, keepers: 300 }, policy).market, undefined);
  assert.equal(pickTopUp(systems, { ...ctx, keepers: 5000, max: 0 }, policy).market, "X1-BB-1");
});

test("holds when one more keeper would pass the polling ceiling", () => {
  assert.match(pickTopUp(systems, { ...ctx, keeperCallsPerMin: 59.9 }, policy).reason, /no API room/);
  assert.equal(pickTopUp(systems, { ...ctx, keeperCallsPerMin: 59.7 }, policy).market, "X1-BB-1");
});

test("nothing to add when every system is covered", () => {
  assert.match(pickTopUp([{ system: "X1-AA", covered: 6, candidates: [] }], ctx, policy).reason, /covered/);
});

import { coverageRows, pendingForTopUp } from "../src/engine/keeperTopUp.js";
import { OPS_TOOLS } from "../src/ops/catalog.js";

describe("what holds top-up back", () => {
  const sysOf = (m: string): string => m.slice(0, m.lastIndexOf("-"));
  it("does not count the listed markets of a staged or scouted system as waiting", () => {
    const listed = ["X1-LIVE-A", "X1-LIVE-B", "X1-STAGED-A", "X1-STAGED-B", "X1-STAGED-C", "X1-STAGED-D"];
    assert.equal(pendingForTopUp(listed, new Set(["X1-LIVE-A"]), new Set(["X1-STAGED"]), sysOf), 1, "only LIVE-B waits");
    assert.equal(pendingForTopUp(listed, new Set(), new Set(), sysOf), 6, "no queued systems: everything uncovered counts, as before");
  });

  it("lists the live systems with the most uncovered markets first", () => {
    const rows = coverageRows([
      { system: "X1-A", covered: 6, candidates: ["a1", "a2"] },
      { system: "X1-B", covered: 6, candidates: ["b1", "b2", "b3", "b4", "b5"] },
      { system: "X1-C", covered: 5, candidates: [] },
    ], (s) => ({ "X1-A": 8, "X1-B": 11, "X1-C": 5 })[s] ?? 0);
    assert.deepEqual(rows.map((r) => [r.system, r.viable, r.covered, r.uncovered]), [["X1-B", 11, 6, 5], ["X1-A", 8, 6, 2], ["X1-C", 5, 5, 0]]);
  });

  it("the ops tool hands the fleet's coverage to the caller with totals", async () => {
    const w = { fleet: { keeperCoverageData: async () => ({ rows: coverageRows([{ system: "X1-B", covered: 6, candidates: ["b1", "b2"] }], () => 8), topUp: { perHour: 8 } }) } } as any;
    const tool = OPS_TOOLS.find((x) => x.name === "keeper_coverage")!;
    const r: any = await tool.run({ w, now: () => 0 } as any, { limit: 40 });
    assert.deepEqual(r.totals, { liveSystems: 1, viable: 8, covered: 6, uncovered: 2, systemsWithGaps: 1 });
    assert.equal(r.topUp.perHour, 8);
  });
});
