import type { RequestHandler } from "express";
import type pg from "pg";
import { parseCookies } from "./cookies.js";
import { verifySessionCookie } from "../auth/crypto.js";
import { resolveSession, touchTenant } from "../db/tenants.js";
import { SESSION_COOKIE_NAME } from "./session.js";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      agentSymbol?: string;
    }
  }
}

/**
 * Gate every route behind it on a resolved tenant, per
 * docs/architecture-plan.md §4 step 5: read the signed session cookie, look
 * up the session (and, transitively, the tenant it belongs to), and attach
 * `req.tenantId`/`req.agentSymbol` for the route to use. 401s on anything
 * that doesn't resolve to a live session — missing cookie, forged/tampered
 * signature, or an id that's expired or was never issued.
 *
 * This does not itself run `SET LOCAL app.tenant_id` on a connection — that
 * happens per Store call inside `withTenant` (src/db/pool.ts), not once per
 * HTTP request against some request-pinned connection, since the pool hands
 * out a fresh connection per query rather than one per request. This
 * middleware's job ends at "which tenant is this," and every downstream
 * Store/FleetManager call is handed `req.tenantId` explicitly.
 */
export function createResolveTenant(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = verifySessionCookie(cookies[SESSION_COOKIE_NAME]);
    if (!sessionId) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    const tenant = await resolveSession(pool, sessionId);
    if (!tenant) {
      res.status(401).json({ error: "session expired or invalid" });
      return;
    }
    req.tenantId = tenant.id;
    req.agentSymbol = tenant.agentSymbol;
    try {
      await touchTenant(pool, tenant.id);
    } catch {
      // Best-effort bookkeeping (last_seen_at) — a failed touch must never
      // fail the request it's riding along with.
    }
    next();
  };
}
