import { Router, type Request } from "express";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { tenantUniverse } from "../db/pool.js";
import { isUniverseKey } from "../engine/universe.js";
import { isOperator, operatorAgents } from "./operatorFlag.js";
import { checkpoints, hoursReached, likeForLike, toPoints, weekTotals, type WeekSeries } from "../engine/weekCompare.js";

/**
 * Week over week (src/engine/weekCompare.ts), for the Season screen's Compare tab and Tower's card. Mounted in the dashboard router.
 *
 *   GET /api/compare/weeks              the weeks that can be compared: this tenant's own kept weeks, and, for an operator
 *                                       (or any caller while OPERATOR_AGENTS is unset), every other tenant's too. Ids are `<tenantId>|<universeKey>`.
 *   GET /api/compare?week=<id>[&base=<id>]  the series for `week` set against `base` (default: this tenant's current week),
 *                                       lined up by hours since each week's first trade.
 *
 * Another tenant's ledger is read across tenants only here, deliberately; see `canSeeAll`.
 */
const MAX_HOURS = 168;

/**
 * Every tenant's weeks are readable when OPERATOR_AGENTS is unset (a box with one owner, where all the tenants are the same
 * person and a second setting only gets in the way), or when the caller is listed in it. Naming other operators and leaving this
 * agent out of the list is how a shared box keeps tenants apart.
 */
const canSeeAll = (agentSymbol: string | undefined): boolean => operatorAgents().size === 0 || isOperator(agentSymbol);

interface WeekRef { tenantId: string; agentSymbol: string; universeKey: string }

export function createCompareRouter(worker: (req: Request) => TenantWorker | undefined): Router {
  const router = Router();

  async function weekList(w: TenantWorker, op: boolean) {
    const directory = op ? await w.store.tenantDirectory() : [{ id: w.tenantId, agentSymbol: w.agentSymbol }];
    const current = tenantUniverse(w.tenantId);
    const out: { id: string; tenant: string; universeKey: string; label: string; rows: number; sells: number; matchedPnl: number; firstAt: string; lastAt: string; current: boolean; own: boolean }[] = [];
    for (const t of directory) {
      const weeks = await w.store.ledgerWeeks(t.id);
      for (const wk of weeks) {
        if (!wk.universeKey || wk.rows === 0) continue;
        const date = wk.universeKey.split("@")[1] ?? "";
        out.push({
          id: `${t.id}|${wk.universeKey}`, tenant: t.agentSymbol, universeKey: wk.universeKey, label: `${t.agentSymbol} · ${date}`,
          rows: wk.rows, sells: wk.sells, matchedPnl: wk.matchedPnl, firstAt: wk.firstAt, lastAt: wk.lastAt,
          current: t.id === w.tenantId && wk.universeKey === current, own: t.id === w.tenantId,
        });
      }
    }
    return out.sort((a, b) => b.firstAt.localeCompare(a.firstAt));
  }

  async function resolve(w: TenantWorker, op: boolean, id: string | undefined): Promise<WeekRef | undefined> {
    if (!id) return undefined;
    const [tenantId, universeKey] = id.split("|");
    if (!tenantId || !universeKey || !isUniverseKey(universeKey)) return undefined;
    if (tenantId !== w.tenantId && !op) return undefined; // another tenant's data: operators only
    const t = (op ? await w.store.tenantDirectory() : [{ id: w.tenantId, agentSymbol: w.agentSymbol }]).find((x) => x.id === tenantId);
    return t ? { tenantId, agentSymbol: t.agentSymbol, universeKey } : undefined;
  }

  async function series(w: TenantWorker, ref: WeekRef): Promise<WeekSeries> {
    const s = await w.store.weekHours(ref.tenantId, ref.universeKey);
    return { label: `${ref.agentSymbol} · ${ref.universeKey.split("@")[1]}`, universeKey: ref.universeKey, startAt: s.startAt, firstJumpHour: s.firstJumpHour, hours: s.hours };
  }

  router.get("/weeks", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const op = canSeeAll(req.agentSymbol);
    try {
      res.json({ operator: op, operatorList: [...operatorAgents()], you: req.agentSymbol, weeks: await weekList(w, op) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const op = canSeeAll(req.agentSymbol);
    try {
      const other = await resolve(w, op, typeof req.query.week === "string" ? req.query.week : undefined);
      if (!other) return res.status(400).json({ error: "week must be one of GET /api/compare/weeks" + (op ? "" : " (another tenant's weeks need operator access: list this agent in OPERATOR_AGENTS)") });
      const currentKey = tenantUniverse(w.tenantId);
      const baseId = typeof req.query.base === "string" ? req.query.base : currentKey ? `${w.tenantId}|${currentKey}` : undefined;
      const base = await resolve(w, op, baseId);
      if (!base) return res.status(400).json({ error: "this tenant has no current week yet" });
      const [a, b] = await Promise.all([series(w, base), series(w, other)]);
      const upTo = Math.min(MAX_HOURS, Math.max(hoursReached(a), hoursReached(b)));
      const pa = toPoints(a, upTo), pb = toPoints(b, upTo);
      res.json({
        a: { label: a.label, universeKey: a.universeKey, startAt: a.startAt, firstJumpHour: a.firstJumpHour, totals: weekTotals(a), points: pa, reached: hoursReached(a) },
        b: { label: b.label, universeKey: b.universeKey, startAt: b.startAt, firstJumpHour: b.firstJumpHour, totals: weekTotals(b), points: pb, reached: hoursReached(b) },
        likeForLike: likeForLike(a, b),
        checkpoints: checkpoints(pa, pb, hoursReached(a), hoursReached(b)),
        upToHour: upTo,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
