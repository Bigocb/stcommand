/**
 * Freshness: what a system yields in the hours after it gains keeper coverage, against what the same fleet earns in systems
 * that have been covered a while.
 *
 * Why (docs/fresh-system-expansion-plan.md): on 2026-10-23 the best hours came from big hulls selling into systems that had just
 * been added to the keeper list, and the profit per unit fell as we sold into them (THEOREM-152 in X1-YB39 and X1-UF49: about 1,170
 * a unit, then 860, then 770, against 350-480 in older systems). That was read off two ships by hand. This module makes it a
 * standing measurement: a curve of profit per unit by age since coverage, so "always be expanding" can be checked, and tuned,
 * from the first days of a week.
 *
 * The anchor is when a system's first market joined the keeper priority list (the `keeper_markets` config change), not when a
 * keeper arrived and read it: that is the moment the engine decided to cover it and the data the analysis already holds. A
 * keeper takes some time to be bought and to arrive, so ages are slightly generous; the first sell after the anchor says how long
 * routes took to appear. Systems already covered before the first recorded change have no anchor and count as mature.
 *
 * Pure: no I/O, no clock. The caller passes the ledger's sells, the keeper-list events and `nowMs`.
 */
import type { ActionEventRow, AnalysisLedgerRow } from "../../db/store.js";
import { round2, confidenceFor, type Finding } from "./types.js";

export interface FreshnessPolicy {
  /** Upper edges of the age buckets, in hours since coverage. The last bucket runs to the end of the window. */
  bucketEdgesH: readonly number[];
  /** Sells at or after this age (hours) count as mature, the baseline each bucket is compared with. */
  matureAfterH: number;
  /** Sells a bucket needs before a ratio is quoted or a finding made. */
  minSells: number;
  /** A bucket "earns a premium" when its profit per unit is at least this multiple of the mature figure. */
  premiumRatio: number;
  /** Most per-system rows in the report. */
  topSystems: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  bucketEdgesH: [2, 4, 8, 16],
  matureAfterH: 16,
  minSells: 15,
  premiumRatio: 1.25,
  topSystems: 10,
};

export interface Coverage {
  system: string;
  /** When the system's first market joined the keeper list, ms. */
  atMs: number;
  /** Markets added in that first change. */
  markets: number;
}

/** "X1-YB39-EA6F" -> "X1-YB39". */
export function systemOf(waypoint: string): string {
  const p = waypoint.split("-");
  return p.length >= 2 ? `${p[0]}-${p[1]}` : waypoint;
}

/**
 * The earliest keeper-list addition per system, from the `keeper_markets` config changes. A `system_release` event (the fresh-system
 * gate opening, systemQueue.ts) replaces the anchor for its system: the keepers were listed earlier, but traders could only reach the
 * system from the release, so that is when its premium starts.
 */
export function coverageFromEvents(events: readonly ActionEventRow[]): Coverage[] {
  const first = new Map<string, Coverage>();
  const released = new Map<string, Coverage>();
  for (const e of events) {
    if (e.kind === "config_change" && e.subject === "system_release") {
      const after = (e.context as { after?: { system?: unknown; markets?: unknown } } | undefined)?.after;
      const at = Date.parse(e.at);
      if (typeof after?.system === "string" && Number.isFinite(at)) {
        const have = released.get(after.system);
        if (!have || at < have.atMs) released.set(after.system, { system: after.system, atMs: at, markets: typeof after.markets === "number" ? after.markets : 0 });
      }
      continue;
    }
    if (e.kind !== "config_change" || e.subject !== "keeper_markets") continue;
    const after = (e.context as { after?: { added?: unknown } } | undefined)?.after;
    const added = Array.isArray(after?.added) ? (after!.added as unknown[]).filter((m): m is string => typeof m === "string") : [];
    const at = Date.parse(e.at);
    if (!added.length || !Number.isFinite(at)) continue;
    const perSystem = new Map<string, number>();
    for (const m of added) perSystem.set(systemOf(m), (perSystem.get(systemOf(m)) ?? 0) + 1);
    for (const [system, n] of perSystem) {
      const have = first.get(system);
      if (!have || at < have.atMs) first.set(system, { system, atMs: at, markets: n });
    }
  }
  for (const [system, c] of released) first.set(system, c);
  return [...first.values()].sort((a, b) => a.atMs - b.atMs);
}

export interface AgeBucket {
  label: string;
  fromH: number;
  /** null = open ended */
  toH: number | null;
  systems: number;
  sells: number;
  units: number;
  profit: number;
  /** null when there were no units. */
  profitPerUnit: number | null;
  /** profitPerUnit over the mature figure; null without a mature baseline or enough sells. */
  ratioToMature: number | null;
}

