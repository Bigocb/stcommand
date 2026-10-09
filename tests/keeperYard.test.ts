import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCheapestKeeperYard } from "../src/engine/keeperYard.js";

const now = Date.parse("2026-10-09T01:30:00Z");
const row = (wp: string, price: number, ts: string, shipType = "SHIP_PROBE") => ({ systemSymbol: "X1-MG54", waypointSymbol: wp, shipType, purchasePrice: price, timestamp: ts });
const opts = { systemSymbol: "X1-MG54", hulls: ["SHIP_PROBE"], nowMs: now };

test("picks the cheaper yard, not the nearer one", () => {
  const rows = [row("X1-MG54-A2", 124017, "2026-10-09T01:28:00Z"), row("X1-MG54-C38", 55589, "2026-10-09T01:27:00Z")];
  const best = pickCheapestKeeperYard(rows, { ...opts, distance: (w) => (w === "X1-MG54-A2" ? 0 : 50) });
  assert.equal(best?.waypointSymbol, "X1-MG54-C38");
});

test("ignores a stale cheaper price while a fresh one exists", () => {
  const rows = [row("A", 100, "2026-10-09T01:28:00Z"), row("B", 50, "2026-10-09T00:00:00Z")];
  assert.equal(pickCheapestKeeperYard(rows, opts)?.waypointSymbol, "A");
});

test("falls back to stale rows when nothing is fresh", () => {
  const rows = [row("A", 100, "2026-10-09T00:00:00Z"), row("B", 50, "2026-10-09T00:10:00Z")];
  assert.equal(pickCheapestKeeperYard(rows, opts)?.waypointSymbol, "B");
});

test("tie goes to the nearer yard; wrong hull or system excluded", () => {
  const rows = [row("A", 50, "2026-10-09T01:28:00Z"), row("B", 50, "2026-10-09T01:28:00Z"), row("C", 10, "2026-10-09T01:28:00Z", "SHIP_SURVEYOR")];
  assert.equal(pickCheapestKeeperYard(rows, { ...opts, distance: (w) => (w === "B" ? 1 : 9) })?.waypointSymbol, "B");
  assert.equal(pickCheapestKeeperYard(rows, { ...opts, systemSymbol: "X1-OTHER" }), undefined);
});
