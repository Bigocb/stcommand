import { Router } from "express";
import type pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { listAllTenantsAdmin, deleteTenant } from "../db/tenants.js";
import type { TenantRegistry } from "../engine/tenantRegistry.js";

/**
 * A small operator-only surface, separate from the tenant dashboard: list
 * every tenant on this server and delete one outright. Not linked from the
 * switcher or any tenant-facing page — reachable only by knowing the URL
 * (`/admin`) and the key.
 *
 * Deliberately its own auth, not the session-cookie flow gate.ts/
 * resolveTenant.ts use: a session proves "this request is tenant X," which
 * is the wrong shape for "this request is allowed to see/delete every
 * tenant." One shared secret (`ADMIN_KEY`), sent as the `x-admin-key`
 * header on every request, checked in constant time so a timing side
 * channel can't shorten a brute-force guess. If `ADMIN_KEY` isn't set in
 * the environment at all, every route here 503s rather than silently
 * having no password — an unconfigured secret must fail closed, not open.
 */
export function createAdminRouter(pool: pg.Pool, registry: TenantRegistry): Router {
  const router = Router();

  router.use((req, res, next) => {
    const configured = process.env.ADMIN_KEY;
    if (!configured) {
      res.status(503).json({ error: "admin access is not configured (ADMIN_KEY unset)" });
      return;
    }
    const given = req.header("x-admin-key") ?? "";
    // Both sides must be the same length for timingSafeEqual to avoid
    // throwing — a length mismatch is itself just "wrong key," not a
    // separate error case worth its own response.
    const a = Buffer.from(given);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: "invalid admin key" });
      return;
    }
    next();
  });

  router.get("/tenants", async (_req, res) => {
    try {
      const tenants = await listAllTenantsAdmin(pool);
      res.json({
        tenants: tenants.map((t) => ({ ...t, running: registry.isBooted(t.id) })),
      });
    } catch (err) {
      console.error("[admin] list tenants error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/tenants/:id", async (req, res) => {
    const tenantId = req.params.id;
    try {
      // Stop the in-memory worker first (if this process has one booted) —
      // otherwise its fleet loop keeps running against an agent whose row
      // is about to disappear, still making live SpaceTraders calls for an
      // account the operator just asked to delete, until the process next
      // restarts. See TenantRegistry.stopOne()'s own comment.
      registry.stopOne(tenantId);
      const deleted = await deleteTenant(pool, tenantId);
      if (!deleted) {
        res.status(404).json({ error: "tenant not found" });
        return;
      }
      res.json({ ok: true, tenantId });
    } catch (err) {
      console.error("[admin] delete tenant error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
