import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marketPricedShares, FRESH_PRICE_MS } from "../src/engine/pricedShare.js";
// @ts-expect-error plain browser module, no types
import { buildQueueView, pricedText } from "../public/shared/queueView.js";

const NOW = Date.parse("2026-11-19T04:00:00Z");

describe("marketPricedShares (Tower Expand cards)", () => {
  const newest = new Map([["X1-A-1", NOW - 10 * 60_000], ["X1-A-2", NOW - FRESH_PRICE_MS - 60_000], ["X1-A-3", NOW - 89 * 60_000]]);
  it("ever priced and priced in the last 90 minutes, as whole percents", () => {
    assert.deepEqual(marketPricedShares(["X1-A-1", "X1-A-2", "X1-A-3", "X1-A-4"], newest, NOW), { pricedPct: 75, freshPct: 50 });
  });
  it("nothing known yet, or no markets: no shares (the card shows nothing)", () => {
    assert.deepEqual(marketPricedShares(["X1-A-1"], undefined, NOW), {});
    assert.deepEqual(marketPricedShares([], newest, NOW), {});
  });
});

describe("queue view carries the shares to the cards", () => {
  const queue = { mode: "auto", queue: [
    { system: "X1-S", state: "staged", markets: ["a", "b"], stagedAt: NOW - 3_600_000, pricedPct: 50, freshPct: 0 },
    { system: "X1-L", state: "live", markets: ["c"], releasedAt: NOW - 3_600_000, pricedPct: 100, freshPct: 100 },
    { system: "X1-Q", state: "scouted", markets: ["d"], addedAt: NOW - 3_600_000, pricedPct: 0, freshPct: 0 },
  ] };
  it("staged, live and scouted rows keep pricedPct / freshPct", () => {
    const v = buildQueueView({ queue, keepers: {}, review: {}, pnl: {}, stuck: {}, approvals: 0, nowMs: NOW });
    assert.equal(v.staged[0].pricedPct, 50);
    assert.equal(v.live[0].freshPct, 100);
    assert.equal(v.scouted[0].pricedPct, 0);
  });
  it("card text, and nothing on an older server", () => {
    assert.equal(pricedText({ pricedPct: 62, freshPct: 40 }), "62% priced · 40% fresh");
    assert.equal(pricedText({}), "");
  });
});
