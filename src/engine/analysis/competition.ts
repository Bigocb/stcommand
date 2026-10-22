/**
 * Competition: does a trip earn less of its estimate when other agents trade the same good at its markets?
 *
 * Pure. For each closed trip with an estimate, counts the units of the trip's good that other agents (ships not ours)
 * traded at its buy market in the window before it started and at its sell market in the window before it ended, and
 * the units our own other ships traded there in the same windows. Trips are then grouped by how much rival activity
 * they met and each group's realized profit is compared with its estimate. A correlation with its sample sizes, not
 * proof: a busy market is often a good market, which pushes the other way.
 */
import type { MarketTrade } from "./priceMoves.js";
import { tripNet, type Trip } from "./trips.js";
import { confidenceFor, median, round2, type AnalysisPolicy, type Finding } from "./types.js";

export type RivalBucket = "none" | "light" | "heavy";

export interface TripExposure {
  trip: Trip;
  /** Units other agents traded of this good at the buy market, then the sell market, in the windows before the trip. */
  rivalBuy: number;
  rivalSell: number;
  /** The same for our own other ships. */
  ownBuy: number;
  ownSell: number;
  bucket: RivalBucket;
}

export interface BucketStats {
  bucket: RivalBucket;
  trips: number;
  expected: number;
  actual: number;
  /** Realized over expected, summed over the bucket's trips; null when nothing was expected. */
  ratio: number | null;
  /** Median of each trip's own ratio, so one large trip can't carry the bucket. */
  medianTripRatio: number | null;
}

export interface CompetitionStats {
  buckets: BucketStats[];
  /** Mean units of our own other ships' trading in the same windows, by bucket: our own pressure on the same markets. */
  ownUnitsPerTrip: Record<RivalBucket, number>;
  /** Exposed trips by the system of their buy market, most rival units first. */
  systems: { system: string; trips: number; rivalUnitsPerTrip: number; ratio: number | null }[];
}

const systemOf = (waypoint: string | null): string => (waypoint ? waypoint.split("-").slice(0, 2).join("-") : "?");

