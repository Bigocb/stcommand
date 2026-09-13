import { Router } from "express";
import type pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { listAllTenantsAdmin, deleteTenant, setTenantPlayProfile, createSession } from "../db/tenants.js";
import type { TenantRegistry } from "../engine/tenantRegistry.js";
import type { GalaxyCrawler } from "../engine/galaxyCrawler.js";
import { Store } from "../db/store.js";
import { signSessionCookie } from "../auth/crypto.js";
import { SESSION_COOKIE_NAME } from "./session.js";
import { cookieOpts } from "./gate.js";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { classifySystem, ARCHETYPE_LABELS, DOCTRINE_TEMPLATES, type SystemAttributes } from "../engine/systemClassifier.js";

/** The home-system attributes both the checkpoint tool and the template
 *  endpoints below read — one place computing it from GalaxyAtlas so the
 *  two never drift into disagreeing about what a given system looks like. */
function homeSystemAttributes(worker: TenantWorker): { symbol: string; attrs: SystemAttributes; waypointCount: number } {
  const symbol = worker.fleet.getSystemSymbol();
  const known = worker.fleet.getGalaxy().getSystem(symbol);
  const waypoints = known?.waypoints ?? [];
  return {
    symbol,
    waypointCount: waypoints.length,
    attrs: {
      marketCount: waypoints.filter((w) => w.traits?.some((t) => t.symbol === "MARKETPLACE")).length,
      shipyardCount: waypoints.filter((w) => w.traits?.some((t) => t.symbol === "SHIPYARD")).length,
      jumpGateCount: waypoints.filter((w) => w.type === "JUMP_GATE").length,
      connectedSystemCount: worker.fleet.getGalaxy().connectedSystems(symbol).length,
    },
  };
}

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
export function createAdminRouter(pool: pg.Pool, registry: TenantRegistry, galaxyCrawler: GalaxyCrawler): Router {
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
        tenants: tenants.map((t) => ({
          ...t,
          running: registry.isBooted(t.id),
          // The existing per-request reactive check (client.ts's
          // TOKEN_RESET_MISMATCH handling) already knows the instant any
          // live call fails with "reset_date does not match" — surfacing
          // it here turns that into a visible admin-page signal instead of
          // something only noticed by reading the app logs after the fact.
          deadTokenReason: registry.get(t.id)?.api.deadTokenReason(),
        })),
      });
    } catch (err) {
      console.error("[admin] list tenants error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Play-style tracking (docs/TODO.md): a free-text label for what this
   * tenant's fleet is actually being run as — "baseline" vs "manual
   * override" vs whatever the operator wants — set here and shown per row
   * in the tenant list above. Purely descriptive; nothing in the engine
   * reads it.
   */
  router.patch("/tenants/:id/profile", async (req, res) => {
    const { profile } = req.body ?? {};
    if (profile !== null && typeof profile !== "string") {
      return res.status(400).json({ error: "profile must be a string or null" });
    }
    try {
      await setTenantPlayProfile(pool, req.params.id, profile);
      res.json({ ok: true, tenantId: req.params.id, profile });
    } catch (err) {
      console.error("[admin] set profile error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The operator's own logged interventions (role changes, manual buys —
  // see src/http/dashboard.ts's POST /fleet/role and POST /fleet/buy) plus
  // any manual checkpoint notes, newest first.
  router.get("/tenants/:id/actions", async (req, res) => {
    try {
      const store = new Store(pool);
      const actions = await store.listOperatorActions(req.params.id, 200);
      res.json({ actions });
    } catch (err) {
      console.error("[admin] list operator actions error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * A manual checkpoint note — "here's what I just did/changed and why,"
   * for a moment the operator wants on the record as a play-style data
   * point (e.g. "overrode automation: command ship → tour, approved two
   * miners, bought and converted a third to trader"). If this tenant is
   * currently booted in this process, the fleet's live role counts,
   * credits, and the home system's own topology (market/shipyard/gate
   * counts, connected systems) are captured into `meta` alongside the
   * operator's own text.
   *
   * The system attributes matter because a strategy is not evaluated in a
   * vacuum: two tenants started in systems with a different number of
   * markets/shipyards/gate connections aren't a fair strategy-vs-strategy
   * comparison without knowing that — see docs/TODO.md's play-style
   * tracking notes. Free for the operator, since this data is already
   * sitting in GalaxyAtlas (the same source the cartography page and
   * desktop galaxy overview read); no need to type it out by hand.
   */
  router.post("/tenants/:id/checkpoint", async (req, res) => {
    const { detail } = req.body ?? {};
    if (typeof detail !== "string" || !detail.trim()) {
      return res.status(400).json({ error: "detail (a string) is required" });
    }
    try {
      const worker = registry.get(req.params.id);
      let meta: Record<string, unknown> | undefined;
      if (worker) {
        const roleCounts: Record<string, number> = {};
        for (const s of worker.fleet.fleetStatusSummary()) roleCounts[s.role] = (roleCounts[s.role] ?? 0) + 1;
        const { symbol, attrs, waypointCount } = homeSystemAttributes(worker);
        const system = {
          symbol,
          waypointCount,
          ...attrs,
          connectedSystems: worker.fleet.getGalaxy().connectedSystems(symbol),
          archetype: classifySystem(attrs),
        };
        meta = { credits: worker.state.get()?.agent?.credits ?? null, roleCounts, shipCount: worker.fleet.fleetStatusSummary().length, system };
      }
      const store = new Store(pool);
      await store.recordOperatorAction(req.params.id, "checkpoint", undefined, detail.trim(), meta);
      res.json({ ok: true, tenantId: req.params.id, meta: meta ?? null });
    } catch (err) {
      console.error("[admin] checkpoint error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Classify this tenant's home system and return the starter doctrine
   * template that goes with it — a read-only preview, never applies
   * anything itself (see POST .../apply-template below for that). Requires
   * the tenant booted in this process, same as the checkpoint's system
   * snapshot — a not-currently-running tenant has no galaxy data to read.
   */
  router.get("/tenants/:id/system-template", async (req, res) => {
    const worker = registry.get(req.params.id);
    if (!worker) return res.status(503).json({ error: "tenant not booted in this process" });
    const { symbol, attrs, waypointCount } = homeSystemAttributes(worker);
    const archetype = classifySystem(attrs);
    res.json({
      system: { symbol, waypointCount, ...attrs },
      archetype,
      label: ARCHETYPE_LABELS[archetype],
      template: DOCTRINE_TEMPLATES[archetype],
    });
  });

  /**
   * Apply the starter template for this tenant's *current* home system —
   * re-classified fresh here rather than trusting an archetype the client
   * sent, so this can never apply a template for a system the tenant isn't
   * actually in anymore. Each entry goes through setAdopted() before
   * set() so a not-yet-adopted rule (e.g. exploringEnabled, off the
   * catalog's own opt-in default) actually takes effect, not just sits in
   * the cache unread — see Doctrine.value()'s isAdopted() gate. This is a
   * suggestion the operator asked to apply, same weight as any other
   * doctrine edit from the dashboard's own Doctrine tab; nothing here runs
   * on its own.
   */
  router.post("/tenants/:id/apply-template", async (req, res) => {
    const worker = registry.get(req.params.id);
    if (!worker) return res.status(503).json({ error: "tenant not booted in this process" });
    try {
      const { attrs } = homeSystemAttributes(worker);
      const archetype = classifySystem(attrs);
      const template = DOCTRINE_TEMPLATES[archetype];
      for (const entry of template) {
        await worker.fleet.doctrine.setAdopted(entry.key, true);
        await worker.fleet.doctrine.set(entry.key, { value: entry.value, enabled: entry.enabled });
      }
      res.json({ ok: true, archetype, label: ARCHETYPE_LABELS[archetype], applied: template });
    } catch (err) {
      console.error("[admin] apply-template error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * "View as": drop the operator straight into a tenant's own dashboard/
   * Tower session without logging out of whichever tenant's browser tab
   * they're already in and re-entering that tenant's SpaceTraders token —
   * the whole reason multi-tenant management kept meaning a log-out/log-in
   * dance. Mints a session exactly the way gate.ts's own /login does
   * (createSession() + the same signed cookie, same cookieOpts) but
   * without verifying any token — the ADMIN_KEY this route already sits
   * behind IS the authorization; this is deliberately admin-issuing-a-
   * session-for-someone-else, not a new kind of login. Only reachable by
   * whoever holds ADMIN_KEY (today: the one operator running this whole
   * server), same trust boundary reset-cleanup and tenant-delete already
   * sit behind.
   */
  router.post("/tenants/:id/impersonate", async (req, res) => {
    try {
      const tenants = await listAllTenantsAdmin(pool);
      const tenant = tenants.find((t) => t.id === req.params.id);
      if (!tenant) {
        res.status(404).json({ error: "tenant not found" });
        return;
      }
      const sessionId = await createSession(pool, tenant.id);
      res.cookie(SESSION_COOKIE_NAME, signSessionCookie(sessionId), cookieOpts);
      res.json({ ok: true, agentSymbol: tenant.agentSymbol });
    } catch (err) {
      console.error("[admin] impersonate error", err);
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

  /**
   * The operator-facing trigger for cleaning up after a SpaceTraders
   * universe reset (weekly, per the game's own status endpoint —
   * `serverResets.frequency`/`next`). A reset invalidates every existing
   * agent token account-wide; every tenant still on an old token starts
   * failing every live call with "reset_date does not match" (surfaced
   * per-tenant on GET /tenants above). Re-registering under a fresh token
   * (the existing sign-in flow) gets a tenant flying again, but every
   * *shared* galaxy table (jump gates, market prices, shipyard stock,
   * system layout — see Store.truncateSharedGalaxyTables()'s own comment)
   * and every *stale* tenant table (old ships, contracts, missions,
   * financial history — see Store.wipeTenantGameData()'s own comment)
   * still describes a universe that no longer exists until this runs.
   *
   * `keepTenantIds` lets an already-re-registered tenant (a fresh
   * agent/token, already flying in the new universe) opt out of having
   * its own brand-new data wiped right back out — everyone else named in
   * the tenant list gets cleared. The shared galaxy tables are always
   * truncated regardless: they have no "already fresh" state to protect,
   * since nothing in this app has scanned the new universe yet either way.
   */
  router.post("/reset-cleanup", async (req, res) => {
    const keepTenantIds: string[] = Array.isArray(req.body?.keepTenantIds)
      ? req.body.keepTenantIds.filter((x: unknown) => typeof x === "string")
      : [];
    try {
      const store = new Store(pool);
      const tenants = await listAllTenantsAdmin(pool);
      const wiped: string[] = [];
      for (const t of tenants) {
        if (keepTenantIds.includes(t.id)) continue;
        // Same reasoning as tenant deletion: stop the in-memory worker
        // first, so it isn't still running against ships/state that are
        // about to disappear underneath it until this process next
        // restarts. It reboots fresh (from whatever token that tenant
        // next signs in with) the next time its session hits the API.
        registry.stopOne(t.id);
        await store.wipeTenantGameData(t.id);
        wiped.push(t.id);
      }
      await store.truncateSharedGalaxyTables();
      galaxyCrawler.resetCrawlState();
      res.json({ ok: true, tenantsWiped: wiped, tenantsKept: keepTenantIds });
    } catch (err) {
      console.error("[admin] reset cleanup error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Quick progress check for the galaxy-wide crawl (galaxyCrawler.ts) —
  // public reference data, not tenant-scoped, so this lives here rather
  // than behind a tenant session.
  router.get("/galaxy/status", async (_req, res) => {
    try {
      const store = new Store(pool);
      const [systemsCrawled, factions] = await Promise.all([
        store.countGalaxySystems(),
        store.listGalaxyFactions(),
      ]);
      res.json({ systemsCrawled, factions });
    } catch (err) {
      console.error("[admin] galaxy status error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
