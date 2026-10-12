/**
 * Where to mine, from what we know: every minable asteroid in a system with its measured deposit mix, how far it is from a
 * target market, and who is already working it. Pure (no I/O, no clock): the ops tool `mining_fields` gathers the inputs.
 * Built for a person choosing where to park drones and a collector now, and as the data an automatic chooser would read
 * later, so the rows are plain and stable.
 */
export interface FieldWaypoint { symbol: string; x: number; y: number; type: string; traits?: string[] }
export interface FieldSurveyTally { waypointSymbol: string; surveys: number; deposits: number; counts: Record<string, number> }
export interface FieldPin { ship: string; field: string }
export interface FieldFeed { good: string; targetWaypoint: string; field?: string; collector?: string }

export interface MiningFieldRow {
  waypoint: string;
  type: string;
  traits: string[];
  /** Straight-line distance to the target market, when one was named. */
  distanceToTarget?: number;
  surveys: number;
  /** Deposits listed across those surveys; shares are percentages of this. */
  deposits: number;
  /** Percent of listed deposits by good, largest first. Empty when never surveyed. */
  shares: { good: string; percent: number }[];
  /** The ranked good's share (percent) when `good` was asked for. */
  goodShare?: number;
  surveyed: boolean;
  /** Fewer than this many surveys is a rough guess (the share moves a lot with each new survey). */
  reliable: boolean;
  miners: string[];
  feeds: { good: string; target: string; collector?: string }[];
}

/** Minable waypoint types. An asteroid base is a market outpost, not something a mining laser works. */
export const MINABLE_TYPES = ["ASTEROID", "ENGINEERED_ASTEROID"];
export const RELIABLE_SURVEYS = 10;

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.round(Math.hypot(a.x - b.x, a.y - b.y));

export function miningFieldsReport(input: {
  waypoints: FieldWaypoint[];
  tallies: FieldSurveyTally[];
  pins: FieldPin[];
  feeds: FieldFeed[];
  target?: string;
  good?: string;
}): MiningFieldRow[] {
  const tally = new Map(input.tallies.map((t) => [t.waypointSymbol, t]));
  const target = input.target ? input.waypoints.find((w) => w.symbol === input.target) : undefined;
  const good = input.good?.toUpperCase();
  const rows = input.waypoints
    .filter((w) => MINABLE_TYPES.includes(w.type))
    .map((w): MiningFieldRow => {
      const t = tally.get(w.symbol);
      const deposits = t?.deposits ?? 0;
      const shares = Object.entries(t?.counts ?? {})
        .map(([g, n]) => ({ good: g, percent: deposits ? Math.round((n / deposits) * 100) : 0 }))
        .sort((a, b) => b.percent - a.percent || a.good.localeCompare(b.good));
      return {
        waypoint: w.symbol,
        type: w.type,
        traits: w.traits ?? [],
        distanceToTarget: target ? dist(w, target) : undefined,
        surveys: t?.surveys ?? 0,
        deposits,
        shares,
        goodShare: good ? shares.find((s) => s.good === good)?.percent ?? 0 : undefined,
        surveyed: (t?.surveys ?? 0) > 0,
        reliable: (t?.surveys ?? 0) >= RELIABLE_SURVEYS,
        miners: input.pins.filter((p) => p.field === w.symbol).map((p) => p.ship).sort(),
        feeds: input.feeds.filter((f) => f.field === w.symbol).map((f) => ({ good: f.good, target: f.targetWaypoint, collector: f.collector })),
      };
    });
  // With a good named: most of it first, ties by nearness to the target. Otherwise nearest first (then name).
  return rows.sort((a, b) => good
    ? (b.goodShare ?? 0) - (a.goodShare ?? 0) || (a.distanceToTarget ?? 0) - (b.distanceToTarget ?? 0) || a.waypoint.localeCompare(b.waypoint)
    : (a.distanceToTarget ?? 0) - (b.distanceToTarget ?? 0) || a.waypoint.localeCompare(b.waypoint));
}
