import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * The two freshness windows in Store.tradeLegs().
 *
 * Holding a cross-system leg to the same window as a local one meant it almost
 * never appeared: both ends have to be fresh at the same moment, and a market
 * a jump away is only revisited when a ship happens to go there, so the
 * intersection was usually empty. No cross-system route ran for a full day
 * despite the gates being open and both markets being known.
 *
 * market_latest is shared galaxy data with no RLS and no tenant column, so
 * these run against it directly.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
});

after(async () => {
  await pool.query(`DELETE FROM market_latest WHERE good_symbol = 'TESTGOOD'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM market_latest WHERE good_symbol = 'TESTGOOD'`);
});

/** Insert one priced market row, aged by `ageMin` minutes. */
async function priceAt(waypoint: string, system: string, ageMin: number, purchase: number, sell: number): Promise<void> {
  await pool.query(
    `INSERT INTO market_latest (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp)
     VALUES ($1, $2, 'TESTGOOD', 'EXCHANGE', 'MODERATE', $3, $4, 20, now() - make_interval(mins => $5::int))
     ON CONFLICT (waypoint_symbol, good_symbol) DO UPDATE
       SET purchase_price = EXCLUDED.purchase_price, sell_price = EXCLUDED.sell_price, timestamp = EXCLUDED.timestamp`,
    [system, waypoint, purchase, sell, ageMin],
  );
}

const legsFor = async (local: number, cross: number) =>
  (await store.tradeLegs(local, cross)).filter((l) => l.goodSymbol === "TESTGOOD");

describe("Store.tradeLegs: local and cross-system freshness", () => {
  it("finds a fresh same-system leg", async () => {
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-AA-SELL", "X1-AA", 10, 400, 300);
    const legs = await legsFor(90, 360);
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.buyAt, "X1-AA-BUY");
    assert.equal(legs[0]!.sellAt, "X1-AA-SELL");
  });

  it("holds a same-system leg to the strict window, even when the wide one would allow it", async () => {
    // A local market is cheap to refresh, so there is no reason to trade on a
    // stale price for one. Widening must not quietly loosen this.
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-AA-SELL", "X1-AA", 200, 400, 300); // older than 90, younger than 360
    assert.deepEqual(await legsFor(90, 360), []);
  });

  it("allows a cross-system leg whose far end is older than the strict window", async () => {
    // The whole point. Before this, the 200-minute side killed the route.
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-BB-SELL", "X1-BB", 200, 400, 300);
    const legs = await legsFor(90, 360);
    assert.equal(legs.length, 1, "the cross-system window applies across a gate");
    assert.equal(legs[0]!.buySystem, "X1-AA");
    assert.equal(legs[0]!.sellSystem, "X1-BB");
  });

  it("still rejects a cross-system leg past the wide window", async () => {
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-BB-SELL", "X1-BB", 500, 400, 300);
    assert.deepEqual(await legsFor(90, 360), []);
  });

  it("behaves exactly as before when both windows are equal", async () => {
    // The default for a caller that passes one argument, so the old behaviour
    // has to survive untouched.
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-BB-SELL", "X1-BB", 200, 400, 300);
    assert.deepEqual(await legsFor(90, 90), []);
    assert.equal((await store.tradeLegs(90)).filter((l) => l.goodSymbol === "TESTGOOD").length, 0, "one-argument form is the strict window on both sides");
  });

  it("compares windows numerically, not as text", async () => {
    // The params bind as text unless cast: GREATEST('90','360') is '90'
    // lexically, which would silently narrow the outer scan to 90 minutes and
    // drop exactly the cross-system rows this feature exists to keep.
    await priceAt("X1-AA-BUY", "X1-AA", 10, 100, 50);
    await priceAt("X1-BB-SELL", "X1-BB", 120, 400, 300); // between 90 and 360
    const legs = await legsFor(90, 360);
    assert.equal(legs.length, 1, "a 120-minute row must survive a 360-minute window");
  });

  it("reports the stalest of the two ends, so age is not understated", async () => {
    await priceAt("X1-AA-BUY", "X1-AA", 5, 100, 50);
    await priceAt("X1-BB-SELL", "X1-BB", 200, 400, 300);
    const [leg] = await legsFor(90, 360);
    const ageMin = (Date.now() - new Date(leg!.stalestIso).getTime()) / 60_000;
    assert.ok(ageMin > 150, `stalest should reflect the 200-minute side, got ${Math.round(ageMin)}m`);
  });
});
