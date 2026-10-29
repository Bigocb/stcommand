import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeDirectory, type DirectoryRow } from "../src/engine/marketDirectory.js";

const now = Date.parse("2026-10-29T12:00:00Z");
const row = (wp: string, imports: string[], exports: string[], exchange: string[] = []): DirectoryRow => ({ waypointSymbol: wp, systemSymbol: wp.slice(0, wp.lastIndexOf("-")), imports, exports, exchange, updatedAt: "2026-10-29T10:00:00Z" });

describe("summarizeDirectory", () => {
  const rows = [
    row("X1-A-1", ["IRON", "FOOD", "FUEL"], ["FABRICS", "CLOTHING"]),
    row("X1-A-2", ["IRON"], []),
    row("X1-A-3", ["FOOD", "IRON"], ["FOOD"], ["FUEL", "ICE"]),
    row("X1-B-1", ["IRON", "FOOD", "FUEL", "ICE", "SAND"], []),
    row("X1-B-2", ["IRON", "FOOD", "FUEL", "ICE", "SAND", "GOLD"], []),
  ];
  it("counts each market's distinct goods and ranks them best first", () => {
    const [a] = summarizeDirectory(rows, new Set(), now).filter((s) => s.system === "X1-A");
    assert.deepEqual(a!.ranked.map((m) => [m.market, m.goods]), [["X1-A-1", 5], ["X1-A-3", 4], ["X1-A-2", 1]]);
    assert.equal(a!.ranked[0]!.ageHours, 2);
  });
  it("flags covered markets and counts the uncovered ones worth a keeper", () => {
    const sys = summarizeDirectory(rows, new Set(["X1-A-1"]), now, 4);
    const a = sys.find((s) => s.system === "X1-A")!;
    assert.equal(a.coveredMarkets, 1);
    assert.equal(a.worthKeeping, 1); // A-3 (4 goods) only: A-1 is covered, A-2 has 1
  });
  it("orders systems by how many uncovered markets are worth keeping", () => {
    const sys = summarizeDirectory(rows, new Set(), now, 5);
    assert.deepEqual(sys.map((x) => [x.system, x.worthKeeping]), [["X1-B", 2], ["X1-A", 1]]);
  });
});
