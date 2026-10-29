import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextBuyLotDecision, sinkCheck, sinkCheckShrunk, type BuyGuardPolicy } from "../src/engine/buyGuard.js";

/**
 * The numbers are THEOREM-5's MEDICINE loop of 2026-10-18 (E52 > G58, lots of 20): its own buying walked the ask
 * 3409 -> 3626 -> 3894 -> 4223 -> 4628 -> 5126 while its selling walked the sink's bid down behind it. Rounds one and
 * two cleared the floor, round three did not, and round three is what the guard has to refuse.
 */
const POLICY: BuyGuardPolicy = { impactPerLot: 0.06 };
/** effectiveMarginFloor with a flat floor of 10 and MIN_MARGIN_PCT 0.02, computed the way the trader computes it. */
const floorFor = (buyPrice: number): number => Math.max(10, buyPrice * 0.02);

describe("sinkCheck: the destination's bid now, with our own impact on both ends", () => {
  it("passes round one of the MEDICINE loop (ask 3409, bid 4213, 2 lots)", () => {
    const d = sinkCheck({ liveBuy: 3_409, liveSink: 4_213, lots: 2, marginFloor: floorFor(3_409), policy: POLICY });
    assert.equal(d.ok, true, d.reason);
    // avg buy 3409 * 1.03 = 3511.27, avg sell 4213 * 0.97 = 4086.61, margin 575.
    assert.match(d.reason, /575c/);
  });

  it("passes round two (ask 3894, bid 4746, 2 lots)", () => {
    const d = sinkCheck({ liveBuy: 3_894, liveSink: 4_746, lots: 2, marginFloor: floorFor(3_894), policy: POLICY });
    assert.equal(d.ok, true, d.reason);
  });

  it("refuses round three, where the ask had climbed past the sink (ask 4628, bid 4549)", () => {
    const d = sinkCheck({ liveBuy: 4_628, liveSink: 4_549, lots: 2, marginFloor: floorFor(4_628), policy: POLICY });
    assert.equal(d.ok, false, "round three lost money in the ledger; the guard must refuse it");
    assert.match(d.reason, /under the floor/);
  });

  it("does not judge a destination it could not read", () => {
    const d = sinkCheck({ liveBuy: 4_628, liveSink: undefined, lots: 2, marginFloor: floorFor(4_628), policy: POLICY });
    assert.equal(d.ok, true);
    assert.match(d.reason, /unreadable/);
  });

  it("is off at impact 0, whatever the prices say", () => {
    const d = sinkCheck({ liveBuy: 4_628, liveSink: 4_549, lots: 2, marginFloor: floorFor(4_628), policy: { impactPerLot: 0 } });
    assert.equal(d.ok, true);
    assert.equal(d.reason, "guard off");
  });

  it("takes no impact discount on a single lot", () => {
    assert.equal(sinkCheck({ liveBuy: 1_000, liveSink: 1_030, lots: 1, marginFloor: floorFor(1_000), policy: POLICY }).ok, true, "margin 30 >= floor 20");
    assert.equal(sinkCheck({ liveBuy: 1_000, liveSink: 1_015, lots: 1, marginFloor: floorFor(1_000), policy: POLICY }).ok, false, "margin 15 < floor 20");
  });

  it("treats zero or negative lots as one", () => {
    const one = sinkCheck({ liveBuy: 1_000, liveSink: 1_030, lots: 1, marginFloor: floorFor(1_000), policy: POLICY });
    for (const lots of [0, -3]) {
      assert.deepEqual(sinkCheck({ liveBuy: 1_000, liveSink: 1_030, lots, marginFloor: floorFor(1_000), policy: POLICY }), one, `lots ${lots}`);
    }
  });
});

