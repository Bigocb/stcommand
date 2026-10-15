/**
 * GET /api/live: the live feed as server-sent events (src/engine/liveFeed.ts).
 *
 * On connect the screen gets a snapshot (every ship's live row and the credits), unless it sends the last event number
 * it saw (Last-Event-ID, which browsers resend on their own when they reconnect, or ?since=) and the buffer still holds
 * everything after it; then it gets only the missed events. Events: snapshot, ships ({changed, removed}), credits,
 * activity. A comment line every 25 s keeps proxies from closing an idle connection. Not gzipped: events are small and
 * must leave at once.
 */
import type { Request, Response } from "express";
import type { TenantWorker } from "../engine/tenantRegistry.js";

export function liveRoute(worker: (req: Request) => Pick<TenantWorker, "live" | "liveSnapshot"> | undefined, heartbeatMs = 25_000) {
  return (req: Request, res: Response): void => {
    const w = worker(req);
    if (!w?.live || !w.liveSnapshot) {
      res.status(503).json({ error: "engine not ready" });
      return;
    }
    const live = w.live;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (seq: number, type: string, data: unknown) => {
      res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = live.subscribe((e) => send(e.seq, e.type, e.data));
    const raw = req.headers["last-event-id"] ?? req.query.since;
    const lastId = raw === undefined || raw === "" ? NaN : Number(raw);
    const missed = Number.isFinite(lastId) ? live.since(lastId) : undefined;
    if (missed) for (const e of missed) send(e.seq, e.type, e.data);
    else {
      // Events published while the snapshot is being built arrive through the subscription above and may repeat what
      // the snapshot has; applying a row twice is harmless.
      w.liveSnapshot()
        .then((snap) => send(snap.seq, "snapshot", snap))
        .catch((err: unknown) => res.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`));
    }
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };
}
