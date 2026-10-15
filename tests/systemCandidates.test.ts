import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { judgeSystems, DEFAULT_CANDIDATE_POLICY, type SystemFacts } from "../src/engine/systems/candidates.js";

const base = (over: Partial<SystemFacts>): SystemFacts => ({
  system: "X1-A", hops: 1, gateComplete: true, surveyed: true, markets: 8, hullYard: true,
  localRoutes: 3, bestLocalProfit: 50_000, ourShips: 0, ...over,
});

const one = (f: SystemFacts) => judgeSystems([f])[0]!;

describe("candidate systems", () => {
  it("makes a surveyed system with local routes, a finished gate and a hull yard a candidate, with reasons", () => {
    const v = one(base({}));
    assert.equal(v.status, "candidate");
    assert.ok(v.score > 0 && v.score <= 100);
    assert.ok(v.reasons.some((r) => /gate hop/.test(r)));
    assert.ok(v.reasons.some((r) => /local route/.test(r)));
  });

  it("excludes a system beyond the hop limit, and one no known gate path reaches", () => {
    assert.match(one(base({ hops: 3 })).reasons[0]!, /3 gate hops away \(limit 2\)/);
    assert.equal(one(base({ hops: undefined })).status, "excluded");
  });

  it("excludes a system with an unfinished gate, and one with no gate data", () => {
    assert.match(one(base({ gateComplete: false })).reasons[0]!, /not finished/);
    assert.equal(one(base({ gateComplete: undefined })).status, "excluded");
  });

  it("lists an unsurveyed system as a survey target, never a candidate, since its markets and yards are unknown", () => {
    const v = one(base({ surveyed: false, localRoutes: 0, hullYard: undefined }));
    assert.equal(v.status, "unsurveyed");
    assert.match(v.reasons.at(-1)!, /not surveyed/);
  });

  it("excludes a surveyed system below the local-route minimum", () => {
    assert.match(one(base({ localRoutes: 0 })).reasons[0]!, /0 profitable local routes \(need 1\)/);
  });

  it("only applies the hull filter when asked, and then excludes a system with no trading hull", () => {
    assert.equal(one(base({ hullYard: false })).status, "candidate");
    const strict = judgeSystems([base({ hullYard: false })], { ...DEFAULT_CANDIDATE_POLICY, requireHullYard: true })[0]!;
    assert.equal(strict.status, "excluded");
  });

  it("ranks candidates by score, then survey targets, then exclusions", () => {
    const rich = base({ system: "X1-RICH", bestLocalProfit: 150_000, hops: 1 });
    const poor = base({ system: "X1-POOR", bestLocalProfit: 5_000, hops: 2, hullYard: false });
    const survey = base({ system: "X1-SURV", surveyed: false, localRoutes: 0, hullYard: undefined });
    const out = base({ system: "X1-OUT", hops: 5 });
    const order = judgeSystems([out, poor, survey, rich]).map((v) => v.system);
    assert.deepEqual(order, ["X1-RICH", "X1-POOR", "X1-SURV", "X1-OUT"]);
  });

  it("a zero weight switches a factor off", () => {
    const off = { ...DEFAULT_CANDIDATE_POLICY, weights: { localProfit: 0, hullYard: 0, hops: 0 } };
    assert.equal(judgeSystems([base({ bestLocalProfit: 999_999 })], off)[0]!.score, 0);
  });
});
