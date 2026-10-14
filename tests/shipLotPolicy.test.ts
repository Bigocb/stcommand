import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveLotSize, effectiveMaxLots, normalizeShipLotPolicy, SHIP_LOT_LIMITS } from "../src/engine/shipLotPolicy.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

// Per-ship lot size and lot count. Unset means the market tradeVolume and the fleet doctrine rule apply, as before.
describe("effectiveLotSize", () => {
  it("is the market's tradeVolume when the ship has no cap", () => {
    assert.equal(effectiveLotSize(60, undefined), 60);
    assert.equal(effectiveLotSize(60, {}), 60);
    assert.equal(effectiveLotSize(60, { maxLots: 4 }), 60);
  });

  it("takes the smaller of the market's tradeVolume and the ship's cap", () => {
    assert.equal(effectiveLotSize(60, { lotSize: 20 }), 20);
    assert.equal(effectiveLotSize(18, { lotSize: 20 }), 18, "a thin market still limits the call");
  });
});

describe("effectiveMaxLots", () => {
  it("uses the doctrine value unless the ship sets its own", () => {
    assert.equal(effectiveMaxLots(6, undefined), 6);
    assert.equal(effectiveMaxLots(6, { lotSize: 40 }), 6);
    assert.equal(effectiveMaxLots(6, { maxLots: 2 }), 2);
  });
});

describe("normalizeShipLotPolicy", () => {
  it("keeps set fields and drops zero, null and missing ones", () => {
    assert.deepEqual(normalizeShipLotPolicy({ lotSize: 40, maxLots: 0 }), { lotSize: 40 });
    assert.deepEqual(normalizeShipLotPolicy({ lotSize: null, maxLots: 3 }), { maxLots: 3 });
  });

  it("returns undefined when neither field is set, so the ship's entry is dropped", () => {
    assert.equal(normalizeShipLotPolicy({ lotSize: 0, maxLots: 0 }), undefined);
    assert.equal(normalizeShipLotPolicy({}), undefined);
  });

  it("rejects out-of-range and non-integer values with the field named", () => {
    assert.throws(() => normalizeShipLotPolicy({ lotSize: SHIP_LOT_LIMITS.lotSize.max + 1 }), /lotSize must be a whole number/);
    assert.throws(() => normalizeShipLotPolicy({ maxLots: 13 }), /maxLots must be a whole number from 1 to 12/);
    assert.throws(() => normalizeShipLotPolicy({ lotSize: 2.5 }), /lotSize/);
    assert.throws(() => normalizeShipLotPolicy({ maxLots: -1 }), /maxLots/);
  });
});

// Seam: the trader sizes every route and buy call through its own lot size, so the ship's cap must reach it.
describe("TraderAgent lot size cap", () => {
  const ship = { symbol: "SHIP-1", cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 100, capacity: 100 }, nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" } } as unknown as Ship;

  it("caps the per-call lot at the ship's lotSize, and leaves the market's tradeVolume as the limit when there is no cap", () => {
    const capped = new TraderAgent(ship, { api: {} as any, lotSizeCap: () => 20 });
    const open = new TraderAgent(ship, { api: {} as any });
    assert.equal((capped as any).tradeLotSize(60, 40), 20);
    assert.equal((open as any).tradeLotSize(60, 40), 40);
  });
});
