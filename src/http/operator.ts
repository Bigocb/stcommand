import { Router } from "express";
import type pg from "pg";
import type { TenantRegistry } from "../engine/tenantRegistry.js";
import type { GalaxyCrawler } from "../engine/galaxyCrawler.js";
import { createResolveTenant } from "./resolveTenant.js";
import { createAdminRoutes } from "./admin.js";
import { requireOperator } from "./operatorFlag.js";

/**
 * The admin surface behind the normal tenant session plus the operator flag —
 * what Deck's Admin screens call (`/api/operator/*`). Deliberately resolved
 * with its own resolveTenant and mounted ahead of the `/api` engine-boot
 * middleware, so the admin screens still work when a tenant's engine is down
 * (the very moment they are needed, e.g. right after a server reset).
 * Same handlers as the key-protected /api/admin; only the auth differs.
 */
export function createOperatorRouter(pool: pg.Pool, registry: TenantRegistry, galaxyCrawler: GalaxyCrawler): Router {
  const router = Router();
  router.use(createResolveTenant(pool), requireOperator);
  router.use(createAdminRoutes(pool, registry, galaxyCrawler));
  return router;
}
