import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitPaceBuckets, expansionShipsOf, type PaceRow } from "../src/engine/paceSplit.js";
import { paceFromBuckets } from "../src/engine/pace.js";

const MIN = 60_000;
const start = 0;
const row = (min: number, type: PaceRow["type"], shipSymbol: string, realizedPnl: number | null, total = 0): PaceRow => ({ timestampMs: min * MIN, type, shipSymbol, realizedPnl, total });
const expansion = new Set(["THEO-1B0", "THEO-150"]);

describe("splitPaceBuckets", () => {
  it("puts sales and a trader's own fuel and jumps in trading, a keeper's and explorer's in expansion", () => {
    const rows = [
      row(1, "SELL", "THEO-12D", 100_000),
      row(2, "JUMP", "THEO-12D", null, 6_000),
      row(3, "REFUEL", "THEO-12D", null, 500),
      row(4, "JUMP", "THEO-1B0", null, 6_200),   // keeper probe delivery
      row(5, "JUMP", "THEO-150", null, 5_900),   // explorer
    ];
    const s = splitPaceBuckets(rows, start, 15 * MIN, 1, expansion);
    assert.deepEqual(s.trading, [93_500]);
    assert.deepEqual(s.expansion, [-12_100]);
  });

  it("keeps a realized loss in trading (it is a trading result)", () => {
    const s = splitPaceBuckets([row(1, "SELL", "THEO-128", -125_478), row(2, "SELL", "THEO-12D", 40_000)], start, 15 * MIN, 1, expansion);
    assert.deepEqual(s.trading, [-85_478]);
    assert.deepEqual(s.expansion, [0]);
  });

  it("trading plus expansion equals the old combined figure", () => {
    const rows = [row(1, "SELL", "A", 1_000), row(16, "JUMP", "THEO-1B0", null, 400), row(17, "JUMP", "A", null, 300), row(31, "SELL", "B", null)];
    const s = splitPaceBuckets(rows, start, 15 * MIN, 3, expansion);
    const old = [1_000, -400 - 300, 0];
    assert.deepEqual(s.trading.map((v, i) => v + s.expansion[i]!), old);
  });

  it("a row after the window clamps into the last bucket and one before it is dropped", () => {
    const s = splitPaceBuckets([row(500, "SELL", "A", 7), row(-5, "SELL", "A", 99)], start, 15 * MIN, 2, expansion);
    assert.deepEqual(s.trading, [0, 7]);
  });

  it("feeds paceFromBuckets: the 2026-11-05 hour reads as trading, with the expansion cost apart", () => {
    // Four 15-minute buckets: sales profit 1.17M in all, 490k of probe and explorer jumps, 500k of trader overhead.
    const rows = [
      row(1, "SELL", "THEO-12D", 585_000), row(16, "SELL", "THEO-129", 585_000),
      row(5, "JUMP", "THEO-1B0", null, 245_000), row(20, "JUMP", "THEO-1B1", null, 245_000),
      row(30, "JUMP", "THEO-13B", null, 500_000),
    ];
    const s = splitPaceBuckets(rows, start, 15 * MIN, 4, new Set(["THEO-1B0", "THEO-1B1"]));
    assert.equal(paceFromBuckets(s.trading, 15).perHour1h, 670_000);
    assert.equal(paceFromBuckets(s.expansion, 15).perHour1h, -490_000);
  });
});

describe("expansionShipsOf", () => {
  it("is every ship that is not a trader", () => {
    const set = expansionShipsOf([{ symbol: "T-1", role: "trader" }, { symbol: "K-1", role: "keeper" }, { symbol: "E-1", role: "explorer" }, { symbol: "U-1", role: "tour" }]);
    assert.deepEqual([...set].sort(), ["E-1", "K-1", "U-1"]);
  });
});
