import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/** The seam where FleetManager uses traderRecord.ts: a trader's post-dock read of a market. Fakes only, no database. */
const MARKET = "X1-T-M1";

function makeFleet(opts: { clauseOn: boolean; covered: boolean; snapshotAgeMs?: number }) {
  const reads: { wp: string; maxAgeMs?: number }[] = [];
  const fleet = new FleetManager({ api: {} as any }) as any;
  fleet.doctrine = {
    isEnabledOr: (k: string) => (k === "traderSkipKeeperMarkets" ? opts.clauseOn : true),
    value: (k: string, def?: number) => (k === "traderSkipKeeperMarkets" ? 10 : def ?? 0),
  };
  fleet.keeperMarkets = new Map(opts.covered ? [["K-1", MARKET]] : []);
  fleet.registry = { market: () => (opts.snapshotAgeMs === undefined ? undefined : { fetchedAt: new Date(Date.now() - opts.snapshotAgeMs).toISOString() }) };
  fleet.recordMarketSnapshot = async (wp: string, o?: { maxAgeMs?: number }) => { reads.push({ wp, maxAgeMs: o?.maxAgeMs }); };
  return { fleet, reads };
}

describe("trader post-dock market read", () => {
  it("clause on, keeper-covered, snapshot 3 minutes old: no read", async () => {
    const { fleet, reads } = makeFleet({ clauseOn: true, covered: true, snapshotAgeMs: 3 * 60_000 });
    await fleet.traderRecordMarket(MARKET);
    assert.deepEqual(reads, []);
  });
  it("clause off: reads exactly as before (60 s freshness window)", async () => {
    const { fleet, reads } = makeFleet({ clauseOn: false, covered: true, snapshotAgeMs: 3 * 60_000 });
    await fleet.traderRecordMarket(MARKET);
    assert.deepEqual(reads, [{ wp: MARKET, maxAgeMs: 60_000 }]);
  });
  it("clause on but no keeper there, or the snapshot is old: reads", async () => {
    for (const o of [{ covered: false, snapshotAgeMs: 60_000 }, { covered: true, snapshotAgeMs: 30 * 60_000 }]) {
      const { fleet, reads } = makeFleet({ clauseOn: true, ...o });
      await fleet.traderRecordMarket(MARKET);
      assert.equal(reads.length, 1);
    }
  });
});
