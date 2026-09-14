import { Router } from "express";
import type { Store } from "../db/store.js";
import type { GalaxyCrawler } from "../engine/galaxyCrawler.js";

/**
 * Public, no-login galaxy map data: whatever GalaxyCrawler.js has recorded
 * from the galaxy-wide public /systems and /factions endpoints, plus its
 * own crawl progress and a scrolling activity log. Deliberately not scoped
 * to any tenant — same public-reference-data reasoning as GalaxyCrawler
 * itself (see its doc comment) — so this is mounted in cli/index.ts ahead
 * of resolveTenant, the same way /api/gate and /api/admin are.
 */
export function createCartographyRouter(store: Store, crawler: GalaxyCrawler): Router {
  const router = Router();

  router.get("/systems", async (_req, res) => {
    const systems = await store.listGalaxySystemPositions();
    res.json({ systems });
  });

  // Per-system detail for the map's click-a-dot side panel — deliberately
  // a separate call from the bulk /systems list above, since most viewers
  // never click a dot and the full waypoint-type breakdown/gate list isn't
  // needed for the scatter of dots itself.
  router.get("/systems/:symbol", async (req, res) => {
    const detail = await store.getGalaxySystemDetail(req.params.symbol.toUpperCase());
    if (!detail) {
      res.status(404).json({ error: "system not recorded" });
      return;
    }
    res.json(detail);
  });

  router.get("/factions", async (_req, res) => {
    const factions = await store.listGalaxyFactions();
    res.json({ factions });
  });

  router.get("/connections", async (_req, res) => {
    const connections = await store.listGalaxyJumpConnections();
    res.json({ connections });
  });

  router.get("/progress", async (_req, res) => {
    const progress = await crawler.progress();
    res.json(progress);
  });

  router.get("/activity", (_req, res) => {
    res.json({ activity: crawler.recentActivity() });
  });

  return router;
}
