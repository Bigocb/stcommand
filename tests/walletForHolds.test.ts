import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  walletForHolds, walletPlusHolds,
  // @ts-expect-error plain browser module, no types
} from "../public/shared/domain.js";

/**
 * 2026-10-25: Credits + holds jumped up by a cargo's worth right after a sale and fell back at the next poll. The live feed
 * moves the wallet at once; the hold values only change on a poll, so the sale counted the cargo twice (a 226k hauler load).
 */
const cargoValues = { "THEO-B": { value: 226_000, unpricedUnits: 0 } };

describe("walletForHolds", () => {
  it("uses the wallet from the same poll as the hold values, not the live-moved one", () => {
    // Poll said: wallet 1,000,000, hauler holds 226,000 of cargo. Then the hauler sells it and the live feed adds 242,000.
    const agent = { credits: 1_242_000, pollCredits: 1_000_000 };
    assert.equal(walletPlusHolds(walletForHolds(agent), cargoValues).total, 1_226_000);
    assert.equal(walletPlusHolds(agent.credits, cargoValues).total, 1_468_000, "the old sum double counts the sold cargo");
  });
  it("falls back to the live wallet before any poll, and to 0 with no agent", () => {
    assert.equal(walletForHolds({ credits: 5 }), 5);
    assert.equal(walletForHolds(undefined), 0);
  });
});

describe("the store keeps the poll's wallet while the feed moves the live one", () => {
  it("loadState records it, applyCredits leaves it alone", async () => {
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ agent: { symbol: "T", credits: 1_000_000 }, ships: [], systems: [], jumpConnections: [], cargoValues, stale: false }) });
    (globalThis as any).window ??= globalThis;
    // @ts-expect-error plain browser module, no types
    const store: any = await import("../public/shared/store.js");
    await store.loadState();
    store.applyCredits(1_242_000);
    assert.equal(store.state.agent.credits, 1_242_000);
    assert.equal(store.state.agent.pollCredits, 1_000_000);
    await store.loadState();
    assert.equal(store.state.agent.pollCredits, 1_000_000);
  });
});
