import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCheapestKeeperYard, pickKeeperYardWithShip } from "../src/engine/keeperYard.js";

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

const tvRow = (waypointSymbol: string, shipType: string, purchasePrice: number) => ({ systemSymbol: "X1-TV37", waypointSymbol, shipType, purchasePrice, timestamp: new Date(0).toISOString() });
const tvRows = [tvRow("X1-TV37-C43", "SHIP_PROBE", 41_394), tvRow("X1-TV37-H56", "SHIP_SURVEYOR", 32_628), tvRow("X1-TV37-H56", "SHIP_MINING_DRONE", 39_838)];
const tvBase = { systemSymbol: "X1-TV37", hulls: ["SHIP_PROBE", "SHIP_SURVEYOR", "SHIP_MINING_DRONE", "SHIP_SIPHON_DRONE"], nowMs: 1 };

test("pickKeeperYardWithShip: TV37 2026-10-28, the probe yard has no ship of ours but the keeper at H56 does, so H56 buys (a surveyor)", () => {
  const pick = pickKeeperYardWithShip(tvRows, { ...tvBase, shipPresentAt: (wp) => wp === "X1-TV37-H56" });
  assert.equal(pick?.waypointSymbol, "X1-TV37-H56");
  assert.equal(pick?.shipType, "SHIP_SURVEYOR");
});

test("pickKeeperYardWithShip: prefers a probe when the yard with a ship sells one", () => {
  assert.equal(pickKeeperYardWithShip(tvRows, { ...tvBase, shipPresentAt: () => true })?.shipType, "SHIP_PROBE");
});

test("pickKeeperYardWithShip: nothing when no ship of ours is at a yard that stocks a keeper hull", () => {
  assert.equal(pickKeeperYardWithShip(tvRows, { ...tvBase, shipPresentAt: () => false }), undefined);
});
