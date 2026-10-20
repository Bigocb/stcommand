import { Router } from "express";
import { validateTaskSpec, validateTemplateTasks } from "../engine/openingTasks.js";
import type { TenantRegistry, TenantWorker } from "../engine/tenantRegistry.js";

/**
 * Opening automation (migrations/055) — the task list and saved templates that
 * the `openingAutomation` doctrine clause executes.
 *
 * Mounted AFTER createResolveTenant, and the tenant always comes from the
 * session (`req.tenantId`), never from the URL. The routes still carry a
 * `:tenantId` segment because Deck's opening panel builds its paths that way;
 * it is checked against the session and a mismatch is a 403 rather than a
 * silent cross-tenant read.
 */
export function createOpeningTasksRouter(registry: TenantRegistry): Router {
  const router = Router();

  function worker(req: { tenantId?: string }): TenantWorker | undefined {
    return req.tenantId ? registry.get(req.tenantId) : undefined;
  }

  /** The session tenant, or a response explaining why this request cannot proceed. */
  function tenantFor(req: { tenantId?: string; params: unknown }, res: import("express").Response): string | null {
    const sessionTenant = req.tenantId;
    if (!sessionTenant) {
      res.status(401).json({ error: "not authenticated" });
      return null;
    }
    const raw = (req.params as { tenantId?: unknown } | undefined)?.tenantId;
    const asked = typeof raw === "string" ? raw : undefined;
    if (asked && asked !== sessionTenant) {
      res.status(403).json({ error: "tenant mismatch" });
      return null;
    }
    return sessionTenant;
  }

  router.get("/opening/tasks/:tenantId?", async (req, res) => {
    const tenantId = tenantFor(req, res);
    if (!tenantId) return;
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      res.json(await w.store.listOpeningTasks(tenantId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/opening/tasks/:tenantId?", async (req, res) => {
    const tenantId = tenantFor(req, res);
    if (!tenantId) return;
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const v = validateTaskSpec(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      await w.store.addOpeningTask(tenantId, v.value, "operator");
      await w.store.recordOperatorAction(tenantId, "opening_task_add", undefined, `queued opening task ${v.value.key}`, { key: v.value.key });
      res.status(201).json({ ok: true, key: v.value.key });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/opening/tasks/:tenantId?/:id/cancel", async (req, res) => {
    const tenantId = tenantFor(req, res);
    if (!tenantId) return;
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
    try {
      await w.store.cancelOpeningTask(tenantId, id);
      await w.store.recordOperatorAction(tenantId, "opening_task_cancel", undefined, `cancelled opening task #${id}`, { id });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/opening/templates/:tenantId?", async (req, res) => {
    const tenantId = tenantFor(req, res);
    if (!tenantId) return;
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      res.json(await w.store.listOpeningTemplates(tenantId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/opening/templates/:tenantId?", async (req, res) => {
    const tenantId = tenantFor(req, res);
    if (!tenantId) return;
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 80) return res.status(400).json({ error: "name must be 1-80 characters" });
    const v = validateTemplateTasks(req.body?.tasks);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      await w.store.saveOpeningTemplate(tenantId, name, v.value);
      await w.store.recordOperatorAction(tenantId, "opening_template_save", undefined, `saved opening template ${name}`, { name, tasks: v.value.length });
      res.status(201).json({ ok: true, name });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
