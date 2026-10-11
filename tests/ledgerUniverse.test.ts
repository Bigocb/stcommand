import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, dbSchema, setTenantUniverse, tenantUniverse, withTenantAllUniverses } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { universeKey } from "../src/engine/universe.js";

/**
 * The ledger is kept week over week, so every read must see only the tenant's current universe (`<agent>@<reset date>`),
 * and ship symbols repeat every week: last week's THEOREM-1 purchase must never become this week's cost basis. Runs against
 * a real local Postgres, because the guarantee is a row-level-security policy (migrations/047), not application code.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

/** Setup and teardown: a role that may create tenants and read run_results directly. */
let admin: pg.Pool;
/** What the app uses. Row-level security must apply to it, or these tests prove nothing. */
let pool: pg.Pool;
let store: Store;
let tenant: string;
let agent: string;
const WEEK1 = "2026-10-04";
const WEEK2 = "2026-10-11";
const key = (week: string) => universeKey(agent, week)!;

const at = (iso: string) => iso;
async function record(over: Record<string, unknown>) {
  await store.recordLedger(tenant, {
    timestamp: at("2026-10-12T00:00:00Z"), shipSymbol: "THEOREM-1", waypointSymbol: "X1-A-A1", type: "PURCHASE",
    tradeSymbol: "GOLD", units: 10, pricePerUnit: 100, total: 1000, ...over,
  } as Parameters<Store["recordLedger"]>[1]);
}

/**
 * A local test database is often connected as a superuser, and superusers skip row-level security altogether (production's
 * app role does not). When that is the case, run the app's queries as a plain role so the policy is really enforced.
 */
