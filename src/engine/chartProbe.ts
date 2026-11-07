/**
 * Manual charting and scan probes (operator, 2026-11-07: "see what it pays", then "add whatever scan support we need").
 *
 * Pure: no I/O, no clock. Two questions the operator wants answered with a real ship:
 *  1. What does charting one waypoint pay? (`chartPayout`: the balance before and after the chart call.)
 *  2. Does a sensor-array waypoint scan chart anything or pay? A scan lists the traits of waypoints nobody has charted, so
 *     the summary separates waypoints with a chart (someone, maybe us, submitted it) from ones without one, and says whose.
 *
 * The balance figures include anything else the fleet earned between the two reads, so the payout is an upper-bound
 * estimate; `ops chart_rewards` (balance gaps against the ledger) is the tighter reading once a chart is recorded.
 */

export interface ScannedWaypointLike {
  symbol: string;
  type: string;
  traits?: { symbol: string }[];
  chart?: { submittedBy?: string; submittedOn?: string } | null;
}

export interface WaypointScanSummary {
  total: number;
  /** Waypoints with no chart on record: the scan revealed their traits, nobody has charted them. */
  uncharted: { symbol: string; type: string; traits: string[] }[];
  /** Waypoints some agent already charted, counted by who. */
  chartedByUs: number;
  chartedByOthers: number;
  /** Waypoints whose trait list is still just UNCHARTED (the scan did not reveal them). */
  stillHidden: number;
}

/** Sort a waypoint scan into what is still uncharted, what we charted and what others did. */
export function summarizeWaypointScan(waypoints: readonly ScannedWaypointLike[], agentSymbol: string): WaypointScanSummary {
  const out: WaypointScanSummary = { total: waypoints.length, uncharted: [], chartedByUs: 0, chartedByOthers: 0, stillHidden: 0 };
  for (const w of waypoints) {
    const traits = (w.traits ?? []).map((t) => t.symbol);
    if (traits.length > 0 && traits.every((t) => t === "UNCHARTED")) out.stillHidden++;
    if (w.chart) {
      if (w.chart.submittedBy === agentSymbol) out.chartedByUs++;
      else out.chartedByOthers++;
    } else {
      out.uncharted.push({ symbol: w.symbol, type: w.type, traits: traits.filter((t) => t !== "UNCHARTED") });
    }
  }
  return out;
}

export interface ChartPayout {
  before: number;
  after: number;
  /** after - before: the chart reward plus anything else the fleet earned or spent in between. */
  delta: number;
}

/** The balance move across one chart call. */
export function chartPayout(before: number, after: number): ChartPayout {
  return { before, after, delta: after - before };
}

/** True when the ship carries a sensor array mount (any tier), which the waypoint scan requires. */
export function hasSensorArray(mounts: readonly { symbol: string }[] | undefined): boolean {
  return !!mounts?.some((m) => m.symbol.startsWith("MOUNT_SENSOR_ARRAY"));
}
