/**
 * Which uncharted waypoints are there, and which systems should the crawler read next to find out.
 *
 * The game's public `GET /systems/{system}/waypoints` lists a system's waypoints, and a waypoint nobody has charted shows the single
 * trait UNCHARTED instead of its real traits. Charting is one-way: a waypoint, once charted, never goes back, so a system with no
 * uncharted waypoint is never read again; one that still has some is re-read after `recheckMs`, since another agent may chart them.
 * Charting pays a one-time credit reward to the first agent to do it, so a waypoint that was uncharted an hour ago may be gone now.
 *
 * Pure: no I/O and no clock. The caller passes the systems, what is already recorded, and the time.
 */
export interface SystemChartState {
  /** Waypoints of the system last seen uncharted. */
  uncharted: number;
  /** When the system was last read, ms. */
  checkedAtMs: number;
}

export interface ChartCheckPolicy {
  /** How long a system that still has uncharted waypoints is left before it is read again. */
  recheckMs: number;
}

export const DEFAULT_CHART_CHECK_POLICY: ChartCheckPolicy = { recheckMs: 60 * 60_000 };

/**
 * The systems to read, in the order to read them. `priority` lists the systems that matter most (the ones we are in) and keeps its
 * own order. Within each group a never-read system comes first, then the stale ones with uncharted waypoints, oldest first.
 * A system whose last read found nothing uncharted is skipped for good.
 */
export function systemsToRead(
  all: readonly string[],
  priority: readonly string[],
  known: ReadonlyMap<string, SystemChartState>,
  now: number,
  policy: ChartCheckPolicy = DEFAULT_CHART_CHECK_POLICY,
): string[] {
  const rank = new Map<string, number>();
  priority.forEach((s, i) => { if (!rank.has(s)) rank.set(s, i); });
  const seen = new Set<string>();
  const fresh: { system: string; rank: number }[] = [];
  const stale: { system: string; rank: number; at: number }[] = [];
  for (const system of all) {
    if (seen.has(system)) continue;
    seen.add(system);
    const r = rank.get(system) ?? Number.MAX_SAFE_INTEGER;
    const k = known.get(system);
    if (!k) { fresh.push({ system, rank: r }); continue; }
    if (k.uncharted === 0) continue;
    if (now - k.checkedAtMs >= policy.recheckMs) stale.push({ system, rank: r, at: k.checkedAtMs });
  }
  fresh.sort((a, b) => a.rank - b.rank);
  stale.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return [...fresh.map((x) => x.system), ...stale.map((x) => x.system)];
}

export interface WaypointChartRow {
  symbol: string;
  type: string;
  uncharted: boolean;
}

/** One page of the public waypoint list, reduced to what we keep; undefined when it is not the shape we expect. */
export function parseWaypointPage(json: unknown): { rows: WaypointChartRow[]; total: number } | undefined {
  const j = json as { data?: unknown; meta?: { total?: unknown } } | undefined;
  if (!j || !Array.isArray(j.data)) return undefined;
  const rows: WaypointChartRow[] = [];
  for (const w of j.data as { symbol?: unknown; type?: unknown; traits?: unknown }[]) {
    if (typeof w?.symbol !== "string") return undefined;
    const traits = Array.isArray(w.traits) ? (w.traits as { symbol?: unknown }[]) : [];
    rows.push({ symbol: w.symbol, type: typeof w.type === "string" ? w.type : "", uncharted: traits.some((t) => t?.symbol === "UNCHARTED") });
  }
  const total = typeof j.meta?.total === "number" ? j.meta.total : rows.length;
  return { rows, total };
}

export interface UnchartedRow {
  waypointSymbol: string;
  systemSymbol: string;
  type: string;
  checkedAt: string;
}

export interface UnchartedSystem {
  system: string;
  /** 0 = a system we have priced markets in, 1 = surveyed from afar; larger = anything else. */
  tier: number;
  uncharted: number;
  ageMinutes: number;
  waypoints: { waypoint: string; type: string }[];
}

/** Group the uncharted waypoints by system: the systems we are in first, then the most uncharted. */
export function summarizeUncharted(rows: readonly UnchartedRow[], tiers: ReadonlyMap<string, number>, now: number): UnchartedSystem[] {
  const by = new Map<string, UnchartedSystem>();
  for (const r of rows) {
    const at = Date.parse(r.checkedAt);
    const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : 0;
    const s = by.get(r.systemSymbol) ?? { system: r.systemSymbol, tier: tiers.get(r.systemSymbol) ?? 9, uncharted: 0, ageMinutes: age, waypoints: [] };
    s.uncharted += 1;
    s.ageMinutes = Math.max(s.ageMinutes, age);
    s.waypoints.push({ waypoint: r.waypointSymbol, type: r.type });
    by.set(r.systemSymbol, s);
  }
  return [...by.values()].sort((a, b) => a.tier - b.tier || b.uncharted - a.uncharted || a.system.localeCompare(b.system));
}
