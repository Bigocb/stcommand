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
/** Log line prefix every /mcp request emits — the *only* current visibility
 *  into whether a call is reaching the server at all. Render's request-type
 *  logs aren't captured for this service (confirmed absent even for
 *  ordinary dashboard POSTs earlier the same session), and this handler
 *  previously only logged on an unexpected internal error — a rejected or
 *  silently-dropped connection attempt left no trace anywhere. Deliberately
 *  logs the *shape* of what arrived (method, whether an Authorization
 *  header is present, its length, first/last few chars) never the raw key
 *  itself. */
function logAttempt(req: { method: string; header(name: string): string | undefined }, outcome: string): void {
  const header = (req.header("authorization") ?? "").trim();
  const shape = header ? `present, len=${header.length}, "${header.slice(0, 10)}…${header.slice(-4)}"` : "absent";
  console.log(`[mcp-auth] ${req.method} authorization=${shape} -> ${outcome}`);
}

export function createMcpAuth(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    const header = (req.header("authorization") ?? "").trim();
    if (!header) {
      logAttempt(req, "401 missing header");
      res.status(401).json({ error: "missing Authorization header — send either \"Bearer <key>\" or the bare key" });
      return;
    }
    // Accept a bare key, not just "Bearer <key>" — confirmed live: a
    // config that stores just the raw key in an env var and interpolates
    // it straight into the header (Authorization:${VAR}, no literal
    // "Bearer " anywhere in the template) is a natural, easy-to-hit shape,
    // not a malformed request. sctk_-prefixed keys are only ever this
    // app's own MCP keys, never ambiguous with another auth scheme, so
    // there's nothing lost by accepting them unprefixed too.
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(header);
    const rawKey = bearerMatch ? bearerMatch[1]!.trim() : header;
    const resolved = await resolveMcpKey(pool, rawKey);
    if (!resolved) {
      logAttempt(req, "401 key not found/revoked");
      res.status(401).json({ error: "invalid or revoked MCP key" });
      return;
    }
    logAttempt(req, `200 tenant=${resolved.tenantId}`);
    req.tenantId = resolved.tenantId;
    req.agentSymbol = resolved.agentSymbol;
    next();
  };
}
