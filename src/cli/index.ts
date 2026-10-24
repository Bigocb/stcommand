import "dotenv/config";
import { logBuffer } from "../core/logBuffer.js";
import { INSTANCE_ID } from "../core/rateLimitMonitor.js";
import { waitForPredecessor } from "../core/instanceGate.js";
import express from "express";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { Store } from "../db/store.js";
import { createGateRouter } from "../http/gate.js";
import { gzipJson } from "../http/gzipJson.js";
import { createPushRouter } from "../http/push.js";
import { createResolveTenant } from "../http/resolveTenant.js";
import { createDashboardRouter } from "../http/dashboard.js";
import { createOpeningTasksRouter } from "../http/openingTasks.js";
import { createUiVersionRouter, cacheHeaders, assetStamp, serveHtml } from "../http/uiVersions.js";
import { createAdminRouter } from "../http/admin.js";
import { createOperatorRouter } from "../http/operator.js";
import { createCartographyRouter } from "../http/cartography.js";
import { createMcpAuth } from "../http/mcpAuth.js";
import { createMcpRouter } from "../mcp/server.js";
import { TenantRegistry } from "../engine/tenantRegistry.js";
import { GalaxyCrawler } from "../engine/galaxyCrawler.js";
import { AgentWatcher } from "../engine/agentWatcher.js";
import { createResetWatcher } from "../engine/resetWatcherLive.js";
import { startRunTimeline } from "../engine/runTimeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../../public");

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Server-wide lines (the galaxy crawler's) also go to the ops `logs` buffer, under tenant "?" which every tenant's query includes. */
function logGlobal(msg: string): void {
  logBuffer.push("?", msg);
  log(msg);
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

  const registry = new TenantRegistry(pool, (tenantId, msg) => {
    logBuffer.push(tenantId, msg); // ops `logs` tool — src/core/logBuffer.ts
    log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`);
  });

  // Eager-boot every known tenant now, rather than leaving each one idle
  // until its first authenticated request arrives post-restart — see
  // TenantRegistry.bootAll()'s doc comment and docs/adr/0009. Fire-and-forget
  // and never awaited: booting N tenants can take a while (each does a real
  // SpaceTraders API round-trip), and the gate/login routes must be servable
  // immediately, not held up behind it.
  // Fleets wait for the instance this deploy replaces to stop — see src/core/instanceGate.ts.
  const bootedAt = new Date();
  const gateStore = new Store(pool);
  registry.setBootGate(waitForPredecessor({ others: (sec) => gateStore.otherLiveInstances(INSTANCE_ID, sec), bootedAt, log }));
  registry.bootAll().catch((err) => log(`eager tenant boot failed: ${err instanceof Error ? err.message : String(err)}`));

  // Galaxy-wide crawl (system coordinates/types, faction roster, and an
  // opportunistic jump-gate connection sweep) — public data, not owned by
  // any one tenant, and no longer even routed through a tenant's own API
  // client: every endpoint it calls is public (see GalaxyCrawler's own doc
  // comment), so it runs on plain fetch() independent of tenant boot state
  // and doesn't compete with any tenant's rate limiter. Deliberately slow
  // (one call per tick) rather than racing to finish.
  const galaxyCrawler = new GalaxyCrawler(new Store(pool), (msg) => logGlobal(msg));
  const galaxyCrawlInterval = setInterval(() => {
    galaxyCrawler.tick().catch((err) => log(`galaxy crawl tick failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 5_000);
  galaxyCrawlInterval.unref?.();

  // Who registered when, and how fast start-system gates get built (docs/agent-watch.md). Public reads only, about 10 requests
  // every 15 minutes; AGENT_WATCH=off turns it off. It also copies the reset's hourly agent snapshots into tables the weekly
  // cleanup leaves alone.
  if ((process.env.AGENT_WATCH ?? "on").toLowerCase() !== "off") {
    const agentWatcher = new AgentWatcher(new Store(pool), (msg) => logGlobal(msg));
    const agentWatchInterval = setInterval(() => { agentWatcher.tick().catch(() => {}); }, 60_000);
    agentWatchInterval.unref?.();
    agentWatcher.tick().catch(() => {});
  }

  // Recovers the fleet after the weekly server reset without the operator: see
  // src/engine/resetWatcher.ts. Needs ST_ACCOUNT_TOKEN to register new agents;
  // AUTO_RESET_RECOVERY=off makes it detect-and-report only.
  createResetWatcher(pool, registry, galaxyCrawler, log).start();

  // Cash/fleet sample every 15 min into run_timeline, for the weekly curve.
  startRunTimeline(registry, log);

  // Heartbeat so any instance can tell whether another one is alive at the
  // same time (deploy overlap — the usual 429-storm cause). See migration 034.
  const heartbeatStore = new Store(pool);
  const beat = () => heartbeatStore.touchInstance(INSTANCE_ID, bootedAt).catch(() => {});
  void beat();
  const heartbeatInterval = setInterval(beat, 10_000);
  heartbeatInterval.unref?.();

  const app = express();
  app.use(express.json());
  // JSON responses are gzipped when the browser accepts it (src/http/gzipJson.ts).
  app.use("/api", gzipJson());

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

  // Public galaxy map data — not scoped to any tenant, same reasoning as
  // GalaxyCrawler itself (see its doc comment), so mounted ahead of
  // resolveTenant like /api/gate and /api/admin.
  app.use("/api/cartography", createCartographyRouter(new Store(pool), galaxyCrawler));

  // Its own key-based auth (see admin.ts), not the tenant session-cookie
  // flow below — mounted first so /api/admin/* never falls through to
  // resolveTenant, which would demand a tenant session for a request that
  // isn't scoped to any one tenant at all.
  app.use("/api/admin", createAdminRouter(pool, registry, galaxyCrawler));
  // The same admin handlers behind the normal session + OPERATOR_AGENTS flag
  // (Deck's Admin screens). Ahead of the /api engine-boot middleware on purpose.
  app.use("/api/operator", createOperatorRouter(pool, registry, galaxyCrawler));
  if (!process.env.ADMIN_KEY) log("ADMIN_KEY is not set — /admin is disabled (every /api/admin/* request 503s)");

  // The hosted MCP server (docs/mcp-server-plan.md): its own per-tenant
  // Bearer-key auth, not the session-cookie flow — mounted ahead of
  // resolveTenant for the same reason /api/admin and /api/cartography are.
  app.use("/mcp", createMcpAuth(pool), createMcpRouter(registry));

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

  app.use("/api", createDashboardRouter(registry, pool, galaxyCrawler));
  // Mounted after the tenant resolver above, so the tenant always comes from the session.
  app.use("/api", createOpeningTasksRouter(registry));
  app.use("/api", createPushRouter(registry));

  // Serve every HTML page with versioned asset URLs: a deploy changes the
  // `?v=` on each local .js/.css, so a CDN that ignores the origin's no-cache
  // (Cloudflare's default 4h Browser Cache TTL) can't pin a browser to
  // superseded modules. Placed before the UI-version router and the static
  // middleware so it covers `/`, `/v5`, `/v6`, `/m`, `/deck`, `/admin`,
  // `/cartography`, `/guide`, and any direct `*.html`.
  const STAMP = assetStamp(PUBLIC_DIR);
  const HTML_PAGES = new Set(["m", "deck", "admin", "cartography", "guide"]);
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const path = req.path.replace(/\/+$/, "") || "/";
    let file: string | null = null;
    if (path === "/") {
      file = resolve(PUBLIC_DIR, "deck.html");
    } else {
      const name = path.slice(1);
      if (HTML_PAGES.has(name)) file = resolve(PUBLIC_DIR, `${name}.html`);
      else if (/^[a-z0-9_-]+\.html$/i.test(name)) file = resolve(PUBLIC_DIR, name);
    }
    if (!file || !existsSync(file)) return next();
    serveHtml(res, file, STAMP);
  });

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

  // Public galaxy-crawl viewer — no key, no tenant session, same free-
  // standing pattern as /admin's dedicated route.
  // Build label for the UIs: the commit this process was built from (Render sets RENDER_GIT_COMMIT), so each
  // screen can show which version it is. Public and uncached; it reveals only a commit id.
  const BUILD = (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || "local";
  app.get("/version.json", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ build: BUILD });
  });

  app.get("/cartography", (_req, res) => {
    res.set(cacheHeaders(resolve(PUBLIC_DIR, "cartography.html")) ?? {});
    res.sendFile(resolve(PUBLIC_DIR, "cartography.html"));
  });

  // Player guide: a static page, no key or session, linked from the sign-in screens and headers.
  app.get("/guide", (_req, res) => {
    res.set(cacheHeaders(resolve(PUBLIC_DIR, "guide.html")) ?? {});
    res.sendFile(resolve(PUBLIC_DIR, "guide.html"));
  });

  // Tower: the mobile app, docs/mobile-app-design.md. A genuinely separate
  // build from the desktop UI versions above (own shell, own manifest, own
  // visual identity) rather than another entry in that family, so it gets
  // its own free-standing route the same way /admin and /cartography do —
  // reachable at /m whether a mobile visitor was redirected there
  // (shared/mobileRedirect.js, wired into v6.html's <head>) or it was
  // opened directly.
  app.get("/m", (_req, res) => {
    res.set(cacheHeaders(resolve(PUBLIC_DIR, "m.html")) ?? {});
    res.sendFile(resolve(PUBLIC_DIR, "m.html"));
  });

  // iOS and some browsers ask for these root paths whatever the page says (an install whose <link> fetch failed, a
  // bookmark, a tab icon). With no answer they showed a plain letter tile for Tower, and Cloudflare kept the 404 for
  // hours. Answer with Tower's own icons; Deck keeps its own <link>s.
  const towerRootIcon = (file: string) => (_req: express.Request, res: express.Response) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(resolve(PUBLIC_DIR, "icons", file));
  };
  for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-180x180.png"]) app.get(path, towerRootIcon("tower-apple-touch-icon.png"));
  app.get("/favicon.ico", towerRootIcon("tower-favicon-32.png"));

  // Deck: the desktop redesign, docs/deck-desktop-design.md. Same pattern as
  // Tower — its own route, shell, manifest, and visual identity.
  app.get("/deck", (_req, res) => {
    res.set(cacheHeaders(resolve(PUBLIC_DIR, "deck.html")) ?? {});
    res.sendFile(resolve(PUBLIC_DIR, "deck.html"));
  });

  app.use(express.static(PUBLIC_DIR, {
    index: "deck.html",
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
    // An open connection (a dashboard stream, an MCP session) can keep server.close() waiting for a
    // long time; the instance has nothing left worth waiting for, so don't linger past a few seconds.
    setTimeout(() => process.exit(0), 5_000).unref();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// A stray rejected promise (a fire-and-forget DB write for a tenant that was just
// deleted, a late API callback) must not take every tenant's fleet down with it —
// that's exactly what happened on 2026-10-06. Log loudly with the stack and carry
// on; a genuinely uncaught *exception* still means undefined state, so exit and
// let Render restart the instance.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection (not exiting):", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException — exiting:", err.stack ?? err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
