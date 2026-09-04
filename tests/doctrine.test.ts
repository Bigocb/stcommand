import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { Doctrine, DOCTRINE_CATALOG } from "../src/engine/doctrine.js";

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
    assert.equal(d.list().length, DOCTRINE_CATALOG.length);
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

describe("Doctrine: policy library (adopt/remove)", () => {
  it("removing a policy takes it out of list() and makes value()/isEnabled() behave as if disabled", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    assert.ok(d.list().some((r) => r.key === "marginFloor"), "sanity: adopted by default (grandfathered)");

    await d.setAdopted("marginFloor", false);

    assert.ok(!d.list().some((r) => r.key === "marginFloor"), "a removed policy must not appear in the active list");
    assert.equal(d.isEnabled("marginFloor"), false, "not-adopted must read as not-enabled to every engine call site");
    assert.equal(d.value("marginFloor", 0), 0, "not-adopted must fall back to whenOff, same as disabled");
  });

  it("re-adding a removed policy restores its previously tuned value, not the catalog default", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.set("marginFloor", { value: 77 });
    await d.setAdopted("marginFloor", false);
    assert.ok(!d.list().some((r) => r.key === "marginFloor"));

    await d.setAdopted("marginFloor", true);

    const rule = d.list().find((r) => r.key === "marginFloor");
    assert.equal(rule?.value, 77, "re-adopting must not reset the tuning a captain already dialed in");
  });

  it("adopting a policy for the first time uses the given initial value, not the catalog default", async () => {
    // A genuine first-time add needs a tenant that has never had a row for
    // this key — tenantB never writes sensorScanIntervalMin anywhere in this
    // file, so its cache has no entry and `initialValue` is what lands.
    //
    // The original version of this test removed the key from tenantA first
    // and expected the initial value to win on re-add. That asserted the
    // opposite of setAdopted()'s documented contract ("initialValue on a
    // first-time add, or whatever it was last tuned to if re-adding after a
    // previous remove") — removal deliberately keeps the tuning, so the
    // remove/re-add path is not a first-time add at all. See the test below,
    // which now covers that second case properly.
    const d = new Doctrine(store, tenantB);
    await d.reload();
    await d.setAdopted("sensorScanIntervalMin", true, 120);

    const rule = d.list().find((r) => r.key === "sensorScanIntervalMin");
    assert.equal(rule?.value, 120);
  });

  it("re-adding after a removal restores the value it was last tuned to, ignoring any initial value", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.set("sensorScanIntervalMin", { value: 45 });
    await d.setAdopted("sensorScanIntervalMin", false);
    await d.setAdopted("sensorScanIntervalMin", true, 120);

    const rule = d.list().find((r) => r.key === "sensorScanIntervalMin");
    assert.equal(rule?.value, 45, "removing a policy must not discard the operator's tuning");
  });

  it("catalog() reports every policy tagged with this tenant's adopted state, regardless of adoption", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.setAdopted("marginFloor", false);

    const catalog = d.catalog();

    assert.equal(catalog.length, DOCTRINE_CATALOG.length, "catalog() must list every known policy, adopted or not");
    assert.equal(catalog.find((c) => c.key === "marginFloor")?.adopted, false);
    assert.equal(catalog.find((c) => c.key === "cashFloor")?.adopted, true, "an untouched, grandfathered policy must still report adopted:true");
  });

  it("setAdopted rejects an unknown key", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await assert.rejects(() => d.setAdopted("not_a_real_policy", true), /unknown policy/);
  });

  it("a removed policy stays removed across a reload", async () => {
    const d = new Doctrine(store, tenantA);
    await d.reload();
    await d.setAdopted("marginFloor", false);

    const fresh = new Doctrine(store, tenantA);
    await fresh.reload();

    assert.ok(!fresh.list().some((r) => r.key === "marginFloor"), "adopted:false must persist and survive a reload, same as any other override");
  });
});
