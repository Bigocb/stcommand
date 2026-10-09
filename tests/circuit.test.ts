import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestCircuit, circuitExpired, circuitScore, judgeLeg2, legId, DEFAULT_CIRCUIT_POLICY, type CircuitContext, type CircuitPolicy } from "../src/engine/circuit.js";
import type { ChainCandidate } from "../src/engine/chain.js";

const cand = (key: string, buyAt: string, sellAt: string, profit: number, extra: Partial<ChainCandidate> = {}): ChainCandidate => ({
  key, good: key, buyAt, buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellAt, profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ...extra,
});
// X1-A waypoints on a line: distance = |number difference|
const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const ctx = (over: Partial<CircuitContext> = {}): CircuitContext => ({
  distanceBetween: (a, b) => Math.abs(num(a) - num(b)),
  unavailable: () => false,
  ...over,
});
const on: CircuitPolicy = { ...DEFAULT_CIRCUIT_POLICY, weight: 1 };

describe("bestCircuit", () => {
  const leg1 = cand("OUT", "X1-A-10", "X1-A-100", 40_000);
  const back = cand("BACK", "X1-A-102", "X1-A-12", 30_000);

  it("pairs a leg that starts where leg 1 sells and ends where leg 1 began", () => {
    const c = bestCircuit(leg1, [leg1, back], ctx(), on);
    assert.equal(c?.leg2.key, "BACK");
    assert.equal(c?.betweenSeconds, 2);
    assert.equal(c?.returnSeconds, 2);
    // (40,000 x 600 + 30,000 x 600) / (300 + 300 + 2 + 2)
    assert.ok(Math.abs((c?.rate ?? 0) - (70_000 * 600) / 604) < 1e-6);
    assert.match(c?.explain ?? "", /then BACK: buy X1-A-102, sell X1-A-12/);
  });

  it("two equal legs with no empty hops earn double a single route", () => {
    const a = cand("A", "X1-A-10", "X1-A-100", 30_000);
    const b = cand("B", "X1-A-100", "X1-A-10", 30_000);
    const c = bestCircuit(a, [a, b], ctx(), on);
    assert.equal(c?.cycleSeconds, 600);
    assert.equal(c?.rate, 60_000);
  });

  it("weight 0 plans nothing", () => {
    assert.equal(bestCircuit(leg1, [leg1, back], ctx(), DEFAULT_CIRCUIT_POLICY), undefined);
  });

  it("rejects a second leg that starts too far from the sale, or ends too far from the start", () => {
    const farStart = cand("FARSTART", "X1-A-900", "X1-A-12", 90_000); // 800s from the sale > 10 min
    const farEnd = cand("FAREND", "X1-A-102", "X1-A-900", 90_000); // 890s back > 10 min
    assert.equal(bestCircuit(leg1, [leg1, farStart, farEnd], ctx(), on), undefined);
  });

  it("rejects the same good, other systems, unavailable legs and unprofitable legs", () => {
    const sameGood = cand("BACK2", "X1-A-102", "X1-A-12", 90_000, { good: "OUT" });
    const otherSystem = cand("OTHER", "X1-B-5", "X1-B-9", 90_000);
    const loss = cand("LOSS", "X1-A-102", "X1-A-12", -5);
    assert.equal(bestCircuit(leg1, [leg1, sameGood, otherSystem, loss], ctx(), on), undefined);
    assert.equal(bestCircuit(leg1, [leg1, back], ctx({ unavailable: (c) => c.key === "BACK" }), on), undefined);
    const crossLeg1 = cand("X", "X1-A-10", "X1-B-9", 40_000);
    assert.equal(bestCircuit(crossLeg1, [crossLeg1, back], ctx(), on), undefined, "a cross-system first leg has no same-system circuit");
  });

  it("takes the best of several second legs", () => {
    const worse = cand("WORSE", "X1-A-101", "X1-A-11", 10_000);
    assert.equal(bestCircuit(leg1, [leg1, worse, back], ctx(), on)?.leg2.key, "BACK");
  });
});

describe("circuitScore", () => {
  const leg1 = cand("OUT", "X1-A-10", "X1-A-100", 40_000);
  const back = cand("BACK", "X1-A-102", "X1-A-12", 30_000);
  const circuit = bestCircuit(leg1, [leg1, back], ctx(), on)!;

  it("credits the weighted gain over the route's own score", () => {
    const gain = circuit.rate - 40_000;
    assert.ok(Math.abs(circuitScore(40_000, circuit, 0, 0, on) - circuit.rate) < 1e-6);
    assert.ok(Math.abs(circuitScore(40_000, circuit, 0, 0, { ...on, weight: 0.5 }) - (40_000 + 0.5 * gain)) < 1e-6);
  });

  it("weight 0, no circuit, or a circuit no better than the route leaves the score alone", () => {
    assert.equal(circuitScore(40_000, circuit, 0, 0, DEFAULT_CIRCUIT_POLICY), 40_000);
    assert.equal(circuitScore(40_000, undefined, 0, 0, on), 40_000);
    assert.equal(circuitScore(90_000, circuit, 0, 0, on), 90_000);
  });

  it("discounts the empty flight to the first buy and charges the extra-buyer penalty", () => {
    const far = circuitScore(20_000, circuit, 600, 0, on); // positioning as long as the trip halves the circuit's rate
    assert.ok(Math.abs(far - circuit.rate / 2) < 1e-6);
    assert.ok(circuitScore(20_000, circuit, 0, 5_000, on) < circuitScore(20_000, circuit, 0, 0, on));
  });
});

describe("judgeLeg2", () => {
  const planned = { leg2: { good: "BACK", buyAt: "X1-A-102", sellAt: "X1-A-12" }, leg2Score: 30_000, at: 0 };
  it("keeps a leg that still scores", () => {
    assert.equal(judgeLeg2(planned, 28_000, on).ok, true);
    assert.equal(judgeLeg2(planned, 15_000, on).ok, true, "exactly the bail-out share still flies");
  });
  it("drops a leg that is gone, unprofitable or has lost too much", () => {
    assert.match(judgeLeg2(planned, undefined, on).reason, /no longer available/);
    assert.match(judgeLeg2(planned, 0, on).reason, /no longer profitable/);
    const v = judgeLeg2(planned, 14_000, on);
    assert.equal(v.ok, false);
    assert.match(v.reason, /fell to 14000 from 30000/);
  });
});

describe("circuitExpired / legId", () => {
  it("expires after the ttl", () => {
    const planned = { leg2: { good: "G", buyAt: "X1-A-1", sellAt: "X1-A-2" }, leg2Score: 1, at: 1_000 };
    assert.equal(circuitExpired(planned, 1_000 + 60 * 60_000, on), false);
    assert.equal(circuitExpired(planned, 1_000 + 60 * 60_000 + 1, on), true);
  });
  it("identifies a leg by good and both markets", () => {
    assert.equal(legId({ good: "G", buyAt: "X1-A-1", sellAt: "X1-A-2" }), "G|X1-A-1|X1-A-2");
  });
});
