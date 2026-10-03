import { Router, type Request } from "express";
import * as z from "zod";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { OPS_BY_NAME, OPS_TOOLS } from "../ops/catalog.js";

/**
 * HTTP door onto the ops catalog (docs/ops-layer-design.md): `GET /api/ops`
 * lists the tools, `GET /api/ops/:name?…` runs one with query-string args.
 * Read-only; mounted inside the dashboard router so it sits behind the same
 * session auth and tenant resolution as every other /api route.
 */
export function createOpsRouter(worker: (req: Request) => TenantWorker | undefined): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      tools: OPS_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, args: Object.keys(t.input) })),
    });
  });

  router.get("/:name", async (req, res) => {
    const tool = OPS_BY_NAME.get(String(req.params.name));
    if (!tool) return res.status(404).json({ error: `no ops tool "${req.params.name}"` });
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const parsed = z.object(tool.input).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    try {
      res.json(await tool.run({ w, now: Date.now }, parsed.data));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
