import type pg from "pg";
import { withTenant, withPool } from "./pool.js";
import { getCurrentResetDate } from "../core/universe.js";

/**
 * Async, tenant-scoped port of straders' `Store` (src/engine/store.ts).
 *
 * Every tenant-scoped method here takes `tenantId` and routes through
 * `withTenant`, which sets `app.tenant_id` for the query — RLS does the
 * actual enforcement, this class doesn't add `WHERE tenant_id = ...` by hand
 * anywhere. That's deliberate: the whole point of the RLS design
 * (docs/architecture-plan.md §1) is that isolation doesn't depend on every
 * method here remembering the clause correctly.
 *
 * A handful of methods — everything touching market_snapshots,
 * shipyard_inventory, module_catalog — route through `withPool` instead, with
 * no tenant_id anywhere, matching those three tables' deliberate lack of RLS:
 * they hold public galaxy data, the same for every tenant on the same server
 * reset (docs/architecture-plan.md §2, and straders' own multi-tenant plan's
 * original finding).
 *
 * Ported so far, covering every method fleet.ts/mission.ts/doctrine.ts/
 * agentChat.ts/the server route layer actually call: recordLedger,
 * ledgerTotals, lastPurchasePrice, avgPurchasePrice, recordActivity,
 * recentActivity, goodPriceHistory, getDoctrine, setDoctrine, getFleetFlag,
 * setFleetFlag, removeFleetFlag, getFleetState, setFleetState,
 * removeFleetState, getShipState, getAllShipStates, updateShipState,
 * getManifestForShip, getAllManifestRows, upsertManifestRows,
 * deleteManifestRows, recordClaim, releaseClaim, getClaim, getAllClaims,
 * warehouseBalance, warehouseAll, warehouseValue,
 * warehouseDeposit, warehouseWithdraw, warehouseLedger, warehouseTargetList,
 * setWarehouseTarget, removeWarehouseTarget, recordMarket,
 * latestMarketSnapshots, freshMarketSnapshots, bestTrades, tradeLegs,
 * recordShipyardInventory, shipyardInventory, recordModuleCatalog,
 * moduleCatalog, recordMission, latestMissions, completeMission,
 * earningsByShip, netSeries, recordChatMessage, chatHistory.
 *
 * Still not ported: `priceHistory` (per-waypoint price history — distinct
 * from `goodPriceHistory`'s fleet-wide aggregate, which the /api/prices
 * route actually uses) and the `buckets`/`bucket_ledger` tables. Neither has
 * a caller anywhere in straders' own server routes or engine; dead surface,
 * not deferred work.
 */

export interface LedgerEntry {
  timestamp: string;
  shipSymbol: string;
  waypointSymbol: string;
  type: "PURCHASE" | "SELL" | "REFUEL" | "JUMP" | "SHIP" | "OTHER";
  tradeSymbol?: string;
  units?: number;
  pricePerUnit?: number;
  total: number;
  // Proceeds minus this lot's own tracked cost basis — only meaningful for a
  // SELL where a cost basis was actually tracked (ordinary arbitrage; see
  // TraderAgent's heldCost/warehouse withdraw). Undefined for every other
  // row type and for a SELL with no tracked cost (mined/siphoned cargo,
  // manual dumps) — NULL there means "no matched-trade number applies",
  // never zero. See migrations/023_ledger_realized_pnl.sql.
  realizedPnl?: number;
  /** Wallet balance right after this transaction, from the game's own response (see SpaceTradersAPI.lastKnownCredits).
   *  Lets a later analysis see what a buy was sized from. Undefined for rows written without a recent response. */
  walletAfter?: number;
}

export interface ActivityEntry {
  timestamp: string;
  shipSymbol: string;
  kind: string;
  detail: string;
  credits?: number;
}

export interface ShipLogRow {
  shipSymbol: string;
  timestamp: string;
  personaKey: string;
  triggerKind: string;
  notability: number;
  detail: string;
  /** Absent when the event earned an entry that was never written. */
  entry?: string;
}

interface ShipLogDbRow {
  ship_symbol: string;
  ts: Date;
  persona_key: string;
  trigger_kind: string;
  notability: number;
  detail: string;
  entry: string | null;
}

export interface MarketRow {
  systemSymbol: string;
  waypointSymbol: string;
  goodSymbol: string;
  type: string;
  supply: string;
  purchasePrice: number;
  sellPrice: number;
  tradeVolume: number;
  /** WEAK | GROWING | STRONG | RESTRICTED — production strength (export) / consumption strength (import). */
  activity?: string;
  timestamp: string;
}

export interface FleetStateRow {
  shipSymbol: string;
  role: string;
  keeperMarket?: string;
  updatedAt: string;
}

/**
 * Greenfield Phase 2: a persisted lifecycle state per ship, kept in sync
 * once per coordinator tick (FleetManager.syncShipStates) so a restart has a
 * real record of what each ship was doing instead of only recovering its
 * *role* (fleet_state, above) and re-deriving its moment-to-moment status
 * from the live SpaceTraders API.
 *
 * `target` is populated: the ship's transit destination
 * (`nav.route.destination.symbol`) while `travelling`/`returning`, or its
 * current waypoint (`nav.waypointSymbol`) otherwise. `returning` is
 * `travelling` with cargo already in the hold — a real, if approximate,
 * signal (a ship in transit carrying cargo is heading toward a sale/
 * delivery, not away from one).
 *
 * `transacting` and `step` are populated too, from each agent's own
 * `AgentStep` (see engine/agentStep.ts): every agent class now sets
 * `currentStep` around its actual buy/sell/extract/siphon/survey API calls
 * and its shared navigation entry point. `transacting` is a real, if
 * narrow, observation — it's only ever seen here if a coordinator tick
 * happens to land while that specific API call is still in flight — not a
 * manufactured state.
 */
export type ShipLifecycleState = "idle" | "assigned" | "travelling" | "returning" | "docked" | "transacting";

export interface ShipStateRow {
  shipSymbol: string;
  state: ShipLifecycleState;
  target?: string;
  step?: unknown;
  updatedAt: string;
}

/**
 * The durable twin of TraderAgent's in-memory `heldRoute`/`heldCost`
 * (src/engine/trader.ts) — what a ship bought a good for and where it's
 * committed to sell it, so a process restart doesn't leave the ship holding
 * real cargo with no memory of the trip it was on. See migration
 * `013_held_route.sql`'s own comment for the incident this closes.
 */
/** One row of the operator approval gate (pending_approvals table) —
 *  src/engine/approvals.ts is the only writer/reader of the "open" half of
 *  this; the dashboard's Approvals panel reads listOpenApprovals() and
 *  writes decideApproval() directly. */
/** A deliberate operator intervention — a role change or a manual ship
 *  purchase (see migrations/019_operator_actions.sql), recorded at the HTTP
 *  route so the engine's own autonomous calls into the same
 *  setShipRole()/buyShip() methods never show up here as if the operator
 *  had done it. `meta` is a free-form bag for whatever detail is useful to
 *  the specific `kind` (e.g. `{ role, keeperMarket }` for a role_change) —
 *  not a typed column per field, since this is a descriptive log for the
 *  operator's own later reading, not something the engine queries by field. */
export interface OperatorActionRow {
  id: string;
  kind: string;
  shipSymbol: string | null;
  detail: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface OperatorActionDbRow {
  id: string;
  kind: string;
  ship_symbol: string | null;
  detail: string;
  meta: Record<string, unknown> | null;
  created_at: Date;
}

function toOperatorActionRow(r: OperatorActionDbRow): OperatorActionRow {
  return { id: r.id, kind: r.kind, shipSymbol: r.ship_symbol, detail: r.detail, meta: r.meta, createdAt: r.created_at.toISOString() };
}

/** The operator's own persisted scratchpad entry — a log line or a note to
 *  self, nothing the engine reads or acts on (see migrations/032_
 *  operator_notes.sql's own comment on why it's excluded from
 *  Store.TENANT_GAME_TABLES). */
export interface OperatorNoteRow {
  id: string;
  body: string;
  createdAt: string;
}

interface OperatorNoteDbRow {
  id: string;
  body: string;
  created_at: Date;
}

function toOperatorNoteRow(r: OperatorNoteDbRow): OperatorNoteRow {
  return { id: r.id, body: r.body, createdAt: r.created_at.toISOString() };
}

export interface PendingApprovalRow {
  id: string;
  kind: string;
  shipSymbol: string | null;
  detail: string;
  cost: number | null;
  status: "pending" | "approved" | "denied" | "expired" | "auto_approved";
  consumed: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

type PendingApprovalDbRow = {
  id: string; kind: string; ship_symbol: string | null; detail: string; cost: string | null;
  status: PendingApprovalRow["status"]; consumed: boolean; created_at: Date; expires_at: Date; decided_at: Date | null;
};

function toPendingApprovalRow(r: PendingApprovalDbRow): PendingApprovalRow {
  return {
    id: r.id,
    kind: r.kind,
    shipSymbol: r.ship_symbol,
    detail: r.detail,
    cost: r.cost === null ? null : Number(r.cost),
    status: r.status,
    consumed: r.consumed,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export interface HeldRouteRow {
  shipSymbol: string;
  goodSymbol: string;
  buyAt: string;
  sellAt: string;
  buyPrice: number;
  sellPrice: number;
  lotSize: number;
  costBasis: number;
  updatedAt: string;
}

/**
 * Greenfield Phase 3: what a ship's cargo is FOR, not just what's in the
 * hold — reconciled from real cargo once per coordinator tick
 * (FleetManager.syncShipManifests). `intent` is a strict subset of the
 * design doc's four values: this phase only ever assigns 'resale' or
 * 'warehouse-deposit', since distinguishing 'mission-delivery' and
 * 'held-position' needs per-ship context (which mission a carrier is
 * actually hauling for, whether a hold was deliberate) this phase doesn't
 * have yet — see README's Greenfield section.
 */
export type CargoIntent = "resale" | "warehouse-deposit" | "mission-delivery" | "held-position";
export type CostBasisKind = "actual" | "estimated";

export interface ManifestRow {
  shipSymbol: string;
  goodSymbol: string;
  units: number;
  costBasis: number;
  basisKind: CostBasisKind;
  intent: CargoIntent;
  acquiredAt: string;
}

/** Greenfield Phase 4: mirrors src/engine/shipRegistry.ts's `Claim` shape — see that file for the ownership model this persists. */
export type ShipOwner = "operator" | "rescue" | "repair" | "trading" | "mission" | "feed" | "warehouse" | "keeper" | "auto";

export interface ClaimRow {
  shipSymbol: string;
  owner: ShipOwner;
  role: string;
  intent: Record<string, unknown>;
  since: string;
}

export interface MissionRow {
  kind: "SUPPLY_CONSTRUCTION";
  targetSystem: string;
  targetWaypoint: string;
  status: "active" | "complete";
  assignedShips: string[];
  carrierTarget: number;
  materials: { tradeSymbol: string; required: number; fulfilled: number }[];
  paused: boolean;
  /** See MissionPacing in engine/mission.ts. */
  pacing?: { buyLotUnits?: number; buyGapMin?: number; maxInflationPct?: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedRow {
  targetSystem: string;
  targetWaypoint: string;
  good: string;
  assignedShips: string[];
  carrierTarget: number;
  paused: boolean;
  /** Source by mining instead of buying at a market — an explicit operator
   *  choice, see feed.ts's Feed.mine comment. */
  mine: boolean;
  /** Pinned source market — see feed.ts's Feed.buyAt comment. */
  buyAt: string | null;
  /** Operator override: buy regardless of the margin gate — see feed.ts's
   *  Feed.force comment. */
  force: boolean;
  /** Per-feed sell-pacing gap override (ms) — see feed.ts's
   *  DEFAULT_SELL_GAP_MS comment. null means "use the default." */
  sellGapMs: number | null;
  /** Chain membership — see feed.ts's FeedChain comment. */
  chainId: string | null;
  chainName: string | null;
  chainOrder: number | null;
  /** Credits per unit the feed will accept paying above what the target pays — see migrations/040. null = default margin gate. */
  maxLossPerUnit: number | null;
  /** Stop sourcing once the target's supply reaches this bucket. null = never. */
  stopAtSupply: string | null;
  /** Drone-plus-collector mining — see migrations/042 and feed.ts's Feed.field / Feed.collector. */
  field: string | null;
  collector: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a freshly registered SpaceTraders agent starts with. */
const STARTING_CREDITS = 175_000;

export class Store {
  constructor(private readonly pool: pg.Pool) {}

  // ── Ops layer reads (src/ops/) ──────────────────────────────

  async opsLedger(tenantId: string, f: { ship?: string; good?: string; type?: string; waypoint?: string; sinceIso: string; limit: number }): Promise<Record<string, unknown>[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const where = ["timestamp >= $1"];
      const args: unknown[] = [f.sinceIso];
      const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
      if (f.ship) add("ship_symbol = ?", f.ship);
      if (f.good) add("trade_symbol = ?", f.good);
      if (f.type) add("type = ?", f.type.toUpperCase());
      if (f.waypoint) add("waypoint_symbol = ?", f.waypoint);
      args.push(f.limit);
      const r = await c.query(
        `SELECT timestamp, ship_symbol, type, trade_symbol, units, waypoint_symbol, price_per_unit, total, realized_pnl, wallet_after
         FROM ledger WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT $${args.length}`,
        args,
      );
      return r.rows;
    });
  }

  /** Ledger roll-ups for the ops `pnl` tool: by type, matched trading profit, per-ship leaders. */
  async opsPnl(tenantId: string, sinceIso: string): Promise<{
    byType: { type: string; n: number; total: number }[];
    matched: { sells: number; pnl: number };
    byShip: { shipSymbol: string; sells: number; pnl: number; revenue: number }[];
  }> {
    return withTenant(this.pool, tenantId, async (c) => {
      const t = await c.query(`SELECT type, COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total FROM ledger WHERE timestamp >= $1 GROUP BY type ORDER BY type`, [sinceIso]);
      const m = await c.query(`SELECT COUNT(*)::int AS sells, COALESCE(SUM(realized_pnl),0) AS pnl FROM ledger WHERE timestamp >= $1 AND type = 'SELL' AND realized_pnl IS NOT NULL`, [sinceIso]);
      const s = await c.query(
        `SELECT ship_symbol, COUNT(*)::int AS sells, COALESCE(SUM(realized_pnl),0) AS pnl, COALESCE(SUM(total),0) AS revenue
         FROM ledger WHERE timestamp >= $1 AND type = 'SELL' AND realized_pnl IS NOT NULL
         GROUP BY ship_symbol ORDER BY pnl DESC LIMIT 15`,
        [sinceIso],
      );
      return {
        byType: t.rows.map((r: any) => ({ type: r.type, n: r.n, total: Math.round(Number(r.total)) })),
        matched: { sells: m.rows[0]?.sells ?? 0, pnl: Math.round(Number(m.rows[0]?.pnl ?? 0)) },
        byShip: s.rows.map((r: any) => ({ shipSymbol: r.ship_symbol, sells: r.sells, pnl: Math.round(Number(r.pnl)), revenue: Math.round(Number(r.revenue)) })),
      };
    });
  }

  /** Every charted system with its market/shipyard counts, priced-market stats and gate adjacency — one pass, for ops survey tools. */
  async opsGalaxyGraph(): Promise<{
    system: string; type: string; markets: number; shipyards: number; priced: number; newest: string | null;
    gates: { gate: string; to: string[] }[];
  }[]> {
    return withPool(this.pool, async (c) => {
      const g = await c.query(
        `SELECT system_symbol, system_type, jump_gates::text AS gates,
           (SELECT COUNT(*) FROM jsonb_array_elements(waypoints::jsonb) w WHERE w::text LIKE '%MARKETPLACE%')::int AS markets,
           (SELECT COUNT(*) FROM jsonb_array_elements(waypoints::jsonb) w WHERE w::text LIKE '%SHIPYARD%')::int AS yards
         FROM galaxy_systems`,
      );
      const p = await c.query(`SELECT system_symbol, COUNT(DISTINCT waypoint_symbol)::int AS priced, MAX(timestamp) AS newest FROM market_latest GROUP BY system_symbol`);
      const pm = new Map(p.rows.map((r: any) => [r.system_symbol, r]));
      return g.rows.map((r: any) => {
        let gates: { gate: string; to: string[] }[] = [];
        try {
          gates = (JSON.parse(r.gates ?? "[]") as any[]).map((x) => ({ gate: x.symbol, to: (x.connections ?? []).map((c: string) => c.slice(0, c.lastIndexOf("-"))) }));
        } catch { /* leave empty */ }
        const pr: any = pm.get(r.system_symbol);
        return { system: r.system_symbol, type: r.system_type, markets: r.markets, shipyards: r.yards, priced: pr?.priced ?? 0, newest: pr?.newest ? new Date(pr.newest).toISOString() : null, gates };
      });
    });
  }

  /** Gate construction status by gate waypoint (true = complete). */
  async opsGateStatus(): Promise<Map<string, boolean>> {
    return withPool(this.pool, async (c) => {
      const r = await c.query(`SELECT gate_symbol, is_complete FROM galaxy_gate_construction`);
      return new Map(r.rows.map((x: any) => [x.gate_symbol, !!x.is_complete]));
    });
  }

  async opsMarketFreshness(systemSymbol: string): Promise<{ waypoint: string; goods: number; newest: string | null; ageMin: number | null }[]> {
    return withPool(this.pool, async (c) => {
      const w = await c.query(`SELECT waypoints::text AS wps FROM galaxy_systems WHERE system_symbol = $1`, [systemSymbol]);
      let symbols: string[] = [];
      try {
        symbols = (JSON.parse(w.rows[0]?.wps ?? "[]") as any[]).filter((x) => JSON.stringify(x).includes("MARKETPLACE")).map((x) => x.symbol);
      } catch { /* leave empty */ }
      const m = await c.query(
        `SELECT waypoint_symbol, COUNT(*)::int AS goods, MAX(timestamp) AS newest FROM market_latest WHERE system_symbol = $1 GROUP BY waypoint_symbol`,
        [systemSymbol],
      );
      const by = new Map(m.rows.map((r: any) => [r.waypoint_symbol, r]));
      const now = Date.now();
      return symbols.map((wp) => {
        const r: any = by.get(wp);
        const newest = r?.newest ? new Date(r.newest).getTime() : undefined;
        return { waypoint: wp, goods: r?.goods ?? 0, newest: newest ? new Date(newest).toISOString() : null, ageMin: newest ? Math.round((now - newest) / 60000) : null };
      }).sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
    });
  }

  /** Recent server instances (heartbeat rows, newest first), for the ops `instances` tool. */
  async opsInstances(withinHours: number): Promise<{ instanceId: string; startedAt: string; lastSeen: string; aliveNow: boolean }[]> {
    return withPool(this.pool, async (c) => {
      const r = await c.query(
        `SELECT instance_id, started_at, last_seen, (last_seen > now() - interval '40 seconds') AS alive
         FROM instance_heartbeats WHERE last_seen > now() - ($1 || ' hours')::interval ORDER BY started_at DESC`,
        [String(withinHours)],
      );
      return r.rows.map((x: any) => ({ instanceId: x.instance_id, startedAt: new Date(x.started_at).toISOString(), lastSeen: new Date(x.last_seen).toISOString(), aliveNow: !!x.alive }));
    });
  }

  // ── Instance heartbeats ─────────────────────────────────────

  /** Refresh this process's liveness row (see migration 034). */
  async touchInstance(instanceId: string, startedAt: Date): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO instance_heartbeats (instance_id, started_at, last_seen) VALUES ($1, $2, now())
         ON CONFLICT (instance_id) DO UPDATE SET last_seen = now()`,
        [instanceId, startedAt.toISOString()],
      ),
    );
  }

  /** Instances other than `self` that checked in within the last `withinSec`
   *  seconds — i.e. alive right now alongside this one. Also prunes rows
   *  that have been silent for a day so the table stays tiny. */
  async otherLiveInstances(self: string, withinSec: number): Promise<{ instanceId: string; startedAt: string }[]> {
    return withPool(this.pool, async (c) => {
      await c.query(`DELETE FROM instance_heartbeats WHERE last_seen < now() - interval '1 day'`);
      const r = await c.query(
        `SELECT instance_id, started_at FROM instance_heartbeats
         WHERE instance_id <> $1 AND last_seen > now() - ($2 || ' seconds')::interval ORDER BY started_at`,
        [self, String(withinSec)],
      );
      return r.rows.map((x: any) => ({ instanceId: x.instance_id, startedAt: new Date(x.started_at).toISOString() }));
    });
  }

  // ── Ledger ──────────────────────────────────────────────────

  async recordLedger(tenantId: string, entry: LedgerEntry): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO ledger (tenant_id, timestamp, ship_symbol, waypoint_symbol, type, trade_symbol, units, price_per_unit, total, realized_pnl, wallet_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenantId,
          entry.timestamp,
          entry.shipSymbol,
          entry.waypointSymbol,
          entry.type,
          entry.tradeSymbol ?? null,
          entry.units ?? null,
          entry.pricePerUnit ?? null,
          entry.total,
          entry.realizedPnl ?? null,
          entry.walletAfter ?? null,
        ],
      );
      if (entry.type === "SHIP") {
        await this.logFleetEvent(
          c, tenantId, "ship_purchased", entry.shipSymbol,
          `bought ${entry.shipSymbol} (${entry.tradeSymbol ?? "?"}) at ${entry.waypointSymbol} for ${Math.round(entry.total)}c`,
          { shipType: entry.tradeSymbol ?? null, yard: entry.waypointSymbol, price: Math.round(entry.total) },
        );
      }
    });
  }

  /**
   * Realized P&L from completed round trips only — sum of `realized_pnl`
   * across SELL rows that actually tracked a cost basis, in the window
   * since `sinceIso`. Deliberately excludes open positions (a buy with no
   * matching sell yet) and non-trading costs (fuel/repair/ship purchases),
   * unlike netSeries()'s gross-totals-per-bucket, which is why that number
   * can swing hard negative in a window that just happens to catch a buy
   * before its sell — see CLAUDE.md's "Reporting matched buy/sell P&L".
   */
  async matchedNet(tenantId: string, sinceIso: string): Promise<{ net: number; trades: number }> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ net: number | null; trades: string }>(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS net, COUNT(*) AS trades
         FROM ledger
         WHERE timestamp >= $1 AND type = 'SELL' AND realized_pnl IS NOT NULL`,
        [sinceIso],
      );
      return { net: Math.round(res.rows[0]?.net ?? 0), trades: Number(res.rows[0]?.trades ?? 0) };
    });
  }

