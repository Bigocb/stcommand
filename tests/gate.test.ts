import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { createGateRouter } from "../src/http/gate.js";
import { createResolveTenant } from "../src/http/resolveTenant.js";
import { SESSION_COOKIE_NAME } from "../src/http/session.js";

/**
 * Integration tests for the gate + resolveTenant middleware, against a real
 * HTTP server (node's built-in http via express's own listen) and real
 * Postgres — the only thing faked is the SpaceTraders API boundary
 * (`verifyToken`/`registerAgent`), the same DI seam TenantRegistry's tests
 * use, since hitting the real SpaceTraders API would need network access
 * and a disposable real account.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
const tenantIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;
let app: express.Express;

before(async () => {
  process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
  pool = createPool(DB_URL);

  app = express();
  app.use(express.json());
  app.use("/api/gate", createGateRouter(
    pool,
    async (token) => {
      if (token === "valid-token") return { symbol: "GATETEST" };
      throw new Error("invalid token");
    },
    async (accountToken, symbol, faction) => {
      if (accountToken !== "valid-account-token") throw new Error("bad account token");
      return { token: `issued-token-for-${symbol}`, agent: { symbol, headquarters: `X1-${symbol}-A1`, credits: 175_000 } };
    },
  ));
  app.get("/api/whoami", createResolveTenant(pool), (req, res) => {
    res.json({ tenantId: req.tenantId, agentSymbol: req.agentSymbol });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (tenantIds.length) {
    const res = await pool.query(`SELECT id FROM tenants WHERE agent_symbol = ANY($1)`, [["GATETEST", "NEWAGENT1"]]);
    tenantIds.push(...res.rows.map((r: { id: string }) => r.id));
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[...new Set(tenantIds)]]);
  }
  await pool.end();
});

function cookieFromResponse(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(match, `expected a ${SESSION_COOKIE_NAME} cookie in the response, got: ${raw}`);
  return `${SESSION_COOKIE_NAME}=${match![1]}`;
}

describe("POST /api/gate/login", () => {
  it("rejects a missing token", async () => {
    const res = await fetch(`${baseUrl}/api/gate/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 400);
  });

  it("rejects a token that fails verification", async () => {
    const res = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    assert.equal(res.status, 401);
  });

  it("logs in with a valid token, sets a session cookie, and resolveTenant accepts it", async () => {
    const res = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agentSymbol: string };
    assert.equal(body.agentSymbol, "GATETEST");

    const cookie = cookieFromResponse(res);
    const who = await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookie } });
    assert.equal(who.status, 200);
    const whoBody = (await who.json()) as { agentSymbol: string };
    assert.equal(whoBody.agentSymbol, "GATETEST");
  });

  it("logging in twice with the same underlying agent reuses one tenant", async () => {
    const first = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    const second = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    const cookieA = cookieFromResponse(first);
    const cookieB = cookieFromResponse(second);
    const whoA = (await (await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookieA } })).json()) as { tenantId: string };
    const whoB = (await (await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookieB } })).json()) as { tenantId: string };
    assert.equal(whoA.tenantId, whoB.tenantId, "same agent must resolve to the same tenant across separate logins/sessions");
  });
});

describe("POST /api/gate/register", () => {
  it("rejects a bad agent symbol", async () => {
    const res = await fetch(`${baseUrl}/api/gate/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSymbol: "!!", accountToken: "valid-account-token" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects a missing account token", async () => {
    const res = await fetch(`${baseUrl}/api/gate/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSymbol: "NEWAGENT1" }),
    });
    assert.equal(res.status, 400);
  });

  it("registers a new agent, creates a tenant, and sets a working session", async () => {
    const res = await fetch(`${baseUrl}/api/gate/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSymbol: "NEWAGENT1", faction: "COSMIC", accountToken: "valid-account-token" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agentSymbol: string; headquarters: string; credits: number };
    assert.equal(body.agentSymbol, "NEWAGENT1");
    assert.equal(body.credits, 175_000);

    const cookie = cookieFromResponse(res);
    const who = await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookie } });
    const whoBody = (await who.json()) as { agentSymbol: string };
    assert.equal(whoBody.agentSymbol, "NEWAGENT1");
  });

  it("surfaces the registration API's own error message", async () => {
    const res = await fetch(`${baseUrl}/api/gate/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSymbol: "BADACCT01", accountToken: "wrong-account-token" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /bad account token/);
  });
});

describe("resolveTenant middleware", () => {
  it("401s with no cookie at all", async () => {
    const res = await fetch(`${baseUrl}/api/whoami`);
    assert.equal(res.status, 401);
  });

  it("401s with a garbage cookie value", async () => {
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=not-a-real-session` } });
    assert.equal(res.status, 401);
  });

  it("401s with a validly-signed cookie for a session that was never created", async () => {
    // A correctly-HMAC'd cookie for a random uuid that was never issued via login/register.
    const { signSessionCookie } = await import("../src/auth/crypto.js");
    const forged = signSessionCookie("00000000-0000-0000-0000-000000000000");
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${forged}` } });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/gate/logout", () => {
  it("clears the session so a subsequent request 401s", async () => {
    const login = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    const cookie = cookieFromResponse(login);
    assert.equal((await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookie } })).status, 200);

    const logout = await fetch(`${baseUrl}/api/gate/logout`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);

    assert.equal((await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookie } })).status, 401, "the session must be dead after logout");
  });

  it("logging out with no session is a safe no-op", async () => {
    const res = await fetch(`${baseUrl}/api/gate/logout`, { method: "POST" });
    assert.equal(res.status, 200);
  });
});

/**
 * GET /api/gate/session — the probe every page load makes before it knows
 * which screen to render.
 *
 * It exists because onboarding used to be decided by the login response's
 * one-shot `isNewTenant`, so a refresh skipped it forever while
 * tenants.onboarding_pending stayed true — and that column is what keeps
 * the fleet paused on every restart. The probe reads the column, so the
 * decision is level-triggered: the same answer on the tenth page load as
 * on the first, until onboarding is actually confirmed.
 */
