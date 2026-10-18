import { test } from "node:test";
import assert from "node:assert/strict";
import { shipLedgerEvent } from "../src/engine/shipLedgerEvent.js";

const row = (o: Record<string, unknown>) => ({ shipSymbol: "THEOREM-3E", waypointSymbol: "X1-JT85-DD4X", type: "SHIP", total: 16241.2, ...o }) as Parameters<typeof shipLedgerEvent>[0];

test("a scrap is a scrap, not a purchase of a ship called SCRAP (the 2026-10-18 wind-down read as 26 purchases)", () => {
  const e = shipLedgerEvent(row({ tradeSymbol: "SCRAP" }))!;
  assert.equal(e.kind, "ship_scrapped"); assert.equal(e.detail, "scrapped THEOREM-3E at X1-JT85-DD4X for 16241c"); assert.equal(e.meta.proceeds, 16241);
});
test("a purchase stays a purchase, with its hull type", () => {
  const e = shipLedgerEvent(row({ tradeSymbol: "SHIP_PROBE", total: 29198 }))!;
  assert.equal(e.kind, "ship_purchased"); assert.match(e.detail, /^bought THEOREM-3E \(SHIP_PROBE\) at X1-JT85-DD4X for 29198c$/); assert.equal(e.meta.price, 29198);
});
test("a repair (negative total) and any other ledger type are no event", () => {
  assert.equal(shipLedgerEvent(row({ tradeSymbol: "REPAIR", total: -1200 })), null);
  assert.equal(shipLedgerEvent(row({ type: "SELL", tradeSymbol: "FUEL" })), null);
  assert.equal(shipLedgerEvent(row({ tradeSymbol: "SCRAP", total: 0 })), null);
});
