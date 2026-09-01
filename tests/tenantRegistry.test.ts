import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPool } from "../src/db/pool.js";
import { findOrCreateTenant, setTenantLlmConfig } from "../src/db/tenants.js";
import { TenantRegistry } from "../src/engine/tenantRegistry.js";
import type { SpaceTradersAPI } from "../src/core/client.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
const tenantIds: string[] = [];
const registries: TenantRegistry[] = [];

before(() => {
  process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
  pool = createPool(DB_URL);
});

after(async () => {
  // Every booted worker's fleet.run() left a coordinator loop ticking every
  // 2s (that's real, intended production behavior — see TenantRegistry's
  // class doc comment on why it's the one deliberately fire-and-forget
  // piece); tests must explicitly stop each one or the process never exits.
  for (const registry of registries) registry.stopAll();
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

/** Tracks the registry for cleanup in `after`, so every test just calls this instead of `new TenantRegistry` directly. */
function makeRegistry(buildApi: (token: string) => SpaceTradersAPI, log: (tenantId: string, msg: string) => void = () => {}): TenantRegistry {
  const registry = new TenantRegistry(pool, log, buildApi);
  registries.push(registry);
  return registry;
}

/**
 * A minimal agent-in-an-empty-system: no ships, no waypoints. Every call
 * TenantRegistry.boot()/FleetManager.init() make with zero ships and zero
 * waypoints to iterate over is covered; anything reachable only via a real
 * ship or waypoint (getMarket, getShipyard, getJumpGate) throws loudly if
 * hit, so a wiring bug that suddenly needs one shows up as a test failure
 * instead of a silent no-op.
 */
function makeFakeApi(agentSymbol: string, credits = 5000): SpaceTradersAPI {
  const unexpected = (name: string) => async () => {
    throw new Error(`fake api: unexpected call to ${name} for an empty test system`);
  };
  return {
    getMyAgent: async () => ({ symbol: agentSymbol, headquarters: "X1-TEST-A1", credits, shipCount: 0 }),
    getAllSystemWaypoints: async () => [],
    getSystem: async () => ({ symbol: "X1-TEST", type: "NEUTRON_STAR", x: 0, y: 0, waypoints: [], factions: [] }),
    getJumpGate: unexpected("getJumpGate"),
    getMarket: unexpected("getMarket"),
    getShipyard: unexpected("getShipyard"),
    listAllShips: async () => [],
    getContracts: async () => [],
  } as unknown as SpaceTradersAPI;
}

function agentSymbol(): string {
  return `REGISTRY-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("TenantRegistry", () => {
  it("boots a tenant worker: fleet initialized, state populated, co-pilot off by default", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    const registry = makeRegistry(() => makeFakeApi(symbol));
    const worker = await registry.getOrCreate(tenant.id, symbol);

    assert.equal(worker.tenantId, tenant.id);
    assert.equal(worker.agentSymbol, symbol);
    assert.equal(worker.chat, undefined, "no LLM key set for this tenant, so no co-pilot");
    assert.equal(worker.state.get().agent?.symbol, symbol);
    assert.equal(worker.state.get().systemSymbol, "X1-TEST");
    assert.equal(registry.size(), 1);
  });

  it("getOrCreate returns the same worker on a second call — a tenant boots once per process", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    let bootCount = 0;
    const registry = makeRegistry(() => {
      bootCount += 1;
      return makeFakeApi(symbol);
    });

    const first = await registry.getOrCreate(tenant.id, symbol);
    const second = await registry.getOrCreate(tenant.id, symbol);

    assert.equal(first, second, "must be the exact same worker object, not a fresh boot");
    assert.equal(bootCount, 1, "buildApi must only be called once for this tenant");
  });

  it("concurrent getOrCreate calls for the same tenant share one in-flight boot", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    let bootCount = 0;
    const registry = makeRegistry(() => {
      bootCount += 1;
      return makeFakeApi(symbol);
    });

    const [a, b, c] = await Promise.all([
      registry.getOrCreate(tenant.id, symbol),
      registry.getOrCreate(tenant.id, symbol),
      registry.getOrCreate(tenant.id, symbol),
    ]);

    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(bootCount, 1, "three concurrent calls for one tenant must boot exactly once, not race into three fleets");
  });

  it("get() returns undefined before getOrCreate has booted the tenant, and the worker after", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    const registry = makeRegistry(() => makeFakeApi(symbol));
    assert.equal(registry.get(tenant.id), undefined);

    const worker = await registry.getOrCreate(tenant.id, symbol);
    assert.equal(registry.get(tenant.id), worker);
  });

  it("wires the co-pilot when the tenant has an LLM key set", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);
    await setTenantLlmConfig(pool, tenant.id, { provider: "openai", model: "gpt-5", apiKey: "sk-test" });

    const registry = makeRegistry(() => makeFakeApi(symbol));
    const worker = await registry.getOrCreate(tenant.id, symbol);

    assert.ok(worker.chat, "an LLM key must enable the co-pilot");
    assert.ok(worker.chat!.getTools().length > 0);
  });

  it("two different tenants each get their own isolated worker", async () => {
    const symbolA = agentSymbol();
    const symbolB = agentSymbol();
    const tenantA = await findOrCreateTenant(pool, symbolA, "st-token-a");
    const tenantB = await findOrCreateTenant(pool, symbolB, "st-token-b");
    tenantIds.push(tenantA.id, tenantB.id);

    const registry = makeRegistry((token) => makeFakeApi(token === "st-token-a" ? symbolA : symbolB));

    const workerA = await registry.getOrCreate(tenantA.id, symbolA);
    const workerB = await registry.getOrCreate(tenantB.id, symbolB);

    assert.notEqual(workerA, workerB);
    assert.equal(workerA.agentSymbol, symbolA);
    assert.equal(workerB.agentSymbol, symbolB);
    assert.equal(registry.size(), 2);
  });

  it("bootAll boots every known tenant without waiting for a request, isolating one tenant's failure from the rest", async () => {
    const symbolA = agentSymbol();
    const symbolB = agentSymbol();
    const symbolBroken = agentSymbol();
    const tenantA = await findOrCreateTenant(pool, symbolA, "st-token-a");
    const tenantB = await findOrCreateTenant(pool, symbolB, "st-token-b");
    const tenantBroken = await findOrCreateTenant(pool, symbolBroken, "st-token-broken");
    tenantIds.push(tenantA.id, tenantB.id, tenantBroken.id);

    // The tenants table is shared across this whole test file (cleanup only
    // runs once, in the top-level `after`), so bootAll() will also try to
    // boot every tenant earlier tests already created. Reject anything this
    // test doesn't recognize rather than fabricating a working fake for it —
    // Promise.allSettled isolation already covers those unrelated tenants
    // for the purpose of this assertion, and a real fake worker would just
    // leave an unwanted background loop running against another test's
    // (possibly since-deleted) tenant row.
    const registry = makeRegistry((token) => {
      if (token === "st-token-a") return makeFakeApi(symbolA);
      if (token === "st-token-b") return makeFakeApi(symbolB);
      if (token === "st-token-broken") throw new Error("simulated boot failure");
      throw new Error(`unrecognized token from an unrelated tenant: ${token}`);
    });

    await registry.bootAll();

    assert.ok(registry.get(tenantA.id), "tenant A must boot even though tenant Broken fails");
    assert.ok(registry.get(tenantB.id), "tenant B must boot even though tenant Broken fails");
    assert.equal(registry.get(tenantBroken.id), undefined, "a tenant whose boot throws must not end up registered");
  });

  it("a genuinely new tenant (onboarding_pending from findOrCreateTenant's INSERT branch) boots paused", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);
    assert.equal(tenant.isNewTenant, true, "sanity check: this call must have hit the INSERT branch");

    const registry = makeRegistry(() => makeFakeApi(symbol));
    const worker = await registry.getOrCreate(tenant.id, symbol);

    assert.equal(worker.fleet.isPaused(), true, "onboarding_pending defaults true on a new INSERT — must stay paused until confirmed");
  });

  it("a returning tenant (already existed before this test, no onboarding_pending) boots unpaused", async () => {
    const symbol = agentSymbol();
    const first = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(first.id);
    // Migration 009's backfill default is false for any row that predates
    // onboarding_pending being set explicitly on INSERT — simulate that
    // grandfathered state directly, since findOrCreateTenant's own INSERT
    // path always sets it true for a brand-new row.
    await pool.query(`UPDATE tenants SET onboarding_pending = false WHERE id = $1`, [first.id]);
    const second = await findOrCreateTenant(pool, symbol, "st-token"); // same agent_symbol -> ON CONFLICT branch, doesn't touch onboarding_pending
    assert.equal(second.isNewTenant, false, "sanity check: this call must have hit the ON CONFLICT branch, not INSERT");

    const registry = makeRegistry(() => makeFakeApi(symbol));
    const worker = await registry.getOrCreate(second.id, symbol);

    assert.equal(worker.fleet.isPaused(), false, "a grandfathered/already-onboarded tenant must not be paused on a fresh boot");
  });
});
