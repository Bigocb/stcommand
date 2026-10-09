import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestFollowOn, chainScore, explainChain, DEFAULT_CHAIN_POLICY, type ChainCandidate, type ChainContext, type ChainPolicy } from "../src/engine/chain.js";

const cand = (key: string, buyAt: string, sellAt: string, profit: number, extra: Partial<ChainCandidate> = {}): ChainCandidate => ({
  key, good: key, buyAt, buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellAt, profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ...extra,
});
// X1-A waypoints on a line: distance = |number difference|
const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const ctx = (over: Partial<ChainContext> = {}): ChainContext => ({
  distanceBetween: (a, b) => Math.abs(num(a) - num(b)),
  crossSystemCost: () => 6000,
  unavailable: () => false,
  ...over,
});
const on: ChainPolicy = { ...DEFAULT_CHAIN_POLICY, followOnWeight: 0.5 };

describe("bestFollowOn", () => {
  it("prefers the follow-on that starts where the ship sold", () => {
    const near = cand("NEAR", "X1-A-10", "X1-A-50", 60_000);
    const far = cand("FAR", "X1-A-500", "X1-A-900", 70_000);
    const f = bestFollowOn("X1-A-12", [near, far], ctx(), on);
    assert.equal(f?.candidate.key, "NEAR");
  });
  it("ignores unavailable and excluded candidates", () => {
    const a = cand("A", "X1-A-10", "X1-A-50", 60_000);
    const b = cand("B", "X1-A-11", "X1-A-50", 30_000);
    assert.equal(bestFollowOn("X1-A-12", [a, b], ctx({ unavailable: (c) => c.key === "A" }), on)?.candidate.key, "B");
    assert.equal(bestFollowOn("X1-A-12", [a, b], ctx(), on, "A")?.candidate.key, "B");
  });
  it("drops a follow-on beyond the horizon", () => {
    const f = cand("F", "X1-A-2000", "X1-A-2100", 90_000); // 1,988s empty > 15 min
    assert.equal(bestFollowOn("X1-A-12", [f], ctx(), on), undefined);
  });
  it("charges a third of the jump for a cross-system follow-on, and skips unreachable ones", () => {
    const x = cand("X", "X1-B-5", "X1-B-9", 30_000);
    assert.equal(bestFollowOn("X1-A-12", [x], ctx(), on)?.score, 30_000 - 2000);
    assert.equal(bestFollowOn("X1-A-12", [x], ctx({ crossSystemCost: () => undefined }), on), undefined);
  });
});

describe("chainScore", () => {
  const f = bestFollowOn("X1-A-12", [cand("N", "X1-A-12", "X1-A-50", 40_000)], ctx(), on);
  it("adds the weighted follow-on", () => {
    assert.equal(chainScore(50_000, f, on), 50_000 + 0.5 * 40_000);
  });
  it("weight 0 is exactly the plain score", () => {
    assert.equal(chainScore(50_000, f, DEFAULT_CHAIN_POLICY), 50_000);
  });
  it("a route ending next to a good follow-on beats an equal route ending in a dead end", () => {
    const followers = [cand("N", "X1-A-12", "X1-A-50", 40_000)];
    const endsNear = chainScore(50_000, bestFollowOn("X1-A-12", followers, ctx(), on), on);
    const deadEnd = chainScore(50_000, bestFollowOn("X1-A-5000", followers, ctx(), on), on);
    assert.ok(endsNear > deadEnd);
  });
  it("explains itself", () => {
    assert.match(explainChain(50_000, f, on), /then N/);
    assert.equal(explainChain(50_000, f, DEFAULT_CHAIN_POLICY), "follow-on lookahead off");
  });
});
