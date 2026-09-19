import type { RequestHandler } from "express";
import type pg from "pg";
import { resolveMcpKey } from "../db/mcpKeys.js";

/**
 * Gate `/mcp` on a per-tenant Bearer key — its own auth, not the
 * session-cookie flow `resolveTenant.ts` uses, same reasoning `admin.ts`
 * gives for its own key-based auth: a session cookie proves "this browser
 * is tenant X" and isn't a shape a programmatic MCP client can hold at
 * all. Mounted ahead of the cookie-based `resolveTenant` in
 * `cli/index.ts`, same position `/api/admin` and `/api/cartography`
 * already occupy, for the same reason: it must never fall through to a
 * middleware that demands a session cookie this caller doesn't have.
 *
 * Reuses `req.tenantId`/`req.agentSymbol` (declared once, globally, by
 * `resolveTenant.ts`) rather than inventing a second field name — every
 * downstream Store/FleetManager call already reads those two, regardless
 * of which auth path set them.
 */
export function createMcpAuth(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      res.status(401).json({ error: "missing or malformed Authorization: Bearer <key> header" });
      return;
    }
    const resolved = await resolveMcpKey(pool, match[1]!.trim());
    if (!resolved) {
      res.status(401).json({ error: "invalid or revoked MCP key" });
      return;
    }
    req.tenantId = resolved.tenantId;
    req.agentSymbol = resolved.agentSymbol;
    next();
  };
}
