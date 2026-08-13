import type pg from "pg";
import { withTenant } from "./pool.js";

/**
 * Async, tenant-scoped port of straders' `Store` (src/engine/store.ts).
 *
 * Every method here takes `tenantId` and routes through `withTenant`, which
 * sets `app.tenant_id` for the query — RLS does the actual enforcement, this
 * class doesn't add `WHERE tenant_id = ...` by hand anywhere. That's
 * deliberate: the whole point of the RLS design (docs/architecture-plan.md
 * §1) is that isolation doesn't depend on every method here remembering the
 * clause correctly.
 *
 * NOT a complete port. This is the Phase 0 scaffold — enough methods to
 * prove the pattern (simple insert, upsert-on-conflict, key/value flags, and
 * the weighted-average-cost warehouse logic, which is the most business-rule
 * -heavy method in the original) against a real Postgres instance with real
 * tests, including the cross-tenant isolation test that's the actual point
 * of this design. The remaining ~35 methods in straders' Store follow the
 * same three patterns already proven here and are mechanical to port.
 *
 * Ported so far: recordLedger, ledgerTotals, recordActivity, recentActivity,
 * getDoctrine, setDoctrine, getFleetFlag, setFleetFlag, removeFleetFlag,
 * warehouseBalance, warehouseAll, warehouseDeposit, warehouseWithdraw,
 * lastPurchasePrice, avgPurchasePrice.
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
      const res = await c.query<{ buys: string | null; sells: string | null }>(
        `SELECT
           COALESCE(SUM(total) FILTER (WHERE total < 0), 0) AS buys,
           COALESCE(SUM(total) FILTER (WHERE total > 0), 0) AS sells
         FROM ledger`,
      );
      const row = res.rows[0]!;
      const buys = Number(row.buys ?? 0);
      const sells = Number(row.sells ?? 0);
      return { credits: buys + sells, buys, sells };
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
}
