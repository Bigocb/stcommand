import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { findOrCreateTenant, createSession, setTenantLlmConfig } from "../src/db/tenants.js";
import { signSessionCookie } from "../src/auth/crypto.js";
import { TenantRegistry } from "../src/engine/tenantRegistry.js";
import { createResolveTenant } from "../src/http/resolveTenant.js";
import { createDashboardRouter } from "../src/http/dashboard.js";
import { SESSION_COOKIE_NAME } from "../src/http/session.js";
import type { SpaceTradersAPI } from "../src/core/client.js";

/**
 * Integration tests for the dashboard route surface, against a real HTTP
 * server and real Postgres — the same fake-SpaceTraders-API DI seam
 * tenantRegistry.test.ts uses (an agent with zero ships in an empty
 * system), wired through the real `resolveTenant` + boot-the-tenant
 * middleware so these routes are exercised exactly as `src/cli/index.ts`
 * exercises them, not called as bare functions.
 *
 * Not exhaustive over all ~45 routes (many are thin, mechanically similar
 * wrappers around a single already-tested FleetManager/Store method) — this
 * covers one representative of each shape: plain reads, reads composed from
 * several sources (/bridge), a doctrine-style GET+POST pair, a warehouse
 * mutation, a co-pilot-not-configured 503, and the 401 a missing session
 * produces at the edge of this whole router.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let registry: TenantRegistry;
const tenantIds: string[] = [];
let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;
let cookie: string;
let tenantId: string;
let agentSymbol: string;

function makeFakeApi(agentSymbol: string, credits = 50_000): SpaceTradersAPI {
  const unexpected = (name: string) => async () => {
    throw new Error(`fake api: unexpected call to ${name}`);
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

before(async () => {
  process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
  pool = createPool(DB_URL);

  agentSymbol = `DASH-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await findOrCreateTenant(pool, agentSymbol, "st-token");
  tenantId = tenant.id;
  tenantIds.push(tenant.id);
  const sessionId = await createSession(pool, tenant.id);
  cookie = `${SESSION_COOKIE_NAME}=${signSessionCookie(sessionId)}`;

  registry = new TenantRegistry(pool, () => {}, () => makeFakeApi(agentSymbol));

  const app = express();
  app.use(express.json());
  const resolveTenant = createResolveTenant(pool);
  app.use("/api", resolveTenant, async (req, res, next) => {
    await registry.getOrCreate(req.tenantId!, req.agentSymbol!);
    next();
  });
  app.use("/api", createDashboardRouter(registry, pool));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  registry.stopAll();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function get(path: string, withCookie = true) {
  return fetch(`${baseUrl}${path}`, withCookie ? { headers: { Cookie: cookie } } : {});
}
async function post(path: string, body: unknown = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe("dashboard router: authentication boundary", () => {
  it("401s with no session, before any route logic runs", async () => {
    const res = await get("/api/state", false);
    assert.equal(res.status, 401);
  });
});

describe("GET /api/state", () => {
  it("returns the tenant's live fleet snapshot", async () => {
    const res = await get("/api/state");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agent?: { symbol: string }; systemSymbol: string };
    assert.equal(body.agent?.symbol, agentSymbol);
    assert.equal(body.systemSymbol, "X1-TEST");
  });
});

describe("GET /api/fleet/status", () => {
  it("reports paused/running/ships/stranded for an idle empty fleet", async () => {
    const res = await get("/api/fleet/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { paused: boolean; running: boolean; ships: unknown[]; stranded: unknown[] };
    assert.equal(body.paused, false);
    assert.deepEqual(body.ships, []);
    assert.deepEqual(body.stranded, []);
  });
});

describe("POST /api/fleet/pause + /api/fleet/resume", () => {
  it("toggles pause state and it's reflected in fleet/status", async () => {
    const paused = await post("/api/fleet/pause");
    assert.equal(paused.status, 200);
    assert.deepEqual(await paused.json(), { paused: true });
    assert.equal(((await (await get("/api/fleet/status")).json()) as { paused: boolean }).paused, true);

    const resumed = await post("/api/fleet/resume");
    assert.deepEqual(await resumed.json(), { paused: false });
    assert.equal(((await (await get("/api/fleet/status")).json()) as { paused: boolean }).paused, false);
  });
});

describe("GET/POST /api/doctrine", () => {
  it("reads the default rules, then a POST edit takes effect immediately", async () => {
    const before = (await (await get("/api/doctrine")).json()) as { rules: { key: string; value: number }[] };
    assert.ok(Array.isArray(before.rules));

    const res = await post("/api/doctrine", { key: "cashFloor", value: 12345, enabled: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; rule: { key: string; value: number } };
    assert.equal(body.ok, true);
    assert.equal(body.rule.value, 12345);

    const after = (await (await get("/api/doctrine")).json()) as { rules: { key: string; value: number }[] };
    assert.equal(after.rules.find((r) => r.key === "cashFloor")?.value, 12345);
  });

  it("rejects a malformed value", async () => {
    const res = await post("/api/doctrine", { key: "cashFloor", value: "not-a-number" });
    assert.equal(res.status, 400);
  });
});

describe("GET /api/warehouse + POST /api/warehouse/targets", () => {
  it("starts empty, then a target add is reflected in the GET", async () => {
    const before = (await (await get("/api/warehouse")).json()) as { targets: unknown[] };
    assert.deepEqual(before.targets, []);

    const res = await post("/api/warehouse/targets", { good: "IRON_ORE", target: 100, forMission: false });
    assert.equal(res.status, 200);

    const after = (await (await get("/api/warehouse")).json()) as { targets: { goodSymbol: string }[] };
    assert.ok(after.targets.some((t) => t.goodSymbol === "IRON_ORE"));
  });

  it("rejects a non-positive target", async () => {
    const res = await post("/api/warehouse/targets", { good: "GOLD", target: 0 });
    assert.equal(res.status, 400);
  });
});

describe("GET /api/missions", () => {
  it("starts with no missions", async () => {
    const res = await get("/api/missions");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { missions: [] });
  });
});

describe("GET /api/bridge", () => {
  it("composes rate/triage/earnings for a fresh idle fleet without error", async () => {
    const res = await get("/api/bridge");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { credits: number; shipCount: number; paused: boolean; shipStatus: unknown[] };
    assert.equal(body.credits, 50_000);
    assert.equal(body.shipCount, 0);
    assert.equal(body.paused, false);
    assert.deepEqual(body.shipStatus, []);
  });
});

describe("POST /api/chat", () => {
  it("503s when no LLM key is configured for this tenant", async () => {
    const res = await post("/api/chat", { message: "how's the fleet doing?" });
    assert.equal(res.status, 503);
  });

  it("setting an LLM key after boot doesn't retroactively enable an already-running worker", async () => {
    // A real, current limitation, not an oversight this test papers over:
    // TenantRegistry boots a worker's ChatAgent once, from whatever LLM
    // config existed at boot time (see tenantRegistry.ts's boot()). Unlike
    // the Discord webhook route, which explicitly pushes an update to the
    // *live* relay, there's no equivalent live-update path for the co-pilot
    // yet — settings changes need that tenant's worker to reboot. Documented
    // here so a future settings-page route inherits the right expectation
    // rather than assuming this already works.
    await setTenantLlmConfig(pool, tenantId, { provider: "openai", model: "gpt-5", apiKey: "sk-test" });
    const res = await post("/api/chat", { message: "how's the fleet doing?" });
    assert.equal(res.status, 503);
  });

  it("400s on an empty message, for a worker whose co-pilot was already configured at boot", async () => {
    const symbol = `DASH-CHAT-${Date.now()}`;
    const tenant = await findOrCreateTenant(pool, symbol, "st-token-chat");
    tenantIds.push(tenant.id);
    await setTenantLlmConfig(pool, tenant.id, { provider: "openai", model: "gpt-5", apiKey: "sk-test" });
    const sessionId = await createSession(pool, tenant.id);
    const chatCookie = `${SESSION_COOKIE_NAME}=${signSessionCookie(sessionId)}`;

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: chatCookie },
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/discord", () => {
  it("rejects a missing webhookUrl", async () => {
    const res = await post("/api/discord", {});
    assert.equal(res.status, 400);
  });

  it("accepts and persists a webhook URL, applied to the live relay", async () => {
    const res = await post("/api/discord", { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(res.status, 200);
    const worker = registry.get(tenantId)!;
    assert.equal((worker.discord as any).webhookUrl, "https://discord.com/api/webhooks/1/abc");
  });
});
