import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectField, type FieldCandidate } from "../src/engine/fleet.js";

const f = (symbol: string, count: number, o: Partial<FieldCandidate> = {}): FieldCandidate =>
  ({ symbol, count, stripped: false, dist: 10, needsDrift: false, ...o });
const opts = { cap: 5, avoidStripped: true, avoidDrift: true };

describe("selectField — miner field spread", () => {
  it("stays on the only reachable field when it is over the crew cap, instead of overflowing to a drift-only one", () => {
    // X1-JX83 on 2026-10-04: CE5D (reachable, stripped) full at 5; B14 needs a multi-hour drift.
    const pick = selectField([f("CE5D", 5, { stripped: true, dist: 2 }), f("B14", 0, { needsDrift: true, dist: 280 })], opts);
    assert.equal(pick, "CE5D");
  });

  it("prefers the emptier of two reachable fields", () => {
    assert.equal(selectField([f("A", 3), f("B", 1)], opts), "B");
  });

  it("steers off a stripped field when an unstripped reachable one has room", () => {
    assert.equal(selectField([f("STRIP", 0, { stripped: true }), f("PLAIN", 3)], opts), "PLAIN");
  });

  it("falls back to a drift-only field only when nothing is reachable", () => {
    assert.equal(selectField([f("FAR1", 2, { needsDrift: true, dist: 300 }), f("FAR2", 0, { needsDrift: true, dist: 400 })], opts), "FAR2");
  });

  it("with avoidDrift off, drift-only fields compete normally", () => {
    const pick = selectField([f("NEAR", 5), f("FAR", 0, { needsDrift: true, dist: 300 })], { ...opts, avoidDrift: false });
    assert.equal(pick, "FAR");
  });

  it("returns undefined for no fields", () => {
    assert.equal(selectField([], opts), undefined);
  });
});
