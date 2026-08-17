import type pg from "pg";
import { withTenant, withPool } from "./pool.js";

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
  type: "PURCHASE" | "SELL" | "REFUEL" | "SHIP" | "OTHER";
  tradeSymbol?: string;
  units?: number;
  pricePerUnit?: number;
  total: number;
}

export interface ActivityEntry {
  timestamp: string;
  shipSymbol: string;
  kind: string;
  detail: string;
  credits?: number;
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
export type ShipOwner = "operator" | "mission" | "warehouse" | "keeper" | "auto";

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
  assignedShip: string | null;
  materials: { tradeSymbol: string; required: number; fulfilled: number }[];
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  constructor(private readonly pool: pg.Pool) {}

  // ── Ledger ──────────────────────────────────────────────────

  async recordLedger(tenantId: string, entry: LedgerEntry): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO ledger (tenant_id, timestamp, ship_symbol, waypoint_symbol, type, trade_symbol, units, price_per_unit, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ],
      ),
    );
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
   */
  async goodPriceHistory(good: string, since: string): Promise<{ t: string; avg: number; min: number; max: number }[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{ t: string; avg: string; min: number; max: number }>(
        `SELECT
           to_char(date_trunc('minute', timestamp), 'YYYY-MM-DD"T"HH24:MI') AS t,
           ROUND(AVG(sell_price)::numeric, 1) AS avg,
           MIN(sell_price) AS min,
           MAX(sell_price) AS max
         FROM market_snapshots
         WHERE good_symbol = $1 AND timestamp >= $2
         GROUP BY t
         ORDER BY t ASC`,
        [good, since],
      );
      return res.rows.map((r) => ({ t: r.t, avg: Number(r.avg), min: r.min, max: r.max }));
    });
  }

  // ── Doctrine ────────────────────────────────────────────────

  async getDoctrine(tenantId: string): Promise<{ key: string; value: number; enabled: boolean }[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ key: string; value: number; enabled: boolean }>(`SELECT key, value, enabled FROM doctrine`);
      return res.rows;
    });
  }

  async setDoctrine(tenantId: string, key: string, value: number, enabled: boolean): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO doctrine (tenant_id, key, value, enabled, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        [tenantId, key, value, enabled],
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

  async setFleetState(tenantId: string, shipSymbol: string, role: string, keeperMarket?: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO fleet_state (tenant_id, ship_symbol, role, keeper_market, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, ship_symbol) DO UPDATE SET role = excluded.role, keeper_market = excluded.keeper_market, updated_at = excluded.updated_at`,
        [tenantId, shipSymbol, role, keeperMarket ?? null],
      ),
    );
  }

  async removeFleetState(tenantId: string, shipSymbol: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) => c.query(`DELETE FROM fleet_state WHERE ship_symbol = $1`, [shipSymbol]));
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

  async lastPurchasePrice(tenantId: string, shipSymbol: string, goodSymbol: string): Promise<number | undefined> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ price_per_unit: number }>(
        `SELECT price_per_unit FROM ledger
         WHERE type = 'PURCHASE' AND ship_symbol = $1 AND trade_symbol = $2 AND price_per_unit > 0
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
        [shipSymbol, goodSymbol],
      );
      return res.rows[0]?.price_per_unit;
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
    await withPool(this.pool, async (c) => {
      await c.query(
        `INSERT INTO market_snapshots (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [m.systemSymbol, m.waypointSymbol, m.goodSymbol, m.type, m.supply, m.purchasePrice, m.sellPrice, m.tradeVolume],
      );
      // Greenfield Phase 1 read model: keep market_latest in lockstep with
      // the append-only history table so latestMarketSnapshots/
      // freshMarketSnapshots/bestTrades/tradeLegs can read one row per
      // waypoint+good directly instead of re-deriving it with a
      // ROW_NUMBER() OVER (PARTITION BY ...) scan of the whole history.
      await c.query(
        `INSERT INTO market_latest (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (waypoint_symbol, good_symbol) DO UPDATE SET
           system_symbol = excluded.system_symbol,
           type = excluded.type,
           supply = excluded.supply,
           purchase_price = excluded.purchase_price,
           sell_price = excluded.sell_price,
           trade_volume = excluded.trade_volume,
           timestamp = excluded.timestamp`,
        [m.systemSymbol, m.waypointSymbol, m.goodSymbol, m.type, m.supply, m.purchasePrice, m.sellPrice, m.tradeVolume],
      );
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
   * Return the most recent market snapshot per waypoint per good — a plain
   * read of the market_latest projection (Greenfield Phase 1), not a
   * PARTITION BY scan of the whole append-only history table.
   */
  async latestMarketSnapshots(): Promise<MarketRow[]> {
    return withPool(this.pool, async (c) => {
      const res = await c.query(`SELECT * FROM market_latest`);
      return res.rows.map(Store.mapMarketRow);
    });
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
  async tradeLegs(maxAgeMinutes = 90): Promise<
    {
      goodSymbol: string;
      buyAt: string;
      buySystem: string;
      buyPrice: number;
      sellAt: string;
      sellSystem: string;
      sellPrice: number;
      volume: number;
      stalestIso: string;
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
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
        `WITH latest AS (
           SELECT * FROM market_latest WHERE timestamp >= now() - ($1 || ' minutes')::interval
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
           LEAST(b.timestamp, s.timestamp)        AS stalest
         FROM latest b
         JOIN latest s
           ON s.good_symbol = b.good_symbol
          AND s.waypoint_symbol != b.waypoint_symbol
         WHERE s.sell_price > b.purchase_price
           AND b.purchase_price > 0`,
        [maxAgeMinutes],
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
        stalestIso: r.stalest.toISOString(),
      }));
    });
  }

  /** Record or update shipyard inventory for a waypoint. */
  async recordShipyardInventory(
    systemSymbol: string,
    waypointSymbol: string,
    ships: { type: string; name: string; purchasePrice: number; frame?: { fuelCapacity?: number; cargoCapacity?: number; moduleSlots?: number; mountingPoints?: number; symbol?: string } }[],
  ): Promise<void> {
    await withPool(this.pool, async (c) => {
      for (const s of ships) {
        const frame = s.frame ?? {};
        await c.query(
          `INSERT INTO shipyard_inventory (timestamp, system_symbol, waypoint_symbol, ship_type, ship_type_name, purchase_price, fuel_capacity, cargo_capacity, module_slots, mounting_points, frame_symbol, unique_key)
           VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (unique_key) DO UPDATE SET
             timestamp = excluded.timestamp, purchase_price = excluded.purchase_price, fuel_capacity = excluded.fuel_capacity,
             cargo_capacity = excluded.cargo_capacity, module_slots = excluded.module_slots, mounting_points = excluded.mounting_points,
             frame_symbol = excluded.frame_symbol`,
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
    }[]
  > {
    return withPool(this.pool, async (c) => {
      const res = await c.query<{
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
         SELECT system_symbol, waypoint_symbol, ship_type, ship_type_name, purchase_price, fuel_capacity, cargo_capacity, module_slots, mounting_points, frame_symbol, timestamp
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

  // ── Missions (tenant-scoped) ────────────────────────────────

  async recordMission(
    tenantId: string,
    m: {
      kind: string;
      targetSystem: string;
      targetWaypoint: string;
      status: string;
      assignedShip?: string;
      materials: { tradeSymbol: string; required: number; fulfilled: number }[];
      paused?: boolean;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO missions (tenant_id, kind, target_system, target_waypoint, status, assigned_ship, materials, paused, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (tenant_id, target_waypoint) DO UPDATE SET
           status = excluded.status, assigned_ship = excluded.assigned_ship, materials = excluded.materials,
           paused = excluded.paused, updated_at = excluded.updated_at`,
        [
          tenantId,
          m.kind,
          m.targetSystem,
          m.targetWaypoint,
          m.status,
          m.assignedShip ?? null,
          JSON.stringify(m.materials),
          m.paused ?? false,
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
        assigned_ship: string | null;
        materials: { tradeSymbol: string; required: number; fulfilled: number }[];
        paused: boolean;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT kind, target_system, target_waypoint, status, assigned_ship, materials, paused, created_at, updated_at
          FROM missions ORDER BY updated_at DESC`);
      return res.rows.map((r) => ({
        kind: r.kind as "SUPPLY_CONSTRUCTION",
        targetSystem: r.target_system,
        targetWaypoint: r.target_waypoint,
        status: r.status as "active" | "complete",
        assignedShip: r.assigned_ship,
        materials: r.materials,
        paused: r.paused,
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

  /**
   * Net credits per ship over a window. SELL is income; PURCHASE, REFUEL and
   * ship purchases are spend. Scrapping is recorded as type SHIP but returns
   * credits, so it is counted as income.
   */
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
      const res = await c.query<{ rule_key: string; ship_symbol: string; last_fired: Date }>(
        `SELECT rule_key, ship_symbol, max(fired_at) AS last_fired
         FROM doctrine_fire_log
         WHERE fired_at >= $2
         GROUP BY rule_key, ship_symbol
         ORDER BY rule_key, last_fired DESC`,
        [tenantId, sinceIso],
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
      const res = await c.query<{ ship_symbol: string; timestamp: Date; waypoint_symbol: string; x: number; y: number; status: string }>(
        `SELECT ship_symbol, timestamp, waypoint_symbol, x, y, status
         FROM ship_position_history
         WHERE timestamp >= $2
         ORDER BY timestamp ASC`,
        [tenantId, sinceIso],
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
}
