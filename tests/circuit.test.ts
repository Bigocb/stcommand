import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestCircuit, circuitExpired, circuitReport, circuitScore, judgeLeg2, legId, DEFAULT_CIRCUIT_POLICY, type CircuitContext, type CircuitPolicy } from "../src/engine/circuit.js";
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

  describe("across a gate", () => {
    // OUT: buy in A, sell in B (one way: 840s incl. a jump). RET: buy in B near where OUT sold, sell back in A near where OUT began.
    const num2 = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
    const dist2 = { distanceBetween: (a: string, b: string) => Math.abs(num2(a) - num2(b)), unavailable: () => false };
    const out = cand("OUT", "X1-A-10", "X1-B-100", 60_000, { tripSeconds: 840 });
    const ret = cand("RET", "X1-B-102", "X1-A-12", 50_000, { tripSeconds: 840 });
    const cross: CircuitPolicy = { ...on, crossSystem: true };

    it("is off unless the policy allows it", () => {
      assert.equal(bestCircuit(out, [out, ret], dist2, on), undefined);
    });

    it("pairs a way out with a way back, and counts each gate trip as one way (not halved)", () => {
      const c = bestCircuit(out, [out, ret], dist2, cross);
      assert.equal(c?.leg2.key, "RET");
      assert.equal(c?.cycleSeconds, 840 + 840 + 2 + 2);
      assert.ok(Math.abs((c?.rate ?? 0) - ((60_000 * 840 + 50_000 * 840) / 1684)) < 1e-6);
    });

    it("is credited against what the way out earns once the empty jump home is counted, not its one-way score", () => {
      // The route's score (60,000) uses its one-way time. Alone the ship also jumps home empty for as long again, so it
      // really earns 30,000; the pair earns ~54,900, and the credit is the weighted difference added to the score.
      const c = bestCircuit(out, [out, ret], dist2, cross)!;
      assert.ok(c.rate < 60_000, "under the one-way score: comparing with that would never credit a circuit");
      const credited = circuitScore(60_000, c, 0, 0, cross);
      assert.ok(Math.abs(credited - (60_000 + (c.rate - 30_000))) < 1e-6);
      // a same-system circuit is compared with the score itself, as before
      const same = bestCircuit(leg1, [leg1, back], ctx(), cross)!;
      assert.ok(Math.abs(circuitScore(40_000, same, 0, 0, cross) - (40_000 + (same.rate - 40_000))) < 1e-6);
    });

    it("is credited in proportion to what the way back earns: a thin return adds almost nothing", () => {
      const thin = cand("THIN", "X1-B-102", "X1-A-12", 1_000, { tripSeconds: 840 });
      const good = bestCircuit(out, [out, ret], dist2, cross)!;
      const poor = bestCircuit(out, [out, thin], dist2, cross)!;
      const gain = (c: typeof good) => circuitScore(60_000, c, 0, 0, cross) - 60_000;
      assert.ok(gain(poor) < 500 && gain(good) > 20_000);
    });

    it("needs the second leg to start in the system leg 1 sells in and end in the one it began in", () => {
      const wrongStart = cand("W1", "X1-C-102", "X1-A-12", 90_000, { tripSeconds: 840 });
      const wrongEnd = cand("W2", "X1-B-102", "X1-C-12", 90_000, { tripSeconds: 840 });
      const sameSystem = cand("W3", "X1-B-102", "X1-B-12", 90_000);
      assert.equal(bestCircuit(out, [out, wrongStart, wrongEnd, sameSystem], dist2, cross), undefined);
    });

    it("leaves same-system circuits exactly as they were when it is on", () => {
      const a = bestCircuit(leg1, [leg1, back], ctx(), on);
      const b = bestCircuit(leg1, [leg1, back], ctx(), cross);
      assert.equal(a?.rate, b?.rate);
      assert.equal(a?.cycleSeconds, b?.cycleSeconds);
    });
  });

  it("takes the best of several second legs", () => {
    const worse = cand("WORSE", "X1-A-101", "X1-A-11", 10_000);
    assert.equal(bestCircuit(leg1, [leg1, worse, back], ctx(), on)?.leg2.key, "BACK");
  });
});

