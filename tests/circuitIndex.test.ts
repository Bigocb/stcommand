import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestCircuit, circuitBucket, circuitIndex, DEFAULT_CIRCUIT_POLICY, type CircuitContext, type CircuitPolicy } from "../src/engine/circuit.js";
import type { ChainCandidate } from "../src/engine/chain.js";

// Deterministic pseudo-random so a failure reproduces.
let seed = 7;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const systems = ["X1-AA", "X1-BB", "X1-CC", "X1-DD"];
const wp = (): string => `${systems[Math.floor(rnd() * systems.length)]}-${Math.floor(rnd() * 200)}`;
const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const ctx: CircuitContext = { distanceBetween: (a, b) => Math.abs(num(a) - num(b)), unavailable: (c) => c.key.endsWith("7") };

const candidates: ChainCandidate[] = Array.from({ length: 600 }, (_, i) => {
  const buyAt = wp();
  return {
    key: `K${i}`, good: `G${i % 23}`, buyAt, buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellAt: wp(),
    profitPerTrip: Math.floor(rnd() * 100_000), tripSeconds: 300 + Math.floor(rnd() * 900), secPerDist: 1 + rnd(),
  };
});

describe("circuitIndex", () => {
  for (const crossSystem of [false, true]) {
    it(`gives bestCircuit the same answer as the full list (crossSystem ${crossSystem})`, () => {
      const policy: CircuitPolicy = { ...DEFAULT_CIRCUIT_POLICY, weight: 1, crossSystem, horizonMinutes: 10 };
      const index = circuitIndex(candidates);
      let found = 0;
      for (const leg1 of candidates) {
        const full = bestCircuit(leg1, candidates, ctx, policy);
        const fast = bestCircuit(leg1, circuitBucket(index, leg1), ctx, policy);
        assert.equal(fast?.leg2.key, full?.leg2.key, leg1.key);
        assert.equal(fast?.rate, full?.rate, leg1.key);
        if (full) found += 1;
      }
      assert.ok(found > 0, "the fixture should produce some circuits");
    });
  }

  it("keeps the original order inside a bucket", () => {
    const index = circuitIndex(candidates);
    for (const bucket of index.values()) {
      const positions = bucket.map((c) => candidates.indexOf(c));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    }
  });
});
