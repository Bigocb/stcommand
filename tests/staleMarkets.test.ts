import { test } from "node:test";
import assert from "node:assert/strict";
import { staleUncoveredMarkets } from "../src/engine/marketDirectory.js";

const row = (wp: string, n: number) => ({ waypointSymbol: wp, systemSymbol: wp.split("-").slice(0, 2).join("-"), imports: Array.from({ length: n }, (_, i) => `G${i}`), exports: [], exchange: [], updatedAt: "2026-11-25T00:00:00Z" });

test("staleUncoveredMarkets keeps 5+ goods, no keeper, older than the limit or never priced, oldest first", () => {
  const now = Date.parse("2026-11-25T23:00:00Z");
  const rows = [row("X1-A1-M1", 8), row("X1-A1-M2", 4), row("X1-A1-M3", 6), row("X1-A1-M4", 7), row("X1-B2-M5", 9), row("X1-A1-M6", 5)];
  const newest = new Map([["X1-A1-M1", now - 120 * 60_000], ["X1-A1-M2", now - 300 * 60_000], ["X1-A1-M3", now - 30 * 60_000], ["X1-A1-M4", now - 200 * 60_000], ["X1-B2-M5", now - 500 * 60_000]]);
  const out = staleUncoveredMarkets(rows, newest, new Set(["X1-A1-M4"]), new Set(["X1-A1"]), now, { minGoods: 5, olderThanMin: 55 });
  // M2 has 4 goods, M3 is fresh, M4 has a keeper, M5 is outside the systems; M6 was never priced and sorts first.
  assert.deepEqual(out.map((m) => [m.market, m.ageMin]), [["X1-A1-M6", null], ["X1-A1-M1", 120]]);
});
