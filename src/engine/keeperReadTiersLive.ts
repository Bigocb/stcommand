import type { Doctrine } from "./doctrine.js";
import {
  DEFAULT_KEEPER_READ_TIER_POLICY, boardFactsByMarket, classifyKeeperMarket, keeperReadIntervals, summarizeKeeperReadTiers,
  type BoardFacts, type KeeperReadTierDecision, type KeeperReadTierPolicy,
} from "./keeperReadTiers.js";

/**
 * The fleet's side of the keeper read tiers (keeperReadTiers.ts): reads the doctrine knobs, keeps a one-minute cache of the
 * board and our recent trades by market, and answers per market. Everything cached is rebuilt from the dispatcher (whose
 * routes are recomputed and whose trade lots are saved across restarts) and the market registry, so nothing here needs saving.
 */
export interface KeeperReadTierSources {
  doctrine: Pick<Doctrine, "isEnabledOr" | "value">;
  /** The dispatcher's board. */
  routes: () => readonly { buyAt: string; sellAt: string; profitPerTrip: number }[];
  /** Current trader assignments (auto and manual). */
  assignments: () => readonly { buyAt?: string; sellAt?: string }[];
  /** Market -> when we last bought or sold there. */
  lastTrades: () => ReadonlyMap<string, number>;
  /** When a market was last read (ms epoch), or undefined. */
  lastReadAt: (waypoint: string) => number | undefined;
}

export const READ_TIER_CACHE_MS = 60_000;

export class KeeperReadTiersLive {
  private cache?: { at: number; board: Map<string, BoardFacts>; trades: ReadonlyMap<string, number> };

  constructor(private readonly src: KeeperReadTierSources) {}

  /** The policy from doctrine, or undefined while the keeperReadTiers clause is off (today's behaviour). */
  policy(): KeeperReadTierPolicy | undefined {
    const d = this.src.doctrine;
    if (!d.isEnabledOr("keeperReadTiers", false)) return undefined;
    const knob = (k: string, def: number) => (d.isEnabledOr(k, true) ? d.value(k) : def);
    const p = DEFAULT_KEEPER_READ_TIER_POLICY;
    const intelMin = d.isEnabledOr("snapshotMaxAgeMin", true) ? d.value("snapshotMaxAgeMin") : undefined;
    return {
      hotMs: knob("keeperReadHotMin", p.hotMs / 60_000) * 60_000,
      warmMs: knob("keeperReadWarmMin", p.warmMs / 60_000) * 60_000,
      coldMs: knob("keeperReadColdMin", p.coldMs / 60_000) * 60_000,
      topN: Math.max(0, Math.floor(knob("keeperReadTopRoutes", p.topN))),
      warmMinProfit: knob("keeperReadWarmMinProfit", p.warmMinProfit),
      recentTradeMs: knob("keeperReadRecentTradeHours", p.recentTradeMs / 3_600_000) * 3_600_000,
      ...(intelMin !== undefined ? { ceilingMs: Math.max(5, intelMin - 5) * 60_000 } : {}),
    };
  }

  private facts(nowMs: number): { board: Map<string, BoardFacts>; trades: ReadonlyMap<string, number> } {
    if (!this.cache || nowMs - this.cache.at >= READ_TIER_CACHE_MS || nowMs < this.cache.at) {
      this.cache = { at: nowMs, board: boardFactsByMarket(this.src.routes(), this.src.assignments()), trades: this.src.lastTrades() };
    }
    return this.cache;
  }

  /** The tier decision for one market, or undefined while the clause is off. */
  decide(waypoint: string, nowMs: number): KeeperReadTierDecision | undefined {
    const policy = this.policy();
    if (!policy) return undefined;
    const { board, trades } = this.facts(nowMs);
    const b = board.get(waypoint);
    const lastTradeAt = trades.get(waypoint);
    const lastReadAt = this.src.lastReadAt(waypoint);
    return classifyKeeperMarket({
      waypoint,
      assignedRoute: b?.assignedRoute ?? false,
      ...(b?.boardRank !== undefined ? { boardRank: b.boardRank } : {}),
      ...(b?.bestLegProfit !== undefined ? { bestLegProfit: b.bestLegProfit } : {}),
      ...(lastTradeAt !== undefined ? { lastTradeAt } : {}),
      ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    }, policy, nowMs);
  }

  /** Read interval for a market under its tier, or undefined while the clause is off. */
  intervalMs(waypoint: string, nowMs: number): number | undefined {
    return this.decide(waypoint, nowMs)?.intervalMs;
  }

  /** How long a keeper at this market should wait before reading it (0 = due), or undefined while the clause is off. */
  waitMs(waypoint: string, nowMs: number): number | undefined {
    return this.decide(waypoint, nowMs)?.dueInMs;
  }

  /** waypoint -> interval for the given markets (empty while the clause is off). */
  intervals(markets: Iterable<string>, nowMs: number): Map<string, number> {
    const out: KeeperReadTierDecision[] = [];
    for (const m of new Set(markets)) { const d = this.decide(m, nowMs); if (d) out.push(d); }
    return keeperReadIntervals(out);
  }

  /** For ops keeper_coverage: the counts and effective pass time per tier, with a few example reasons. */
  report(markets: Iterable<string>, nowMs: number, measuredReadsPerMin?: number): Record<string, unknown> {
    const policy = this.policy();
    if (!policy) return { enabled: false, note: "clause keeperReadTiers is off: every keeper market follows the price-change cadence (keeperPollMaxMin)" };
    const decisions: KeeperReadTierDecision[] = [];
    const reads = new Map<string, { lastReadAt?: number }>();
    for (const m of new Set(markets)) {
      const d = this.decide(m, nowMs);
      if (!d) continue;
      decisions.push(d);
      const at = this.src.lastReadAt(m);
      reads.set(m, at !== undefined ? { lastReadAt: at } : {});
    }
    const summary = summarizeKeeperReadTiers(decisions, reads, nowMs, measuredReadsPerMin);
    const examples = (tier: string) => decisions.filter((d) => d.tier === tier).slice(0, 5).map((d) => `${d.waypoint}: ${d.reason}`);
    return {
      enabled: true,
      policy: { hotMin: policy.hotMs / 60_000, warmMin: policy.warmMs / 60_000, coldMin: policy.coldMs / 60_000, topRoutes: policy.topN, warmMinProfit: policy.warmMinProfit, recentTradeHours: policy.recentTradeMs / 3_600_000, ceilingMin: policy.ceilingMs === undefined ? null : policy.ceilingMs / 60_000 },
      ...summary,
      examples: { HOT: examples("HOT"), WARM: examples("WARM"), COLD: examples("COLD") },
    };
  }
}