function indexTrades(trades: readonly MarketTrade[]): Map<string, { at: number; ship: string; units: number }[]> {
  const by = new Map<string, { at: number; ship: string; units: number }[]>();
  for (const t of trades) {
    const key = `${t.waypoint}|${t.good}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push({ at: Date.parse(t.timestamp), ship: t.shipSymbol, units: t.units });
  }
  return by;
}

export function bucketFor(rivalUnits: number, policy: AnalysisPolicy): RivalBucket {
  if (rivalUnits <= 0) return "none";
  return rivalUnits >= policy.heavyRivalUnits ? "heavy" : "light";
}

/** Rival and own activity around every closed trip that has an estimate. */
export function tripExposures(
  trips: readonly Trip[],
  marketTrades: readonly MarketTrade[],
  ourShips: ReadonlySet<string>,
  policy: AnalysisPolicy,
): TripExposure[] {
  const index = indexTrades(marketTrades);
  const windowMs = policy.competitionWindowMin * 60_000;
  const out: TripExposure[] = [];
  for (const trip of trips) {
    if (trip.endMs === null || trip.partial || trip.expectedProfit === null || !trip.buyAt || !trip.sellAt) continue;
    const count = (waypoint: string, endMs: number) => {
      let rival = 0;
      let own = 0;
      for (const x of index.get(`${waypoint}|${trip.good}`) ?? []) {
        if (x.at > endMs || x.at < endMs - windowMs) continue;
        if (x.ship === trip.shipSymbol) continue;
        if (ourShips.has(x.ship)) own += x.units;
        else rival += x.units;
      }
      return { rival, own };
    };
    const buy = count(trip.buyAt, trip.startMs);
    const sell = count(trip.sellAt, trip.endMs);
    out.push({ trip, rivalBuy: buy.rival, rivalSell: sell.rival, ownBuy: buy.own, ownSell: sell.own, bucket: bucketFor(buy.rival + sell.rival, policy) });
  }
  return out;
}

const ratioOf = (actual: number, expected: number): number | null => (expected > 0 ? round2(actual / expected) : null);

export function summarizeCompetition(exposures: readonly TripExposure[]): CompetitionStats {
  const order: RivalBucket[] = ["none", "light", "heavy"];
  const buckets: BucketStats[] = [];
  const ownUnitsPerTrip = { none: 0, light: 0, heavy: 0 } as Record<RivalBucket, number>;
  for (const bucket of order) {
    const list = exposures.filter((e) => e.bucket === bucket);
    const expected = list.reduce((s, e) => s + (e.trip.expectedProfit ?? 0), 0);
    const actual = list.reduce((s, e) => s + tripNet(e.trip), 0);
    const perTrip = list.filter((e) => (e.trip.expectedProfit ?? 0) > 0).map((e) => tripNet(e.trip) / (e.trip.expectedProfit as number));
    buckets.push({ bucket, trips: list.length, expected: Math.round(expected), actual: Math.round(actual), ratio: ratioOf(actual, expected), medianTripRatio: perTrip.length ? round2(median(perTrip)!) : null });
    ownUnitsPerTrip[bucket] = list.length ? Math.round(list.reduce((s, e) => s + e.ownBuy + e.ownSell, 0) / list.length) : 0;
  }
  const bySystem = new Map<string, TripExposure[]>();
  for (const e of exposures) {
    const k = systemOf(e.trip.buyAt);
    (bySystem.get(k) ?? bySystem.set(k, []).get(k)!).push(e);
  }
  const systems = [...bySystem].map(([system, list]) => ({
    system,
    trips: list.length,
    rivalUnitsPerTrip: Math.round(list.reduce((s, e) => s + e.rivalBuy + e.rivalSell, 0) / list.length),
    ratio: ratioOf(list.reduce((s, e) => s + tripNet(e.trip), 0), list.reduce((s, e) => s + (e.trip.expectedProfit ?? 0), 0)),
  })).sort((a, b) => b.rivalUnitsPerTrip - a.rivalUnitsPerTrip);
  return { buckets, ownUnitsPerTrip, systems: systems.slice(0, 12) };
}

/**
 * One finding when busy trips earn clearly less of their estimate than quiet ones, with enough trips on both sides.
 * It carries no tool call: whether to discount busy systems is a policy decision, and the numbers are the evidence.
 */
export function competitionFindings(stats: CompetitionStats, policy: AnalysisPolicy): Finding[] {
  const quiet = stats.buckets.find((b) => b.bucket === "none");
  const busy = stats.buckets.find((b) => b.bucket === "heavy");
  if (!quiet || !busy || quiet.ratio === null || busy.ratio === null) return [];
  if (quiet.trips < policy.minCompetitionTrips || busy.trips < policy.minCompetitionTrips) return [];
  const gap = quiet.ratio - busy.ratio;
  if (gap < policy.competitionGap) return [];
  const n = Math.min(quiet.trips, busy.trips);
  return [{
    id: "competition:rival-activity",
    kind: "competition",
    subject: "rival activity",
    headline: `Trips that met heavy rival trading earned ${busy.ratio} of their estimate against ${quiet.ratio} with none (${busy.trips} vs ${quiet.trips} trips; correlation, not proof)`,
    evidence: { quietRatio: quiet.ratio, heavyRatio: busy.ratio, quietTrips: quiet.trips, heavyTrips: busy.trips, heavyExpected: busy.expected, heavyActual: busy.actual },
    sampleSize: n,
    confidence: confidenceFor(n),
    weight: Math.max(0, Math.round(busy.expected * gap)),
    suggestion: {
      action: "Discount routes through systems with heavy rival trading when ranking them (a competition weight on the dispatcher, off by default)",
      why: `heavy-rival trips fell ${round2(gap)} short of quiet ones against the same estimate`,
    },
  }];
}
