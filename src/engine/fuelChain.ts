/**
 * Whether a ship with `capacity` fuel can get from `from` to `to` by hopping
 * through any chain of `stops` (fuel-selling waypoints), each hop within one
 * tank. This used to be a single relay (d1 <= cap && d2 <= cap), which capped
 * a reachable leg at 2x the tank — so a market ~660 units out (X1-SJ91-J70,
 * 300-unit tanks) was "unreachable" to the dispatcher while the trader's own
 * executor (nextHopToward()) happily flew it in several hops. Confirmed live
 * 2026-10-02: the three best home routes (DRUGS 35k, ASSAULT_RIFLES 23k,
 * FIREARMS 13k) all touch J70 and sat unassigned with idle traders.
 */
export function fuelChainReaches(
  from: string,
  to: string,
  stops: string[],
  capacity: number,
  dist: (a: string, b: string) => number,
): boolean {
  const within = (a: string, b: string) => {
    const d = dist(a, b);
    return Number.isFinite(d) && d <= capacity;
  };
  if (within(from, to)) return true;
  const seen = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const here of frontier) {
      for (const stop of stops) {
        if (seen.has(stop) || stop === to || !within(here, stop)) continue;
        if (within(stop, to)) return true;
        seen.add(stop);
        next.push(stop);
      }
    }
    frontier = next;
  }
  return false;
}
