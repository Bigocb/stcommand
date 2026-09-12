import "dotenv/config";
import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { Store } from "../db/store.js";
import { createGateRouter } from "../http/gate.js";
import { createResolveTenant } from "../http/resolveTenant.js";
import { createDashboardRouter } from "../http/dashboard.js";
import { createUiVersionRouter, cacheHeaders } from "../http/uiVersions.js";
import { createAdminRouter } from "../http/admin.js";
import { TenantRegistry } from "../engine/tenantRegistry.js";
import { GalaxyCrawler } from "../engine/galaxyCrawler.js";

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
 * chat endpoint — and serves the command-center frontend (public/v6.html,
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

  // Apply any migration that hasn't run yet before anything else touches
  // the pool — this used to be a separate manual/deploy-pipeline step
  // (`npm run migrate`), and confirmed live: a deploy can land with a new
  // migration file that nothing ever actually ran, silently, until
  // whatever code depends on its tables starts erroring on every call.
  // Every migration in this repo is itself idempotent, so running this on
  // every boot (not just once) is safe and cheap once caught up.
  await runMigrations(pool);

  const registry = new TenantRegistry(pool, (tenantId, msg) => log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`));

  // Eager-boot every known tenant now, rather than leaving each one idle
  // until its first authenticated request arrives post-restart — see
  // TenantRegistry.bootAll()'s doc comment and docs/adr/0009. Fire-and-forget
  // and never awaited: booting N tenants can take a while (each does a real
  // SpaceTraders API round-trip), and the gate/login routes must be servable
  // immediately, not held up behind it.
  registry.bootAll().catch((err) => log(`eager tenant boot failed: ${err instanceof Error ? err.message : String(err)}`));

  // Galaxy-wide crawl (system coordinates/types, faction roster) — public
  // data, not owned by any one tenant, so it rides whichever tenant's API
  // client happens to be booted rather than needing its own. Deliberately
  // slow (one page every 5s) since it shares the same process-wide rate
  // limiter every tenant's own ticking already competes for — see
  // GalaxyCrawler's own doc comment.
  const galaxyCrawler = new GalaxyCrawler(() => registry.anyBootedApi(), new Store(pool), (msg) => log(msg));
  const galaxyCrawlInterval = setInterval(() => {
    galaxyCrawler.tick().catch((err) => log(`galaxy crawl tick failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 5_000);
  galaxyCrawlInterval.unref?.();

  const app = express();
  app.use(express.json());

  // Render's health check: mounted first, ahead of every other route, so it
  // answers even if something downstream (a tenant boot, the DB pool) is
  // unhealthy — a health check that shares fate with the thing it is
  // supposed to gate defeats the point of having one. Existence alone is
  // the signal Render needs: with this wired to Render's own health-check
  // path (see docs/TODO.md's entry on this), a new instance is only cut
  // over to once it actually answers requests, instead of the old instance
  // being torn down the moment the new one merely starts.
  app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("ok"));

  app.use("/api/gate", createGateRouter(pool));

  // Its own key-based auth (see admin.ts), not the tenant session-cookie
  // flow below — mounted first so /api/admin/* never falls through to
  // resolveTenant, which would demand a tenant session for a request that
  // isn't scoped to any one tenant at all.
  app.use("/api/admin", createAdminRouter(pool, registry));
  if (!process.env.ADMIN_KEY) log("ADMIN_KEY is not set — /admin is disabled (every /api/admin/* request 503s)");

  const resolveTenant = createResolveTenant(pool);
  const store = new Store(pool);
  app.use("/api", resolveTenant, async (req, res, next) => {
    try {
      await registry.getOrCreate(req.tenantId!, req.agentSymbol!);
      next();
    } catch (err) {
      log(`failed to boot tenant ${req.tenantId}: ${err instanceof Error ? err.message : String(err)}`);
      // A live boot failing (a SpaceTraders outage, a bad token) doesn't
      // have to mean every route 503s: if there's a durable copy of this
      // tenant's last-successful /api/state, attach it and let the request
      // through — only that one read-only route actually uses it (see
      // dashboard.ts), everything else still sees no worker and 503s
      // exactly as before. A snapshot lookup failing here must never mask
      // the real boot error, so it's soft-failed too.
      try {
        req.staleSnapshot = req.tenantId ? await store.getStateSnapshot(req.tenantId) : undefined;
      } catch { /* fall through to the 503 below */ }
      if (req.staleSnapshot) return next();
      res.status(503).json({ error: "engine failed to start; try again shortly" });
    }
  });

  app.use("/api", createDashboardRouter(registry, pool));

  // Before express.static so /v5 resolves, and so a version that is
  // planned but not yet built answers with something actionable rather than
  // a bare 404. `/` now serves v6 (the 3D map) — the deliberate successor
  // chosen once its map/hull work landed; v2/v3/v4 are retired (still on
  // disk, no longer routed or offered by the switcher).
  app.use(createUiVersionRouter(PUBLIC_DIR));

  // Not part of the version-switcher family (createUiVersionRouter) or
  // listed in it — reachable only by knowing this exact path. The page
  // itself prompts for the admin key and sends it as a header on every
  // /api/admin/* call; nothing here needs the key server-side, since
  // admin.ts's router is what actually checks it.
  app.get("/admin", (_req, res) => {
    res.set(cacheHeaders(resolve(PUBLIC_DIR, "admin.html")) ?? {});
    res.sendFile(resolve(PUBLIC_DIR, "admin.html"));
  });

  app.use(express.static(PUBLIC_DIR, {
    index: "v6.html",
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
