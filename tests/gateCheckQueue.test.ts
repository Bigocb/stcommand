import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gatesToCheck, type KnownGate } from "../src/engine/gateCheckQueue.js";

const H = 3_600_000;
const NOW = 100 * H;
const g = (sys: string, n = "G") => ({ systemSymbol: sys, gateSymbol: `${sys}-${n}` });

describe("gatesToCheck", () => {
  it("asks about never-checked gates first, skips finished ones, and re-reads unfinished ones only after the interval", () => {
    const known = new Map<string, KnownGate>([
      ["X1-B-G", { isComplete: true, checkedAtMs: NOW - 10 * H }],   // built: never asked again
      ["X1-C-G", { isComplete: false, checkedAtMs: NOW - 30 * 60_000 }], // unfinished, read 30 min ago: leave
      ["X1-D-G", { isComplete: false, checkedAtMs: NOW - 5 * H }],  // unfinished, stale
      ["X1-E-G", { isComplete: false, checkedAtMs: NOW - 2 * H }],  // unfinished, less stale
    ]);
    const out = gatesToCheck([g("X1-A"), g("X1-B"), g("X1-C"), g("X1-D"), g("X1-E")], known, NOW);
    assert.deepEqual(out.map((x) => x.gateSymbol), ["X1-A-G", "X1-D-G", "X1-E-G"], "new first, then the stalest unfinished");
  });

  it("lists a gate once and treats an unfinished gate with no check time as stale", () => {
    const known = new Map<string, KnownGate>([["X1-A-G", { isComplete: false }]]);
    assert.deepEqual(gatesToCheck([g("X1-A"), g("X1-A")], known, NOW).map((x) => x.gateSymbol), ["X1-A-G"]);
  });

  it("returns nothing when every gate is known built", () => {
    const known = new Map<string, KnownGate>([["X1-A-G", { isComplete: true }], ["X1-B-G", { isComplete: true }]]);
    assert.deepEqual(gatesToCheck([g("X1-A"), g("X1-B")], known, NOW), []);
  });
});
