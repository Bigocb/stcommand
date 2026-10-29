import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, withTenant } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * Slice 1 of docs/system-survey-persistence-design.md: the two explorer-state
 * tables exist, are tenant-isolated, and their write paths are idempotent.
 *
 * Real Postgres (TEST_DATABASE_URL, DB_SCHEMA=stcommand_test), same as
 * store.test.ts — an RLS guarantee cannot be proven against a stub.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:***@localhost:5432/stcommand";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

let pool: pg.Pool;
let tenantA: string;
let tenantB: string;
let store: Store;

before(async () => {
  pool = createPool(DB_URL);
  const mk = async (label: string) => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
      [`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    return res.rows[0]!.id;
  };
  tenantA = await mk("SURVEY-A");
  tenantB = await mk("SURVEY-B");
  store = new Store(pool);
});

after(async () => {
  if (tenantA) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  await pool.end();
});

describe("Store.system_surveys", () => {
  it("records a survey, and a second record refreshes the same row", async () => {
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-AA11", markets: 3, shipyards: 1, source: "survey" });
    await new Promise((r) => setTimeout(r, 15));
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-AA11", markets: 7, shipyards: 2, source: "tour" });

    const rows = await store.listSystemSurveys(tenantA);
    assert.equal(rows.length, 1, "a re-survey is the same row, not a second one");
    assert.equal(rows[0]!.systemSymbol, "X1-AA11");
  });

  it("returns rows newest first and honours the freshness window", async () => {
    const now = Date.now();
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-FRESH", markets: 1, shipyards: 0, source: "tour" });
    // Backdate the first row past the window. Must go through withTenant(): the
    // tables are FORCE ROW LEVEL SECURITY, so an unqualified UPDATE sees no rows.
    await withTenant(pool, tenantA, (c) =>
      c.query(`UPDATE system_surveys SET surveyed_at = now() - interval '20 days' WHERE system_symbol = 'X1-AA11'`),
    );

    const all = await store.listSystemSurveys(tenantA);
    assert.deepEqual(all.map((r) => r.systemSymbol), ["X1-FRESH", "X1-AA11"], "newest first");

    const fresh = await store.listSystemSurveys(tenantA, now - TTL_MS);
    assert.deepEqual(fresh.map((r) => r.systemSymbol), ["X1-FRESH"], "a row past the window is not returned");
    assert.ok(fresh[0]!.surveyedAt > now - 60_000, "surveys come back as epoch ms, not a Date");
  });

  it("forgets one system, then all of them, and reports how many rows went", async () => {
    assert.equal(await store.forgetSystemSurveys(tenantA, "X1-FRESH"), 1);
    assert.equal(await store.forgetSystemSurveys(tenantA, "X1-FRESH"), 0, "forgetting twice removes nothing the second time");
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-BB22", markets: 2, shipyards: 0, source: "survey" });
    const removed = await store.forgetSystemSurveys(tenantA);
    assert.ok(removed >= 2, `expected every mark to go, removed ${removed}`);
    assert.deepEqual(await store.listSystemSurveys(tenantA), []);
  });

  it("keeps one tenant's surveys invisible to another", async () => {
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-CC33", markets: 4, shipyards: 0, source: "survey" });
    assert.deepEqual(await store.listSystemSurveys(tenantB), [], "RLS must hide tenant A's rows from tenant B with no WHERE clause");
    assert.equal(await store.forgetSystemSurveys(tenantB), 0, "tenant B cannot delete tenant A's marks");
    assert.equal((await store.listSystemSurveys(tenantA)).length, 1);
  });
});

describe("Store.tour_queue", () => {
  const stops = [
    { symbol: "X1-DD44-M01", market: true, yard: false },
    { symbol: "X1-DD44-Y01", market: false, yard: true },
  ];

  it("saves a queue and reads it back with the stop flags intact", async () => {
    await store.saveTourQueue(tenantA, { shipSymbol: "SHIP-1", systemSymbol: "X1-DD44", stops });
    const queues = await store.listTourQueues(tenantA);
    assert.equal(queues.length, 1);
    assert.equal(queues[0]!.shipSymbol, "SHIP-1");
    assert.equal(queues[0]!.systemSymbol, "X1-DD44");
    assert.deepEqual(queues[0]!.stops, stops, "market/yard flags decide what the resume does at each stop");
    assert.ok(queues[0]!.updatedAt > Date.now() - 60_000);
  });

  it("replaces a ship's queue rather than appending to it", async () => {
    await store.saveTourQueue(tenantA, { shipSymbol: "SHIP-1", systemSymbol: "X1-DD44", stops: stops.slice(1) });
    const queues = await store.listTourQueues(tenantA);
    assert.equal(queues.length, 1, "one row per ship");
    assert.deepEqual(queues[0]!.stops, stops.slice(1));
  });

  it("clears exactly one ship's queue", async () => {
    await store.saveTourQueue(tenantA, { shipSymbol: "SHIP-2", systemSymbol: "X1-EE55", stops });
    await store.clearTourQueue(tenantA, "SHIP-1");
    const left = await store.listTourQueues(tenantA);
    assert.deepEqual(left.map((q) => q.shipSymbol), ["SHIP-2"]);
  });

  it("keeps one tenant's queue invisible to another", async () => {
    assert.deepEqual(await store.listTourQueues(tenantB), []);
    await store.clearTourQueue(tenantB, "SHIP-2");
    assert.deepEqual((await store.listTourQueues(tenantA)).map((q) => q.shipSymbol), ["SHIP-2"], "tenant B cannot clear tenant A's queue");
  });
});

describe("explorer-state tables survive a universe reset correctly", () => {
  it("wipeTenantGameData empties both tables", async () => {
    await store.recordSystemSurvey(tenantA, { systemSymbol: "X1-FF66", markets: 1, shipyards: 0, source: "survey" });
    await store.saveTourQueue(tenantA, { shipSymbol: "SHIP-3", systemSymbol: "X1-FF66", stops: [{ symbol: "X1-FF66-M01", market: true, yard: false }] });

    await store.wipeTenantGameData(tenantA);

    assert.deepEqual(await store.listSystemSurveys(tenantA), [], "a universe reset invalidates every survey mark");
    assert.deepEqual(await store.listTourQueues(tenantA), [], "and every queued waypoint symbol");
  });
});

describe("market directory (migrations/064)", () => {
  it("saves a system's goods lists, replaces them on a re-read, and reads them back by system", async () => {
    const sys = `X1-MD${Date.now() % 100000}`;
    await store.recordMarketDirectory(sys, [
      { symbol: `${sys}-A1`, imports: ["IRON"], exports: ["FUEL"], exchange: [] },
      { symbol: `${sys}-B2`, imports: [], exports: [], exchange: ["ICE", "FOOD"] },
    ]);
    await store.recordMarketDirectory(sys, [{ symbol: `${sys}-A1`, imports: ["IRON", "FOOD"], exports: ["FUEL"], exchange: [] }]);
    const rows = await store.marketDirectory(sys);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.waypointSymbol === `${sys}-A1`)!.imports, ["IRON", "FOOD"]);
    assert.deepEqual(rows.find((r) => r.waypointSymbol === `${sys}-B2`)!.exchange, ["ICE", "FOOD"]);
    assert.equal((await store.marketDirectory("X1-NOPE")).length, 0);
    await pool.query(`DELETE FROM market_directory WHERE system_symbol = $1`, [sys]);
  });
});

describe("shipyard directory (migrations/065)", () => {
  it("saves each yard's hull types, replaces them on a re-read, and lists the systems the market directory covers", async () => {
    const sys = `X1-SD${Date.now() % 100000}`;
    await store.recordShipyardDirectory(sys, [{ symbol: `${sys}-A2`, shipTypes: ["SHIP_PROBE", "SHIP_LIGHT_HAULER"] }]);
    await store.recordShipyardDirectory(sys, [{ symbol: `${sys}-A2`, shipTypes: ["SHIP_PROBE"] }]);
    const rows = await store.shipyardDirectory(sys);
    assert.deepEqual(rows.map((r) => [r.waypointSymbol, r.shipTypes]), [[`${sys}-A2`, ["SHIP_PROBE"]]]);
    await store.recordMarketDirectory(sys, [{ symbol: `${sys}-A1`, imports: ["IRON"], exports: [], exchange: [] }]);
    assert.ok((await store.directorySystems()).has(sys));
    await pool.query(`DELETE FROM shipyard_directory WHERE system_symbol = $1`, [sys]);
    await pool.query(`DELETE FROM market_directory WHERE system_symbol = $1`, [sys]);
  });
});