async function appPool(): Promise<pg.Pool> {
  const app = createPool(DB_URL);
  const me = (await admin.query<{ bypass: boolean }>(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (me?.bypass) {
    const schema = dbSchema();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_test_app') THEN CREATE ROLE ledger_test_app NOLOGIN; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ledger_test_app`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ledger_test_app`);
    app.on("connect", (c) => { void c.query("SET ROLE ledger_test_app"); });
  }
  return app;
}

before(async () => {
  admin = createPool(DB_URL);
  pool = await appPool();
  agent = `TEST-U-${Date.now()}`;
  tenant = (await admin.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [agent])).rows[0]!.id;
  store = new Store(pool);
});
afterEach(() => setTenantUniverse(tenant, undefined));
after(async () => {
  await admin.query(`DELETE FROM run_results WHERE agent_symbol = $1`, [agent]);
  await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
  await pool.end();
  await admin.end();
});

describe("ledger rows by universe", () => {
  it("stamps each row with the tenant's current key, and reads only the current week", async () => {
    setTenantUniverse(tenant, key(WEEK1));
    await record({ timestamp: at("2026-10-05T10:00:00Z"), shipSymbol: "OLD-1" });
    setTenantUniverse(tenant, key(WEEK2));
    await record({ timestamp: at("2026-10-12T10:00:00Z"), shipSymbol: "NEW-1" });

    const current = await store.ledgerRowsSince(tenant, "2026-10-01T00:00:00Z");
    assert.deepEqual(current.map((r) => r.ship), ["NEW-1"], "last week's row is invisible to this week's reads");

    setTenantUniverse(tenant, key(WEEK1));
    assert.deepEqual((await store.ledgerRowsSince(tenant, "2026-10-01T00:00:00Z")).map((r) => r.ship), ["OLD-1"]);
  });

  it("keeps both weeks for comparison, newest first", async () => {
    setTenantUniverse(tenant, key(WEEK2));
    const weeks = await store.ledgerWeeks(tenant);
    assert.deepEqual(weeks.map((w) => w.universeKey), [key(WEEK2), key(WEEK1)]);
    assert.equal(weeks[0]!.rows, 1);
  });

  it("does not let last week's purchase by a ship with the same symbol become this week's cost basis", async () => {
    setTenantUniverse(tenant, key(WEEK1));
    await record({ timestamp: at("2026-10-06T10:00:00Z"), shipSymbol: "THEOREM-1", tradeSymbol: "GOLD", pricePerUnit: 9999, total: 99990 });
    setTenantUniverse(tenant, key(WEEK2));
    await record({ timestamp: at("2026-10-12T11:00:00Z"), shipSymbol: "THEOREM-1", tradeSymbol: "GOLD", pricePerUnit: 120, total: 1200 });
    assert.equal(await store.lastPurchasePrice(tenant, "THEOREM-1", "GOLD"), 120, "this week's price, not the 9999 from last week");

    // And with no purchase this week at all, last week's is not a fallback either.
    assert.equal(await store.lastPurchasePrice(tenant, "THEOREM-1", "IRON"), undefined);
  });

  it("the cleanup no longer deletes the ledger", async () => {
    setTenantUniverse(tenant, key(WEEK2));
    const before = (await store.ledgerWeeks(tenant)).reduce((n, w) => n + w.rows, 0);
    await store.wipeTenantGameData(tenant);
    const after = (await store.ledgerWeeks(tenant)).reduce((n, w) => n + w.rows, 0);
    assert.equal(after, before, "every week's rows survive the weekly wipe");
  });

  it("with no key known, reads behave as they did before keys: nothing is hidden", async () => {
    setTenantUniverse(tenant, undefined);
    assert.equal(tenantUniverse(tenant), undefined);
    const all = await store.ledgerRowsSince(tenant, "2026-10-01T00:00:00Z");
    assert.ok(all.length >= 3, "both weeks' rows are visible");
  });

  it("refuses a key that could escape the SET LOCAL statement", () => {
    setTenantUniverse(tenant, "X'; DROP TABLE ledger; --");
    assert.equal(tenantUniverse(tenant), undefined, "an invalid key is never stored, so it can never reach SQL");
  });
});

describe("adoptLedgerUniverse", () => {
  it("stamps only unkeyed rows from the given time on, leaving earlier ones in no week", async () => {
    setTenantUniverse(tenant, undefined); // rows written before the key was known
    await record({ timestamp: at("2026-10-09T00:00:00Z"), shipSymbol: "LEGACY-1" });
    await record({ timestamp: at("2026-10-12T05:00:00Z"), shipSymbol: "TODAY-1" });
    const stamped = await store.adoptLedgerUniverse(tenant, key(WEEK2), "2026-10-11T13:00:00Z");
    assert.equal(stamped, 1, "only today's unkeyed row is adopted");

    setTenantUniverse(tenant, key(WEEK2));
    const ships = (await store.ledgerRowsSince(tenant, "2026-10-01T00:00:00Z")).map((r) => r.ship);
    assert.ok(ships.includes("TODAY-1"));
    assert.ok(!ships.includes("LEGACY-1"), "the earlier unkeyed row belongs to no known week, so scoped reads skip it");
  });

  it("refuses something that is not a key", async () => {
    await assert.rejects(() => store.adoptLedgerUniverse(tenant, "nope'; --", "2026-10-11T00:00:00Z"), /not a universe key/);
  });
});

describe("captureRunResult", () => {
  it("describes the week it was asked about, even after the tenant's current key has moved on", async () => {
    setTenantUniverse(tenant, key(WEEK1));
    await record({ type: "SELL", timestamp: at("2026-10-07T10:00:00Z"), shipSymbol: "WK1-SELLER", tradeSymbol: "GOLD", units: 5, pricePerUnit: 200, total: 1000, realizedPnl: 500 });
    setTenantUniverse(tenant, key(WEEK2)); // the reset has happened and the fleet already moved on
    assert.equal(await store.captureRunResult(tenant, agent, WEEK1, { endedByReset: WEEK2 }), true);

    const row = (await admin.query(`SELECT trades, trading_net FROM run_results WHERE agent_symbol = $1 AND reset_date = $2`, [agent, WEEK1])).rows[0];
    assert.equal(Number(row.trades), 1, "week 1's one matched sale");
    assert.equal(Number(row.trading_net), 500);
  });
});

describe("withTenantAllUniverses", () => {
  it("sees every week at once", async () => {
    setTenantUniverse(tenant, key(WEEK2));
    const n = await withTenantAllUniverses(pool, tenant, async (c) => Number((await c.query(`SELECT COUNT(DISTINCT universe_key)::int AS n FROM ledger`)).rows[0].n));
    assert.ok(n >= 2);
  });
});