  async ledgerTotals(tenantId: string): Promise<{ credits: number; buys: number; sells: number }> {
    return withTenant(this.pool, tenantId, async (c) => {
      // `total` is always stored as a positive magnitude (res.transaction.totalPrice,
      // never negated at insertion — see trader.ts's recordLedger call sites) —
      // direction comes entirely from `type`, not from the sign of `total`.
      const res = await c.query<{ buys: string | null; sells: string | null }>(
        `SELECT
           COALESCE(SUM(total) FILTER (WHERE type = 'PURCHASE'), 0) AS buys,
           COALESCE(SUM(total) FILTER (WHERE type = 'SELL'), 0) AS sells
         FROM ledger`,
      );
      const row = res.rows[0]!;
      const buys = Number(row.buys ?? 0);
      const sells = Number(row.sells ?? 0);
      return { credits: sells - buys, buys, sells };
    });
  }

  /**
   * Sell entries at one waypoint for a given set of goods, newest first —
   * for watching whether a deliberate buy-side manipulation attempt
   * (docs/TODO.md's supply-chain-aware pricing idea) is actually landing
   * sells at the intended market. Tenant-scoped like every other ledger
   * read (RLS via withTenant) — this tenant's own sells only, same as the
   * rest of the ledger.
   */
  async ledgerSellsAt(tenantId: string, waypointSymbol: string, tradeSymbols: string[], limit = 50): Promise<
    { timestamp: string; shipSymbol: string; tradeSymbol: string; units: number; pricePerUnit: number; total: number }[]
  > {
    if (tradeSymbols.length === 0) return [];
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{
        timestamp: Date; ship_symbol: string; trade_symbol: string; units: number; price_per_unit: number; total: number;
      }>(
        `SELECT timestamp, ship_symbol, trade_symbol, units, price_per_unit, total
         FROM ledger WHERE type = 'SELL' AND waypoint_symbol = $1 AND trade_symbol = ANY($2::text[])
         ORDER BY timestamp DESC LIMIT $3`,
        [waypointSymbol, tradeSymbols, limit],
      );
      return res.rows.map((r) => ({
        timestamp: r.timestamp.toISOString(),
        shipSymbol: r.ship_symbol,
        tradeSymbol: r.trade_symbol,
        units: r.units,
        pricePerUnit: r.price_per_unit,
        total: r.total,
      }));
    });
  }

  // ── Activity ────────────────────────────────────────────────

  async recordActivity(tenantId: string, entry: ActivityEntry): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO activity (tenant_id, timestamp, ship_symbol, kind, detail, credits)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, entry.timestamp, entry.shipSymbol, entry.kind, entry.detail, entry.credits ?? null],
      ),
    );
  }

  /* ── crew log ──────────────────────────────────────────────
     A hull's assigned captain, and the entries that captain has earned.
     Strictly narrative — nothing here is read by routing, trading or
     doctrine. See src/engine/personas.ts. */

  /** Explicit persona assignments only. Unassigned hulls fall back to
   *  personas.ts's deterministic default, so this is usually sparse. */
  async shipPersonas(tenantId: string): Promise<Map<string, string>> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; persona_key: string }>(
        `SELECT ship_symbol, persona_key FROM ship_persona`,
      );
      return new Map(res.rows.map((r) => [r.ship_symbol, r.persona_key]));
    });
  }

  async setShipPersona(tenantId: string, shipSymbol: string, personaKey: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ship_persona (tenant_id, ship_symbol, persona_key) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, ship_symbol) DO UPDATE SET persona_key = EXCLUDED.persona_key, assigned_at = now()`,
        [tenantId, shipSymbol, personaKey],
      ),
    );
  }

  /**
   * Record an earned log entry. `entry` is null when the event qualified but
   * nothing wrote it up — budget spent, or generation switched off. Those
   * rows are what make the firing rate observable without spending tokens.
   */
  async recordShipLog(tenantId: string, row: ShipLogRow): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ship_log (tenant_id, ship_symbol, ts, persona_key, trigger_kind, notability, detail, entry)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, row.shipSymbol, row.timestamp, row.personaKey, row.triggerKind, row.notability, row.detail, row.entry ?? null],
      ),
    );
  }

  /** The feed, newest first. `shipSymbol` narrows it to one hull's log. */
  async shipLog(tenantId: string, opts: { limit?: number; shipSymbol?: string } = {}): Promise<ShipLogRow[]> {
    const limit = opts.limit ?? 40;
    return withTenant(this.pool, tenantId, async (c) => {
      const res = opts.shipSymbol
        ? await c.query<ShipLogDbRow>(
            `SELECT ship_symbol, ts, persona_key, trigger_kind, notability, detail, entry
             FROM ship_log WHERE ship_symbol = $1 ORDER BY ts DESC, id DESC LIMIT $2`,
            [opts.shipSymbol, limit],
          )
        : await c.query<ShipLogDbRow>(
            `SELECT ship_symbol, ts, persona_key, trigger_kind, notability, detail, entry
             FROM ship_log ORDER BY ts DESC, id DESC LIMIT $1`,
            [limit],
          );
      return res.rows.map((r) => ({
        shipSymbol: r.ship_symbol,
        timestamp: r.ts.toISOString(),
        personaKey: r.persona_key,
        triggerKind: r.trigger_kind,
        notability: r.notability,
        detail: r.detail,
        entry: r.entry ?? undefined,
      }));
    });
  }

  /** When each hull last logged, for the per-ship cooldown. */
  async lastShipLogAt(tenantId: string): Promise<Map<string, number>> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; ts: Date }>(
        `SELECT ship_symbol, max(ts) AS ts FROM ship_log GROUP BY ship_symbol`,
      );
      return new Map(res.rows.map((r) => [r.ship_symbol, r.ts.getTime()]));
    });
  }

  async recentActivity(tenantId: string, limit = 50): Promise<ActivityEntry[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ timestamp: Date; ship_symbol: string; kind: string; detail: string; credits: number | null }>(
        `SELECT timestamp, ship_symbol, kind, detail, credits FROM activity ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => ({
        timestamp: r.timestamp.toISOString(),
        shipSymbol: r.ship_symbol,
        kind: r.kind,
        detail: r.detail,
        credits: r.credits ?? undefined,
      }));
    });
  }

  /**
   * Average/max/min sell price per minute for a good, from the SHARED galaxy
   * table — same data for every tenant, so this is the one "activity-shaped"
   * method that isn't tenant-scoped despite living in this section.
   *
   * `waypointSymbol` narrows the fleet-wide aggregate to one specific
   * market — added because the aggregate mixes every market's price for a
   * good into one line, which is actively misleading for a good sold at
   * several very different markets (a real live case: IRON's price at F49
   * vs F50 vs H56 differed by 2-3x, and the combined average tracked none
   * of them). Omit it for the original fleet-wide behavior.
   *
   * The combined ("all markets") path forward-fills: naively grouping raw
   * snapshots by minute and averaging looked "wrong" for a good sold at
   * only two very differently-priced markets (confirmed live, ASSAULT_RIFLES
   * at ~9502c vs ~5248c) — each market's own keeper/probe visits on its own
   * staggered schedule, so almost no minute bucket ever contains a snapshot
   * from more than one market. The "average" was really just toggling
   * between whichever single market happened to report that minute, a
   * sawtooth that looked like price volatility but was really just which
   * market got sampled. Carrying each market's last known price forward
   * into every minute (a per-waypoint as-of join) turns that into a real
   * blended trend instead.
   */
  async goodPriceHistory(good: string, since: string, waypointSymbol?: string): Promise<{ t: string; avg: number; min: number; max: number; buyAvg: number; buyMin: number; buyMax: number }[]> {
    return withPool(this.pool, async (c) => {
      const res = waypointSymbol
        ? await c.query<{ t: string; avg: string; min: number; max: number; buy_avg: string; buy_min: number; buy_max: number }>(
            `SELECT
               to_char(date_trunc('minute', timestamp), 'YYYY-MM-DD"T"HH24:MI') AS t,
               ROUND(AVG(sell_price)::numeric, 1) AS avg,
               MIN(sell_price) AS min,
               MAX(sell_price) AS max,
               ROUND(AVG(purchase_price)::numeric, 1) AS buy_avg,
               MIN(purchase_price) AS buy_min,
               MAX(purchase_price) AS buy_max
             FROM market_snapshots
             WHERE good_symbol = $1 AND timestamp >= $2 AND waypoint_symbol = $3
             GROUP BY t
             ORDER BY t ASC`,
            [good, since, waypointSymbol],
          )
        : await c.query<{ t: string; avg: string; min: number; max: number; buy_avg: string; buy_min: number; buy_max: number }>(
            `WITH waypoints AS (
               SELECT DISTINCT waypoint_symbol FROM market_snapshots WHERE good_symbol = $1 AND timestamp >= $2::timestamptz
             ),
             minutes AS (
               SELECT generate_series(date_trunc('minute', $2::timestamptz), date_trunc('minute', now()), interval '1 minute') AS t
             ),
             filled AS (
               SELECT m.t, f.sell_price, f.purchase_price
               FROM minutes m
               CROSS JOIN waypoints w
               LEFT JOIN LATERAL (
                 SELECT ms.sell_price, ms.purchase_price
                 FROM market_snapshots ms
                 WHERE ms.good_symbol = $1 AND ms.waypoint_symbol = w.waypoint_symbol AND ms.timestamp <= m.t
                 ORDER BY ms.timestamp DESC
                 LIMIT 1
               ) f ON true
             )
             SELECT
               to_char(t, 'YYYY-MM-DD"T"HH24:MI') AS t,
               ROUND(AVG(sell_price)::numeric, 1) AS avg,
               MIN(sell_price) AS min,
               MAX(sell_price) AS max,
               ROUND(AVG(purchase_price)::numeric, 1) AS buy_avg,
               MIN(purchase_price) AS buy_min,
               MAX(purchase_price) AS buy_max
             FROM filled
             WHERE sell_price IS NOT NULL
             GROUP BY t
             ORDER BY t ASC`,
            [good, since],
          );
      return res.rows.map((r) => ({ t: r.t, avg: Number(r.avg), min: r.min, max: r.max, buyAvg: Number(r.buy_avg), buyMin: r.buy_min, buyMax: r.buy_max }));
    });
  }

  // ── Doctrine ────────────────────────────────────────────────

  async getDoctrine(tenantId: string): Promise<{ key: string; value: number; enabled: boolean; adopted: boolean }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ key: string; value: number; enabled: boolean; adopted: boolean }>(`SELECT key, value, enabled, adopted FROM doctrine`);
      return res.rows;
    });
  }

  /** `adopted` defaults to true (unchanged pre-existing callers, e.g.
   *  ensureShipTypeRule(), which always pass it explicitly now, but keeping
   *  the default here too matches the migration's own DEFAULT true — see
   *  docs/policy-library-and-onboarding-plan.md). */
  async setDoctrine(tenantId: string, key: string, value: number, enabled: boolean, adopted = true): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO doctrine (tenant_id, key, value, enabled, adopted, updated_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, enabled = excluded.enabled, adopted = excluded.adopted, updated_at = excluded.updated_at`,
        [tenantId, key, value, enabled, adopted],
      ),
    );
  }

  // ── Fleet state (persisted role decisions, restored at boot) ─

  async getFleetState(tenantId: string): Promise<FleetStateRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; role: string; keeper_market: string | null; updated_at: Date }>(
        `SELECT ship_symbol, role, keeper_market, updated_at FROM fleet_state`,
      );
      return res.rows.map((r) => ({
        shipSymbol: r.ship_symbol,
        role: r.role,
        keeperMarket: r.keeper_market ?? undefined,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  /**
   * Appends one row to fleet_events (migration 037) on the caller's tenant
   * connection. Wrapped in a savepoint so a failure here can never abort the
   * transaction of the write it describes — history is best-effort, the action
   * it records is not.
   */
  private async logFleetEvent(
    c: pg.PoolClient,
    tenantId: string,
    kind: string,
    shipSymbol: string | undefined,
    detail: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await c.query("SAVEPOINT fleet_event");
      await c.query(
        `INSERT INTO fleet_events (agent_symbol, tenant_id, reset_date, kind, ship_symbol, detail, meta)
         SELECT agent_symbol, id, $2, $3, $4, $5, $6 FROM tenants WHERE id = $1`,
        [tenantId, getCurrentResetDate(), kind, shipSymbol ?? null, detail, meta ? JSON.stringify(meta) : null],
      );
      await c.query("RELEASE SAVEPOINT fleet_event");
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT fleet_event").catch(() => {});
    }
  }

  async setFleetState(tenantId: string, shipSymbol: string, role: string, keeperMarket?: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      const prev = (await c.query<{ role: string }>(`SELECT role FROM fleet_state WHERE ship_symbol = $1`, [shipSymbol])).rows[0]?.role;
      await c.query(
        `INSERT INTO fleet_state (tenant_id, ship_symbol, role, keeper_market, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, ship_symbol) DO UPDATE SET role = excluded.role, keeper_market = excluded.keeper_market, updated_at = excluded.updated_at`,
        [tenantId, shipSymbol, role, keeperMarket ?? null],
      );
      if (prev !== role) {
        await this.logFleetEvent(c, tenantId, "role_change", shipSymbol, `${shipSymbol}: ${prev ?? "(new)"} → ${role}`, {
          from: prev ?? null,
          to: role,
          keeperMarket: keeperMarket ?? null,
        });
      }
    });
  }

  async removeFleetState(tenantId: string, shipSymbol: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) => c.query(`DELETE FROM fleet_state WHERE ship_symbol = $1`, [shipSymbol]));
  }

  // ── State snapshot (last-known-good /api/state, for a failed boot) ─

  /** The exact JSON /api/state last served successfully, plus when. Read
   *  back only when a tenant's live boot fails and there's nothing else to
   *  answer with — see tenantRegistry.ts's refreshState() (the writer) and
   *  dashboard.ts's /state route (the reader). */
  async getStateSnapshot(tenantId: string): Promise<{ snapshot: unknown; updatedAt: string } | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ snapshot: unknown; updated_at: Date }>(`SELECT snapshot, updated_at FROM state_snapshot`);
      const row = res.rows[0];
      return row ? { snapshot: row.snapshot, updatedAt: row.updated_at.toISOString() } : undefined;
    });
  }

  async saveStateSnapshot(tenantId: string, snapshot: unknown): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO state_snapshot (tenant_id, snapshot, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (tenant_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
        [tenantId, JSON.stringify(snapshot)],
      ),
    );
  }

  // ── Ship state (Greenfield Phase 2: persisted lifecycle) ────

  async getShipState(tenantId: string, shipSymbol: string): Promise<ShipStateRow | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; state: ShipLifecycleState; target: string | null; step: unknown; updated_at: Date }>(
        `SELECT ship_symbol, state, target, step, updated_at FROM ship_state WHERE ship_symbol = $1`,
        [shipSymbol],
      );
      const r = res.rows[0];
      if (!r) return undefined;
      return { shipSymbol: r.ship_symbol, state: r.state, target: r.target ?? undefined, step: r.step ?? undefined, updatedAt: r.updated_at.toISOString() };
    });
  }

  async getAllShipStates(tenantId: string): Promise<ShipStateRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; state: ShipLifecycleState; target: string | null; step: unknown; updated_at: Date }>(
        `SELECT ship_symbol, state, target, step, updated_at FROM ship_state`,
      );
      return res.rows.map((r) => ({
        shipSymbol: r.ship_symbol,
        state: r.state,
        target: r.target ?? undefined,
        step: r.step ?? undefined,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  async updateShipState(tenantId: string, shipSymbol: string, state: ShipLifecycleState, target?: string, step?: unknown): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ship_state (tenant_id, ship_symbol, state, target, step, updated_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, ship_symbol) DO UPDATE SET state = excluded.state, target = excluded.target, step = excluded.step, updated_at = excluded.updated_at`,
        [tenantId, shipSymbol, state, target ?? null, step === undefined ? null : JSON.stringify(step)],
      ),
    );
  }

  // ── Held routes (durable twin of TraderAgent's heldRoute/heldCost) ─

  async getAllHeldRoutes(tenantId: string): Promise<HeldRouteRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{
        ship_symbol: string; good_symbol: string; buy_at: string; sell_at: string;
        buy_price: number; sell_price: number; lot_size: number; cost_basis: number; updated_at: Date;
      }>(`SELECT ship_symbol, good_symbol, buy_at, sell_at, buy_price, sell_price, lot_size, cost_basis, updated_at FROM held_route`);
      return res.rows.map((r) => ({
        shipSymbol: r.ship_symbol,
        goodSymbol: r.good_symbol,
        buyAt: r.buy_at,
        sellAt: r.sell_at,
        buyPrice: r.buy_price,
        sellPrice: r.sell_price,
        lotSize: r.lot_size,
        costBasis: r.cost_basis,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  async setHeldRoute(
    tenantId: string,
    shipSymbol: string,
    good: string,
    leg: { buyAt: string; sellAt: string; buyPrice: number; sellPrice: number; lotSize: number },
    costBasis: number,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO held_route (tenant_id, ship_symbol, good_symbol, buy_at, sell_at, buy_price, sell_price, lot_size, cost_basis, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (tenant_id, ship_symbol, good_symbol) DO UPDATE SET
           buy_at = excluded.buy_at, sell_at = excluded.sell_at, buy_price = excluded.buy_price,
           sell_price = excluded.sell_price, lot_size = excluded.lot_size, cost_basis = excluded.cost_basis,
           updated_at = excluded.updated_at`,
        [tenantId, shipSymbol, good, leg.buyAt, leg.sellAt, leg.buyPrice, leg.sellPrice, leg.lotSize, costBasis],
      ),
    );
  }

  async deleteHeldRoute(tenantId: string, shipSymbol: string, good: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`DELETE FROM held_route WHERE ship_symbol = $1 AND good_symbol = $2`, [shipSymbol, good]),
    );
  }

  // ── Cargo manifest (Greenfield Phase 3: intent-tagged holds) ─

  private static mapManifestRow(r: { ship_symbol: string; good_symbol: string; units: number; cost_basis: number; basis_kind: CostBasisKind; intent: CargoIntent; acquired_at: Date }): ManifestRow {
    return {
      shipSymbol: r.ship_symbol,
      goodSymbol: r.good_symbol,
      units: r.units,
      costBasis: r.cost_basis,
      basisKind: r.basis_kind,
      intent: r.intent,
      acquiredAt: r.acquired_at.toISOString(),
    };
  }

  async getManifestForShip(tenantId: string, shipSymbol: string): Promise<ManifestRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query(`SELECT * FROM ship_manifest WHERE ship_symbol = $1`, [shipSymbol]);
      return res.rows.map(Store.mapManifestRow);
    });
  }

  async getAllManifestRows(tenantId: string): Promise<ManifestRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query(`SELECT * FROM ship_manifest`);
      return res.rows.map(Store.mapManifestRow);
    });
  }

  /** Upserts every row given, keyed on (ship, good) — the caller decides what "currently held" means. */
  async upsertManifestRows(tenantId: string, rows: Omit<ManifestRow, "acquiredAt">[]): Promise<void> {
    if (rows.length === 0) return;
    await withTenant(this.pool, tenantId, async (c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO ship_manifest (tenant_id, ship_symbol, good_symbol, units, cost_basis, basis_kind, intent, acquired_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (tenant_id, ship_symbol, good_symbol) DO UPDATE SET
             units = excluded.units, cost_basis = excluded.cost_basis, basis_kind = excluded.basis_kind, intent = excluded.intent`,
          [tenantId, r.shipSymbol, r.goodSymbol, r.units, r.costBasis, r.basisKind, r.intent],
        );
      }
    });
  }

  /** Drops rows for goods a ship no longer holds — the other half of reconciliation alongside upsertManifestRows. */
  async deleteManifestRows(tenantId: string, shipSymbol: string, goodSymbols: string[]): Promise<void> {
    if (goodSymbols.length === 0) return;
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`DELETE FROM ship_manifest WHERE ship_symbol = $1 AND good_symbol = ANY($2)`, [shipSymbol, goodSymbols]),
    );
  }

  // ── Ship claims (Greenfield Phase 4: ShipRegistry ownership) ─

  async recordClaim(tenantId: string, claim: ClaimRow): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ship_claims (tenant_id, ship_symbol, owner, role, intent, since) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, ship_symbol) DO UPDATE SET owner = excluded.owner, role = excluded.role, intent = excluded.intent, since = excluded.since`,
        [tenantId, claim.shipSymbol, claim.owner, claim.role, JSON.stringify(claim.intent), claim.since],
      ),
    );
  }

  /** Deletes the claim, but only if it's currently held by `owner` — mirrors ShipRegistry.release()'s same-owner-only semantics. */
  async releaseClaim(tenantId: string, shipSymbol: string, owner: ShipOwner): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`DELETE FROM ship_claims WHERE ship_symbol = $1 AND owner = $2`, [shipSymbol, owner]),
    );
  }

  private static mapClaimRow(r: { ship_symbol: string; owner: ShipOwner; role: string; intent: Record<string, unknown>; since: Date }): ClaimRow {
    return { shipSymbol: r.ship_symbol, owner: r.owner, role: r.role, intent: r.intent, since: r.since.toISOString() };
  }

  async getClaim(tenantId: string, shipSymbol: string): Promise<ClaimRow | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query(`SELECT * FROM ship_claims WHERE ship_symbol = $1`, [shipSymbol]);
      return res.rows[0] ? Store.mapClaimRow(res.rows[0]) : undefined;
    });
  }

  async getAllClaims(tenantId: string): Promise<ClaimRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query(`SELECT * FROM ship_claims`);
      return res.rows.map(Store.mapClaimRow);
    });
  }

  // ── Fleet flags (small per-tenant settings blobs) ──────────

  async getFleetFlag(tenantId: string, key: string): Promise<string | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ value: string }>(`SELECT value FROM fleet_flags WHERE key = $1`, [key]);
      return res.rows[0]?.value;
    });
  }

  async setFleetFlag(tenantId: string, key: string, value: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO fleet_flags (tenant_id, key, value, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [tenantId, key, value],
      ),
    );
  }

  async removeFleetFlag(tenantId: string, key: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) => c.query(`DELETE FROM fleet_flags WHERE key = $1`, [key]));
  }

  // ── Warehouse ───────────────────────────────────────────────

  async warehouseBalance(tenantId: string, goodSymbol: string): Promise<number> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ units: number }>(`SELECT units FROM warehouse WHERE good_symbol = $1`, [goodSymbol]);
      return res.rows[0]?.units ?? 0;
    });
  }

  /** Every good the warehouse holds, with cost basis and value at that basis. */
  async warehouseAll(tenantId: string): Promise<{ goodSymbol: string; units: number; avgCost: number; value: number }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ good_symbol: string; units: number; avg_cost: number }>(
        `SELECT good_symbol, units, avg_cost FROM warehouse WHERE units > 0 ORDER BY good_symbol`,
      );
      return res.rows.map((r) => ({
        goodSymbol: r.good_symbol,
        units: r.units,
        avgCost: r.avg_cost,
        value: Math.round(r.units * r.avg_cost),
      }));
    });
  }

  /** Total value of everything held, at cost basis. */
  async warehouseValue(tenantId: string): Promise<number> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ v: string }>(`SELECT COALESCE(SUM(units * avg_cost), 0) AS v FROM warehouse`);
      return Math.round(Number(res.rows[0]!.v));
    });
  }

  /**
   * Add units to the warehouse, recomputing the weighted-average cost basis
   * over the combined old + new holding. Returns the good's new total.
   *
   * Ported straight from straders' Store.warehouseDeposit — same formula,
   * same two-writes-per-call shape (the balance row, then the ledger entry).
   * The one real difference: straders reads-then-writes across two
   * synchronous statements with no transaction, which is safe there because
   * better-sqlite3 has no concurrent callers on the same connection. Here,
   * withTenant already wraps the whole method in one transaction (BEGIN at
   * the top, COMMIT at the end), so two deposits landing on the same good at
   * the same instant don't race on the read.
   */
  async warehouseDeposit(
    tenantId: string,
    goodSymbol: string,
    units: number,
    price: number,
    shipSymbol: string | undefined,
    reason: string,
  ): Promise<number> {
    if (units <= 0) throw new Error(`warehouseDeposit: units must be positive (got ${units})`);
    return withTenant(this.pool, tenantId, async (c) => {
      const current = await c.query<{ units: number; avg_cost: number }>(
        `SELECT units, avg_cost FROM warehouse WHERE good_symbol = $1 FOR UPDATE`,
        [goodSymbol],
      );
      const oldUnits = current.rows[0]?.units ?? 0;
      const oldCost = current.rows[0]?.avg_cost ?? 0;
      const newUnits = oldUnits + units;
      const newAvgCost = (oldUnits * oldCost + units * price) / newUnits;
      await c.query(
        `INSERT INTO warehouse (tenant_id, good_symbol, units, avg_cost, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, good_symbol) DO UPDATE SET units = excluded.units, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at`,
        [tenantId, goodSymbol, newUnits, newAvgCost],
      );
      await c.query(
        `INSERT INTO warehouse_ledger (tenant_id, timestamp, good_symbol, delta, price, ship_symbol, reason) VALUES ($1, now(), $2, $3, $4, $5, $6)`,
        [tenantId, goodSymbol, units, price, shipSymbol ?? null, reason],
      );
      return newUnits;
    });
  }

  /**
   * Remove up to `units` from the warehouse, clamped to what's actually held.
   * Withdrawing never changes avgCost — only a deposit moves the cost basis.
   */
  async warehouseWithdraw(
    tenantId: string,
    goodSymbol: string,
    units: number,
    price: number,
    shipSymbol: string | undefined,
    reason: string,
  ): Promise<{ units: number; avgCost: number }> {
    if (units <= 0) throw new Error(`warehouseWithdraw: units must be positive (got ${units})`);
    return withTenant(this.pool, tenantId, async (c) => {
      const current = await c.query<{ units: number; avg_cost: number }>(
        `SELECT units, avg_cost FROM warehouse WHERE good_symbol = $1 FOR UPDATE`,
        [goodSymbol],
      );
      const held = current.rows[0]?.units ?? 0;
      const avgCost = current.rows[0]?.avg_cost ?? 0;
      const actual = Math.min(units, held);
      if (actual <= 0) return { units: 0, avgCost };
      await c.query(`UPDATE warehouse SET units = units - $1, updated_at = now() WHERE good_symbol = $2`, [actual, goodSymbol]);
      await c.query(
        `INSERT INTO warehouse_ledger (tenant_id, timestamp, good_symbol, delta, price, ship_symbol, reason) VALUES ($1, now(), $2, $3, $4, $5, $6)`,
        [tenantId, goodSymbol, -actual, price, shipSymbol ?? null, reason],
      );
      return { units: actual, avgCost };
    });
  }

  /** Recent warehouse movements, newest first — the audit trail behind the balances. */
  async warehouseLedger(
    tenantId: string,
    limit = 50,
  ): Promise<{ timestamp: string; goodSymbol: string; delta: number; price: number; shipSymbol: string | null; reason: string }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{
        timestamp: Date;
        good_symbol: string;
        delta: number;
        price: number;
        ship_symbol: string | null;
        reason: string;
      }>(`SELECT timestamp, good_symbol, delta, price, ship_symbol, reason FROM warehouse_ledger ORDER BY timestamp DESC LIMIT $1`, [
        limit,
      ]);
      return res.rows.map((r) => ({
        timestamp: r.timestamp.toISOString(),
        goodSymbol: r.good_symbol,
        delta: r.delta,
        price: r.price,
        shipSymbol: r.ship_symbol,
        reason: r.reason,
      }));
    });
  }

  /** The curated list of goods the warehouse is allowed to buy/sell. A good
   *  with no row here is never warehoused, however profitable its route. */
  async warehouseTargetList(tenantId: string): Promise<{ goodSymbol: string; target: number; forMission: boolean }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ good_symbol: string; target: number; for_mission: boolean }>(
        `SELECT good_symbol, target, for_mission FROM warehouse_targets ORDER BY good_symbol`,
      );
      return res.rows.map((r) => ({ goodSymbol: r.good_symbol, target: r.target, forMission: r.for_mission }));
    });
  }

  /** Add a good to the curated list, or update its target/forMission flag. */
  async setWarehouseTarget(tenantId: string, goodSymbol: string, target: number, forMission: boolean): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO warehouse_targets (tenant_id, good_symbol, target, for_mission) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, good_symbol) DO UPDATE SET target = excluded.target, for_mission = excluded.for_mission`,
        [tenantId, goodSymbol, target, forMission],
      ),
    );
  }

  /** Remove a good from the curated list — it stops being bought/sold through the warehouse. */
  async removeWarehouseTarget(tenantId: string, goodSymbol: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) => c.query(`DELETE FROM warehouse_targets WHERE good_symbol = $1`, [goodSymbol]));
  }

  // ── Cost-basis recovery (ported from the straders A3 fix) ──

  /**
   * This ship's cost basis for a good it's still holding — the weighted
   * average of purchase lots since its last full sale, not just the most
   * recent transaction's price. Confirmed live: an 80-unit buy in two lots
   * (60u@1991c, 20u@2244c — true weighted average 2054c) recovered as a
   * flat 2244c (just the last lot) after a restart wiped `heldCost`,
   * understating the real basis and letting the loss-floor check
   * (`exceedsLossFloor()` in trader.ts) pass a sale it should have blocked.
   * "Since the last full sale" is a purchase-timestamp cutoff at the most
   * recent SELL row for this ship+good — everything bought before that sale
   * is presumed already sold off, same assumption `heldRoute`'s own pruning
   * makes (a good not currently in the hold has no live pin).
   */
  async lastPurchasePrice(tenantId: string, shipSymbol: string, goodSymbol: string): Promise<number | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ avg_cost: number | null }>(
        `SELECT SUM(units * price_per_unit) / NULLIF(SUM(units), 0) AS avg_cost FROM ledger
         WHERE type = 'PURCHASE' AND ship_symbol = $1 AND trade_symbol = $2 AND units > 0 AND price_per_unit > 0
           AND timestamp > COALESCE(
             (SELECT MAX(timestamp) FROM ledger WHERE type = 'SELL' AND ship_symbol = $1 AND trade_symbol = $2),
             '-infinity'::timestamptz
           )`,
        [shipSymbol, goodSymbol],
      );
      return res.rows[0]?.avg_cost ?? undefined;
    });
  }

  async avgPurchasePrice(tenantId: string, goodSymbol: string, withinDays = 30): Promise<number | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ avg_cost: number | null }>(
        `SELECT SUM(units * price_per_unit) / SUM(units) AS avg_cost FROM ledger
         WHERE type = 'PURCHASE' AND trade_symbol = $1 AND units > 0 AND price_per_unit > 0
           AND timestamp >= now() - ($2 || ' days')::interval`,
        [goodSymbol, withinDays],
      );
      return res.rows[0]?.avg_cost ?? undefined;
    });
  }

  // ── Shared galaxy data: markets, shipyards, modules ────────
  // No tenant_id anywhere below — these three tables hold public data, same
  // for every tenant on the same server reset. See the class doc comment.

  async recordMarket(m: Omit<MarketRow, "timestamp">): Promise<void> {
    this.dropLatestMemo();
    await this.recordMarkets([m]);
  }

  /**
   * Bulk version of recordMarket() — one pool checkout and one multi-row
   * INSERT per table, instead of one checkout per good. A single market
   * scan (background refresh or boot) can be 100-150+ individual goods
   * across every market in a system; at one recordMarket() call each, that
   * was 100-150+ separate pool.connect() calls landing in a tight loop —
   * confirmed in production as the actual cause of dashboard requests
   * queuing for a free connection (pool maxed at 10, some checkouts taking
   * 500-800ms, real Store work waiting behind them). Chunked defensively —
   * not needed at today's fleet sizes, but caps how large a single INSERT
   * ever gets if a much bigger system is ever scanned.
   */
  async recordMarkets(rows: Omit<MarketRow, "timestamp">[]): Promise<void> {
    this.dropLatestMemo();
    if (rows.length === 0) return;
    const CHUNK = 200;
    await withPool(this.pool, async (c) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const historyValues: string[] = [];
        const latestValues: string[] = [];
        const params: unknown[] = [];
        chunk.forEach((m, idx) => {
          const base = idx * 9;
          const p = Array.from({ length: 9 }, (_, k) => `$${base + k + 1}`);
          historyValues.push(`(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, ${p[6]}, ${p[7]}, ${p[8]}, now())`);
          latestValues.push(`(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, ${p[6]}, ${p[7]}, ${p[8]}, now())`);
          params.push(m.systemSymbol, m.waypointSymbol, m.goodSymbol, m.type, m.supply, m.purchasePrice, m.sellPrice, m.tradeVolume, m.activity ?? null);
        });
        await c.query(
          `INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, activity, timestamp)
           VALUES ${historyValues.join(", ")}`,
          params,
        );
        // Greenfield Phase 1 read model: keep market_latest in lockstep with
        // the append-only history table so latestMarketSnapshots/
        // freshMarketSnapshots/bestTrades/tradeLegs can read one row per
        // waypoint+good directly instead of re-deriving it with a
        // ROW_NUMBER() OVER (PARTITION BY ...) scan of the whole history.
        await c.query(
          `INSERT INTO market_latest (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, activity, timestamp)
           VALUES ${latestValues.join(", ")}
           ON CONFLICT (waypoint_symbol, good_symbol) DO UPDATE SET
             activity = excluded.activity,
             system_symbol = excluded.system_symbol,
             type = excluded.type,
             supply = excluded.supply,
             purchase_price = excluded.purchase_price,
             sell_price = excluded.sell_price,
             trade_volume = excluded.trade_volume,
             timestamp = excluded.timestamp`,
          params,
        );
      }
    });
  }

  /**
   * The full recorded price history for one good at one waypoint, newest
   * first — a plain read of the append-only `market_snapshots` table
   * (never overwritten, unlike `market_latest`), for watching whether a
   * price actually moved after a deliberate buy-side manipulation attempt
   * (docs/TODO.md's supply-chain-aware pricing idea). No new persistence:
   * every recordMarkets() call already writes here regardless of why the
   * snapshot was taken.
   */
  async marketPriceHistory(waypointSymbol: string, goodSymbol: string, limit = 50): Promise<MarketRow[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        system_symbol: string; waypoint_symbol: string; good_symbol: string; type: string;
        supply: string; purchase_price: number; sell_price: number; trade_volume: number; timestamp: Date;
      }>(
        `SELECT system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp
         FROM market_snapshots WHERE waypoint_symbol = $1 AND good_symbol = $2
         ORDER BY timestamp DESC LIMIT $3`,
        [waypointSymbol, goodSymbol, limit],
      );
      return res.rows.map(Store.mapMarketRow);
    });
  }

  private static mapMarketRow(r: {
    system_symbol: string;
    waypoint_symbol: string;
    good_symbol: string;
    type: string;
    supply: string;
    purchase_price: number;
    sell_price: number;
    trade_volume: number;
    timestamp: Date;
  }): MarketRow {
    return {
      systemSymbol: r.system_symbol,
      waypointSymbol: r.waypoint_symbol,
      goodSymbol: r.good_symbol,
      type: r.type,
      supply: r.supply,
      purchasePrice: r.purchase_price,
      sellPrice: r.sell_price,
      tradeVolume: r.trade_volume,
      timestamp: r.timestamp.toISOString(),
    };
  }

  /**
   * The lowest positive purchase price recorded for one good at one
   * waypoint since `sinceMs` (epoch ms) — a plain MIN() over the append-
   * only `market_snapshots` history, for anchoring a "what has this
   * actually cost when not run up by our own buying" baseline. Windowed
   * rather than all-time on purpose: a fresh post-reset market opens at its
   * cheapest and only drifts up from there, so an all-time minimum pins the
   * baseline to a price the market may never offer again. Returns undefined
   * if there are no snapshots in the window.
   */
  async cheapestKnownPrice(waypointSymbol: string, goodSymbol: string, sinceMs: number): Promise<number | undefined> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ min: number | null }>(
        `SELECT MIN(purchase_price) FROM market_snapshots
         WHERE waypoint_symbol = $1 AND good_symbol = $2 AND purchase_price > 0 AND timestamp >= $3`,
        [waypointSymbol, goodSymbol, new Date(sinceMs).toISOString()],
      );
      return res.rows[0]?.min ?? undefined;
    });
  }

  /**
   * Return the most recent market snapshot per waypoint per good — a plain
   * read of the market_latest projection (Greenfield Phase 1), not a
   * PARTITION BY scan of the whole append-only history table.
   */
  /** Persist a market read's `transactions` (every agent's recent trades there). Duplicates are skipped, so
   *  re-reading a market every few minutes is safe. Shared galaxy data: no tenant scoping. */
  async recordMarketTransactions(systemSymbol: string, rows: { waypointSymbol: string; shipSymbol: string; tradeSymbol: string; type: string; units: number; pricePerUnit: number; totalPrice: number; timestamp: string }[]): Promise<void> {
    if (!rows.length) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of rows) {
      const i = params.length;
      values.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9})`);
      params.push(systemSymbol, r.waypointSymbol, r.shipSymbol, r.tradeSymbol, r.type, r.units, r.pricePerUnit, r.totalPrice, r.timestamp);
    }
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO market_transactions (system_symbol, waypoint_symbol, ship_symbol, trade_symbol, type, units, price_per_unit, total_price, timestamp)
         VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`,
        params,
      ),
    );
  }

  /** Keep every survey batch's deposit list per field (see migrations/043). Deduplicated by survey signature. */
  async recordFieldSurveys(systemSymbol: string, waypointSymbol: string, surveys: { signature: string; size?: string; deposits: { symbol: string }[] }[]): Promise<void> {
    if (!surveys.length) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const sv of surveys) {
      const i = params.length;
      values.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}::jsonb)`);
      params.push(sv.signature, systemSymbol, waypointSymbol, sv.size ?? null, JSON.stringify(sv.deposits.map((d) => d.symbol)));
    }
    await withPool(this.pool, (c) =>
      c.query(`INSERT INTO field_surveys (signature, system_symbol, waypoint_symbol, size, deposits) VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`, params),
    );
  }

  /** Per-field deposit tally from recorded surveys: how many surveys, and how often each deposit was listed. */
  async fieldComposition(opts: { systemSymbol?: string; since: string }): Promise<{ waypointSymbol: string; surveys: number; deposits: number; counts: Record<string, number> }[]> {
    const params: unknown[] = [opts.since];
    let sys = "";
    if (opts.systemSymbol) { params.push(opts.systemSymbol); sys = ` AND system_symbol = $2`; }
    const res = await withPool(this.pool, (c) =>
      c.query<{ waypoint_symbol: string; deposit: string; n: string; surveys: string }>(
        `SELECT s.waypoint_symbol, d AS deposit, count(*) AS n,
                (SELECT count(*) FROM field_surveys f2 WHERE f2.waypoint_symbol = s.waypoint_symbol AND f2.created_at >= $1) AS surveys
           FROM field_surveys s, jsonb_array_elements_text(s.deposits) d
          WHERE s.created_at >= $1${sys}
          GROUP BY s.waypoint_symbol, d`,
        params,
      ),
    );
    const byWp = new Map<string, { waypointSymbol: string; surveys: number; deposits: number; counts: Record<string, number> }>();
    for (const r of res.rows) {
      const e = byWp.get(r.waypoint_symbol) ?? { waypointSymbol: r.waypoint_symbol, surveys: Number(r.surveys), deposits: 0, counts: {} };
      e.counts[r.deposit] = Number(r.n);
      e.deposits += Number(r.n);
      byWp.set(r.waypoint_symbol, e);
    }
    return [...byWp.values()].sort((a, b) => a.waypointSymbol.localeCompare(b.waypointSymbol));
  }

  /** Market transactions (ours and other agents', as each market read reports them), newest first. */
  async marketTransactions(opts: { good?: string; waypointSymbol?: string; systemSymbol?: string; since: string; limit?: number }): Promise<{ waypointSymbol: string; shipSymbol: string; tradeSymbol: string; type: string; units: number; pricePerUnit: number; totalPrice: number; timestamp: string }[]> {
    const where: string[] = ["timestamp >= $1"];
    const params: unknown[] = [opts.since];
    if (opts.good) { params.push(opts.good); where.push(`trade_symbol = $${params.length}`); }
    if (opts.waypointSymbol) { params.push(opts.waypointSymbol); where.push(`waypoint_symbol = $${params.length}`); }
    if (opts.systemSymbol) { params.push(opts.systemSymbol); where.push(`system_symbol = $${params.length}`); }
    params.push(Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000));
    const res = await withPool(this.pool, (c) =>
      c.query<{ waypoint_symbol: string; ship_symbol: string; trade_symbol: string; type: string; units: number; price_per_unit: number; total_price: number; timestamp: Date }>(
        `SELECT waypoint_symbol, ship_symbol, trade_symbol, type, units, price_per_unit, total_price, timestamp
           FROM market_transactions WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT $${params.length}`,
        params,
      ),
    );
    return res.rows.map((r) => ({
      waypointSymbol: r.waypoint_symbol, shipSymbol: r.ship_symbol, tradeSymbol: r.trade_symbol, type: r.type,
      units: Number(r.units), pricePerUnit: Number(r.price_per_unit), totalPrice: Number(r.total_price), timestamp: new Date(r.timestamp).toISOString(),
    }));
  }

  /** Short memo for latestMarketSnapshots(): 16 call sites (feeds' sellPriceAt/supplyAt per carrier per 2 s tick,
   *  the route list, keepers) each did a full `SELECT * FROM market_latest`. Invalidated by every write below, so a
   *  fresh market read is visible on the next call; otherwise reused for a few seconds. */
  private latestMemo?: { at: number; rows: Promise<MarketRow[]> };
  private static readonly LATEST_MEMO_MS = 5_000;

  private dropLatestMemo(): void {
    this.latestMemo = undefined;
  }

  async latestMarketSnapshots(): Promise<MarketRow[]> {
    const now = Date.now();
    if (this.latestMemo && now - this.latestMemo.at < Store.LATEST_MEMO_MS) return this.latestMemo.rows;
    const rows = withPool(this.pool, async (c) => {
      const res = await c.query(`SELECT * FROM market_latest`);
      return res.rows.map(Store.mapMarketRow);
    });
    this.latestMemo = { at: now, rows };
    rows.catch(() => { if (this.latestMemo?.rows === rows) this.latestMemo = undefined; });
    return rows;
  }

  /**
   * The most recent snapshot per waypoint per good, but only those seen within
   * `maxAgeMinutes`. This is the view the traders and the dispatcher both fly
   * by: when they read different windows they disagree about which routes
   * exist, and every trader falls back to picking the same "best" good off the
   * same stale table. Same window, same answer.
   */
  async freshMarketSnapshots(maxAgeMinutes: number): Promise<MarketRow[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query(
        `SELECT * FROM market_latest WHERE timestamp >= now() - ($1 || ' minutes')::interval`,
        [maxAgeMinutes],
      );
      return res.rows.map(Store.mapMarketRow);
    });
  }

  /** Best buy/sell spread per trade good across known markets. Optionally scope to one system. */
  async bestTrades(system?: string): Promise<
    {
      goodSymbol: string;
      lowestPurchasePrice: number;
      cheapestMarket: string;
      highestSellPrice: number;
      expensiveMarket: string;
      spread: number;
      profitMarginPct: number;
      crossSystem: boolean;
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        good_symbol: string;
        lowest_purchase_price: number;
        cheapest_market: string;
        highest_sell_price: number;
        expensive_market: string;
        spread: number;
        profit_margin_pct: number | null;
        cross_system: boolean;
      }>(
        `WITH latest AS (
           SELECT * FROM market_latest
           ${system ? "WHERE system_symbol = $1" : ""}
         ), scored AS (
           SELECT *,
             MIN(purchase_price) OVER (PARTITION BY good_symbol) AS min_purchase,
             MAX(sell_price) OVER (PARTITION BY good_symbol) AS max_sell
           FROM latest
         )
         SELECT
           good_symbol,
           MIN(purchase_price) AS lowest_purchase_price,
           MIN(CASE WHEN purchase_price = min_purchase THEN waypoint_symbol END) AS cheapest_market,
           MAX(sell_price) AS highest_sell_price,
           MAX(CASE WHEN sell_price = max_sell THEN waypoint_symbol END) AS expensive_market,
           MAX(sell_price) - MIN(purchase_price) AS spread,
           ROUND((((MAX(sell_price) - MIN(purchase_price)) / NULLIF(MIN(purchase_price), 0)) * 100)::numeric, 1) AS profit_margin_pct,
           (MIN(system_symbol) != MAX(system_symbol)) AS cross_system
         FROM scored
         GROUP BY good_symbol
         HAVING MAX(sell_price) - MIN(purchase_price) > 0
         ORDER BY profit_margin_pct DESC NULLS LAST`,
        system ? [system] : [],
      );
      return res.rows.map((r) => ({
        goodSymbol: r.good_symbol,
        lowestPurchasePrice: r.lowest_purchase_price,
        cheapestMarket: r.cheapest_market,
        highestSellPrice: r.highest_sell_price,
        expensiveMarket: r.expensive_market,
        spread: r.spread,
        profitMarginPct: Number(r.profit_margin_pct ?? 0),
        crossSystem: r.cross_system,
      }));
    });
  }

  /**
   * Every buy→sell pair worth considering, as raw legs. Unlike `bestTrades`,
   * this does NOT collapse to one row per good and does not rank.
   *
   * Ported with one real dialect fix: SQLite's scalar MIN(a, b) (smaller of
   * two values on one row) isn't valid Postgres, where MIN/MAX are aggregate-
   * only — the two-argument form here is LEAST() instead.
   */
  /**
   * Profitable buy/sell pairs per good, from the hot read model.
   *
   * Two windows rather than one. Holding a cross-system leg to the same
   * freshness as a local one means it almost never appears: both ends have to
   * be fresh at the same moment, and a market a jump away is only revisited
   * when a ship happens to go there, so the intersection is usually empty.
   * That is why no cross-system route ran for a day despite gates being open
   * and both markets being known. A local market, by contrast, is cheap to
   * refresh and there is no reason to trade on a stale price for it.
   *
   * Staleness here costs trip *selection* quality rather than money directly:
   * a trader re-reads live prices when it docks, and the maxLossPct doctrine
   * caps what it will actually accept. So a longer window for the expensive
   * side buys real opportunities at the price of some wasted trips.
   */
  async tradeLegs(maxAgeMinutes = 90, crossSystemMaxAgeMinutes = maxAgeMinutes): Promise<
    {
      goodSymbol: string;
      buyAt: string;
      buySystem: string;
      buyPrice: number;
      sellAt: string;
      sellSystem: string;
      sellPrice: number;
      volume: number;
      /** Each side's own trade volume; `volume` is the smaller of the two. */
      buyVolume: number;
      sellVolume: number;
      stalestIso: string;
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        buy_volume: number;
        sell_volume: number;
        good_symbol: string;
        buy_at: string;
        buy_system: string;
        buy_price: number;
        sell_at: string;
        sell_system: string;
        sell_price: number;
        volume: number;
        stalest: Date;
      }>(
        `-- Every window is cast to int before use. Left untyped the driver
         -- binds these as text, and GREATEST('90','360') compares lexically
         -- and returns '90', silently narrowing the very window this widens.
         WITH latest AS (
           SELECT * FROM market_latest
           WHERE timestamp >= now() - make_interval(mins => GREATEST($1::int, $2::int))
         )
         SELECT
           b.good_symbol                        AS good_symbol,
           b.waypoint_symbol                     AS buy_at,
           b.system_symbol                       AS buy_system,
           b.purchase_price                      AS buy_price,
           s.waypoint_symbol                     AS sell_at,
           s.system_symbol                       AS sell_system,
           s.sell_price                          AS sell_price,
           LEAST(b.trade_volume, s.trade_volume)  AS volume,
           b.trade_volume                         AS buy_volume,
           s.trade_volume                         AS sell_volume,
           LEAST(b.timestamp, s.timestamp)        AS stalest
         FROM latest b
         JOIN latest s
           ON s.good_symbol = b.good_symbol
          AND s.waypoint_symbol != b.waypoint_symbol
         WHERE s.sell_price > b.purchase_price
           AND b.purchase_price > 0
           -- Same system: both ends must be inside the strict window. Across
           -- a gate: the longer one applies to both, since the expensive side
           -- is whichever one the fleet is not currently sitting in.
           AND CASE
                 WHEN b.system_symbol = s.system_symbol
                   THEN b.timestamp >= now() - make_interval(mins => $1::int)
                    AND s.timestamp >= now() - make_interval(mins => $1::int)
                 ELSE b.timestamp >= now() - make_interval(mins => $2::int)
                  AND s.timestamp >= now() - make_interval(mins => $2::int)
               END`,
        [maxAgeMinutes, crossSystemMaxAgeMinutes],
      );
      return res.rows.map((r) => ({
        goodSymbol: r.good_symbol,
        buyAt: r.buy_at,
        buySystem: r.buy_system,
        buyPrice: r.buy_price,
        sellAt: r.sell_at,
        sellSystem: r.sell_system,
        sellPrice: r.sell_price,
        volume: r.volume,
        buyVolume: r.buy_volume,
        sellVolume: r.sell_volume,
        stalestIso: r.stalest.toISOString(),
      }));
    });
  }

  /** Record or update shipyard inventory for a waypoint.
   *
   *  A real SpaceTraders shipyard rotates which ship types it offers on its
   *  own schedule — a type that was for sale yesterday can simply stop
   *  being offered, with no "removed" event to react to. The upsert loop
   *  below only ever touches rows for types present in *this* fetch, so
   *  without this delete a type that dropped off the yard's catalog just
   *  sat here forever at its last-known price: confirmed live, an operator
   *  saw a listing read "2 min old" (true — that row's timestamp really
   *  was fresh) for a type that had, in fact, rotated out, because a
   *  *different* type at the same waypoint was what had actually just been
   *  refreshed. Deleting every row for this waypoint not present in the
   *  current fetch — including all of them, when the yard now offers
   *  nothing (`ships` empty) — keeps the table an honest mirror of what
   *  the yard last reported, not an accumulating log of everything it
   *  ever has.
   *
   *  BUT: the live API only populates `ships` (the full purchasable list
   *  with price) when one of our own ships is physically present/docked
   *  at that waypoint right now — with none there, it comes back empty
   *  regardless of true stock. `GalaxyAtlas.surveyShipyards()` sweeps
   *  every shipyard-trait waypoint in a system on a periodic background
   *  refresh, almost always without a ship docked at most of them.
   *  Treating that routine "no visibility" empty response the same as a
   *  genuine sold-out yard meant every sweep silently deleted whatever a
   *  tour/keeper ship's own dock had just correctly recorded — confirmed
   *  live: an operator watched real inventory at X1-TX45-A2 appear, then
   *  vanish again within a minute, with no purchase or actual restock in
   *  between. An empty fetch here is therefore a no-op: it carries no
   *  information either way, so it must not touch existing rows. */
  async recordShipyardInventory(
    systemSymbol: string,
    waypointSymbol: string,
    ships: {
      type: string; name: string; purchasePrice: number;
      frame?: { fuelCapacity?: number; cargoCapacity?: number; moduleSlots?: number; mountingPoints?: number; symbol?: string };
      engine?: { speed?: number };
      reactor?: { powerOutput?: number };
      crew?: { required?: number; capacity?: number };
      modules?: { symbol: string; name?: string; capacity?: number; range?: number }[];
      mounts?: { symbol: string; name?: string; strength?: number }[];
    }[],
  ): Promise<void> {
    if (ships.length === 0) return;
    await withPool(this.pool, async (c) => {
      await c.query(
        `DELETE FROM shipyard_inventory WHERE waypoint_symbol = $1 AND ship_type <> ALL($2::text[])`,
        [waypointSymbol, ships.map((s) => s.type)],
      );
      for (const s of ships) {
        const frame = s.frame ?? {};
        await c.query(
          `INSERT INTO shipyard_inventory (timestamp, system_symbol, waypoint_symbol, ship_type, ship_type_name, purchase_price, fuel_capacity, cargo_capacity, module_slots, mounting_points, frame_symbol, unique_key,
                                           engine_speed, reactor_power, crew_required, crew_capacity, modules, mounts)
           VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT (unique_key) DO UPDATE SET
             timestamp = excluded.timestamp, purchase_price = excluded.purchase_price, fuel_capacity = excluded.fuel_capacity,
             cargo_capacity = excluded.cargo_capacity, module_slots = excluded.module_slots, mounting_points = excluded.mounting_points,
             frame_symbol = excluded.frame_symbol,
             engine_speed = COALESCE(excluded.engine_speed, shipyard_inventory.engine_speed),
             reactor_power = COALESCE(excluded.reactor_power, shipyard_inventory.reactor_power),
             crew_required = COALESCE(excluded.crew_required, shipyard_inventory.crew_required),
             crew_capacity = COALESCE(excluded.crew_capacity, shipyard_inventory.crew_capacity),
             modules = COALESCE(excluded.modules, shipyard_inventory.modules),
             mounts = COALESCE(excluded.mounts, shipyard_inventory.mounts)`,
          [
            systemSymbol,
            waypointSymbol,
            s.type,
            s.name,
            s.purchasePrice,
            frame.fuelCapacity ?? 0,
            frame.cargoCapacity ?? 0,
            frame.moduleSlots ?? 0,
            frame.mountingPoints ?? 0,
            frame.symbol ?? null,
            `${waypointSymbol}:${s.type}`,
            s.engine?.speed ?? null,
            s.reactor?.powerOutput ?? null,
            s.crew?.required ?? null,
            s.crew?.capacity ?? null,
            s.modules ? JSON.stringify(s.modules.map((m) => ({ symbol: m.symbol, name: m.name, capacity: m.capacity, range: m.range }))) : null,
            s.mounts ? JSON.stringify(s.mounts.map((m) => ({ symbol: m.symbol, name: m.name, strength: m.strength }))) : null,
          ],
        );
      }
    });
  }

  /** Latest shipyard inventory across all known systems. */
  async shipyardInventory(): Promise<
    {
      systemSymbol: string;
      waypointSymbol: string;
      shipType: string;
      shipTypeName: string;
      purchasePrice: number;
      fuelCapacity: number;
      cargoCapacity: number;
      moduleSlots: number;
      mountingPoints: number;
      frameSymbol: string;
      timestamp: string;
      engineSpeed: number | null;
      reactorPower: number | null;
      crewRequired: number | null;
      crewCapacity: number | null;
      modules: { symbol: string; name?: string; capacity?: number; range?: number }[] | null;
      mounts: { symbol: string; name?: string; strength?: number }[] | null;
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        engine_speed: number | null;
        reactor_power: number | null;
        crew_required: number | null;
        crew_capacity: number | null;
        modules: { symbol: string; name?: string; capacity?: number; range?: number }[] | null;
        mounts: { symbol: string; name?: string; strength?: number }[] | null;
        system_symbol: string;
        waypoint_symbol: string;
        ship_type: string;
        ship_type_name: string;
        purchase_price: number;
        fuel_capacity: number;
        cargo_capacity: number;
        module_slots: number;
        mounting_points: number;
        frame_symbol: string;
        timestamp: Date;
      }>(
        `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY unique_key ORDER BY timestamp DESC, id DESC) AS rn FROM shipyard_inventory)
         SELECT system_symbol, waypoint_symbol, ship_type, ship_type_name, purchase_price, fuel_capacity, cargo_capacity, module_slots, mounting_points, frame_symbol, timestamp,
                engine_speed, reactor_power, crew_required, crew_capacity, modules, mounts
         FROM ranked WHERE rn = 1 ORDER BY system_symbol, waypoint_symbol, purchase_price`,
      );
      return res.rows.map((r) => ({
        systemSymbol: r.system_symbol,
        waypointSymbol: r.waypoint_symbol,
        shipType: r.ship_type,
        shipTypeName: r.ship_type_name,
        purchasePrice: r.purchase_price,
        fuelCapacity: r.fuel_capacity,
        cargoCapacity: r.cargo_capacity,
        moduleSlots: r.module_slots,
        mountingPoints: r.mounting_points,
        frameSymbol: r.frame_symbol,
        timestamp: r.timestamp.toISOString(),
        engineSpeed: r.engine_speed,
        reactorPower: r.reactor_power,
        crewRequired: r.crew_required,
        crewCapacity: r.crew_capacity,
        modules: r.modules,
        mounts: r.mounts,
      }));
    });
  }

  /** Record or update module/mount catalog for a waypoint. */
  async recordModuleCatalog(
    systemSymbol: string,
    waypointSymbol: string,
    items: { symbol: string; name: string; category: string; purchasePrice: number }[],
    kind: "module" | "mount",
  ): Promise<void> {
    await withPool(this.pool, async (c) => {
      for (const i of items) {
        await c.query(
          `INSERT INTO module_catalog (timestamp, system_symbol, waypoint_symbol, module_symbol, mount_symbol, name, category, purchase_price, unique_key)
           VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (unique_key) DO UPDATE SET
             timestamp = excluded.timestamp, purchase_price = excluded.purchase_price, name = excluded.name, category = excluded.category`,
          [
            systemSymbol,
            waypointSymbol,
            kind === "module" ? i.symbol : null,
            kind === "mount" ? i.symbol : null,
            i.name,
            i.category,
            i.purchasePrice,
            `${waypointSymbol}:${kind}:${i.symbol}`,
          ],
        );
      }
    });
  }

  /** Latest module catalog. Optionally filter by symbol/category. */
  async moduleCatalog(
    symbol?: string,
    category?: string,
  ): Promise<
    {
      systemSymbol: string;
      waypointSymbol: string;
      symbol: string;
      kind: "module" | "mount";
      name: string;
      category: string;
      purchasePrice: number;
      timestamp: string;
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (symbol) {
        params.push(symbol);
        conditions.push(`(module_symbol = $${params.length} OR mount_symbol = $${params.length})`);
      }
      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
      const res = await c.query<{
        system_symbol: string;
        waypoint_symbol: string;
        module_symbol: string | null;
        mount_symbol: string | null;
        name: string;
        category: string;
        purchase_price: number;
        timestamp: Date;
      }>(
        `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY unique_key ORDER BY timestamp DESC, id DESC) AS rn FROM module_catalog)
         SELECT system_symbol, waypoint_symbol, module_symbol, mount_symbol, name, category, purchase_price, timestamp
         FROM ranked WHERE rn = 1 ${where}`,
        params,
      );
      return res.rows.map((r) => ({
        systemSymbol: r.system_symbol,
        waypointSymbol: r.waypoint_symbol,
        symbol: (r.module_symbol ?? r.mount_symbol)!,
        kind: r.module_symbol ? ("module" as const) : ("mount" as const),
        name: r.name,
        category: r.category,
        purchasePrice: r.purchase_price,
        timestamp: r.timestamp.toISOString(),
      }));
    });
  }

  /**
   * Cached waypoints + jump-gate connections for a system — public galaxy
   * data (no tenant_id, matching market_snapshots/shipyard_inventory),
   * shared across every tenant on this server reset. GalaxyAtlas.loadSystem()
   * checks this before falling back to a live API scan; a cache hit skips
   * the live round-trip entirely. Loosely typed (no import of client.ts's
   * Waypoint/JumpGate types here) to keep this module decoupled from the
   * SpaceTraders API surface, same as recordShipyardInventory()'s own
   * structural param type just above.
   */
  async getSystemTopology(systemSymbol: string): Promise<{ waypoints: unknown[]; jumpGates: unknown[] } | undefined> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ waypoints: unknown[]; jump_gates: unknown[] }>(
        `SELECT waypoints, jump_gates FROM galaxy_systems WHERE system_symbol = $1`,
        [systemSymbol],
      );
      const row = res.rows[0];
      return row ? { waypoints: row.waypoints, jumpGates: row.jump_gates } : undefined;
    });
  }

  /**
   * Upserts a system's waypoint layout from the galaxy-wide crawler's own
   * `GET /systems` page fetch (galaxyCrawler.ts) — that response already
   * embeds every system's waypoints (symbol/type/x/y/orbitals, no `traits`;
   * SpaceTraders only reveals those once a waypoint is actually charted),
   * so this is free data riding along on a call the crawler already makes,
   * not a new one.
   *
   * Deliberately its own `crawled_waypoints` column (migrations/
   * 020_galaxy_crawled_waypoints.sql), NOT the `waypoints` column
   * setSystemTopology() writes: GalaxyAtlas.loadSystem() trusts any
   * non-empty `waypoints` row as a fully-scanned system and casts it
   * straight to the live API's Waypoint type (traits included) with no
   * live fetch — writing this trait-less public data there would hand a
   * tenant's very first visit to that system waypoints missing `.traits`
   * entirely, and every trait check downstream would throw.
   */
  async mergeSystemWaypoints(systemSymbol: string, waypoints: unknown[]): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_systems (system_symbol, waypoints, jump_gates, crawled_waypoints)
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, $2)
         ON CONFLICT (system_symbol) DO UPDATE SET crawled_waypoints = excluded.crawled_waypoints`,
        [systemSymbol, JSON.stringify(waypoints)],
      ),
    );
  }

  /** Upserts a system's cached topology — called once after a live scan (waypoints only, jumpGates=[]) and again once jump gates are actually resolved. */
  async setSystemTopology(systemSymbol: string, waypoints: unknown[], jumpGates: unknown[]): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_systems (system_symbol, waypoints, jump_gates, scanned_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (system_symbol) DO UPDATE SET waypoints = excluded.waypoints, jump_gates = excluded.jump_gates, scanned_at = now()`,
        [systemSymbol, JSON.stringify(waypoints), JSON.stringify(jumpGates)],
      ),
    );
  }

  /**
   * Upserts just a system's own metadata (sector/type/x/y, from GET /systems
   * or GET /systems/{symbol}) — separate from setSystemTopology() above,
   * which caches that system's *waypoints*. The galaxy-wide crawler
   * (galaxyCrawler.ts) discovers a system's coordinates/type long before it
   * ever gets around to scanning that system's waypoints (a much larger,
   * separate pass), so this must not require or touch waypoints/jump_gates
   * — a fresh row here has empty defaults for those, backfilled later by
   * whichever of the crawler's waypoint pass or a tenant's own
   * GalaxyAtlas.loadSystem() reaches this system first.
   */
  async setGalaxySystemMeta(systemSymbol: string, sectorSymbol: string, systemType: string, x: number, y: number): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_systems (system_symbol, waypoints, jump_gates, sector_symbol, system_type, x, y)
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, $2, $3, $4, $5)
         ON CONFLICT (system_symbol) DO UPDATE SET sector_symbol = excluded.sector_symbol, system_type = excluded.system_type, x = excluded.x, y = excluded.y`,
        [systemSymbol, sectorSymbol, systemType, x, y],
      ),
    );
  }

  /** Just `system_symbol -> system_type` for every crawled system with a
   *  known star type — the one thing the per-tenant dashboard's own state
   *  refresh needs from the shared galaxy table (to color a system's star
   *  on the 3D map), without listGalaxySystems()'s much heavier per-system
   *  waypoints/jumpGates jsonb payload that only the cartography page uses. */
  async listSystemTypes(): Promise<{ systemSymbol: string; systemType: string }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ system_symbol: string; system_type: string }>(
        `SELECT system_symbol, system_type FROM galaxy_systems WHERE system_type IS NOT NULL`,
      );
      return res.rows.map((r) => ({ systemSymbol: r.system_symbol, systemType: r.system_type }));
    });
  }

  /** Every crawled system's metadata + however much topology is known for
   *  it — the galaxy map's one read query. `waypoints`/`jumpGates` come back
   *  as their raw jsonb (possibly `[]` if only the meta pass has reached
   *  this system so far), left untyped for the same reason
   *  getSystemTopology() is. `crawledWaypoints` is the separate, trait-less
   *  public data mergeSystemWaypoints() writes (positions/types only) — a
   *  consumer that wants a system's shape even where no tenant has ever
   *  charted it should fall back to this when `waypoints` is empty, never
   *  treat the two as interchangeable (see mergeSystemWaypoints()'s own
   *  comment on why they're separate columns at all). */
  async listGalaxySystems(): Promise<{
    systemSymbol: string; sectorSymbol: string | null; systemType: string | null;
    x: number | null; y: number | null; waypoints: unknown[]; jumpGates: unknown[]; crawledWaypoints: unknown[];
  }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        system_symbol: string; sector_symbol: string | null; system_type: string | null;
        x: number | null; y: number | null; waypoints: unknown[]; jump_gates: unknown[]; crawled_waypoints: unknown[] | null;
      }>(`SELECT system_symbol, sector_symbol, system_type, x, y, waypoints, jump_gates, crawled_waypoints FROM galaxy_systems`);
      return res.rows.map((r) => ({
        systemSymbol: r.system_symbol, sectorSymbol: r.sector_symbol, systemType: r.system_type,
        x: r.x, y: r.y, waypoints: r.waypoints, jumpGates: r.jump_gates, crawledWaypoints: r.crawled_waypoints ?? [],
      }));
    });
  }

  /** One system's detail for the cartography page's click-a-dot side
   *  panel. Uses `waypoints` (tenant-scanned, trait-complete) when it's
   *  non-empty; falls back to `crawledWaypoints` (public-crawler,
   *  trait-less) only when no tenant has ever scanned this system — the
   *  two are never merged or treated as interchangeable, same rule as
   *  everywhere else this pair of columns is read (see
   *  mergeSystemWaypoints()'s own comment). Returns null for a system
   *  symbol the crawl has never recorded at all. */
  async getGalaxySystemDetail(systemSymbol: string): Promise<{
    systemSymbol: string; sectorSymbol: string | null; systemType: string | null;
    x: number | null; y: number | null;
    source: "scanned" | "crawled" | "unknown";
    waypointCount: number; typeCounts: Record<string, number>;
    gates: { symbol: string; connections: string[] }[];
  } | null> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        system_symbol: string; sector_symbol: string | null; system_type: string | null;
        x: number | null; y: number | null;
        waypoints: { symbol: string; type: string }[]; jump_gates: { symbol: string; connections: string[] }[];
        crawled_waypoints: { symbol: string; type: string }[] | null;
      }>(
        `SELECT system_symbol, sector_symbol, system_type, x, y, waypoints, jump_gates, crawled_waypoints
         FROM galaxy_systems WHERE system_symbol = $1`,
        [systemSymbol],
      );
      const row = res.rows[0];
      if (!row) return null;
      const scanned = row.waypoints ?? [];
      const crawled = row.crawled_waypoints ?? [];
      const source: "scanned" | "crawled" | "unknown" = scanned.length > 0 ? "scanned" : crawled.length > 0 ? "crawled" : "unknown";
      const effective = source === "scanned" ? scanned : crawled;
      const typeCounts: Record<string, number> = {};
      for (const wp of effective) typeCounts[wp.type] = (typeCounts[wp.type] ?? 0) + 1;
      return {
        systemSymbol: row.system_symbol, sectorSymbol: row.sector_symbol, systemType: row.system_type,
        x: row.x, y: row.y, source, waypointCount: effective.length, typeCounts,
        gates: row.jump_gates ?? [],
      };
    });
  }

  /** Just enough per-system data to plot the galaxy map (a scatter of dots),
   *  skipping listGalaxySystems()'s full jsonb waypoint/jump-gate blobs
   *  entirely — the map doesn't need them, and pulling every row's full
   *  topology for a page that only draws x/y dots would be wasted
   *  bandwidth once the crawl covers tens of thousands of systems.
   *  `explored` is still cheap to include (a length check, not the blob
   *  itself): it's true once *some* tenant's own fleet has actually
   *  visited the system and populated its waypoints — GalaxyCrawler alone
   *  only ever learns a system's coordinates/type, never its waypoints —
   *  so this is the one bit of tenant-exploration data visible on the
   *  otherwise tenant-agnostic crawl map. */
  async listGalaxySystemPositions(): Promise<{
    systemSymbol: string; sectorSymbol: string | null; systemType: string | null; x: number | null; y: number | null; explored: boolean;
  }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ system_symbol: string; sector_symbol: string | null; system_type: string | null; x: number | null; y: number | null; explored: boolean }>(
        `SELECT system_symbol, sector_symbol, system_type, x, y, jsonb_array_length(waypoints) > 0 AS explored
         FROM galaxy_systems WHERE system_type IS NOT NULL`,
      );
      return res.rows.map((r) => ({
        systemSymbol: r.system_symbol, sectorSymbol: r.sector_symbol, systemType: r.system_type,
        x: r.x, y: r.y, explored: r.explored,
      }));
    });
  }

  /** Every crawled system that has at least one known (from the public
   *  /systems waypoints list) jump gate — the raw material for
   *  GalaxyCrawler's opportunistic gate-connection sweep (buildGateQueue()),
   *  which needs each system's still-unresolved gate symbols (in
   *  crawledWaypoints, filtered against jumpGates' already-resolved ones)
   *  without pulling every system's full topology the way listGalaxySystems()
   *  does. */
  async listSystemsForGateCrawl(): Promise<{ systemSymbol: string; crawledWaypoints: unknown[]; jumpGates: unknown[] }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ system_symbol: string; crawled_waypoints: unknown[] | null; jump_gates: unknown[] }>(
        `SELECT system_symbol, crawled_waypoints, jump_gates FROM galaxy_systems WHERE crawled_waypoints IS NOT NULL`,
      );
      return res.rows.map((r) => ({ systemSymbol: r.system_symbol, crawledWaypoints: r.crawled_waypoints ?? [], jumpGates: r.jump_gates ?? [] }));
    });
  }

  /** Record one gate's connections as learned by the crawler's opportunistic
   *  sweep (someone else charted it — GalaxyCrawler.crawlOneGate()) — a
   *  read-modify-write on just this row's `jump_gates` array, replacing any
   *  existing entry for this gate symbol. Deliberately touches only
   *  `jump_gates`, never `waypoints`/`crawled_waypoints`: this is additive
   *  topology data, not a waypoint scan, so it must not trip
   *  GalaxyAtlas.loadSystem()'s "non-empty waypoints means fully scanned"
   *  cache-hit trust boundary (see mergeSystemWaypoints()'s own comment). */
  async mergeGateConnections(systemSymbol: string, gateSymbol: string, connections: string[]): Promise<void> {
    await withPool(this.pool, async (c) => {
      const res = await c.query<{ jump_gates: { symbol: string; connections: string[] }[] }>(
        `SELECT jump_gates FROM galaxy_systems WHERE system_symbol = $1`,
        [systemSymbol],
      );
      const existing = res.rows[0]?.jump_gates ?? [];
      const filtered = existing.filter((g) => g.symbol !== gateSymbol);
      filtered.push({ symbol: gateSymbol, connections });
      await c.query(`UPDATE galaxy_systems SET jump_gates = $2 WHERE system_symbol = $1`, [systemSymbol, JSON.stringify(filtered)]);
    });
  }

  /** System-to-system jump-gate connections known so far — either from
   *  tenant exploration (GalaxyAtlas.scanJumpGates()) or from the crawler's
   *  own opportunistic sweep (mergeGateConnections(), above) once someone
   *  else has charted a gate. Each `galaxy_systems` row's
   *  jump_gates is a JumpGate[] (`{ symbol, connections }`, the raw
   *  SpaceTraders shape) where `symbol` is that row's own gate waypoint
   *  and `connections` are the *destination* gates' waypoint symbols, in
   *  potentially other systems — this collapses that down to a deduped
   *  set of system-symbol pairs, which is all the map/route-planner need. */
  async listGalaxyJumpConnections(): Promise<{ from: string; to: string }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ system_symbol: string; jump_gates: { symbol: string; connections: string[] }[] }>(
        `SELECT system_symbol, jump_gates FROM galaxy_systems WHERE jsonb_array_length(jump_gates) > 0`,
      );
      const systemOf = (waypointSymbol: string): string => waypointSymbol.split("-").slice(0, 2).join("-");
      const seen = new Set<string>();
      const out: { from: string; to: string }[] = [];
      for (const row of res.rows) {
        for (const gate of row.jump_gates) {
          for (const connection of gate.connections) {
            const destSystem = systemOf(connection);
            if (destSystem === row.system_symbol) continue;
            const key = [row.system_symbol, destSystem].sort().join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ from: row.system_symbol, to: destSystem });
          }
        }
      }
      return out;
    });
  }

  /** Add one real jumpShip() transaction to the running per-gate-pair
   *  average — see migrations/017_galaxy_jump_costs.sql's own comment on
   *  why this exists (GalaxyAtlas's in-memory version never survived a
   *  restart). Shared across every tenant, same as the table itself. */
  async recordGalaxyJumpCost(fromGate: string, toSystem: string, price: number): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_jump_costs (from_gate, to_system, total_price, jump_count, updated_at)
         VALUES ($1, $2, $3, 1, now())
         ON CONFLICT (from_gate, to_system) DO UPDATE SET
           total_price = galaxy_jump_costs.total_price + excluded.total_price,
           jump_count = galaxy_jump_costs.jump_count + 1,
           updated_at = now()`,
        [fromGate, toSystem, Math.round(price)],
      ),
    );
  }

  /** Every learned jump cost recorded so far, for GalaxyAtlas to seed its
   *  in-memory average from at boot instead of starting cold every time
   *  this process restarts. */
  async getAllGalaxyJumpCosts(): Promise<{ fromGate: string; toSystem: string; totalPrice: number; jumpCount: number }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ from_gate: string; to_system: string; total_price: string; jump_count: number }>(
        `SELECT from_gate, to_system, total_price, jump_count FROM galaxy_jump_costs`,
      );
      return res.rows.map((r) => ({ fromGate: r.from_gate, toSystem: r.to_system, totalPrice: Number(r.total_price), jumpCount: r.jump_count }));
    });
  }

  /** Record one gate's checked construction status — see
   *  migrations/018_galaxy_gate_construction.sql's own comment on why this
   *  exists (GalaxyAtlas's in-memory version never survived a restart).
   *  Shared across every tenant, same as the table itself. */
  async recordGalaxyGateConstruction(gateSymbol: string, isComplete: boolean): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_gate_construction (gate_symbol, is_complete, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (gate_symbol) DO UPDATE SET is_complete = excluded.is_complete, updated_at = now()`,
        [gateSymbol, isComplete],
      ),
    );
  }

  /** Every gate's checked construction status, for GalaxyAtlas to seed its
   *  in-memory cache from at boot instead of starting cold every time this
   *  process restarts. */
  async getAllGalaxyGateConstruction(): Promise<{ gateSymbol: string; isComplete: boolean }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ gate_symbol: string; is_complete: boolean }>(
        `SELECT gate_symbol, is_complete FROM galaxy_gate_construction`,
      );
      return res.rows.map((r) => ({ gateSymbol: r.gate_symbol, isComplete: r.is_complete }));
    });
  }

  /** How many systems the galaxy crawl has recorded meta for so far — cheap
   *  progress signal, doesn't pull every row's jsonb blobs like listGalaxySystems(). */
  async countGalaxySystems(): Promise<number> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ count: string }>(`SELECT count(*) FROM galaxy_systems WHERE system_type IS NOT NULL`);
      return Number(res.rows[0]!.count);
    });
  }

  /** Full faction roster — public reference data, upserted wholesale each
   *  crawl pass (the list is small, a couple dozen entries; no per-row diff
   *  needed). */
  async setGalaxyFactions(factions: { symbol: string; name: string; headquarters?: string; isRecruiting?: boolean }[]): Promise<void> {
    if (factions.length === 0) return;
    await withPool(this.pool, async (c) => {
      for (const f of factions) {
        await c.query(
          `INSERT INTO galaxy_factions (symbol, name, headquarters, is_recruiting, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (symbol) DO UPDATE SET name = excluded.name, headquarters = excluded.headquarters, is_recruiting = excluded.is_recruiting, updated_at = now()`,
          [f.symbol, f.name, f.headquarters ?? null, f.isRecruiting ?? null],
        );
      }
    });
  }

  async listGalaxyFactions(): Promise<{ symbol: string; name: string; headquarters: string | null; isRecruiting: boolean | null }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ symbol: string; name: string; headquarters: string | null; is_recruiting: boolean | null }>(
        `SELECT symbol, name, headquarters, is_recruiting FROM galaxy_factions ORDER BY symbol`,
      );
      return res.rows.map((r) => ({ symbol: r.symbol, name: r.name, headquarters: r.headquarters, isRecruiting: r.is_recruiting }));
    });
  }

  /** One row per known agent per crawl pass — the running tally behind
   *  "agents in my home system" (see agent_credit_snapshots's own
   *  migration comment for why). A bulk multi-row INSERT, not per-agent
   *  queries, since crawlAgents() calls this with the full ~200-agent
   *  directory in one shot every hour. */
  async recordAgentCreditSnapshots(agents: { symbol: string; headquarters: string; credits: number; shipCount: number }[]): Promise<void> {
    if (agents.length === 0) return;
    await withPool(this.pool, async (c) => {
      const values: unknown[] = [];
      const rows = agents.map((a, i) => {
        const system = a.headquarters.split("-").slice(0, 2).join("-");
        values.push(system, a.symbol, a.credits, a.shipCount);
        const base = i * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`;
      });
      await c.query(
        `INSERT INTO agent_credit_snapshots (system_symbol, agent_symbol, credits, ship_count, timestamp) VALUES ${rows.join(", ")}`,
        values,
      );
    });
  }

  /** Credit/ship-count history for every agent headquartered in `systemSymbol`,
   *  newest first per agent — the operator-facing "running tally" the
   *  dashboard's system-agents panel plots. */
  async agentCreditHistory(systemSymbol: string, since: string): Promise<{ agentSymbol: string; credits: number; shipCount: number; timestamp: string }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ agent_symbol: string; credits: string; ship_count: number; timestamp: string }>(
        `SELECT agent_symbol, credits, ship_count, timestamp
         FROM agent_credit_snapshots
         WHERE system_symbol = $1 AND timestamp >= $2
         ORDER BY agent_symbol ASC, timestamp ASC`,
        [systemSymbol, since],
      );
      return res.rows.map((r) => ({ agentSymbol: r.agent_symbol, credits: Number(r.credits), shipCount: r.ship_count, timestamp: r.timestamp }));
    });
  }

  /**
   * Per waypoint+good market behavior within one system over a time window
   * — the "deep understanding of market dynamics" the operator asked for
   * 2026-09-21, built entirely from `market_snapshots` (already unpruned,
   * append-only, one row per good per market visit) plus a window function
   * for supply-level transitions. No new raw-data table: everything here
   * is derivable from what the fleet's own market crawling already
   * records every time any ship docks somewhere with a marketplace.
   *
   * `sellVolatility`/`buyVolatility` are population stddev of the raw
   * price, in the good's own currency units — compare within one good,
   * not across goods of very different price scales (a 2c swing on a 10c
   * good and a 2c swing on a 10,000c good are not equally volatile; see
   * `systemTypeDynamics()` below for the normalized cross-good version of
   * this same idea). `supplyTransitions` counts how many times the
   * `supply` enum (ABUNDANT/HIGH/MODERATE/LIMITED/SCARCE) actually changed
   * between consecutive snapshots in the window — a market that never
   * transitions is either very stable or very rarely visited; cross-check
   * against `snapshotCount` before reading too much into a transition
   * count from only 2-3 data points.
   */
  async marketDynamics(systemSymbol: string, since: string): Promise<{
    waypointSymbol: string; goodSymbol: string; type: string;
    snapshotCount: number;
    sellAvg: number; sellVolatility: number;
    buyAvg: number; buyVolatility: number;
    avgTradeVolume: number;
    commonSupply: string;
    supplyTransitions: number;
  }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        waypoint_symbol: string; good_symbol: string; type: string;
        snapshot_count: string;
        sell_avg: string; sell_volatility: string;
        buy_avg: string; buy_volatility: string;
        avg_trade_volume: string;
        common_supply: string;
        supply_transitions: string;
      }>(
        `WITH base AS (
           SELECT waypoint_symbol, good_symbol, type, supply, sell_price, purchase_price, trade_volume, timestamp,
                  LAG(supply) OVER (PARTITION BY waypoint_symbol, good_symbol ORDER BY timestamp) AS prev_supply
           FROM market_snapshots
           WHERE system_symbol = $1 AND timestamp >= $2
         )
         SELECT
           waypoint_symbol, good_symbol, type,
           COUNT(*) AS snapshot_count,
           ROUND(AVG(sell_price)::numeric, 1) AS sell_avg,
           ROUND(COALESCE(STDDEV_POP(sell_price), 0)::numeric, 2) AS sell_volatility,
           ROUND(AVG(purchase_price)::numeric, 1) AS buy_avg,
           ROUND(COALESCE(STDDEV_POP(purchase_price), 0)::numeric, 2) AS buy_volatility,
           ROUND(AVG(trade_volume)::numeric, 1) AS avg_trade_volume,
           MODE() WITHIN GROUP (ORDER BY supply) AS common_supply,
           SUM(CASE WHEN prev_supply IS NOT NULL AND supply IS DISTINCT FROM prev_supply THEN 1 ELSE 0 END) AS supply_transitions
         FROM base
         GROUP BY waypoint_symbol, good_symbol, type
         ORDER BY sell_volatility DESC NULLS LAST`,
        [systemSymbol, since],
      );
      return res.rows.map((r) => ({
        waypointSymbol: r.waypoint_symbol, goodSymbol: r.good_symbol, type: r.type,
        snapshotCount: Number(r.snapshot_count),
        sellAvg: Number(r.sell_avg), sellVolatility: Number(r.sell_volatility),
        buyAvg: Number(r.buy_avg), buyVolatility: Number(r.buy_volatility),
        avgTradeVolume: Number(r.avg_trade_volume),
        commonSupply: r.common_supply,
        supplyTransitions: Number(r.supply_transitions),
      }));
    });
  }

  /**
   * Cross-system-type market comparison — "how market dynamics work in a
   * given system type" (star type: `galaxy_systems.system_type`, e.g.
   * RED_STAR/BLUE_STAR/..., filled in by GalaxyCrawler's systems pass).
   * Volatility here is the average **coefficient of variation**
   * (stddev/mean) per good-in-a-system, then averaged across every
   * good+system pair in that system type — a normalized, cross-good-
   * comparable number, unlike `marketDynamics()`'s raw-currency stddev
   * above. `HAVING COUNT(*) >= 3` drops good/system pairs with too few
   * snapshots for a stddev to mean anything.
   */
  async systemTypeDynamics(since: string): Promise<{
    systemType: string;
    systemCount: number;
    goodMarketPairs: number;
    avgVolatilityCoefficient: number;
    avgTradeVolume: number;
  }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
        system_type: string;
        system_count: string;
        good_market_pairs: string;
        avg_volatility_coefficient: string;
        avg_trade_volume: string;
      }>(
        `WITH per_good AS (
           SELECT ms.system_symbol, gs.system_type, ms.good_symbol,
                  AVG(ms.sell_price) AS avg_price,
                  STDDEV_POP(ms.sell_price) AS price_stddev,
                  AVG(ms.trade_volume) AS avg_volume
           FROM market_snapshots ms
           JOIN galaxy_systems gs ON gs.system_symbol = ms.system_symbol
           WHERE ms.timestamp >= $1 AND gs.system_type IS NOT NULL
           GROUP BY ms.system_symbol, gs.system_type, ms.good_symbol
           HAVING COUNT(*) >= 3
         )
         SELECT
           system_type,
           COUNT(DISTINCT system_symbol) AS system_count,
           COUNT(*) AS good_market_pairs,
           ROUND(AVG(CASE WHEN avg_price > 0 THEN price_stddev / avg_price ELSE NULL END)::numeric, 4) AS avg_volatility_coefficient,
           ROUND(AVG(avg_volume)::numeric, 1) AS avg_trade_volume
         FROM per_good
         GROUP BY system_type
         ORDER BY avg_volatility_coefficient DESC NULLS LAST`,
        [since],
      );
      return res.rows.map((r) => ({
        systemType: r.system_type,
        systemCount: Number(r.system_count),
        goodMarketPairs: Number(r.good_market_pairs),
        avgVolatilityCoefficient: Number(r.avg_volatility_coefficient),
        avgTradeVolume: Number(r.avg_trade_volume),
      }));
    });
  }

  /** Resumable cursor storage for background crawl jobs — see galaxy_crawl_state's own migration comment. */
  async getCrawlState<T>(key: string): Promise<T | undefined> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ value: T }>(`SELECT value FROM galaxy_crawl_state WHERE key = $1`, [key]);
      return res.rows[0]?.value;
    });
  }

  async setCrawlState(key: string, value: unknown): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO galaxy_crawl_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      ),
    );
  }

  // ── Missions (tenant-scoped) ────────────────────────────────

  async recordMission(
    tenantId: string,
    m: {
      kind: string;
      targetSystem: string;
      targetWaypoint: string;
      status: string;
      assignedShips: string[];
      carrierTarget: number;
      materials: { tradeSymbol: string; required: number; fulfilled: number }[];
      paused?: boolean;
      pacing?: { buyLotUnits?: number; buyGapMin?: number; maxInflationPct?: number } | null;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO missions (tenant_id, kind, target_system, target_waypoint, status, assigned_ships, carrier_target, materials, paused, pacing, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (tenant_id, target_waypoint) DO UPDATE SET
           status = excluded.status, assigned_ships = excluded.assigned_ships, carrier_target = excluded.carrier_target,
           materials = excluded.materials, paused = excluded.paused, pacing = excluded.pacing, updated_at = excluded.updated_at`,
        [
          tenantId,
          m.kind,
          m.targetSystem,
          m.targetWaypoint,
          m.status,
          JSON.stringify(m.assignedShips),
          m.carrierTarget,
          JSON.stringify(m.materials),
          m.paused ?? false,
          m.pacing ? JSON.stringify(m.pacing) : null,
        ],
      ),
    );
  }

  /** Latest mission records. */
  async latestMissions(tenantId: string): Promise<MissionRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{
        kind: string;
        target_system: string;
        target_waypoint: string;
        status: string;
        assigned_ships: string[];
        carrier_target: number;
        materials: { tradeSymbol: string; required: number; fulfilled: number }[];
        paused: boolean;
        pacing: { buyLotUnits?: number; buyGapMin?: number; maxInflationPct?: number } | null;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT kind, target_system, target_waypoint, status, assigned_ships, carrier_target, materials, paused, pacing, created_at, updated_at
          FROM missions ORDER BY updated_at DESC`);
      return res.rows.map((r) => ({
        kind: r.kind as "SUPPLY_CONSTRUCTION",
        targetSystem: r.target_system,
        targetWaypoint: r.target_waypoint,
        status: r.status as "active" | "complete",
        assignedShips: r.assigned_ships ?? [],
        carrierTarget: r.carrier_target ?? 1,
        materials: r.materials,
        paused: r.paused,
        pacing: r.pacing ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  /** Mark a mission complete. */
  async completeMission(tenantId: string, targetWaypoint: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`UPDATE missions SET status = 'complete', updated_at = now() WHERE target_waypoint = $1`, [targetWaypoint]),
    );
  }

  // ── Feeder-tier missions (tenant-scoped) ────────────────────
  // See migrations/026_feed_missions.sql's own comment: a separate table
  // from `missions` on purpose — a feed has no construction site or
  // required/fulfilled materials and never completes, it just runs a crew
  // continuously buying a good cheap and selling it into one target market.

  async recordFeed(
    tenantId: string,
    f: {
      targetSystem: string;
      targetWaypoint: string;
      good: string;
      assignedShips: string[];
      carrierTarget: number;
      paused?: boolean;
      mine?: boolean;
      buyAt?: string;
      force?: boolean;
      sellGapMs?: number;
      chainId?: string;
      chainName?: string;
      chainOrder?: number;
      maxLossPerUnit?: number;
      stopAtSupply?: string;
      field?: string;
      collector?: string;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO feed_missions (tenant_id, target_system, target_waypoint, good, assigned_ships, carrier_target, paused, mine, buy_at, force, sell_gap_ms, chain_id, chain_name, chain_order, max_loss_per_unit, stop_at_supply, field, collector, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
         ON CONFLICT (tenant_id, target_waypoint, good, mine) DO UPDATE SET
           assigned_ships = excluded.assigned_ships, carrier_target = excluded.carrier_target,
           paused = excluded.paused, mine = excluded.mine, buy_at = excluded.buy_at, force = excluded.force,
           sell_gap_ms = excluded.sell_gap_ms,
           chain_id = excluded.chain_id, chain_name = excluded.chain_name, chain_order = excluded.chain_order,
           max_loss_per_unit = excluded.max_loss_per_unit, stop_at_supply = excluded.stop_at_supply,
           field = excluded.field, collector = excluded.collector,
           updated_at = excluded.updated_at`,
        [
          tenantId, f.targetSystem, f.targetWaypoint, f.good, JSON.stringify(f.assignedShips), f.carrierTarget,
          f.paused ?? false, f.mine ?? false, f.buyAt ?? null, f.force ?? false, f.sellGapMs ?? null,
          f.chainId ?? null, f.chainName ?? null, f.chainOrder ?? null, f.maxLossPerUnit ?? null, f.stopAtSupply ?? null,
          f.field ?? null, f.collector ?? null,
        ],
      ),
    );
  }

  /** All known feeds for a tenant. */
  async latestFeeds(tenantId: string): Promise<FeedRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{
        target_system: string;
        target_waypoint: string;
        good: string;
        assigned_ships: string[];
        carrier_target: number;
        paused: boolean;
        mine: boolean;
        buy_at: string | null;
        force: boolean;
        sell_gap_ms: number | null;
        chain_id: string | null;
        chain_name: string | null;
        chain_order: number | null;
        max_loss_per_unit: number | null;
        stop_at_supply: string | null;
        field: string | null;
        collector: string | null;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT target_system, target_waypoint, good, assigned_ships, carrier_target, paused, mine, buy_at, force, sell_gap_ms, chain_id, chain_name, chain_order, max_loss_per_unit, stop_at_supply, field, collector, created_at, updated_at
          FROM feed_missions ORDER BY updated_at DESC`);
      return res.rows.map((r) => ({
        targetSystem: r.target_system,
        targetWaypoint: r.target_waypoint,
        good: r.good,
        assignedShips: r.assigned_ships ?? [],
        carrierTarget: r.carrier_target ?? 1,
        paused: r.paused,
        mine: r.mine ?? false,
        buyAt: r.buy_at,
        force: r.force ?? false,
        sellGapMs: r.sell_gap_ms,
        chainId: r.chain_id,
        chainName: r.chain_name,
        chainOrder: r.chain_order,
        maxLossPerUnit: r.max_loss_per_unit,
        stopAtSupply: r.stop_at_supply,
        field: r.field,
        collector: r.collector,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  /** Remove a feed entirely (operator-initiated, not just paused). `mine` picks the buying or the mining feed for
   *  this good; omitted, both go (the old one-feed-per-good behaviour). */
  async deleteFeed(tenantId: string, targetWaypoint: string, good: string, mine?: boolean): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      mine === undefined
        ? c.query(`DELETE FROM feed_missions WHERE target_waypoint = $1 AND good = $2`, [targetWaypoint, good])
        : c.query(`DELETE FROM feed_missions WHERE target_waypoint = $1 AND good = $2 AND mine = $3`, [targetWaypoint, good, mine]),
    );
  }

  // ── Tick step timings ──────────────────────────────────────
  // See migrations/031_tick_step_timings.sql's comment — FleetManager.tick()
  // records here only when a pass runs unusually slowly (FleetManager's own
  // TICK_WARN_MS), with a full per-step breakdown, to catch which step in
  // the long serial chain (refreshCredits → ... → feeds.tick() → ...) is
  // occasionally the one blocking every step after it in the same pass.

  async recordSlowTick(tenantId: string, tick: { startedAt: string; totalMs: number; steps: { name: string; ms: number }[] }): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO tick_step_timings (tenant_id, started_at, total_ms, steps) VALUES ($1, $2, $3, $4)`,
        [tenantId, tick.startedAt, tick.totalMs, JSON.stringify(tick.steps)],
      ),
    );
  }

  /** Most recent slow ticks, newest first — for an operator diagnosing a stall. */
  async recentSlowTicks(tenantId: string, limit = 50): Promise<{ startedAt: string; totalMs: number; steps: { name: string; ms: number }[] }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ started_at: Date; total_ms: number; steps: { name: string; ms: number }[] }>(
        `SELECT started_at, total_ms, steps FROM tick_step_timings ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => ({ startedAt: r.started_at.toISOString(), totalMs: r.total_ms, steps: r.steps }));
    });
  }

  /**
   * Net credits per ship over a window. SELL is income; PURCHASE, REFUEL and
   * ship purchases are spend. Scrapping is recorded as type SHIP but returns
   * credits, so it is counted as income.
   */
  /**
   * Realized cash flow since `sinceIso`, split by what actually moved it.
   *
   * Every instrument this engine had reported *intent* — what a ship wants,
   * what a route is worth on paper. Intent was never wrong during the two
   * biggest incidents of the day: a cross-system loop that logged confident
   * buys and sells while the ship never moved and lost 9,036c a cycle, and a
   * stall where six traders held assignments they could not fly. Both were
   * found by a human noticing the credit balance, hours later.
   *
   * This is the outcome side. `net` is the number that answers "is it
   * working", and the breakdown says where it went when the answer is no —
   * fuel and repairs are real costs that a gross trading margin hides.
   */
  async ledgerSummary(tenantId: string, sinceIso: string): Promise<{
    net: number; sells: number; purchases: number; refuel: number; jump: number; ship: number; contract: number; trades: number;
  }> {
    return withTenant(this.pool, tenantId, async (c) => {
      // `total` is stored as a positive magnitude regardless of direction —
      // see ledgerTotals() — so direction comes from `type` alone.
      const res = await c.query<{ type: string; amount: string | null; n: string }>(
        `SELECT type, COALESCE(SUM(total), 0) AS amount, COUNT(*) AS n
         FROM ledger WHERE timestamp >= $1 GROUP BY type`,
        [sinceIso],
      );
      const by = new Map(res.rows.map((r) => [r.type, { amount: Number(r.amount ?? 0), n: Number(r.n) }]));
      const amt = (t: string) => by.get(t)?.amount ?? 0;
      const sells = amt("SELL");
      const purchases = amt("PURCHASE");
      const refuel = amt("REFUEL");
      const jump = amt("JUMP");
      const ship = amt("SHIP");
      // Contract payouts are income, and leaving them out was not a rounding
      // error: buying contract goods was booked as cost while the payout that
      // justified it was booked nowhere, so a fleet working a profitable
      // contract read as one bleeding money. Grouping a row without adding it
      // to net would keep the same lie in a tidier shape.
      const contract = amt("CONTRACT");
      return {
        net: sells + contract - purchases - refuel - jump - ship,
        sells, purchases, refuel, jump, ship, contract,
        trades: by.get("SELL")?.n ?? 0,
      };
    });
  }

  async earningsByShip(tenantId: string, sinceIso: string): Promise<{ shipSymbol: string; earned: number; spent: number; net: number }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ ship_symbol: string; earned: number; spent: number }>(
        `SELECT ship_symbol,
           COALESCE(SUM(CASE WHEN type = 'SELL' OR trade_symbol = 'SCRAP' THEN total ELSE 0 END), 0) AS earned,
           COALESCE(SUM(CASE WHEN type != 'SELL' AND COALESCE(trade_symbol, '') != 'SCRAP' THEN total ELSE 0 END), 0) AS spent
         FROM ledger
         WHERE timestamp >= $1
         GROUP BY ship_symbol`,
        [sinceIso],
      );
      return res.rows
        .map((r) => ({ shipSymbol: r.ship_symbol, earned: r.earned, spent: r.spent, net: r.earned - r.spent }))
        .sort((a, b) => b.net - a.net);
    });
  }

  /**
   * Net credits bucketed over time, for the rate readout and its sparkline.
   * Buckets are labelled by their start instant.
   */
  async netSeries(tenantId: string, sinceIso: string, bucketMinutes = 60): Promise<{ t: string; net: number }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ timestamp: Date; delta: number }>(
        `SELECT timestamp,
           CASE WHEN type = 'SELL' OR trade_symbol = 'SCRAP' THEN total ELSE -total END AS delta
         FROM ledger
         WHERE timestamp >= $1
         ORDER BY timestamp ASC`,
        [sinceIso],
      );
      const size = bucketMinutes * 60_000;
      const start = new Date(sinceIso).getTime();
      const buckets = new Map<number, number>();
      for (const r of res.rows) {
        const idx = Math.floor((r.timestamp.getTime() - start) / size);
        buckets.set(idx, (buckets.get(idx) ?? 0) + r.delta);
      }
      const last = Math.floor((Date.now() - start) / size);
      const out: { t: string; net: number }[] = [];
      for (let i = 0; i <= last; i += 1) {
        out.push({ t: new Date(start + i * size).toISOString(), net: Math.round(buckets.get(i) ?? 0) });
      }
      return out;
    });
  }

  /** Persist one chat message for the co-pilot. */
  async recordChatMessage(tenantId: string, msg: { role: string; content: string; toolCallId?: string }): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO chat_messages (tenant_id, role, content, tool_call_id, timestamp) VALUES ($1, $2, $3, $4, now())`,
        [tenantId, msg.role, msg.content, msg.toolCallId ?? null],
      ),
    );
  }

  /** Recent co-pilot chat history, oldest first. */
  async chatHistory(tenantId: string, limit = 50): Promise<{ role: string; content: string; toolCallId: string | null; timestamp: string }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ role: string; content: string; tool_call_id: string | null; timestamp: Date }>(
        `SELECT role, content, tool_call_id, timestamp FROM chat_messages ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return res.rows
        .map((r) => ({ role: r.role, content: r.content, toolCallId: r.tool_call_id, timestamp: r.timestamp.toISOString() }))
        .reverse();
    });
  }

  /** Record a doctrine rule firing. */
  async recordDoctrineFire(tenantId: string, ruleKey: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        // fire_count on the right must be qualified — doctrine_fires has
        // FORCE ROW LEVEL SECURITY, and Postgres's RLS query rewrite for
        // ON CONFLICT DO UPDATE introduces a second relation into scope
        // that also has a fire_count column, making the bare name
        // genuinely ambiguous (reproduced directly against production;
        // not present on tables without FORCE ROW LEVEL SECURITY).
        `INSERT INTO doctrine_fires (tenant_id, rule_key, fire_count, last_fired) VALUES ($1, $2, 1, now())
         ON CONFLICT (tenant_id, rule_key) DO UPDATE SET fire_count = doctrine_fires.fire_count + 1, last_fired = now()`,
        [tenantId, ruleKey],
      ),
    );
  }

  /** Get doctrine fire stats for all rules. */
  async getDoctrineFires(tenantId: string): Promise<{ ruleKey: string; fireCount: number; lastFired: string | null }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ rule_key: string; fire_count: number; last_fired: Date | null }>(
        `SELECT rule_key, fire_count, last_fired FROM doctrine_fires ORDER BY fire_count DESC`,
      );
      return res.rows.map((r) => ({
        ruleKey: r.rule_key,
        fireCount: r.fire_count,
        lastFired: r.last_fired?.toISOString() ?? null,
      }));
    });
  }

  /** Log one doctrine rule firing against a specific ship — see doctrine_fire_log's
   *  migration comment for why this is a separate event log from doctrine_fires'
   *  aggregate counter: Book mode's clause hover needs the real hulls a rule
   *  governed, not just a count. */
  async recordDoctrineFireEvent(tenantId: string, ruleKey: string, shipSymbol: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO doctrine_fire_log (tenant_id, rule_key, ship_symbol, fired_at) VALUES ($1, $2, $3, now())`,
        [tenantId, ruleKey, shipSymbol],
      ),
    );
  }

  /** Distinct ships that fired each rule since `sinceIso`, most-recent first,
   *  capped at `limitPerRule` hulls per rule — what Book mode's clause hover
   *  highlights on the field. Rules with no fires in the window are omitted. */
  async getDoctrineFireShips(
    tenantId: string,
    sinceIso: string,
    limitPerRule = 6,
  ): Promise<{ ruleKey: string; ships: string[] }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      // Same fix as pruneShipPositionHistory()/getShipPositionHistory(): the
      // query must reference every placeholder in the params array, or
      // Postgres can't infer that placeholder's type at all — tenantId
      // isn't (and doesn't need to be) referenced in the query text, RLS
      // already scopes it via withTenant's SET LOCAL.
      const res = await c.query<{ rule_key: string; ship_symbol: string; last_fired: Date }>(
        `SELECT rule_key, ship_symbol, max(fired_at) AS last_fired
         FROM doctrine_fire_log
         WHERE fired_at >= $1
         GROUP BY rule_key, ship_symbol
         ORDER BY rule_key, last_fired DESC`,
        [sinceIso],
      );
      const byRule = new Map<string, string[]>();
      for (const r of res.rows) {
        const ships = byRule.get(r.rule_key) ?? [];
        if (ships.length < limitPerRule) ships.push(r.ship_symbol);
        byRule.set(r.rule_key, ships);
      }
      return [...byRule.entries()].map(([ruleKey, ships]) => ({ ruleKey, ships }));
    });
  }

  /**
   * Operator approval gate (docs: ApprovalGate, src/engine/approvals.ts).
   * `kind` identifies the class of decision (e.g. "buyShip") — by convention
   * only one row is ever `pending` per (tenant_id, kind) at a time; that's
   * enforced in ApprovalGate, not here.
   */
  async createPendingApproval(
    tenantId: string,
    kind: string,
    shipSymbol: string | undefined,
    detail: string,
    cost: number | undefined,
    expiresAtIso: string,
  ): Promise<PendingApprovalRow> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<PendingApprovalDbRow>(
        `INSERT INTO pending_approvals (tenant_id, kind, ship_symbol, detail, cost, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, kind, shipSymbol ?? null, detail, cost ?? null, expiresAtIso],
      );
      await this.logFleetEvent(c, tenantId, "approval_requested", shipSymbol, `${kind}: ${detail}`, { kind, cost: cost ?? null });
      return toPendingApprovalRow(res.rows[0]!);
    });
  }

  /** The row ApprovalGate still needs to act on for this kind — either
   *  awaiting a decision, or decided but not yet polled by the engine.
   *  Not the same thing as "awaiting an operator decision"; see
   *  listOpenApprovals() for what the dashboard shows. */
  async getUnconsumedApproval(tenantId: string, kind: string): Promise<PendingApprovalRow | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<PendingApprovalDbRow>(
        `SELECT * FROM pending_approvals WHERE tenant_id = $1 AND kind = $2 AND consumed = false
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, kind],
      );
      return res.rows[0] ? toPendingApprovalRow(res.rows[0]) : undefined;
    });
  }

  /** Most recently *decided* row for this kind — used to hold a denial's
   *  cooldown window without re-asking the operator every tick. */
  async getLastDecidedApproval(tenantId: string, kind: string): Promise<PendingApprovalRow | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<PendingApprovalDbRow>(
        `SELECT * FROM pending_approvals WHERE tenant_id = $1 AND kind = $2 AND status != 'pending'
         ORDER BY decided_at DESC NULLS LAST LIMIT 1`,
        [tenantId, kind],
      );
      return res.rows[0] ? toPendingApprovalRow(res.rows[0]) : undefined;
    });
  }

  /** All open approvals across every kind — what the dashboard's Approvals panel lists. */
  async listOpenApprovals(tenantId: string): Promise<PendingApprovalRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<PendingApprovalDbRow>(
        `SELECT * FROM pending_approvals WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
        [tenantId],
      );
      return res.rows.map(toPendingApprovalRow);
    });
  }

  /** Resolve one approval — an explicit operator decision (dashboard) or
   *  ApprovalGate's own timeout fallback. `consumed` is only ever true for
   *  the latter: a timeout is decided and acted on by the engine in the
   *  same breath, so there's nothing left to poll for. An operator decision
   *  leaves `consumed` false — the engine picks it up (and marks it
   *  consumed itself, via consumeApproval()) on its own next poll. Scoped
   *  by tenant AND id so a stale dashboard tab can't resolve a different
   *  tenant's row. */
  async decideApproval(
    tenantId: string,
    id: string,
    status: "approved" | "denied" | "expired" | "auto_approved",
    consumed = false,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ kind: string; ship_symbol: string | null; detail: string; cost: number | null }>(
        `UPDATE pending_approvals SET status = $3, consumed = $4, decided_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING kind, ship_symbol, detail, cost`,
        [tenantId, id, status, consumed],
      );
      const row = res.rows[0];
      if (row) {
        await this.logFleetEvent(c, tenantId, "approval_decided", row.ship_symbol ?? undefined, `${status}: ${row.kind} — ${row.detail}`, {
          kind: row.kind,
          status,
          cost: row.cost,
          // auto_approved/expired = ApprovalGate's own timeout policy, not a person
          byTimeout: status === "auto_approved" || status === "expired",
        });
      }
    });
  }

  /** Mark an already-decided approval as acted upon — the engine calls this
   *  right after reading an operator's decision off getUnconsumedApproval(). */
  async consumeApproval(tenantId: string, id: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`UPDATE pending_approvals SET consumed = true WHERE tenant_id = $1 AND id = $2`, [tenantId, id]),
    );
  }

  /** Log a deliberate operator intervention — see OperatorActionRow's own
   *  comment on why this is only ever called from an HTTP route, never from
   *  inside FleetManager's shared setShipRole()/buyShip(). */
  async recordOperatorAction(
    tenantId: string,
    kind: string,
    shipSymbol: string | undefined,
    detail: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO operator_actions (tenant_id, kind, ship_symbol, detail, meta) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, kind, shipSymbol ?? null, detail, meta ? JSON.stringify(meta) : null],
      ),
    );
  }

  /** Most recent operator interventions for this tenant, newest first —
   *  what the admin page's play-style panel lists. */
  async listOperatorActions(tenantId: string, limit = 100): Promise<OperatorActionRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<OperatorActionDbRow>(
        `SELECT * FROM operator_actions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [tenantId, limit],
      );
      return res.rows.map(toOperatorActionRow);
    });
  }

  /** Add one entry to the operator's own persisted log/notes-to-self. */
  async addOperatorNote(tenantId: string, body: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`INSERT INTO operator_notes (tenant_id, body) VALUES ($1, $2)`, [tenantId, body]),
    );
  }

  /** Most recent notes for this tenant, newest first. */
  async listOperatorNotes(tenantId: string, limit = 200): Promise<OperatorNoteRow[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<OperatorNoteDbRow>(
        `SELECT * FROM operator_notes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [tenantId, limit],
      );
      return res.rows.map(toOperatorNoteRow);
    });
  }

  /** Delete one note — scoped by tenant AND id, same convention as
   *  decideApproval()'s own scoping comment. */
  async deleteOperatorNote(tenantId: string, id: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`DELETE FROM operator_notes WHERE tenant_id = $1 AND id = $2`, [tenantId, id]),
    );
  }

  /** Snapshot one ship's position — periodic sample the replay scrubber plays back. */
  async recordShipPosition(
    tenantId: string,
    shipSymbol: string,
    waypointSymbol: string,
    x: number,
    y: number,
    status: string,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ship_position_history (tenant_id, ship_symbol, timestamp, waypoint_symbol, x, y, status)
         VALUES ($1, $2, now(), $3, $4, $5, $6)`,
        [tenantId, shipSymbol, waypointSymbol, x, y, status],
      ),
    );
  }

  /** Every position sample recorded since `sinceIso`, oldest first — one row per
   *  ship per refresh cycle. The frontend groups these into scrubber frames. */
  async getShipPositionHistory(
    tenantId: string,
    sinceIso: string,
  ): Promise<{ shipSymbol: string; timestamp: string; waypointSymbol: string; x: number; y: number; status: string }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      // Same $1-must-be-referenced fix as pruneShipPositionHistory() below.
      const res = await c.query<{ ship_symbol: string; timestamp: Date; waypoint_symbol: string; x: number; y: number; status: string }>(
        `SELECT ship_symbol, timestamp, waypoint_symbol, x, y, status
         FROM ship_position_history
         WHERE timestamp >= $1
         ORDER BY timestamp ASC`,
        [sinceIso],
      );
      return res.rows.map((r) => ({
        shipSymbol: r.ship_symbol,
        timestamp: r.timestamp.toISOString(),
        waypointSymbol: r.waypoint_symbol,
        x: r.x,
        y: r.y,
        status: r.status,
      }));
    });
  }

  /** Delete position samples older than `beforeIso` — called opportunistically
   *  from the same refresh cycle that records new ones, so the table stays
   *  bounded (~24h of samples at STATE_REFRESH_MS cadence) without a cron. */
  async pruneShipPositionHistory(tenantId: string, beforeIso: string): Promise<void> {
    // $1 was beforeIso's actual placeholder, but the params array passed
    // tenantId first and the query used $2 — since tenantId is never
    // referenced anywhere in the query text (RLS scopes it via withTenant's
    // SET LOCAL, same as every other method here), Postgres had no type
    // context for $1 at all: "could not determine data type of parameter
    // $1", firing on every refreshState() cycle in production.
    await withTenant(this.pool, tenantId, (c) =>
      c.query(`DELETE FROM ship_position_history WHERE timestamp < $1`, [beforeIso]),
    );
  }

  /**
   * Every table holding a plain fact about the SpaceTraders galaxy itself —
   * not any one tenant's own observation of it. Each one's own migration
   * comment already calls this out ("static for the life of a server
   * reset" — see 011_galaxy_topology.sql, 001_init.sql's "Shared, ungated"
   * section) — a weekly SpaceTraders universe reset invalidates all of it
   * at once: old jump-gate connections, market prices, shipyard stock, and
   * system layouts no longer describe anything real. See
   * admin.ts's POST /reset-cleanup, the operator-facing trigger for this.
   */
  private static readonly SHARED_GALAXY_TABLES = [
    "galaxy_systems", "galaxy_factions", "galaxy_crawl_state",
    "market_snapshots", "market_latest", "shipyard_inventory", "module_catalog",
    "galaxy_jump_costs", "galaxy_gate_construction", "agent_credit_snapshots", "market_transactions", "field_surveys",
  ];

  /** Wipes every shared galaxy-fact table — see SHARED_GALAXY_TABLES's own
   *  comment for why these (and only these) are safe to discard outright:
   *  none of them are tenant-owned, all of them are pure cache of a public,
   *  reset-scoped fact. Table names are an internal constant, never request
   *  input, so string-interpolating them into the query is safe. */
  async truncateSharedGalaxyTables(): Promise<void> {
    this.dropLatestMemo();
    await withPool(this.pool, (c) => c.query(`TRUNCATE ${Store.SHARED_GALAXY_TABLES.join(", ")}`));
  }

  /**
   * Every tenant-scoped table holding a *fact about the old universe* (a
   * ship, a route, a contract, a mission, a financial record) rather than
   * an operator *preference* — `doctrine`/`doctrine_fires`/
   * `doctrine_fire_log` (standing-order settings), `chat_messages` (the
   * co-pilot conversation log), and `sessions` (login state) deliberately
   * stay out of this list: none of them were made wrong by the reset, they
   * just don't need re-entering. Everything below either names a ship
   * symbol from the dead universe or is otherwise meaningless without one.
   */
  private static readonly TENANT_GAME_TABLES = [
    // feed_missions names a target waypoint and assigned ship symbols from
    // the dead universe — the agent name (and so every THEO-N symbol) is
    // reused across resets, so a surviving feed would claim new-universe
    // ships it was never configured for.
    "feed_missions",
    "activity", "bucket_ledger", "buckets", "fleet_flags", "fleet_state",
    "held_route", "ledger", "missions", "pending_approvals", "ship_claims",
    "ship_log", "ship_manifest", "ship_persona", "ship_position_history",
    "ship_state", "state_snapshot", "warehouse", "warehouse_ledger", "warehouse_targets",
  ];

  /** Wipes one tenant's post-reset-stale game data (see
   *  TENANT_GAME_TABLES's own comment for exactly what's included and
   *  why). Plain unqualified `DELETE FROM` is safe and correct here the
   *  same way it is everywhere else in this file: `withTenant()`'s `SET
   *  LOCAL app.tenant_id` plus each table's RLS policy already scopes it
   *  to this one tenant. */
  async wipeTenantGameData(tenantId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      for (const table of Store.TENANT_GAME_TABLES) await c.query(`DELETE FROM ${table}`);
    });
  }

  /**
   * Writes this tenant's scoreboard row for the universe described by
   * `resetDate` (migrations/036_run_results.sql). Reads only what is already in
   * Postgres — the last state snapshot, the ledger, fleet roles, doctrine — so
   * it works after the game token has died, which is exactly when the reset
   * watcher calls it (just before wiping that data). Idempotent: a second call
   * for the same agent + resetDate keeps the first row (a retry after the wipe
   * would otherwise overwrite real numbers with an empty week). Returns whether
   * a row was written.
   */
  async captureRunResult(
    tenantId: string,
    agentSymbol: string,
    resetDate: string,
    opts: { endedByReset?: string; kind?: "reset" | "manual"; notes?: string } = {},
  ): Promise<boolean> {
    const n = (v: unknown): number => Math.round(Number(v ?? 0));
    return withTenant(this.pool, tenantId, async (c) => {
      const snapRow = (await c.query(`SELECT snapshot, updated_at FROM state_snapshot`)).rows[0];
      const snap = (snapRow?.snapshot ?? {}) as {
        agent?: { credits?: number; headquarters?: string };
        ships?: { registration?: { role?: string } }[];
        systemSymbol?: string;
        totals?: { credits?: number };
      };
      const finalCredits = snap.agent?.credits ?? undefined;
      const byClass: Record<string, number> = {};
      for (const s of snap.ships ?? []) {
        const r = s.registration?.role ?? "UNKNOWN";
        byClass[r] = (byClass[r] ?? 0) + 1;
      }

      const roles: Record<string, number> = {};
      for (const r of (await c.query(`SELECT role, COUNT(*)::int AS n FROM fleet_state GROUP BY role`)).rows) roles[r.role] = r.n;

      const byType: Record<string, { n: number; total: number }> = {};
      for (const r of (await c.query(`SELECT type, COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total FROM ledger GROUP BY type`)).rows) {
        byType[r.type] = { n: r.n, total: n(r.total) };
      }
      const matched = (await c.query(
        `SELECT COUNT(*)::int AS trades, COALESCE(SUM(realized_pnl),0) AS pnl FROM ledger WHERE type = 'SELL' AND realized_pnl IS NOT NULL`,
      )).rows[0];
      const topShips = (await c.query(
        `SELECT ship_symbol, COUNT(*)::int AS sells, COALESCE(SUM(realized_pnl),0) AS pnl FROM ledger
         WHERE type = 'SELL' AND realized_pnl IS NOT NULL GROUP BY ship_symbol ORDER BY pnl DESC LIMIT 5`,
      )).rows.map((r: any) => ({ ship: r.ship_symbol, sells: r.sells, pnl: n(r.pnl) }));
      const topGoods = (await c.query(
        `SELECT trade_symbol, COUNT(*)::int AS sells, COALESCE(SUM(realized_pnl),0) AS pnl FROM ledger
         WHERE type = 'SELL' AND realized_pnl IS NOT NULL AND trade_symbol IS NOT NULL GROUP BY trade_symbol ORDER BY pnl DESC LIMIT 5`,
      )).rows.map((r: any) => ({ good: r.trade_symbol, sells: r.sells, pnl: n(r.pnl) }));
      const span = (await c.query(
        `SELECT LEAST((SELECT MIN(timestamp) FROM ledger), (SELECT MIN(timestamp) FROM activity)) AS first_at`,
      )).rows[0];

      // Every SpaceTraders agent registers with the same grant; the earliest public
      // credit snapshot is hours into the week (115k observed), so it cannot be
      // used as the starting balance. Peak still comes from the hourly snapshots.
      const peakRow = (await c.query(`SELECT MAX(credits) AS peak FROM agent_credit_snapshots WHERE agent_symbol = $1`, [agentSymbol])).rows[0];
      const startingCredits = STARTING_CREDITS;
      const peak = Math.max(n(peakRow?.peak), n(finalCredits));

      const contracts: Record<string, number> = {};
      for (const r of (await c.query(`SELECT status, COUNT(*)::int AS n FROM missions GROUP BY status`)).rows) contracts[r.status] = r.n;
      const doctrine: Record<string, { value: number; enabled: boolean }> = {};
      for (const r of (await c.query(`SELECT key, value, enabled FROM doctrine`)).rows) doctrine[r.key] = { value: Number(r.value), enabled: r.enabled };
      const actions = (await c.query(`SELECT COUNT(*)::int AS n FROM operator_actions`)).rows[0]?.n ?? 0;
      const profile = (await c.query(`SELECT play_profile FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.play_profile ?? null;

      // A manual capture is a refreshable mid-week peek, so it replaces its own
      // earlier row; a reset capture is write-once (see the doc comment above).
      if (opts.kind === "manual") await c.query(`DELETE FROM run_results WHERE agent_symbol = $1 AND reset_date = $2 AND capture_kind = 'manual'`, [agentSymbol, resetDate]);
      const insert = await c.query(
        `INSERT INTO run_results (
           agent_symbol, tenant_id, reset_date, ended_by_reset, capture_kind, started_at, ended_at, home_system, headquarters, play_profile,
           starting_credits, final_credits, peak_credits, wallet_delta, ship_count, ships_by_role, ships_by_class,
           trading_net, trades, sell_revenue, purchase_cost, fuel_cost, jump_cost, jumps, ship_spend,
           ledger_by_type, top_ships, top_goods, contracts, doctrine, operator_actions, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
         ON CONFLICT (agent_symbol, reset_date, capture_kind) DO NOTHING`,
        [
          agentSymbol, tenantId, resetDate, opts.endedByReset ?? null, opts.kind ?? "reset",
          span?.first_at ?? null, snapRow?.updated_at ?? null,
          snap.systemSymbol || null, snap.agent?.headquarters ?? null, profile,
          startingCredits, finalCredits ?? null, peak, finalCredits != null ? finalCredits - startingCredits : null,
          (snap.ships ?? []).length, JSON.stringify(roles), JSON.stringify(byClass),
          n(matched?.pnl), matched?.trades ?? 0,
          byType.SELL?.total ?? 0, byType.PURCHASE?.total ?? 0, byType.REFUEL?.total ?? 0,
          byType.JUMP?.total ?? 0, byType.JUMP?.n ?? 0, byType.SHIP?.total ?? 0,
          JSON.stringify(byType), JSON.stringify(topShips), JSON.stringify(topGoods), JSON.stringify(contracts),
          JSON.stringify(doctrine), actions, opts.notes ?? null,
        ],
      );
      return (insert.rowCount ?? 0) > 0;
    });
  }

  /** One cash/fleet sample for the weekly curve (migration 037). Best-effort. */
  async recordRunTimeline(
    tenantId: string,
    sample: { credits: number | null; shipCount: number; roles: Record<string, number>; buys?: number; sells?: number },
  ): Promise<void> {
    await withPool(this.pool, (c) =>
      c.query(
        `INSERT INTO run_timeline (agent_symbol, tenant_id, reset_date, credits, ship_count, roles, buys, sells)
         SELECT agent_symbol, id, $2, $3, $4, $5, $6, $7 FROM tenants WHERE id = $1`,
        [tenantId, getCurrentResetDate(), sample.credits, sample.shipCount, JSON.stringify(sample.roles), sample.buys ?? null, sample.sells ?? null],
      ),
    );
  }

  /**
   * The fleet's story, oldest-to-newest within the window: fleet_events (roles,
   * purchases, approvals) merged with operator_actions (everything an operator
   * did, including manual routes and checkpoint notes). Both survive the weekly
   * wipe. `agentSymbol` + optional `resetDate` select the week.
   */
  async opsTimeline(
    agentSymbol: string,
    opts: { sinceIso?: string; resetDate?: string; kinds?: string[]; ship?: string; limit: number },
  ): Promise<{ ts: string; source: string; kind: string; ship: string | null; detail: string; meta: unknown }[]> {
    return withPool(this.pool, async (c) => {
      const events = await c.query(
        `SELECT ts, 'event' AS source, kind, ship_symbol, detail, meta FROM fleet_events
         WHERE agent_symbol = $1 AND ($2::text IS NULL OR reset_date = $2) AND ($3::timestamptz IS NULL OR ts >= $3)
           AND ($4::text IS NULL OR ship_symbol = $4)`,
        [agentSymbol, opts.resetDate ?? null, opts.sinceIso ?? null, opts.ship ?? null],
      );
      // operator_actions is row-level-secured; read it through the tenant of this agent.
      const tenantId = (await c.query(`SELECT id FROM tenants WHERE agent_symbol = $1`, [agentSymbol])).rows[0]?.id as string | undefined;
      let ops: any[] = [];
      if (tenantId) {
        ops = await withTenant(this.pool, tenantId, async (tc) =>
          (await tc.query(
            `SELECT created_at AS ts, 'operator' AS source, kind, ship_symbol, detail, meta FROM operator_actions
             WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::text IS NULL OR ship_symbol = $2)`,
            [opts.sinceIso ?? null, opts.ship ?? null],
          )).rows,
        );
      }
      const rows = [...events.rows, ...ops]
        .filter((r) => !opts.kinds?.length || opts.kinds.includes(r.kind))
        .map((r) => ({ ts: new Date(r.ts).toISOString(), source: r.source as string, kind: r.kind as string, ship: (r.ship_symbol ?? null) as string | null, detail: r.detail as string, meta: r.meta }))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      return rows.slice(-opts.limit);
    });
  }

  /** The 15-minute cash/fleet samples for one agent, oldest first. */
  async listRunTimeline(agentSymbol: string, opts: { sinceIso?: string; resetDate?: string; limit: number }): Promise<Record<string, unknown>[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query(
        `SELECT ts, reset_date, credits, ship_count, roles FROM (
           SELECT * FROM run_timeline WHERE agent_symbol = $1 AND ($2::text IS NULL OR reset_date = $2) AND ($3::timestamptz IS NULL OR ts >= $3)
           ORDER BY ts DESC LIMIT $4) t ORDER BY ts ASC`,
        [agentSymbol, opts.resetDate ?? null, opts.sinceIso ?? null, opts.limit],
      );
      return res.rows;
    });
  }

  /** Newest first. Not tenant-scoped (see migration 036). */
  async listRunResults(limit = 20): Promise<Record<string, unknown>[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query(`SELECT * FROM run_results ORDER BY captured_at DESC LIMIT $1`, [limit]);
      return res.rows;
    });
  }
}