export interface SystemYield {
  system: string;
  coveredAt: string;
  markets: number;
  /** Hours from coverage to our first sell there; null = none in the window. */
  hoursToFirstSell: number | null;
  sells: number;
  units: number;
  profit: number;
  profitPerUnit: number | null;
  /** Profit per unit in the first and last age buckets that system had sells in, to see its own decay. */
  firstBucketPerUnit: number | null;
  lastBucketPerUnit: number | null;
}

export interface FreshnessReport {
  /** The mature baseline: sells in systems with no recorded coverage, or older than matureAfterH. */
  mature: { sells: number; units: number; profitPerUnit: number | null };
  /** Sells in a covered system before its coverage time (the window reaches back past it). */
  beforeCoverage: { sells: number; units: number; profitPerUnit: number | null };
  curve: AgeBucket[];
  systems: SystemYield[];
  /** Hours after coverage by which the premium has gone (first bucket under the premium ratio after one above it); null if never seen. */
  premiumFadesByH: number | null;
}

const perUnit = (profit: number, units: number): number | null => (units > 0 ? Math.round(profit / units) : null);

function bucketIndex(ageH: number, edges: readonly number[]): number {
  for (let i = 0; i < edges.length; i++) if (ageH < edges[i]!) return i;
  return edges.length;
}

function labelFor(i: number, edges: readonly number[]): { label: string; fromH: number; toH: number | null } {
  const fromH = i === 0 ? 0 : edges[i - 1]!;
  const toH = i < edges.length ? edges[i]! : null;
  return { label: toH === null ? `${fromH}h+` : `${fromH}-${toH}h`, fromH, toH };
}

export function buildFreshness(
  sells: readonly AnalysisLedgerRow[],
  coverage: readonly Coverage[],
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): FreshnessReport {
  const cover = new Map(coverage.map((c) => [c.system, c]));
  const edges = policy.bucketEdgesH;
  const nb = edges.length + 1;
  const acc = Array.from({ length: nb }, () => ({ systems: new Set<string>(), sells: 0, units: 0, profit: 0 }));
  const mature = { sells: 0, units: 0, profit: 0 };
  const before = { sells: 0, units: 0, profit: 0 };
  const bySystem = new Map<string, { sells: number; units: number; profit: number; first: number | null; buckets: { units: number; profit: number }[] }>();

  for (const r of sells) {
    if (r.type !== "SELL" || r.realizedPnl === null || !(r.units > 0) || !r.waypoint) continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) continue;
    const sys = systemOf(r.waypoint);
    const c = cover.get(sys);
    if (!c) { mature.sells++; mature.units += r.units; mature.profit += r.realizedPnl; continue; }
    const ageH = (at - c.atMs) / 3_600_000;
    if (ageH < 0) { before.sells++; before.units += r.units; before.profit += r.realizedPnl; continue; }
    if (ageH >= policy.matureAfterH) { mature.sells++; mature.units += r.units; mature.profit += r.realizedPnl; }
    const i = bucketIndex(ageH, edges);
    acc[i]!.systems.add(sys); acc[i]!.sells++; acc[i]!.units += r.units; acc[i]!.profit += r.realizedPnl;
    let s = bySystem.get(sys);
    if (!s) { s = { sells: 0, units: 0, profit: 0, first: null, buckets: Array.from({ length: nb }, () => ({ units: 0, profit: 0 })) }; bySystem.set(sys, s); }
    s.sells++; s.units += r.units; s.profit += r.realizedPnl;
    s.buckets[i]!.units += r.units; s.buckets[i]!.profit += r.realizedPnl;
    if (s.first === null || ageH < s.first) s.first = ageH;
  }

  const matureUnit = perUnit(mature.profit, mature.units);
  const curve: AgeBucket[] = acc.map((a, i) => {
    const ppu = perUnit(a.profit, a.units);
    return {
      ...labelFor(i, edges), systems: a.systems.size, sells: a.sells, units: a.units, profit: Math.round(a.profit), profitPerUnit: ppu,
      ratioToMature: ppu !== null && matureUnit !== null && matureUnit > 0 && a.sells >= policy.minSells ? round2(ppu / matureUnit) : null,
    };
  });

  const systems: SystemYield[] = [...bySystem].map(([system, s]) => {
    const c = cover.get(system)!;
    const used = s.buckets.map((b, i) => ({ i, ppu: perUnit(b.profit, b.units) })).filter((b) => b.ppu !== null);
    return {
      system, coveredAt: new Date(c.atMs).toISOString(), markets: c.markets,
      hoursToFirstSell: s.first === null ? null : round2(s.first),
      sells: s.sells, units: s.units, profit: Math.round(s.profit), profitPerUnit: perUnit(s.profit, s.units),
      firstBucketPerUnit: used[0]?.ppu ?? null, lastBucketPerUnit: used.length > 1 ? used[used.length - 1]!.ppu : null,
    };
  }).sort((a, b) => b.profit - a.profit).slice(0, policy.topSystems);

  let fades: number | null = null;
  let seenPremium = false;
  for (const b of curve) {
    if (b.ratioToMature === null) continue;
    if (b.ratioToMature >= policy.premiumRatio) seenPremium = true;
    else if (seenPremium) { fades = b.fromH; break; }
  }

  return {
    mature: { sells: mature.sells, units: mature.units, profitPerUnit: matureUnit },
    beforeCoverage: { sells: before.sells, units: before.units, profitPerUnit: perUnit(before.profit, before.units) },
    curve, systems, premiumFadesByH: fades,
  };
}