describe("GET /api/gate/session", () => {
  it("401s without a cookie", async () => {
    const res = await fetch(`${baseUrl}/api/gate/session`);
    assert.equal(res.status, 401);
  });

  it("401s on a forged cookie rather than trusting it", async () => {
    const res = await fetch(`${baseUrl}/api/gate/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=not.a.real.signature` },
    });
    assert.equal(res.status, 401);
  });

  it("reports the agent and its pending onboarding, on every call", async () => {
    const login = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    const cookie = cookieFromResponse(login);
    const who = (await (await fetch(`${baseUrl}/api/whoami`, { headers: { Cookie: cookie } })).json()) as { tenantId: string };
    await pool.query(`UPDATE tenants SET onboarding_pending = true WHERE id = $1`, [who.tenantId]);

    // Twice: the second call is the refresh that used to lose onboarding.
    for (const attempt of [1, 2]) {
      const res = await fetch(`${baseUrl}/api/gate/session`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agentSymbol: string; onboardingPending: boolean };
      assert.equal(body.agentSymbol, "GATETEST");
      assert.equal(body.onboardingPending, true, `probe ${attempt} must still say onboarding is owed`);
    }

    await pool.query(`UPDATE tenants SET onboarding_pending = false WHERE id = $1`, [who.tenantId]);
    const after = await fetch(`${baseUrl}/api/gate/session`, { headers: { Cookie: cookie } });
    const afterBody = (await after.json()) as { onboardingPending: boolean };
    assert.equal(afterBody.onboardingPending, false, "confirming onboarding is what ends the gate");
  });

  it("login reports onboardingPending from the same durable column", async () => {
    const res = await fetch(`${baseUrl}/api/gate/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "valid-token" }),
    });
    const body = (await res.json()) as { onboardingPending: boolean };
    assert.equal(typeof body.onboardingPending, "boolean");
  });
});
