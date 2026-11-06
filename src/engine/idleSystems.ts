/**
 * Live systems that nobody trades in: park their keepers, unpark them when sales come back.
 *
 * Operator idea (2026-10-30): a system with no sales at all for hours is only costing API calls (a keeper polls about 0.18 times a
 * minute). A live system more than `hours` past its release with zero sells and zero purchases in the last `hours` hours is idle (a system only bought from still feeds routes); a parked one that has
 * sells or purchases again is not. Parking only stops the polling: the keepers stay on their markets and still cover them.
 *
 * A parked system's prices go stale, so nothing trades there and it is opened for a re-check after `hours`. The re-check does not need
 * another `hours` of polling: it only has to refresh prices and see whether traders come back, about one keeper rotation. So the
 * re-check has its own length (`recheckMin`, 45 minutes from 2026-11-06): the system is parked again as soon as that long has passed
 * with no sells or purchases since the reopen. Without it (recheckMin 0) a dead system polled `hours` in every `2 x hours`.
 *
 * Pure: no I/O, no clock. Policy is data: hours 0 (the clause off) decides nothing, recheckMin 0 is the single-window behaviour. Every
 * decision carries a one-line reason.
 */
export interface IdlePolicy {
  /** Age and sell window in hours; 0 = off. */
  hours: number;
  /** Minutes a reopened system is given to show trading before it is parked again; 0 = a whole `hours` window. */
  recheckMin?: number;
  /**
   * Profit mode (credits an hour, 0 = count mode). A system is in use only if at least this much profit involved it in one of the last
   * `hours` hours (see systemUse); idle when every hour is under it. Count mode (any sell or purchase) is the behaviour of before.
   */
  minHourlyProfit?: number;
}

export const DEFAULT_IDLE_POLICY: IdlePolicy = { hours: 0 };

export interface IdleFacts {
  system: string;
  releasedAt: number;
  /** Sells into the system's markets over the last `hours` hours. */
  sells: number;
  /** Purchases from the system's markets over the same hours. A system traders only buy from is a supply source, not an idle one:
   *  parking it would stale the prices its routes start from. */
  buys: number;
  /** Its keepers are parked for being idle right now. */
  parked: boolean;
  /** When they were parked (ms). */
  parkedAt?: number;
  /** When they were last unparked for a re-check (ms): no parking again for `recheckMin` (or `hours`) after it. */
  checkedAt?: number;
  /** Sells plus purchases in the system since `checkedAt` (0 when there was no re-check). */
  usedSinceCheck?: number;
  /** Profit mode: profit involving the system in each of the last `hours` hours, most recent first. Missing in profit mode = unknown,
   *  which counts as in use (nothing is parked on a missing figure). */
  hourly?: number[];
  /** Profit mode: profit involving the system since `checkedAt`. */
  profitSinceCheck?: number;
  /** Events and profit involving the system since it was parked (only for a parked system). */
  parkedUse?: { events: number; profit: number };
}

export interface IdleDecision {
  park: { system: string; reason: string }[];
  unpark: { system: string; reason: string }[];
}

const H = 3_600_000;

/**
 * Whether the fresh-system tick should run idle parking. It is its own clause (freshIdleParkHours), switched on by the operator, so it
 * does not wait for the release rule to be on auto: until 2026-11-06 it ran only in auto mode, and with the gate on advisory (the
 * operator releases systems by hand) the clause did nothing at all. Only a switched-off gate (no queue, no release times) stops it.
 */
export function runsIdleParking(gateMode: "off" | "advisory" | "auto"): boolean {
  return gateMode !== "off";
}

