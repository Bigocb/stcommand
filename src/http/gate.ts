import { Router } from "express";
import type pg from "pg";
import { Client, SpaceTradersAPI, API_BASE } from "../core/client.js";
import { findOrCreateTenant, createSession, deleteSession, resolveSession, needsOnboarding } from "../db/tenants.js";
import { signSessionCookie, verifySessionCookie } from "../auth/crypto.js";
import { parseCookies } from "./cookies.js";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_MAX_AGE_MS } from "./session.js";

const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_COOKIE_MAX_AGE_MS,
  path: "/",
};

/** Default: verify a token against the real SpaceTraders API. Injectable so tests don't need network access or a real account. */
async function defaultVerifyToken(token: string): Promise<{ symbol: string }> {
  const api = new SpaceTradersAPI(new Client({ token }), token);
  const agent = await api.getMyAgent();
  return { symbol: agent.symbol };
}

/** Default: register a new agent against the real SpaceTraders API. Injectable for the same reason as `defaultVerifyToken`. */
async function defaultRegisterAgent(
  accountToken: string,
  symbol: string,
  faction: string,
): Promise<{ token: string; agent: { symbol: string; headquarters: string; credits: number } }> {
  const apiRes = await fetch(`${API_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ symbol, faction }),
  });
  const json = (await apiRes.json()) as {
    data?: { token: string; agent: { symbol: string; headquarters: string; credits: number } };
    error?: { message: string };
  };
  if (!apiRes.ok || !json.data) throw new Error(json.error?.message ?? `registration failed (${apiRes.status})`);
  return json.data;
}

/**
 * The gate: how a visitor becomes a tenant. Two ways in, both from
 * docs/architecture-plan.md §4 — paste an existing token, or register a
 * brand-new agent — converging on the same outcome: a verified agent
 * symbol, a `tenants` row, a session, and a signed cookie.
 *
 * Neither route is behind `resolveTenant` — that's the point of a gate.
 */
export function createGateRouter(
  pool: pg.Pool,
  verifyToken: (token: string) => Promise<{ symbol: string }> = defaultVerifyToken,
  registerAgent: (accountToken: string, symbol: string, faction: string) => Promise<{ token: string; agent: { symbol: string; headquarters: string; credits: number } }> = defaultRegisterAgent,
): Router {
  const router = Router();

  router.post("/login", async (req, res) => {
    const token = String((req.body as { token?: unknown } | undefined)?.token ?? "").trim();
    if (!token) {
      res.status(400).json({ error: "token required" });
      return;
    }
    let agentSymbol: string;
    try {
      agentSymbol = (await verifyToken(token)).symbol;
    } catch {
      res.status(401).json({ error: "invalid SpaceTraders token" });
      return;
    }
    const tenant = await findOrCreateTenant(pool, agentSymbol, token);
    const sessionId = await createSession(pool, tenant.id);
    res.cookie(SESSION_COOKIE_NAME, signSessionCookie(sessionId), cookieOpts);
    res.json({
      agentSymbol: tenant.agentSymbol,
      isNewTenant: tenant.isNewTenant,
      onboardingPending: await needsOnboarding(pool, tenant.id),
    });
  });

  router.post("/register", async (req, res) => {
    const body = req.body as { agentSymbol?: unknown; faction?: unknown; accountToken?: unknown } | undefined;
    const agentSymbol = String(body?.agentSymbol ?? "").trim();
    const faction = String(body?.faction ?? "COSMIC").trim();
    const accountToken = String(body?.accountToken ?? "").trim();
    if (!/^[a-zA-Z0-9]{3,14}$/.test(agentSymbol)) {
      res.status(400).json({ error: "agent symbol must be 3-14 alphanumeric characters" });
      return;
    }
    if (!accountToken) {
      res.status(400).json({
        error: "account token required — get one at https://my.spacetraders.io (Settings → Generate Account Token)",
      });
      return;
    }
    let result: { token: string; agent: { symbol: string; headquarters: string; credits: number } };
    try {
      result = await registerAgent(accountToken, agentSymbol, faction);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "registration failed" });
      return;
    }
    const tenant = await findOrCreateTenant(pool, result.agent.symbol, result.token);
    const sessionId = await createSession(pool, tenant.id);
    res.cookie(SESSION_COOKIE_NAME, signSessionCookie(sessionId), cookieOpts);
    res.json({
      agentSymbol: tenant.agentSymbol,
      headquarters: result.agent.headquarters,
      credits: result.agent.credits,
      isNewTenant: tenant.isNewTenant,
      onboardingPending: await needsOnboarding(pool, tenant.id),
    });
  });

  /**
   * Who is this cookie, and does this tenant still owe us onboarding?
   *
   * Deliberately here, on the gate, and not behind `resolveTenant`: every
   * /api/* route is gated on `registry.getOrCreate()`, which blocks the
   * request until that tenant's engine has fully booted (live SpaceTraders
   * round-trips). A page load needs to know *which screen to render* long
   * before it needs an engine, and the screen it renders for a tenant that
   * hasn't onboarded is a full-screen gate the engine isn't part of.
   *
   * `onboardingPending` reads the durable tenants.onboarding_pending column
   * — the same one FleetManager stays paused on — so onboarding is decided
   * by observed state on every load, not by the one-shot `isNewTenant`
   * edge from a login that may have happened in a tab that has since been
   * refreshed away. Rule 3 of docs/control-plane-data-plane.md, applied to
   * the UI: level-triggered, not edge-triggered.
   */
  router.get("/session", async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = verifySessionCookie(cookies[SESSION_COOKIE_NAME]);
    const tenant = sessionId ? await resolveSession(pool, sessionId) : undefined;
    if (!tenant) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.json({
      agentSymbol: tenant.agentSymbol,
      onboardingPending: await needsOnboarding(pool, tenant.id),
    });
  });

  router.post("/logout", async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = verifySessionCookie(cookies[SESSION_COOKIE_NAME]);
    if (sessionId) await deleteSession(pool, sessionId);
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });

  return router;
}
