import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/** One market, a getMarket counter, and the fleet's registry pointed at both. */
function fleetWithMarket() {
  const calls = { getMarket: 0 };
  const api = {
    getMarket: async (_s: string, symbol: string) => {
      calls.getMarket += 1;
      return { symbol, tradeGoods: [{ symbol: "IRON", type: "IMPORT", supply: "MODERATE", purchasePrice: 50, sellPrice: 40, tradeVolume: 20 }], imports: [], exports: [], exchange: [] };
    },
  } as any;
  const fleet = new FleetManager({ api, log: () => {} });
  const f = fleet as any;
  const markets = new Map<string, any>();
  f.registry = {
    systemOf: (wp: string) => wp.slice(0, wp.lastIndexOf("-")),
    isMarket: () => true,
    market: (wp: string) => markets.get(wp),
    recordMarket: (m: any) => markets.set(m.symbol, m),
  };
  return { fleet, f, calls, markets };
}

async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

describe("market snapshot reuse", () => {
  it("reuses a snapshot younger than the market's cadence instead of reading it again", async () => {
    const { fleet, calls } = fleetWithMarket();
    await fleet.recordMarketSnapshot("X1-A-M1");
    await fleet.recordMarketSnapshot("X1-A-M1");
    assert.equal(calls.getMarket, 1);
    await later(6 * 60_000, () => fleet.recordMarketSnapshot("X1-A-M1"));
    assert.equal(calls.getMarket, 2, "a market that just changed has a 5-minute cadence");
  });

  it("lets a trader's one-minute limit read again sooner", async () => {
    const { fleet, calls } = fleetWithMarket();
    await fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 60_000 });
    await fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 60_000 });
    assert.equal(calls.getMarket, 1);
    await later(61_000, () => fleet.recordMarketSnapshot("X1-A-M1", { maxAgeMs: 60_000 }));
    assert.equal(calls.getMarket, 2);
  });

  it("reads every time with the doctrine clause off", async () => {
    const { fleet, f, calls } = fleetWithMarket();
    const real = f.doctrine.isEnabledOr.bind(f.doctrine);
    f.doctrine.isEnabledOr = (key: string, d: boolean) => (key === "marketSnapshotReuse" ? false : real(key, d));
    await fleet.recordMarketSnapshot("X1-A-M1");
    await fleet.recordMarketSnapshot("X1-A-M1");
    assert.equal(calls.getMarket, 2);
  });
});