export function decideIdleParking(facts: readonly IdleFacts[], now: number, p: IdlePolicy): IdleDecision {
  const out: IdleDecision = { park: [], unpark: [] };
  const min = p.minHourlyProfit ?? 0;
  for (const f of facts) {
    if (p.hours <= 0) {
      if (f.parked) out.unpark.push({ system: f.system, reason: "idle parking is switched off" });
      continue;
    }
    const ageH = (now - f.releasedAt) / H;
    // In use: a profitable enough hour (profit mode, a missing figure counts as in use) or any sell or purchase (count mode).
    const best = min > 0 && f.hourly ? Math.max(0, ...f.hourly) : undefined;
    const inUse = min > 0 ? best === undefined || best >= min : f.sells > 0 || f.buys > 0;
    const useReason = min > 0
      ? `an hour with ${Math.round(best ?? 0).toLocaleString("en-US")} profit in the last ${p.hours} h (needs ${min.toLocaleString("en-US")})`
      : f.sells > 0 ? `${f.sells} sell(s) in the last ${p.hours} h` : `${f.buys} purchase(s) in the last ${p.hours} h`;
    if (f.parked) {
      // A parked system is judged on what happened since it was parked, not on the whole window: the window still holds the hours before it
      // was parked, so a system parked at its re-check came straight back (2026-11-06 05:48-06:08: PJ53 and GF96 parked and unparked within
      // 5-10 minutes of each other, the profit of earlier hours reading as "in use"). Without that figure the old reading applies.
      const since = f.parkedUse;
      const backNow = since !== undefined ? (min > 0 ? since.profit >= min : since.events > 0) : inUse;
      const backReason = since !== undefined ? (min > 0 ? `${Math.round(since.profit).toLocaleString("en-US")} profit since it was parked (needs ${min.toLocaleString("en-US")})` : `${since.events} trade(s) since it was parked`) : useReason;
      if (backNow) out.unpark.push({ system: f.system, reason: backReason });
      // A parked system's prices go stale, so traders see no routes there and nothing sells to unpark it: after `hours` it is opened for
      // one more window to show whether its routes are back.
      else if (f.parkedAt !== undefined && now - f.parkedAt >= p.hours * H) out.unpark.push({ system: f.system, reason: `re-check: parked ${((now - f.parkedAt) / H).toFixed(1)} h, its prices are stale` });
    } else if (ageH >= p.hours) {
      const recheckMs = (p.recheckMin ?? 0) * 60_000;
      const sinceMs = f.checkedAt === undefined ? 0 : now - f.checkedAt;
      // A re-check that has run its short window with nothing earned (profit mode: under the hourly bar pro rata) or sold or bought since the reopen.
      const quietSinceCheck = min > 0 ? (f.profitSinceCheck ?? Number.POSITIVE_INFINITY) < min * (sinceMs / H) : (f.usedSinceCheck ?? 0) === 0;
      if (recheckMs > 0 && f.checkedAt !== undefined && sinceMs >= recheckMs && quietSinceCheck) {
        out.park.push({ system: f.system, reason: `re-check: reopened ${Math.round(sinceMs / 60_000)} min ago with ${min > 0 ? "less than the hourly profit bar" : "no sells or purchases"} since` });
      } else if (!inUse && (f.checkedAt === undefined || sinceMs >= p.hours * H)) {
        out.park.push({ system: f.system, reason: min > 0 ? `live ${ageH.toFixed(1)} h, no hour above ${min.toLocaleString("en-US")} profit in the last ${p.hours} h (best ${Math.round(best ?? 0).toLocaleString("en-US")})` : `live ${ageH.toFixed(1)} h with no sells or purchases in the last ${p.hours} h` });
      }
    }
  }
  return out;
}

/** Ledger rows as idle parking reads them. */
export interface UseRow { timestamp: string; type: string; waypoint: string | null; realizedPnl: number | null; route: string | null }

/** `X1-AB-C12` -> `X1-AB`. */
export function systemOfWaypoint(waypoint: string): string {
  return waypoint.split("-").slice(0, 2).join("-");
}

export interface SystemUse {
  sells: number;
  buys: number;
  /** Profit involving the system in each of the last `hours` hours, most recent first. */
  hourly: number[];
}

/**
 * What each system did over the last `hours` hours: sells and purchases there, and the realized profit of every sale credited to the
 * system it sold in AND the system its trip started in (the route "buy>sell ..."), so a system traders only buy from is not read as
 * idle. A trip's profit therefore appears at both ends; read it as "profit that involved this system", not as a share to add up.
 */
export function systemUse(rows: readonly UseRow[], now: number, hours: number): Map<string, SystemUse> {
  const n = Math.max(1, Math.ceil(hours));
  const out = new Map<string, SystemUse>();
  const get = (sys: string): SystemUse => { let u = out.get(sys); if (!u) { u = { sells: 0, buys: 0, hourly: new Array<number>(n).fill(0) }; out.set(sys, u); } return u; };
  for (const r of rows) {
    if (!r.waypoint) continue;
    const at = Date.parse(r.timestamp);
    const age = now - at;
    if (!(age >= 0) || age >= hours * H) continue;
    const bucket = Math.min(n - 1, Math.floor(age / H));
    const here = systemOfWaypoint(r.waypoint);
    if (r.type === "PURCHASE") { get(here).buys += 1; continue; }
    if (r.type !== "SELL") continue;
    get(here).sells += 1;
    const pnl = r.realizedPnl ?? 0;
    if (pnl === 0) continue;
    const credited = new Set([here]);
    const origin = r.route?.split(" ")[0]?.split(">")[0];
    if (origin) credited.add(systemOfWaypoint(origin));
    for (const sys of credited) get(sys).hourly[bucket]! += pnl;
  }
  return out;
}

/** Events and profit involving one system since `since` (ms). */
export function useSince(rows: readonly UseRow[], system: string, since: number): { events: number; profit: number } {
  let events = 0;
  let profit = 0;
  for (const r of rows) {
    if (!r.waypoint || Date.parse(r.timestamp) < since) continue;
    const here = systemOfWaypoint(r.waypoint);
    if (r.type === "PURCHASE" && here === system) events += 1;
    else if (r.type === "SELL") {
      const origin = r.route?.split(" ")[0]?.split(">")[0];
      const inv = here === system || (origin !== undefined && systemOfWaypoint(origin) === system);
      if (here === system) events += 1;
      if (inv) profit += r.realizedPnl ?? 0;
    }
  }
  return { events, profit };
}
