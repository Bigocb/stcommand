import "dotenv/config";
import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../db/pool.js";
import { createGateRouter } from "../http/gate.js";
import { createResolveTenant } from "../http/resolveTenant.js";
import { createDashboardRouter } from "../http/dashboard.js";
import { createUiVersionRouter, cacheHeaders } from "../http/uiVersions.js";
import { TenantRegistry } from "../engine/tenantRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../../public");

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * The multi-tenant server boot sequence. Unlike straders' single-tenant CLI
 * (src/cli/index.ts there boots exactly one fleet against ST_TOKEN and runs
 * it for `maxTicks`), this process serves any number of tenants:
 * `registry.bootAll()` eager-boots every already-known tenant in the
 * background as soon as the pool is up (docs/adr/0009), and
 * `TenantRegistry.getOrCreate` in the `/api/*` middleware below still boots
 * a brand-new tenant lazily, on their first authenticated request, the
 * moment they register — then, per docs/architecture-plan.md §5, that
 * tenant's fleet keeps running for the life of the process regardless of
 * whether they have a request in flight.
 *
 * Wires the mechanics (gate, session resolution, per-tenant engine boot)
 * together with the full dashboard route surface (src/http/dashboard.ts) —
 * ship commands, warehouse controls, doctrine/dispatch/keeper tuning, the
 * chat endpoint — and serves the command-center frontend (public/v2.html,
 * a tenant-aware port of straders' own dashboard) as static files. Still
 * ahead: the LLM/Discord settings UI's own routes for reading back what's
 * currently configured. See README.md's status section.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("DATABASE_URL is not set — see .env.example");
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) {
    log("SESSION_SECRET is not set — see .env.example");
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  const registry = new TenantRegistry(pool, (tenantId, msg) => log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`));

  // Eager-boot every known tenant now, rather than leaving each one idle
  // until its first authenticated request arrives post-restart — see
  // TenantRegistry.bootAll()'s doc comment and docs/adr/0009. Fire-and-forget
  // and never awaited: booting N tenants can take a while (each does a real
  // SpaceTraders API round-trip), and the gate/login routes must be servable
  // immediately, not held up behind it.
  registry.bootAll().catch((err) => log(`eager tenant boot failed: ${err instanceof Error ? err.message : String(err)}`));

  const app = express();
  app.use(express.json());

  app.use("/api/gate", createGateRouter(pool));

  const resolveTenant = createResolveTenant(pool);
  app.use("/api", resolveTenant, async (req, res, next) => {
    try {
      await registry.getOrCreate(req.tenantId!, req.agentSymbol!);
      next();
    } catch (err) {
      log(`failed to boot tenant ${req.tenantId}: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({ error: "engine failed to start; try again shortly" });
    }
  });

  app.use("/api", createDashboardRouter(registry, pool));

  // Before express.static so /v3 /v4 /v5 resolve, and so a version that is
  // planned but not yet built answers with something actionable rather than
  // a bare 404. `/` stays v2 until a successor is chosen deliberately.
  app.use(createUiVersionRouter(PUBLIC_DIR));

  app.use(express.static(PUBLIC_DIR, {
    index: "v2.html",
    // See cacheHeaders(): HTML must not be cached or a browser pins itself
    // to superseded modules after a deploy; fonts and shared modules must
    // be, or every version re-downloads them on every load.
    setHeaders: (res, path) => {
      const headers = cacheHeaders(path);
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    },
  }));

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => log(`Standing Orders listening on :${port}`));

  const shutdown = () => {
    log(`shutting down (${registry.size()} tenant${registry.size() === 1 ? "" : "s"} running)`);
    registry.stopAll();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
