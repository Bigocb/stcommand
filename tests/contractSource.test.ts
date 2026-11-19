import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseContractSource, CONTRACT_SOURCE_OFF, type SourceCandidate } from "../src/engine/contractSource.js";

// The 2026-11-18 FOOD contract (issue #54): home KJ19, delivery YH41 (2 jumps from KJ19), S96 1 jump from YH41.
const NOW = Date.parse("2026-11-19T00:30:00Z");
const HOPS: Record<string, number> = { "X1-KJ19>X1-YH41": 2, "X1-S96>X1-YH41": 1, "X1-AV19>X1-YH41": 2, "X1-FAR>X1-YH41": 5 };
const hops = (a: string, b: string): number | undefined => (a === b ? 0 : HOPS[`${a}>${b}`]);
const c = (waypoint: string, price: number, ageMin = 5): SourceCandidate => ({
  waypoint, system: waypoint.slice(0, waypoint.lastIndexOf("-")), purchasePrice: price, observedAt: NOW - ageMin * 60_000,
});
const CANDS = [c("X1-KJ19-A1", 4_422, 300), c("X1-KJ19-K83", 4_041, 300), c("X1-S96-AD6B", 2_203), c("X1-AV19-FE8X", 2_214)];
const ctx = { homeSystem: "X1-KJ19", destinationSystem: "X1-YH41", units: 19, now: NOW, hops };
const ON = { ...CONTRACT_SOURCE_OFF, enabled: true };

describe("chooseContractSource (pure)", () => {
  it("off reproduces the old rule: cheapest home-system market, whatever its age", () => {
    const got = chooseContractSource(CANDS, ctx, CONTRACT_SOURCE_OFF);
    assert.equal(got?.waypoint, "X1-KJ19-K83");
    assert.equal(got?.purchasePrice, 4_041);
  });

  it("on: a 1-jump market at half price beats the home system (the issue #54 case)", () => {
    const got = chooseContractSource(CANDS, ctx, ON);
    assert.equal(got?.waypoint, "X1-S96-AD6B");
    assert.equal(got?.hops, 1);
    assert.equal(got?.landedCost, 2_203 * 19 + 1 * 2 * 6_500);
    assert.match(got?.reason ?? "", /home X1-KJ19-K83 at 4041 would land/);
  });

  it("on: jumps count, so a slightly cheaper far market loses to a nearer one", () => {
    const got = chooseContractSource([c("X1-FAR-A1", 2_100), c("X1-S96-AD6B", 2_203)], { ...ctx, units: 10 }, ON);
    // FAR: 21,000 + 5*2*6,500 = 86,000; S96: 22,030 + 13,000 = 35,030
    assert.equal(got?.waypoint, "X1-S96-AD6B");
  });

  it("on: a stale away price is ignored, a stale home price is kept (as before)", () => {
    const got = chooseContractSource([c("X1-KJ19-A1", 4_422, 300), c("X1-S96-AD6B", 2_203, 200)], ctx, ON);
    assert.equal(got?.waypoint, "X1-KJ19-A1");
  });

  it("on: an away market with no known gate path is skipped", () => {
    const got = chooseContractSource([c("X1-KJ19-A1", 4_422), c("X1-NOPATH-A1", 1_000)], ctx, ON);
    assert.equal(got?.waypoint, "X1-KJ19-A1");
  });

  it("no candidates (or none at home with the clause off) gives undefined", () => {
    assert.equal(chooseContractSource([], ctx, ON), undefined);
    assert.equal(chooseContractSource([c("X1-S96-AD6B", 2_203)], ctx, CONTRACT_SOURCE_OFF), undefined);
  });
});
