import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { Doctrine, DOCTRINE_DEFAULTS } from "../src/engine/doctrine.js";

/**
 * Mirrors straders' tests/synthesis.test.ts "Doctrine" describe block, plus
 * one new case: cross-tenant isolation, which didn't exist as a concept in
 * the single-tenant original. The one deliberate behavioral difference from
 * the original — a fresh Doctrine's cache is empty until reload() is
 * explicitly awaited, since the constructor can no longer populate it
 * synchronously — is exercised directly rather than glossed over.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

let pool: pg.Pool;
let store: Store;
let tenantA: string;
let tenantB: string;

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
  const a = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`DOCTRINE-A-${Date.now()}`],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`DOCTRINE-B-${Date.now()}`],
  );
  tenantA = a.rows[0]!.id;
  tenantB = b.rows[0]!.id;
});

after(async () => {
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
});

describe("Doctrine", () => {
  it("falls back to code defaults when nothing is stored", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    assert.equal(d.value("cashFloor"), 20_000);
    assert.equal(d.value("maxLossPct"), 15);
    assert.equal(d.value("snapshotMaxAgeMin"), 90);
    assert.equal(d.list().length, DOCTRINE_DEFAULTS.length);
  });

  it("persists an override and survives a reload — but only once reload() is awaited", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.set("cashFloor", { value: 45_000 });
    assert.equal(d.value("cashFloor"), 45_000);

    // A fresh instance over the same store/tenant has an EMPTY cache until
    // reload() runs — unlike the straders original, where the constructor's
    // synchronous SQLite read meant this worked with no extra step. That
    // constructor can no longer be async, so this is a real, documented
    // behavior change, not an oversight — exercise both halves of it.
    const fresh = new Doctrine(store, tenantA);
    assert.equal(fresh.value("cashFloor"), 20_000, "unreloaded: falls back to the default, not the stored override");
    await fresh.reload();
    assert.equal(fresh.value("cashFloor"), 45_000, "after reload: sees the persisted override");
  });

  it("clamps values to the rule's declared bounds", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    assert.equal((await d.set("maxLossPct", { value: 9_999 })).value, 100, "clamped to max");
    assert.equal((await d.set("maxLossPct", { value: -50 })).value, 0, "clamped to min");
  });

  it("returns the unconstrained value when a rule is switched off", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.set("marginFloor", { enabled: false });
    // Off means "do not constrain", not "constrain to zero-ish by accident".
    assert.equal(d.value("marginFloor", 0), 0);
    assert.equal(d.isEnabled("marginFloor"), false);
    // With no fallback supplied the configured number is still returned.
    assert.equal(d.value("marginFloor"), 10);
  });

  it("rejects unknown rules rather than silently storing them", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await assert.rejects(() => d.set("nonsense", { value: 1 }), /unknown doctrine rule/);
    assert.throws(() => d.value("nonsense"), /unknown doctrine rule/);
  });

  it("a tenant's overrides are invisible to another tenant, even sharing one Store instance", async () => {
    const a = new Doctrine(store, tenantA);
    const b = new Doctrine(store, tenantB);
    await a.reload();
    await b.reload();
    await a.set("cashFloor", { value: 77_000 });
    assert.equal(a.value("cashFloor"), 77_000);
    assert.equal(b.value("cashFloor"), 20_000, "tenant B must still see the default, not tenant A's override");

    // And reloading B from the database confirms it was never written there either.
    await b.reload();
    assert.equal(b.value("cashFloor"), 20_000);
  });

  it("without a store, every write is a no-op but reads still work off defaults", async () => {
    const d = new Doctrine();
    await d.reload(); // must not throw with no store/tenant
    assert.equal(d.value("cashFloor"), 20_000);
    await d.ensureShipTypeRule("SHIP_MINING_DRONE"); // must not throw
    const rule = await d.set("cashFloor", { value: 1_000 }); // must not throw, updates the cache only
    assert.equal(rule.value, 1_000);
    assert.equal(d.value("cashFloor"), 1_000);
  });
});
