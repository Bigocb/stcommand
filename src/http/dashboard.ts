import { Router } from "express";
import type pg from "pg";
import { generateLog } from "../engine/narrative.js";
import { optimizeLoadouts } from "../engine/loadoutGa.js";
import { buildTriage } from "../engine/triage.js";
import { setTenantDiscordWebhook } from "../db/tenants.js";
import type { TenantRegistry, TenantWorker } from "../engine/tenantRegistry.js";

/**
 * The command-center dashboard's JSON API — a tenant-scoped port of
 * straders' src/server/index.ts. Every route there read from one process-
 * wide `opts.{state,store,fleet,chat}` bundle; every route here reads the
 * same shape from `registry.get(req.tenantId!)` instead, since that bundle
 * is now per-tenant. Mounted behind `resolveTenant` + the
 * "ensure this tenant's engine is booted" middleware in `src/cli/index.ts`,
 * so `req.tenantId` is always set and `registry.get()` should never
 * actually return undefined here — the `503 "engine not ready"` checks are
 * kept anyway, same defensive shape as the original, for the split second
 * between a session resolving and that tenant's first boot completing.
 *
 * Every store call below that straders' original made synchronously is
 * `await`ed here (Postgres is async); every `opts.store.X()` becomes
 * `worker.store.X(tenantId, ...)` for the methods that take one, or stays
 * `worker.store.X(...)` unchanged for the three shared-galaxy-table methods
 * that never did.
 */
