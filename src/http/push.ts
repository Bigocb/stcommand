import { Router } from "express";
import { CATEGORIES } from "../engine/notify/categories.js";
import { effectivePrefs, sanitizePrefs, sanitizeSubscription } from "../engine/notify/prefs.js";
import { vapidFromEnv } from "../engine/notify/transport.js";
import type { TenantRegistry, TenantWorker } from "../engine/tenantRegistry.js";

/**
 * Push notification settings for Tower (docs/notifications.md). Mounted after the tenant resolver: the tenant always comes
 * from the session, and a device can only read or change its own subscription (looked up by endpoint within that tenant).
 *
 *   GET  /push/config        is push on at the server, the public key, and the categories a device can choose from
 *   GET  /push/subscription  this device's saved choices (?endpoint=...)
 *   POST /push/subscribe     add or refresh a device { subscription, prefs? }
 *   PUT  /push/prefs         change a device's choices { endpoint, prefs }
 *   POST /push/unsubscribe   remove a device { endpoint }
 *   POST /push/test          send one message to this device now { endpoint }
 */
export function createPushRouter(registry: TenantRegistry): Router {
  const router = Router();
  const worker = (req: { tenantId?: string }): TenantWorker | undefined => (req.tenantId ? registry.get(req.tenantId) : undefined);
  const endpointOf = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 1024 ? v : undefined);

  router.get("/push/config", (_req, res) => {
    const vapid = vapidFromEnv();
    res.json({
      enabled: vapid !== undefined,
      publicKey: vapid?.publicKey ?? null,
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, description: c.description, defaultOn: c.defaultOn })),
    });
  });

  router.get("/push/subscription", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const endpoint = endpointOf(req.query.endpoint);
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    const sub = await w.store.getPushSubscription(w.tenantId, endpoint);
    if (!sub) return res.json({ subscribed: false });
    res.json({ subscribed: true, prefs: effectivePrefs(sub.prefs), lastSentAt: sub.lastSentAt, failures: sub.failures, lastError: sub.lastError });
  });

  router.post("/push/subscribe", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    if (!w.notifications) return res.status(503).json({ error: "push notifications are not configured on this server" });
    const sub = sanitizeSubscription(req.body?.subscription);
    if (!sub) return res.status(400).json({ error: "a valid https push subscription is required" });
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 200) : null;
    const prefs = req.body?.prefs !== undefined ? sanitizePrefs(req.body.prefs) : undefined;
    const row = await w.store.upsertPushSubscription(w.tenantId, { ...sub, userAgent: ua, prefs });
    res.json({ ok: true, prefs: effectivePrefs(row.prefs) });
  });

  router.put("/push/prefs", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const endpoint = endpointOf(req.body?.endpoint);
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    const prefs = sanitizePrefs(req.body?.prefs);
    const ok = await w.store.setPushPrefs(w.tenantId, endpoint, prefs);
    if (!ok) return res.status(404).json({ error: "this device is not subscribed" });
    res.json({ ok: true, prefs: effectivePrefs(prefs) });
  });

  router.post("/push/unsubscribe", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const endpoint = endpointOf(req.body?.endpoint);
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    res.json({ ok: await w.store.deletePushSubscription(w.tenantId, endpoint) });
  });

  router.post("/push/test", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    if (!w.notifications) return res.status(503).json({ error: "push notifications are not configured on this server" });
    const endpoint = endpointOf(req.body?.endpoint);
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    const r = await w.notifications.sendTest(endpoint);
    res.status(r.ok ? 200 : r.removed ? 410 : 502).json(r);
  });

  return router;
}