describe("nextBuyLotDecision: the next lot is judged after the lots already held are sold", () => {
  it("allows round two's second lot (last 3894, bid 4746)", () => {
    // next ask 3894 * 1.06 = 4127.64, sell 4746 * 0.94 = 4461.24.
    const d = nextBuyLotDecision({ lotsBought: 1, lastPrice: 3_894, liveSink: 4_746, fallbackSink: 4_746, marginFloor: floorFor(3_894), policy: POLICY });
    assert.equal(d.ok, true, d.reason);
    assert.match(d.reason, /4128c/);
    assert.match(d.reason, /4461c/);
  });

  it("stops round three's second lot (last 4628, bid 4549)", () => {
    const d = nextBuyLotDecision({ lotsBought: 1, lastPrice: 4_628, liveSink: 4_549, fallbackSink: 4_549, marginFloor: floorFor(4_628), policy: POLICY });
    assert.equal(d.ok, false, d.reason);
  });

  it("uses how far the last lot actually moved the price when there is a lot before it", () => {
    // growth 4223/3894 = 1.0845, next ask 4579.9, sell 4569 * (1 - 0.12) = 4020.7.
    const d = nextBuyLotDecision({ lotsBought: 2, lastPrice: 4_223, prevPrice: 3_894, liveSink: 4_569, fallbackSink: 4_569, marginFloor: floorFor(4_223), policy: POLICY });
    assert.equal(d.ok, false, d.reason);
    assert.match(d.reason, /4580c/);
  });

  it("falls back to the planned sell price, with no discount, when the destination could not be read", () => {
    const base = { lotsBought: 1, lastPrice: 4_000, liveSink: undefined, marginFloor: floorFor(4_000), policy: POLICY };
    // next ask 4240; margin 760 at a planned 5000, -40 at 4200.
    assert.equal(nextBuyLotDecision({ ...base, fallbackSink: 5_000 }).ok, true);
    assert.equal(nextBuyLotDecision({ ...base, fallbackSink: 4_200 }).ok, false);
  });

  it("is off at impact 0", () => {
    const d = nextBuyLotDecision({ lotsBought: 2, lastPrice: 4_628, liveSink: 4_549, fallbackSink: 4_549, marginFloor: floorFor(4_628), policy: { impactPerLot: 0 } });
    assert.equal(d.ok, true);
    assert.equal(d.reason, "guard off");
  });
});

describe("sinkCheckShrunk: cut the trip before refusing it", () => {
  const base = { liveBuy: 204, liveSink: 312, marginFloor: 10, policy: { impactPerLot: 0.045 } as BuyGuardPolicy };
  it("passes the planned lots when the whole plan clears the floor", () => {
    const d = sinkCheckShrunk({ ...base, lots: 3 });
    assert.equal(d.ok, true);
    assert.equal(d.lots, 3);
  });
  it("cuts an 8-lot plan that fails on average to the largest plan that passes", () => {
    const full = sinkCheck({ ...base, lots: 8 });
    // Chosen so eight lots fail but fewer pass (the THEO-AB COPPER case: 312c bid against a 204c ask).
    const tight = { ...base, liveSink: 250 };
    const eight = sinkCheck({ ...tight, lots: 8 });
    const shrunk = sinkCheckShrunk({ ...tight, lots: 8 });
    assert.equal(eight.ok, false, "the full plan fails: " + eight.reason);
    assert.equal(shrunk.ok, true);
    assert.ok(shrunk.lots >= 1 && shrunk.lots < 8, `cut to ${shrunk.lots} lots`);
    assert.equal(sinkCheck({ ...tight, lots: shrunk.lots }).ok, true);
    assert.equal(sinkCheck({ ...tight, lots: shrunk.lots + 1 }).ok, false, "one more lot would fail");
    assert.ok(full.ok !== undefined);
  });
  it("refuses only when even one lot fails", () => {
    const d = sinkCheckShrunk({ ...base, liveSink: 205, lots: 8 });
    assert.equal(d.ok, false);
    assert.equal(d.lots, 0);
  });
  it("guard off passes everything unchanged", () => {
    const d = sinkCheckShrunk({ ...base, lots: 8, policy: { impactPerLot: 0 } });
    assert.equal(d.ok, true);
    assert.equal(d.lots, 8);
  });
});