export function createDashboardRouter(registry: TenantRegistry, pool: pg.Pool): Router {
  const router = Router();

  function worker(req: { tenantId?: string }): TenantWorker | undefined {
    return req.tenantId ? registry.get(req.tenantId) : undefined;
  }

  router.get("/state", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json(w.state.get());
  });

  router.get("/systems", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({
      systems: w.fleet.getGalaxy().listSystems().map((s) => s.symbol),
      connections: w.fleet.getGalaxy().jumpConnections(),
    });
  });

  router.get("/system/:symbol/waypoints", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const known = w.fleet.getGalaxy().getSystem(req.params.symbol);
    if (!known) return res.status(404).json({ error: "system not known" });
    res.json({
      system: known.symbol,
      waypoints: known.waypoints.map((wp) => ({ symbol: wp.symbol, x: wp.x, y: wp.y, type: wp.type, traits: wp.traits.map((t) => t.symbol) })),
    });
  });

  router.get("/intel", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const intel = await w.fleet.getIntel();
      res.json({
        snapshots: await w.store.latestMarketSnapshots(),
        bestTrades: await w.store.bestTrades(),
        shipyards: intel.shipyards,
        modules: intel.modules,
      });
    } catch (err) {
      console.error("[dashboard] /intel error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/activity", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ activity: await w.store.recentActivity(w.tenantId, 100) });
  });

  /* ── Bridge ──────────────────────────────────────────────────
     Everything the operating view needs in one call: the earning rate, the
     triage queue ranked by cost of inaction, and per-ship earnings. */
  router.get("/bridge", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const series = await w.store.netSeries(w.tenantId, since, 60);
      const byShip = await w.store.earningsByShip(w.tenantId, new Date(Date.now() - 3600 * 1000).toISOString());
      const state = w.state.get();
      const status = { ships: w.fleet.getShipStatuses(), stranded: w.fleet.getStrandedShips(), paused: w.fleet.isPaused() };

      const complete = series.slice(0, -1);
      const rate = Math.round(complete.at(-1)?.net ?? series.at(-1)?.net ?? 0);
      const prev = Math.round(complete.at(-2)?.net ?? 0);

      const HISTORY_HOURS = 24;
      const historyStart = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();
      const historicalRates = (await w.store.earningsByShip(w.tenantId, historyStart)).map((r) => ({
        shipSymbol: r.shipSymbol,
        net: r.net / HISTORY_HOURS,
      }));

      const { triage, forgone } = buildTriage({
        ships: status.ships,
        stranded: status.stranded,
        earnings: byShip,
        historicalRates,
        contracts: (state.contracts ?? []) as any[],
      });

      res.json({
        rate, prevRate: prev, forgone,
        series: series.map((p) => p.net),
        credits: state.agent?.credits ?? 0,
        shipCount: state.agent?.shipCount ?? 0,
        totals: state.totals ?? { sells: 0, buys: 0 },
        paused: status.paused,
        earnings: byShip,
        stranded: status.stranded,
        shipStatus: status.ships,
        triage,
      });
    } catch (err) {
      console.error("[dashboard] /bridge error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Markets ─────────────────────────────────────────────────
     Routes ranked by profit per round trip net of fuel, not margin %. */
  router.get("/markets", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      // Same staleness cutoff trading actually flies by (doctrine's
      // snapshotMaxAgeMin, default 90m) — latestMarketSnapshots() had no
      // age filter at all, so this panel could show a price hours or days
      // stale that the dispatcher/traders had already stopped considering.
      const maxAgeMin = w.fleet.doctrine.value("snapshotMaxAgeMin", 5_256_000);
      const snapshots = await w.store.freshMarketSnapshots(maxAgeMin);
      const dispatchRoutes = await w.fleet.computeDispatchRoutes();
      const routes = dispatchRoutes
        .map((r) => ({
          goodSymbol: r.good,
          buyAt: r.buyAt,
          buySystem: r.buySystem,
          buyPrice: r.buyPrice,
          sellAt: r.sellAt,
          sellSystem: r.sellSystem,
          sellPrice: r.sellPrice,
          volume: r.volume,
          distance: r.distance || null,
          fuelUnits: r.fuelUnits || null,
          fuelCost: r.fuelCost,
          marginPerUnit: Math.round((r.sellPrice - r.buyPrice) * 10) / 10,
          marginPct: Math.round(((r.sellPrice - r.buyPrice) / r.buyPrice) * 1000) / 10,
          grossPerTrip: Math.round((r.sellPrice - r.buyPrice) * r.volume),
          profitPerTrip: r.profitPerTrip,
          crossSystem: r.buySystem !== r.sellSystem,
          ageMinutes: r.ageMinutes,
        }))
        .slice(0, 25);

      const intel = await w.fleet.getIntel();
      res.json({ routes, snapshots, shipyards: intel.shipyards, modules: intel.modules });
    } catch (err) {
      console.error("[dashboard] /markets error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Doctrine ────────────────────────────────────────────────
     The policy the engine flies by. Reads are live, so an edit takes effect
     on the next tick without a restart. */
  router.get("/doctrine", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ rules: w.fleet.doctrine.list() });
  });

  router.post("/doctrine", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { key, value, enabled } = req.body ?? {};
    if (typeof key !== "string") return res.status(400).json({ error: "key required" });
    if (value !== undefined && typeof value !== "number") return res.status(400).json({ error: "value must be a number" });
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    try {
      const rule = await w.fleet.doctrine.set(key, { value, enabled });
      res.json({ ok: true, rule, rules: w.fleet.doctrine.list() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/doctrine/stats", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const stats = await w.store.getDoctrineFires(w.tenantId);
      res.json({ stats });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Which real hulls fired each doctrine rule "this watch" (default 2h) —
   *  what Book mode's clause hover highlights on the field. Separate from
   *  /doctrine/stats' aggregate counts, which stay all-time. */
  router.get("/doctrine/fire-ships", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const hours = Math.min(24, Math.max(0.25, Number(req.query.hours) || 2));
    try {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const ships = await w.store.getDoctrineFireShips(w.tenantId, since);
      res.json({ ships });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Position history for the replay scrubber — every sample recorded in the
   *  requested window (default 12h, matching the mockup's scrub range). */
  router.get("/replay", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const hours = Math.min(24, Math.max(0.1, Number(req.query.hours) || 12));
    try {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const samples = await w.store.getShipPositionHistory(w.tenantId, since);
      res.json({ since, samples });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Keeper stations ─────────────────────────────────────────
     Which buy markets get a stationed keeper + the current assignments. */
  router.get("/keeper/markets", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({
      markets: await w.fleet.keeperPriorityMarkets(),
      stations: w.fleet.keeperStations(),
      keeperCount: w.fleet.doctrine.value("keeperCount", 0),
      coverList: await w.fleet.keeperCoverList(),
    });
  });

  router.post("/keeper/markets", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { markets, reset, coverList } = req.body ?? {};
    try {
      if (typeof coverList === "boolean") await w.fleet.setKeeperCoverList(coverList);
      if (reset === true) {
        const clean = await w.fleet.resetKeeperPriorityMarkets();
        return res.json({ ok: true, markets: clean, coverList: await w.fleet.keeperCoverList() });
      }
      if (markets !== undefined) {
        if (!Array.isArray(markets) || !markets.every((m) => typeof m === "string")) {
          return res.status(400).json({ error: "markets must be an array of waypoint symbols" });
        }
        const clean = await w.fleet.setKeeperPriorityMarkets(markets);
        return res.json({ ok: true, markets: clean, coverList: await w.fleet.keeperCoverList() });
      }
      res.json({ ok: true, markets: await w.fleet.keeperPriorityMarkets(), coverList: await w.fleet.keeperCoverList() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Dispatch ────────────────────────────────────────────────
     The centralized route dispatcher: which trader runs which good. */
  router.get("/dispatch", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ routes: await w.fleet.computeDispatchRoutes(), assignments: w.fleet.dispatcher.list() });
  });

  router.post("/dispatch", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, good, buyAt, sellAt, buyPrice, sellPrice, profitPerTrip, clear } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      if (clear) {
        await w.fleet.setManualDispatch(shipSymbol, undefined);
      } else {
        if (typeof good !== "string") return res.status(400).json({ error: "good required" });
        await w.fleet.setManualDispatch(shipSymbol, {
          shipSymbol,
          good,
          role: "direct",
          buyAt: typeof buyAt === "string" ? buyAt : "",
          sellAt: typeof sellAt === "string" ? sellAt : "",
          buyPrice: typeof buyPrice === "number" ? buyPrice : 0,
          sellPrice: typeof sellPrice === "number" ? sellPrice : 0,
          profitPerTrip: typeof profitPerTrip === "number" ? profitPerTrip : 0,
          source: "manual",
        });
      }
      res.json({ ok: true, assignments: w.fleet.dispatcher.list() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Warehouse ───────────────────────────────────────────────
     The staging ship buy/sell-role traders rendezvous with. */
  router.get("/warehouse", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({
      ship: w.fleet.getWarehouseShip() ?? null,
      goods: await w.fleet.warehouseGoods(),
      totalValue: await w.fleet.warehouseValue(),
      ledger: await w.fleet.warehouseLedger(20),
      targets: await w.fleet.warehouseTargetList(),
    });
  });

  router.post("/warehouse/targets", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { good, target, forMission } = req.body ?? {};
    if (typeof good !== "string" || !good) return res.status(400).json({ error: "good required" });
    if (typeof target !== "number" || target <= 0) return res.status(400).json({ error: "target must be a positive number" });
    try {
      await w.fleet.setWarehouseTarget(good, target, forMission === true);
      res.json({ ok: true, targets: await w.fleet.warehouseTargetList() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/warehouse/targets/remove", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { good } = req.body ?? {};
    if (typeof good !== "string" || !good) return res.status(400).json({ error: "good required" });
    await w.fleet.removeWarehouseTarget(good);
    res.json({ ok: true, targets: await w.fleet.warehouseTargetList() });
  });

  router.post("/warehouse/designate", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, waypointSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof waypointSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and waypointSymbol required" });
    }
    try {
      await w.fleet.designateWarehouseShip(shipSymbol, waypointSymbol);
      res.json({ ok: true, ship: w.fleet.getWarehouseShip() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/warehouse/release", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    await w.fleet.releaseWarehouseShip();
    res.json({ ok: true });
  });

  router.post("/warehouse/adjust", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { good, units, direction, price } = req.body ?? {};
    if (typeof good !== "string") return res.status(400).json({ error: "good required" });
    if (typeof units !== "number" || units <= 0) return res.status(400).json({ error: "units must be a positive number" });
    if (direction !== "deposit" && direction !== "withdraw") return res.status(400).json({ error: "direction must be 'deposit' or 'withdraw'" });
    try {
      const result = await w.fleet.adjustWarehouse(good, units, direction, typeof price === "number" ? price : 0);
      res.json({ ok: true, result, goods: await w.fleet.warehouseGoods() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/missions", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ missions: await w.fleet.getMissions() });
  });

  router.get("/contracts", async (req, res) => {
    const w = worker(req);
    if (!w?.contracts) return res.status(503).json({ error: "contracts not ready" });
    try {
      const contracts = await w.contracts.listActive();
      res.json({
        contracts: contracts.map((c) => ({
          id: c.id,
          factionSymbol: c.factionSymbol,
          type: c.type,
          accepted: c.accepted,
          fulfilled: c.fulfilled,
          deadlineToAccept: c.deadlineToAccept ?? c.expiration,
          deadline: c.terms.deadline,
          onAccepted: c.terms.payment.onAccepted,
          onFulfilled: c.terms.payment.onFulfilled,
          deliver: (c.terms.deliver ?? []).map((d) => ({
            tradeSymbol: d.tradeSymbol,
            destinationSymbol: d.destinationSymbol,
            unitsRequired: d.unitsRequired,
            unitsFulfilled: d.unitsFulfilled,
          })),
          declined: w.contracts!.isDeclined(c.id),
        })),
      });
    } catch (err) {
      console.error("[dashboard] /contracts error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/contracts/decline", (req, res) => {
    const w = worker(req);
    if (!w?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") return res.status(400).json({ error: "contractId required" });
    w.contracts.decline(contractId);
    res.json({ ok: true });
  });

  router.post("/contracts/undecline", (req, res) => {
    const w = worker(req);
    if (!w?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") return res.status(400).json({ error: "contractId required" });
    w.contracts.undecline(contractId);
    res.json({ ok: true });
  });

  router.post("/contracts/accept", async (req, res) => {
    const w = worker(req);
    if (!w?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") return res.status(400).json({ error: "contractId required" });
    try {
      const c = await w.contracts.acceptById(contractId);
      res.json({ ok: true, contractId: c.id });
    } catch (err) {
      console.error("[dashboard] accept error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/construct", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ missions: await w.fleet.getMissions() });
  });

  router.post("/missions/start", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const waypoint = String(req.body?.waypoint ?? "");
      if (!waypoint) return res.status(400).json({ error: "waypoint required" });
      await w.fleet.startMission(waypoint);
      res.json({ ok: true, missions: await w.fleet.getMissions() });
    } catch (err) {
      console.error("[dashboard] /missions/start error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/missions/pause", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const waypoint = String(req.body?.waypoint ?? "");
    if (!waypoint) return res.status(400).json({ error: "waypoint required" });
    await w.fleet.pauseMission(waypoint);
    res.json({ ok: true, missions: await w.fleet.getMissions() });
  });

  router.post("/missions/resume", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const waypoint = String(req.body?.waypoint ?? "");
    if (!waypoint) return res.status(400).json({ error: "waypoint required" });
    await w.fleet.resumeMission(waypoint);
    res.json({ ok: true, missions: await w.fleet.getMissions() });
  });

  router.post("/missions/assign", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const waypoint = String(req.body?.waypoint ?? "");
    const shipSymbol = String(req.body?.shipSymbol ?? "");
    if (!waypoint || !shipSymbol) return res.status(400).json({ error: "waypoint and shipSymbol required" });
    try {
      await w.fleet.assignMissionCarrier(waypoint, shipSymbol);
      res.json({ ok: true, missions: await w.fleet.getMissions() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/prices", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const good = String(req.query.good ?? "");
    const since = String(req.query.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    if (!good) return res.status(400).json({ error: "good required" });
    try {
      res.json({ points: await w.store.goodPriceHistory(good, since) });
    } catch (err) {
      console.error("[dashboard] /prices error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/goods", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const snaps = await w.store.latestMarketSnapshots();
      res.json({ goods: [...new Set(snaps.map((s) => s.goodSymbol))].sort() });
    } catch (err) {
      console.error("[dashboard] /goods error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/surveys", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const waypoint = req.query.waypoint ? String(req.query.waypoint) : undefined;
    res.json({
      waypoint,
      surveys: w.fleet.surveyData(waypoint).map((s) => ({
        signature: s.signature,
        size: s.size,
        expiration: s.expiration,
        deposits: s.deposits.map((d) => d.symbol),
      })),
    });
  });

  router.get("/narrative", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const activity = await w.store.recentActivity(w.tenantId, 30);
    const state = w.state.get();
    res.json({ log: generateLog(activity, state.agent?.credits ?? 0, state.ships ?? []) });
  });

  router.get("/loadout", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      res.json({ scores: await w.fleet.scanLoadouts() });
    } catch (err) {
      console.error("[dashboard] /loadout error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/loadout/ga", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const agent = await w.fleet.getApi().getMyAgent();
      const scores = await w.fleet.scanLoadouts();
      const baseShips = scores.map((s) => ({ ...scores.find((x) => x.type === s.type)! }));
      const seen = new Set<string>();
      const uniqueBaseShips = baseShips.filter((s) => {
        if (seen.has(s.type)) return false;
        seen.add(s.type);
        return true;
      });
      const ships = uniqueBaseShips.map((s) => ({
        type: s.type,
        purchasePrice: s.purchasePrice,
        frame: { fuelCapacity: s.fuelCapacity, moduleSlots: s.moduleSlots, mountingPoints: s.mountingPoints, name: s.type, description: "", condition: 100, requirements: {} },
        engine: { speed: 10, name: "", description: "", condition: 100, requirements: {} },
        reactor: { name: "", description: "", condition: 100, requirements: {} },
        modules: [] as any[],
        mounts: [] as any[],
        name: s.type,
        description: "",
        crew: { required: 0, capacity: 0, current: 0 },
      } as any));
      const candidates = optimizeLoadouts(ships, agent.credits - 20_000, { population: 30, generations: 20 });
      res.json({ candidates: candidates.slice(0, 8) });
    } catch (err) {
      console.error("[dashboard] /loadout/ga error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/pause", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    await w.fleet.setPaused(true);
    res.json({ paused: true });
  });

  router.post("/fleet/resume", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    await w.fleet.setPaused(false);
    res.json({ paused: false });
  });

  router.get("/fleet/status", (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({
      paused: w.fleet.isPaused(),
      running: w.fleet.running,
      ships: w.fleet.getShipStatuses(),
      stranded: w.fleet.getStrandedShips(),
    });
  });

  /**
   * Greenfield Phase 2: the persisted lifecycle table, as of the last
   * coordinator tick — distinct from /fleet/status above, which recomputes
   * live from each agent's in-memory ship object on every call. This is
   * what survives a restart; that one is what's true right now. Both are
   * kept, not one replacing the other — see README's Greenfield section.
   */
  router.get("/ship-state", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ states: await w.store.getAllShipStates(w.tenantId) });
  });

  /** Greenfield Phase 3: the persisted cargo-intent manifest, reconciled once per coordinator tick. */
  router.get("/ship-manifest", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ manifest: await w.store.getAllManifestRows(w.tenantId) });
  });

  /** Greenfield Phase 4: the persisted ownership claims — a mirror of fleet.ts's own role/dispatch/mission/warehouse/keeper decisions, not yet the thing anything is gated on. See shipRegistry.ts. */
  router.get("/ship-claims", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    res.json({ claims: await w.store.getAllClaims(w.tenantId) });
  });

  router.post("/fleet/dispatch", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, waypointSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof waypointSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and waypointSymbol required" });
    }

    try {
      const api = w.fleet.getApi();
      const ship = await api.getShip(shipSymbol);
      const need = w.fleet.estimatedFuelTo(shipSymbol, waypointSymbol);
      if (ship.fuel.capacity > 0 && ship.fuel.current < need) {
        return res.status(400).json({
          error: `${shipSymbol} needs ${need} fuel to reach ${waypointSymbol}, but has ${ship.fuel.current}/${ship.fuel.capacity}`,
        });
      }
    } catch (err) {
      console.error("[dashboard] dispatch pre-check error", err);
    }

    const status = w.fleet.getShipStatuses().find((s) => s.symbol === shipSymbol);
    if (status && status.role !== "idle") {
      w.fleet.dispatchShip(shipSymbol, waypointSymbol).catch((err) => console.error("[dashboard] dispatch error", err));
    } else {
      const api = w.fleet.getApi();
      api.getShip(shipSymbol)
        .then((ship) => {
          if (ship.nav.status === "DOCKED") return api.orbitShip(shipSymbol);
        })
        .then(() => api.navigateShip(shipSymbol, waypointSymbol))
        .catch((err) => console.error("[dashboard] fallback dispatch error", err));
    }
    res.json({ ok: true, shipSymbol, waypointSymbol });
  });

  router.post("/fleet/hold", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      await w.fleet.holdShip(shipSymbol);
      res.json({ ok: true, shipSymbol });
    } catch (err) {
      console.error("[dashboard] hold error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/release", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      await w.fleet.releaseShip(shipSymbol);
      res.json({ ok: true, shipSymbol });
    } catch (err) {
      console.error("[dashboard] release error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const MANUAL_ROLES = new Set(["miner", "trader", "surveyor", "tour", "keeper", "scout", "siphoner"]);

  router.post("/fleet/role", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, role, keeperMarket } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof role !== "string" || !MANUAL_ROLES.has(role)) {
      return res.status(400).json({ error: `shipSymbol required, role must be one of ${[...MANUAL_ROLES].join(", ")}` });
    }
    if (keeperMarket !== undefined && typeof keeperMarket !== "string") {
      return res.status(400).json({ error: "keeperMarket must be a string" });
    }
    try {
      await w.fleet.setShipRole(shipSymbol, role as Parameters<typeof w.fleet.setShipRole>[1], keeperMarket);
      res.json({ ok: true, shipSymbol, role });
    } catch (err) {
      console.error("[dashboard] role error", err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/mine", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, waypointSymbol, clear } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      if (clear) {
        await w.fleet.unpinMining(shipSymbol);
        return res.json({ ok: true, shipSymbol, pinned: null });
      }
      if (typeof waypointSymbol !== "string") return res.status(400).json({ error: "waypointSymbol required" });
      await w.fleet.mineAt(shipSymbol, waypointSymbol);
      res.json({ ok: true, shipSymbol, pinned: waypointSymbol });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/dock", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      const api = w.fleet.getApi();
      const ship = await api.getShip(shipSymbol);
      if (ship.nav.status === "IN_TRANSIT") return res.status(400).json({ error: `${shipSymbol} is in transit — wait for arrival` });
      if (ship.nav.status === "DOCKED") await api.orbitShip(shipSymbol);
      else await api.dockShip(shipSymbol);
      const updated = await api.getShip(shipSymbol);
      res.json({ ok: true, shipSymbol, status: updated.nav.status });
    } catch (err) {
      console.error("[dashboard] dock error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/transfer", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, toShipSymbol, tradeSymbol, units } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof toShipSymbol !== "string" || typeof tradeSymbol !== "string" || typeof units !== "number") {
      return res.status(400).json({ error: "shipSymbol, toShipSymbol, tradeSymbol and units required" });
    }
    try {
      const api = w.fleet.getApi();
      const receiver = await api.getShip(toShipSymbol);
      const sender = await api.getShip(shipSymbol);
      if (receiver.nav.waypointSymbol !== sender.nav.waypointSymbol) {
        return res.status(400).json({ error: `${shipSymbol} (${sender.nav.waypointSymbol}) and ${toShipSymbol} (${receiver.nav.waypointSymbol}) are not at the same waypoint` });
      }
      if (sender.nav.status === "IN_TRANSIT" || receiver.nav.status === "IN_TRANSIT") {
        return res.status(400).json({ error: "a ship is in transit — wait for arrival before transferring" });
      }
      if (sender.nav.status !== receiver.nav.status) {
        if (receiver.nav.status === "DOCKED") await api.dockShip(shipSymbol);
        else await api.orbitShip(shipSymbol);
      }
      const result = await api.transferCargo(shipSymbol, tradeSymbol, units, toShipSymbol);
      res.json({ ok: true, shipSymbol, toShipSymbol, tradeSymbol, units, cargo: result.cargo });
    } catch (err) {
      console.error("[dashboard] transfer error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/buy", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipType, yardSymbol } = req.body ?? {};
    if (typeof shipType !== "string" || typeof yardSymbol !== "string") return res.status(400).json({ error: "shipType and yardSymbol required" });
    try {
      const ship = await w.fleet.buyShip(shipType as never, yardSymbol);
      res.json({ ok: true, shipSymbol: ship.symbol });
    } catch (err) {
      console.error("[dashboard] buy error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/refuel", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      const r = await w.fleet.refuelShip(shipSymbol);
      res.json({ ok: true, ...r });
    } catch (err) {
      console.error("[dashboard] refuel error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/scrap", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      const r = await w.fleet.scrapShip(shipSymbol);
      res.json({ ok: true, shipSymbol, totalPrice: r.transaction.totalPrice });
    } catch (err) {
      console.error("[dashboard] scrap error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/jump", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, waypointSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof waypointSymbol !== "string") return res.status(400).json({ error: "shipSymbol and waypointSymbol required" });
    try {
      await w.fleet.jumpShip(shipSymbol, waypointSymbol);
      res.json({ ok: true, shipSymbol, waypointSymbol });
    } catch (err) {
      console.error("[dashboard] jump error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/explore", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, targetSystem } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      const system = await w.fleet.exploreSystem(shipSymbol, typeof targetSystem === "string" ? targetSystem : undefined);
      res.json({ ok: true, shipSymbol, system });
    } catch (err) {
      console.error("[dashboard] explore error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/buy-install", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, componentSymbol, marketWaypoint } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string" || typeof marketWaypoint !== "string") {
      return res.status(400).json({ error: "shipSymbol, componentSymbol and marketWaypoint required" });
    }
    try {
      await w.fleet.buyAndInstallComponent(shipSymbol, componentSymbol, marketWaypoint);
      res.json({ ok: true, shipSymbol, componentSymbol, marketWaypoint });
    } catch (err) {
      console.error("[dashboard] buy-install error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/install", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, componentSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string") return res.status(400).json({ error: "shipSymbol and componentSymbol required" });
    try {
      await w.fleet.installComponent(shipSymbol, componentSymbol);
      res.json({ ok: true, shipSymbol, componentSymbol });
    } catch (err) {
      console.error("[dashboard] install error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/remove-component", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, componentSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string") return res.status(400).json({ error: "shipSymbol and componentSymbol required" });
    try {
      await w.fleet.removeComponent(shipSymbol, componentSymbol);
      res.json({ ok: true, shipSymbol, componentSymbol });
    } catch (err) {
      console.error("[dashboard] remove-component error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/fleet/trade", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { shipSymbol, good, units, action } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof good !== "string" || typeof units !== "number" || (action !== "buy" && action !== "sell")) {
      return res.status(400).json({ error: "shipSymbol, good, units, action (buy|sell) required" });
    }
    try {
      if (action === "buy") await w.fleet.buyCargo(shipSymbol, good, units);
      else await w.fleet.sellCargo(shipSymbol, good, units);
      res.json({ ok: true });
    } catch (err) {
      console.error("[dashboard] trade error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Sets this tenant's own webhook — persisted, and applied to the live relay immediately, no restart needed. */
  router.post("/discord", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    const { webhookUrl } = req.body ?? {};
    if (typeof webhookUrl !== "string") return res.status(400).json({ error: "webhookUrl required" });
    try {
      await setTenantDiscordWebhook(pool, w.tenantId, webhookUrl);
      w.discord.setWebhook(webhookUrl);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/chat/history", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      res.json({ messages: await w.store.chatHistory(w.tenantId, 100) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/chat", async (req, res) => {
    const w = worker(req);
    if (!w?.chat) return res.status(503).json({ error: "co-pilot not configured — set an LLM key in Settings" });
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });
    try {
      const history = (await w.store.chatHistory(w.tenantId, 60)).map((m) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
      }));
      const result = await w.chat.chat(message, history);
      await w.store.recordChatMessage(w.tenantId, { role: "user", content: message });
      // Persist only the final assistant reply — tool calls/results are
      // transient to a single turn, and storing them would leave orphaned
      // tool messages in future histories, which some providers reject.
      if (result.reply) await w.store.recordChatMessage(w.tenantId, { role: "assistant", content: result.reply });
      res.json({ reply: result.reply, usage: result.usage });
    } catch (err) {
      console.error("[dashboard] /chat error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