/**
 * Findings from the curve. Only quoted when a bucket has enough sells to mean something, and always with the caveat that the age is
 * measured from the keeper-list change. The weight is the credits the fresh hours earned over what the mature rate would have paid.
 */
export function freshnessFindings(f: FreshnessReport, policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY): Finding[] {
  const premium = f.curve.filter((b) => b.ratioToMature !== null && b.ratioToMature >= policy.premiumRatio);
  if (!premium.length || f.mature.profitPerUnit === null) return [];
  const sells = premium.reduce((s, b) => s + b.sells, 0);
  const excess = premium.reduce((s, b) => s + (b.profit - (f.mature.profitPerUnit ?? 0) * b.units), 0);
  const first = premium[0]!;
  const best = [...premium].sort((a, b) => b.ratioToMature! - a.ratioToMature!)[0]!;
  return [{
    id: "freshness:premium",
    kind: "freshness",
    subject: "systems in their first hours after keeper coverage",
    headline: `Sells in systems ${premium.map((b) => b.label).join(", ")} after coverage earned ${best.ratioToMature}x the mature profit per unit at best (${best.profitPerUnit}c against ${f.mature.profitPerUnit}c)${f.premiumFadesByH !== null ? `, fading by ${f.premiumFadesByH}h` : ""} (age from the keeper-list change; ${sells} sells)`,
    evidence: {
      maturePerUnit: f.mature.profitPerUnit, bestBucket: best.label, bestPerUnit: best.profitPerUnit, bestRatio: best.ratioToMature,
      firstPremiumBucket: first.label, fadesByH: f.premiumFadesByH, excessCredits: Math.round(excess),
    },
    sampleSize: sells,
    confidence: confidenceFor(Math.floor(sells / policy.minSells)),
    weight: Math.max(0, Math.round(excess)),
    suggestion: {
      action: "Keep covering new systems and point big hulls at them while the premium lasts (docs/fresh-system-expansion-plan.md)",
      why: "A correlation: the premium is the fleet's own profit per unit in newly covered systems against older ones, not a controlled test.",
    },
  }];
}

/**
 * The premium a system is earning right now: its profit per unit over the recent sells against the mature rate. `sells` should be
 * the last couple of hours; null = fewer than minSells in that system, so no ratio is believed.
 */
export function livePremium(
  sells: readonly AnalysisLedgerRow[],
  systems: readonly string[],
  matureProfitPerUnit: number | null,
  policy: Pick<FreshnessPolicy, "minSells"> = DEFAULT_FRESHNESS_POLICY,
): Map<string, { ratio: number | null; sells: number }> {
  const want = new Set(systems);
  const acc = new Map<string, { n: number; units: number; profit: number }>();
  for (const r of sells) {
    if (r.type !== "SELL" || r.realizedPnl === null || !(r.units > 0) || !r.waypoint) continue;
    const sys = systemOf(r.waypoint);
    if (!want.has(sys)) continue;
    const a = acc.get(sys) ?? { n: 0, units: 0, profit: 0 };
    a.n++; a.units += r.units; a.profit += r.realizedPnl;
    acc.set(sys, a);
  }
  const out = new Map<string, { ratio: number | null; sells: number }>();
  for (const sys of systems) {
    const a = acc.get(sys);
    const ratio = a && a.n >= policy.minSells && matureProfitPerUnit !== null && matureProfitPerUnit > 0 ? round2(a.profit / a.units / matureProfitPerUnit) : null;
    out.set(sys, { ratio, sells: a?.n ?? 0 });
  }
  return out;
}
