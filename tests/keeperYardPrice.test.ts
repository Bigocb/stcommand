import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { keeperYardPrice, yardPaidKey } from "../src/engine/keeperYardPrice.js";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

const HOUR = 60 * 60_000;

describe("keeperYardPrice", () => {
  it("uses the stored price when nothing was bought there recently", () => {
    assert.equal(keeperYardPrice(24_089, undefined, 1_000, HOUR), 24_089);
    assert.equal(keeperYardPrice(24_089, { price: 90_000, at: 0 }, 2 * HOUR, HOUR), 24_089);
  });
  it("uses the last price paid when it is higher (2026-11-05: stored 24,089, paid 46k-96k)", () => {
    assert.equal(keeperYardPrice(24_089, { price: 96_476, at: 0 }, 10 * 60_000, HOUR), 96_476);
  });
  it("never lowers a fresher, higher stored price", () => {
    assert.equal(keeperYardPrice(30_000, { price: 25_000, at: 0 }, 1_000, HOUR), 30_000);
  });
});

/** The seam: a keeper purchase records what it really cost, so the next one is priced from it. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const tenantIds: string[] = [];
before(async () => { pool = createPool(DB_URL); store = new Store(pool); });
after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

describe("FleetManager.purchaseKeeperProbe records the price paid", () => {
  it("stores the transaction price for the yard and hull", async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
      [`KYP-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    tenantIds.push(res.rows[0]!.id);
    const api = {
      onMarket: () => {},
      purchaseShip: async () => ({ ship: { symbol: "P-1", frame: { symbol: "FRAME_PROBE" }, nav: { systemSymbol: "X1-SQ43", waypointSymbol: "X1-SQ43-ZZ6Z", status: "DOCKED" }, cargo: { inventory: [] }, fuel: { current: 0, capacity: 0 } }, transaction: { price: 46_393 } }),
    };
    const fleet: any = new FleetManager({ api: api as any, store, tenantId: res.rows[0]!.id });
    fleet.keeperTargetCovered = async () => false;
    await fleet.purchaseKeeperProbe("X1-SQ43-ZZ6Z", "X1-AR4-F11E", 24_089, "SHIP_PROBE").catch(() => undefined);
    assert.equal(fleet.keeperYardPaid.get(yardPaidKey("X1-SQ43-ZZ6Z", "SHIP_PROBE"))?.price, 46_393);
  });
});
