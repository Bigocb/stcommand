/**
 * Cover a live system's uncovered worthwhile markets in one batch, on the operator's call.
 *
 * keeperTopUp.ts adds ONE market every 5 minutes, and with the tour plan on (keeperTourPlan, issue #63) it only adds markets that
 * earn a fixed keeper; the rest are left to the tour ships. 2026-11-25: 135 viable markets had no keeper, and in X1-GQ73 four of
 * them (4-6 goods each) had not been read for 33 hours, so no route could ever use them (routes ignore prices older than 90 min).
 * This picks a batch of them now, least-covered system first, one market per system per round so that no system takes the whole
 * batch, and stops at the keeper limit and the API ceiling. The caller lists the picks; the usual queue buys the probes.
 *
 * Pure: no I/O, no clock, no globals. The caller supplies the room figures. Every result carries a one-line reason.
 */
export interface FillSystem {
  system: string;
  /** Markets of this system that already have a keeper (or are listed for one). */
  covered: number;
  /** Worthwhile markets not yet listed, best first. */
  candidates: readonly string[];
}

export interface FillRoom {
  /** Most markets this call may add (the operator's limit). */
  limit: number;
  /** Keeper slots left under keeperMaxTotal (after the staging reserve); undefined = no limit. */
  slots?: number;
  /** API room: how many more keepers' reads fit under the polling ceiling; undefined = not judged. */
  apiRoom?: number;
  /** Only this system. */
  system?: string;
}

export interface FillPlan {
  markets: string[];
  bySystem: Record<string, number>;
  /** Candidates left after this batch, so the operator sees how much remains. */
  remaining: number;
  reason: string;
}

export function pickFillBatch(systems: readonly FillSystem[], room: FillRoom): FillPlan {
  const pool = systems.filter((s) => s.candidates.length > 0 && (room.system === undefined || s.system === room.system));
  const total = pool.reduce((t, s) => t + s.candidates.length, 0);
  if (total === 0) return { markets: [], bySystem: {}, remaining: 0, reason: room.system ? `${room.system} has no uncovered worthwhile market` : "every live system's worthwhile markets are covered" };
  const caps = [room.limit, room.slots ?? Infinity, room.apiRoom ?? Infinity].map((n) => Math.max(0, Math.floor(n)));
  const n = Math.min(...caps, total);
  const bound = n === caps[0] ? `the limit of ${room.limit}` : n === caps[1] ? `the keeper limit (${room.slots} slots left)` : n === caps[2] ? `the API ceiling (room for ${room.apiRoom} more keepers)` : "all that are left";
  if (n <= 0) return { markets: [], bySystem: {}, remaining: total, reason: `nothing added: ${caps[1] === 0 ? "no keeper slots left" : caps[2] === 0 ? "no API room under the polling ceiling" : "limit is 0"}` };
  // Least-covered first: the share of the system's worthwhile markets that already have a keeper.
  const share = (s: FillSystem): number => s.covered / (s.covered + s.candidates.length);
  const order = [...pool].sort((a, b) => share(a) - share(b) || a.system.localeCompare(b.system));
  const markets: string[] = [];
  const bySystem: Record<string, number> = {};
  for (let round = 0; markets.length < n; round++) {
    let took = false;
    for (const s of order) {
      if (markets.length >= n) break;
      const m = s.candidates[round];
      if (m === undefined) continue;
      markets.push(m);
      bySystem[s.system] = (bySystem[s.system] ?? 0) + 1;
      took = true;
    }
    if (!took) break;
  }
  return { markets, bySystem, remaining: total - markets.length, reason: `${markets.length} of ${total} uncovered markets in ${Object.keys(bySystem).length} systems, stopped by ${bound}` };
}
