import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bidKey, sellPriceVerdict, type BidStat } from "../src/engine/priceSanity.js";

const stats = new Map<string, BidStat>([[bidKey("X1-RB80-A1", "CYBER_IMPLANTS"), { median: 12_000, samples: 30 }], [bidKey("X1-NEW-A1", "GOLD"), { median: 300, samples: 2 }]]);

describe("sellPriceVerdict", () => {
  it("rejects the CYBER_IMPLANTS case: a 42,430 bid on a market whose median is 12,000", () => {
    const v = sellPriceVerdict({ good: "CYBER_IMPLANTS", sellAt: "X1-RB80-A1", sellPrice: 42_430 }, stats);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /3\.5x its own median 12000 over 30 readings/);
  });

  it("allows a price near or moderately above the market's own median", () => {
    assert.equal(sellPriceVerdict({ good: "CYBER_IMPLANTS", sellAt: "X1-RB80-A1", sellPrice: 13_000 }, stats).ok, true);
    assert.equal(sellPriceVerdict({ good: "CYBER_IMPLANTS", sellAt: "X1-RB80-A1", sellPrice: 24_000 }, stats).ok, true, "exactly twice is allowed");
  });

  it("does not judge a market with too little history, or one it has never seen", () => {
    assert.equal(sellPriceVerdict({ good: "GOLD", sellAt: "X1-NEW-A1", sellPrice: 5_000 }, stats).ok, true);
    assert.equal(sellPriceVerdict({ good: "GOLD", sellAt: "X1-NOPE-A1", sellPrice: 5_000 }, stats).ok, true);
  });

  it("a ratio of 0 switches the check off", () => {
    assert.equal(sellPriceVerdict({ good: "CYBER_IMPLANTS", sellAt: "X1-RB80-A1", sellPrice: 42_430 }, stats, { maxOverMedian: 0, minSamples: 4 }).ok, true);
  });
});
