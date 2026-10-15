/**
 * Action events: the decisions and changes the analysis engine correlates with outcomes (docs/analysis-engine.md).
 *
 * Pure builders. Each returns the record the store writes to action_events; the callers (TraderAgent, FleetManager,
 * Doctrine) only decide when to emit one. A trip's planned and closed events share a correlation id, so the analysis
 * can compare what the bot expected with what happened. A settings change carries its before and after values.
 */
import type { ActionEventRecord } from "../db/store.js";

/** A trip's correlation id: ship, good and the moment its first lot was bought. Unique per ship. */
export function tripId(shipSymbol: string, good: string, startedAtMs: number): string {
  return `trip:${shipSymbol}:${good}:${startedAtMs}`;
}

export interface TripPlan {
  shipSymbol: string;
  good: string;
  buyAt: string;
  sellAt: string;
  /** Prices and units the route was chosen on. */
  buyPrice: number;
  sellPrice: number;
  units: number;
  /** The route's own profit estimate after slippage and trip cost (TraderAgent.routeProfit()). */
  profit: number;
  /** The trip cost included in `profit` (fuel and jumps). */
  tripCost: number;
  lotSize: number;
  /** Each market's own trade volume, for impact. */
  buyVolume?: number;
  sellVolume?: number;
  /** Who chose it: auto (dispatcher) or manual (operator route). */
  source?: string;
  /** Lots per trip in force (doctrine or the ship's own lot policy). */
  maxLots?: number;
}

/** The trip's first lot was bought: record what it was expected to earn. */
export function tripPlannedEvent(plan: TripPlan, id: string, atIso: string, bought: { units: number; avgPrice: number }): ActionEventRecord {
  return {
    at: atIso,
    kind: "trip_planned",
    actor: plan.source === "manual" ? "operator" : "engine",
    shipSymbol: plan.shipSymbol,
    good: plan.good,
    waypoint: plan.buyAt,
    correlationId: id,
    subject: `${plan.buyAt}>${plan.sellAt}`,
    expected: {
      buyPrice: plan.buyPrice,
      sellPrice: plan.sellPrice,
      units: plan.units,
      profit: Math.round(plan.profit),
      tripCost: Math.round(plan.tripCost),
      margin: plan.sellPrice - plan.buyPrice,
    },
    observed: { unitsBought: bought.units, avgBuyPrice: Math.round(bought.avgPrice) },
    context: {
      lotSize: plan.lotSize,
      buyVolume: plan.buyVolume ?? null,
      sellVolume: plan.sellVolume ?? null,
      source: plan.source ?? null,
      maxLots: plan.maxLots ?? null,
    },
    reason: `${plan.good} ${plan.buyAt}>${plan.sellAt}: expected ${Math.round(plan.profit)}c on ${plan.units}u`,
  };
}

export interface TripClose {
  shipSymbol: string;
  good: string;
  sellAt: string;
  buyAt?: string;
  unitsSold: number;
  revenue: number;
  /** Cost basis of the units sold (average paid x units). */
  cost: number;
  /** When the trip's first lot was bought, if this process saw it. */
  startedAtMs?: number;
}

/** The hold was sold down: record what the trip actually made. */
export function tripClosedEvent(close: TripClose, id: string, atIso: string, atMs: number): ActionEventRecord {
  const profit = close.revenue - close.cost;
  const minutes = close.startedAtMs !== undefined ? Math.round((atMs - close.startedAtMs) / 60_000) : null;
  return {
    at: atIso,
    kind: "trip_closed",
    actor: "engine",
    shipSymbol: close.shipSymbol,
    good: close.good,
    waypoint: close.sellAt,
    correlationId: id,
    subject: close.buyAt ? `${close.buyAt}>${close.sellAt}` : undefined,
    observed: {
      unitsSold: close.unitsSold,
      revenue: Math.round(close.revenue),
      cost: Math.round(close.cost),
      profit: Math.round(profit),
      avgSellPrice: close.unitsSold > 0 ? Math.round(close.revenue / close.unitsSold) : null,
      minutes,
    },
    reason: `${close.good} sold ${close.unitsSold}u at ${close.sellAt}: ${profit >= 0 ? "+" : ""}${Math.round(profit)}c`,
  };
}

/** A setting changed: doctrine rule, a ship's lot policy, the keeper list. Null when nothing actually changed. */
export function configChangeEvent(c: {
  setting: string;
  before: unknown;
  after: unknown;
  actor?: ActionEventRecord["actor"];
  shipSymbol?: string;
  atIso: string;
  reason?: string;
}): ActionEventRecord | null {
  if (JSON.stringify(c.before) === JSON.stringify(c.after)) return null;
  return {
    at: c.atIso,
    kind: "config_change",
    actor: c.actor ?? "operator",
    shipSymbol: c.shipSymbol,
    subject: c.setting,
    context: { before: c.before ?? null, after: c.after ?? null },
    reason: c.reason ?? `${c.setting}: ${JSON.stringify(c.before ?? null)} -> ${JSON.stringify(c.after ?? null)}`,
  };
}

/** The keeper list change as added/removed markets, so a 150-entry list doesn't swamp the row. */
export function keeperListChange(before: string[], after: string[]): { added: string[]; removed: string[]; count: number } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((m) => !b.has(m)),
    removed: before.filter((m) => !a.has(m)),
    count: after.length,
  };
}