describe("return share", () => {
  const leg1 = cand("OUT", "X1-A-10", "X1-A-100", 40_000);
  const ends = cand("ENDSFAR", "X1-A-102", "X1-A-900", 42_000); // starts by the sale, ends 890s from where leg 1 began
  it("by default a second leg that ends far from the start is not a circuit", () => {
    assert.equal(bestCircuit(leg1, [leg1, ends], ctx(), on), undefined);
  });
  it("with the return share at 0 two loaded legs back to back are enough, and the empty return is not charged", () => {
    const c = bestCircuit(leg1, [leg1, ends], ctx(), { ...on, returnShare: 0 });
    assert.equal(c?.leg2.key, "ENDSFAR");
    assert.equal(c?.cycleSeconds, 300 + 300 + 2); // no return hop in the cycle
    assert.ok(Math.abs((c?.rate ?? 0) - (82_000 * 600) / 602) < 1e-6);
  });
  it("a share between 0 and 1 charges that part of a return that is within reach", () => {
    const back = cand("BACK", "X1-A-102", "X1-A-30", 42_000); // 20s back
    const half = bestCircuit(leg1, [leg1, back], ctx(), { ...on, returnShare: 0.5 });
    assert.equal(half?.cycleSeconds, 300 + 300 + 2 + 10);
  });
});

describe("circuitReport", () => {
  const leg1 = cand("OUT", "X1-A-10", "X1-A-100", 40_000);
  it("counts why nothing paired", () => {
    const other = cand("OTHER", "X1-A-900", "X1-A-950", 40_000); // starts 800s from the sale
    const text = circuitReport(leg1, [leg1, other], ctx(), on, 40_000);
    assert.match(text, /^no circuit \(1 legs that close the loop, 1 free, 0 start within 10m of the sale, 0 also end within 10m of the start\)$/);
  });
  it("names the best pair and its rate against the route when one exists", () => {
    const back = cand("BACK", "X1-A-102", "X1-A-12", 30_000);
    const text = circuitReport(leg1, [leg1, back], ctx(), on, 90_000);
    assert.match(text, /best BACK scores \d+ \(rate \d+\) vs route 90000/);
  });
  it("puts the circuit on the route's scale (positioning, penalty) before comparing", () => {
    const back = cand("BACK", "X1-A-102", "X1-A-12", 30_000);
    const plain = circuitReport(leg1, [leg1, back], ctx(), on, 90_000);
    const shifted = circuitReport(leg1, [leg1, back], ctx(), on, 90_000, leg1.tripSeconds, 1_000);
    const scored = (t: string) => Number(/scores (-?\d+)/.exec(t)![1]);
    assert.ok(scored(shifted) < scored(plain) / 2, "a positioning flight as long as the trip more than halves it");
  });
  it("does not count legs that are taken", () => {
    const back = cand("BACK", "X1-A-102", "X1-A-12", 30_000);
    const text = circuitReport(leg1, [leg1, back], ctx({ unavailable: () => true }), on, 40_000);
    assert.match(text, /1 legs that close the loop, 0 free/);
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

describe("judgeLeg2 cash", () => {
  const planned = { leg2: { good: "BACK", buyAt: "X1-A-102", sellAt: "X1-A-12" }, leg2Score: 30_000, at: 0 };
  it("flies the leg when cash buys at least half the load, or the wallet is unknown", () => {
    assert.equal(judgeLeg2(planned, 30_000, on, { spendable: 50_000, cost: 100_000 }).ok, true);
    assert.equal(judgeLeg2(planned, 30_000, on).ok, true);
  });
  it("drops the leg when cash would buy under half the load", () => {
    const v = judgeLeg2(planned, 30_000, on, { spendable: 49_999, cost: 100_000 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /cash: 49999 spendable vs 100000/);
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
