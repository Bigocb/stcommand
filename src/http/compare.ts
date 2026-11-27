import { Router, type Request } from "express";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { tenantUniverse } from "../db/pool.js";
import { isUniverseKey } from "../engine/universe.js";
import { isOperator, operatorAgents } from "./operatorFlag.js";
import { SNAPSHOT_KIND, fleetPoints } from "../engine/hourlySnapshot.js";
import { checkpoints, drawnPoints, gateAligned, gateOpenToFirstJob, hoursReached, likeForLike, toPoints, weekTotals, type WeekSeries } from "../engine/weekCompare.js";
import { GATE_OPEN_SUBJECT } from "../engine/actionEvents.js";
import { forecastFrom, forecastPolicyFromDoctrine, forecastWeek, gateHourOf, joinForecast, typicalHullPrice, type ForecastPoint } from "../engine/forecast.js";
import { buyRulesFrom } from "../engine/buyAdvice.js";
import { keyedTtlCache } from "./cache.js";
import { markCached } from "./endpointStats.js";

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
  /**
   * Server caches (issue #87). Each Compare open used to run two whole-week ledger aggregations, up to 10,000 snapshot rows and the
   * shipyard inventory. A finished week never changes, so its series and fleet points are kept for hours; the live week's for
   * a few minutes, which is also how often Tower refreshes the card. The week list changes only when a week starts.
   */
  const LIVE_TTL_MS = 3 * 60_000;
  const DONE_TTL_MS = 6 * 3600_000;
  const isLive = (k: string) => k.startsWith("live|");
  const seriesCache = keyedTtlCache<string, WeekSeries>({ ttlMs: (k) => (isLive(k) ? LIVE_TTL_MS : DONE_TTL_MS), maxEntries: 64 });
  const fleetCache = keyedTtlCache<string, ReturnType<typeof fleetPoints>>({ ttlMs: (k) => (isLive(k) ? LIVE_TTL_MS : DONE_TTL_MS), maxEntries: 64 });
  const responseCache = keyedTtlCache<string, unknown>({ ttlMs: 60_000, maxEntries: 32 });
  const weekListCache = keyedTtlCache<string, unknown>({ ttlMs: 5 * 60_000, maxEntries: 16 });

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

  const liveTag = (ref: WeekRef) => (ref.universeKey === tenantUniverse(ref.tenantId) ? "live" : "done");
  function series(w: TenantWorker, ref: WeekRef): Promise<WeekSeries> {
    return seriesCache.get(`${liveTag(ref)}|${ref.tenantId}|${ref.universeKey}`, () => buildSeries(w, ref));
  }

  async function buildSeries(w: TenantWorker, ref: WeekRef): Promise<WeekSeries> {
    const s = await w.store.weekHours(ref.tenantId, ref.universeKey);
    // The engine's gate_open milestone for this week, on the same clock as the hour rows (hours since the first trade).
    const milestones = s.startAt ? await w.store.actionEvents(ref.tenantId, { sinceIso: s.startAt, kinds: ["milestone"], limit: 500 }) : [];
    const gate = milestones.find((e) => e.universeKey === ref.universeKey && e.subject === GATE_OPEN_SUBJECT);
    const opened = (gate?.observed as { hoursIntoWeek?: unknown } | undefined)?.hoursIntoWeek;
    const gateOpenHour = typeof opened === "number" && Number.isFinite(opened) ? Math.floor(opened) : null;
    return { label: `${ref.agentSymbol} · ${ref.universeKey.split("@")[1]}`, universeKey: ref.universeKey, startAt: s.startAt, firstJumpHour: s.firstJumpHour, gateOpenHour, hours: s.hours };
  }

  router.get("/weeks", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const op = canSeeAll(req.agentSymbol);
    try {
      res.json({ operator: op, operatorList: [...operatorAgents()], you: req.agentSymbol, weeks: await weekListCache.get(`${w.tenantId}|${op}`, () => weekList(w, op)) });
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
      let built = false;
      // The forecast settings are part of the key, so switching a forecast clause shows at once.
      const d = w.fleet?.doctrine;
      const fcKey = d ? ["weekForecast", "weekForecastHeavyHour", "weekForecastAnchor"].map((k) => `${d.isEnabled(k) ? 1 : 0}:${d.value(k, 0)}`).join(",") : "-";
      const body = await responseCache.get(`${w.tenantId}|${base.tenantId}|${base.universeKey}|${other.tenantId}|${other.universeKey}|${fcKey}`, async () => { built = true; return buildCompare(w, base, other); });
      if (!built) markCached(res);
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function buildCompare(w: TenantWorker, base: WeekRef, other: WeekRef) {
    {
      const [a, b] = await Promise.all([series(w, base), series(w, other)]);
      const upTo = Math.min(MAX_HOURS, Math.max(hoursReached(a), hoursReached(b)));
      const pa = toPoints(a, upTo), pb = toPoints(b, upTo);
      const fleet = (ref: WeekRef, ser: WeekSeries) => fleetCache.get(`${liveTag(ref)}|${ref.tenantId}|${ref.universeKey}|${upTo}`, async () => {
        const rows = await w.store.actionEvents(ref.tenantId, { sinceIso: ser.startAt ?? "1970-01-01T00:00:00Z", kinds: [SNAPSHOT_KIND], limit: 5000 });
        return fleetPoints(rows.filter((r) => r.universeKey === ref.universeKey), ser.startAt, upTo);
      });
      const [fa, fb] = await Promise.all([fleet(base, a), fleet(other, b)]);
      // The week's forecast (clause weekForecast, issue #76): drawn as a third, dotted line; absent when the clause is off.
      const doctrine = w.fleet?.doctrine;
      const policy = doctrine ? forecastPolicyFromDoctrine(doctrine) : null;
      const sized = policy ? { ...policy, hours: Math.max(upTo + 1, Math.min(MAX_HOURS, policy.hours)) } : null;
      // Clause weekForecastAnchor: the line is the real week up to its latest hour, then simulated from the real wallet, the real gate
      // hour and the recent profit rate (src/engine/forecast.ts forecastFrom). Off, or no wallet reading yet: the plan-only line.
      const reached = hoursReached(a);
      const last = pa[reached];
      let fc: ForecastPoint[] | null = null;
      let anchored: { hour: number; gateOpenHour: number | null; baseRate: number | null; bigHulls?: number; hullShare?: number; hullPrice?: number } | null = null;
      if (sized && doctrine?.isEnabled("weekForecastAnchor") && last && last.wallet !== null) {
        const gateAt = a.gateOpenHour ?? null;
        const real: ForecastPoint[] = pa.slice(0, reached + 1).map((x) => ({ hour: x.hour, gateOpen: gateAt !== null && x.hour >= gateAt, cumPnl: x.cumPnl, pnl: x.pnl, rate: x.rate, units: x.units, wallet: x.wallet ?? last.wallet!, bigHulls: 0, note: "real" }));
        // The live week only: the big hulls trading now and the yards' typical heavy price (2026-11-26: without them the line bought a
        // whole new fleet on top of the real one).
        const live = !!w.fleet && a.universeKey === tenantUniverse(w.tenantId);
        let bigHulls = 0;
        let hullPrice: number | undefined;
        if (live && w.fleet) {
          const bigCargo = buyRulesFrom(w.fleet.doctrine).bigHullCargo;
          bigHulls = w.fleet.fleetStatusSummary().filter((s) => s.role === "trader" && s.cargoCap > bigCargo).length;
          const inv = await w.store.shipyardInventory().catch(() => []);
          hullPrice = typicalHullPrice(inv.filter((r) => r.shipType === "SHIP_HEAVY_FREIGHTER").map((r) => ({ price: r.purchasePrice, readAt: Date.parse(r.timestamp) })), Date.now()) ?? undefined;
        }
        const f = forecastFrom({ hour: reached, cumPnl: last.cumPnl, wallet: last.wallet, units: last.units, gateOpenHour: gateAt, pnlByHour: pa.slice(0, reached + 1).map((x) => x.pnl), bigHulls, hullPrice }, sized);
        fc = joinForecast(real, f.points);
        anchored = { hour: reached, gateOpenHour: gateAt, baseRate: f.baseRate, bigHulls, hullShare: f.hullShare, hullPrice: f.policy.hullPrice };
      } else if (sized) {
        fc = forecastWeek(sized);
      }
      return {
        forecast: fc ? { label: "Forecast", gateOpenHour: anchored ? anchored.gateOpenHour : gateHourOf(fc), anchored, points: fc.map((p) => ({ hour: p.hour, cumPnl: p.cumPnl, pnl: p.pnl, rate: p.rate, units: p.units, wallet: p.wallet, ships: null, bigHulls: p.bigHulls, note: p.note })) } : null,
        fleetA: fa, fleetB: fb,
        a: { label: a.label, universeKey: a.universeKey, startAt: a.startAt, firstJumpHour: a.firstJumpHour, gateOpenHour: a.gateOpenHour ?? null, gateOpenToFirstJob: gateOpenToFirstJob(a), totals: weekTotals(a), points: drawnPoints(pa, hoursReached(a)), reached: hoursReached(a) },
        b: { label: b.label, universeKey: b.universeKey, startAt: b.startAt, firstJumpHour: b.firstJumpHour, gateOpenHour: b.gateOpenHour ?? null, gateOpenToFirstJob: gateOpenToFirstJob(b), totals: weekTotals(b), points: drawnPoints(pb, hoursReached(b)), reached: hoursReached(b) },
        likeForLike: likeForLike(a, b),
        gateAligned: gateAligned(a, b) ?? null,
        checkpoints: checkpoints(pa, pb, hoursReached(a), hoursReached(b)),
        upToHour: upTo,
      };
    }
  }

  return router;
}
