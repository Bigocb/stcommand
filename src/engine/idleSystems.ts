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
}

export interface IdleDecision {
  park: { system: string; reason: string }[];
  unpark: { system: string; reason: string }[];
}

const H = 3_600_000;

export function decideIdleParking(facts: readonly IdleFacts[], now: number, p: IdlePolicy): IdleDecision {
  const out: IdleDecision = { park: [], unpark: [] };
  for (const f of facts) {
    if (p.hours <= 0) {
      if (f.parked) out.unpark.push({ system: f.system, reason: "idle parking is switched off" });
      continue;
    }
    const ageH = (now - f.releasedAt) / H;
    if (f.parked) {
      if (f.sells > 0 || f.buys > 0) out.unpark.push({ system: f.system, reason: f.sells > 0 ? `${f.sells} sell(s) in the last ${p.hours} h` : `${f.buys} purchase(s) in the last ${p.hours} h` });
      // A parked system's prices go stale, so traders see no routes there and nothing sells to unpark it: after `hours` it is opened for
      // one more window to show whether its routes are back.
      else if (f.parkedAt !== undefined && now - f.parkedAt >= p.hours * H) out.unpark.push({ system: f.system, reason: `re-check: parked ${((now - f.parkedAt) / H).toFixed(1)} h, its prices are stale` });
    } else if (ageH >= p.hours) {
      const recheckMs = (p.recheckMin ?? 0) * 60_000;
      // A re-check that has run its short window with nothing sold or bought since the reopen.
      if (recheckMs > 0 && f.checkedAt !== undefined && now - f.checkedAt >= recheckMs && (f.usedSinceCheck ?? 0) === 0) {
        out.park.push({ system: f.system, reason: `re-check: reopened ${Math.round((now - f.checkedAt) / 60_000)} min ago with no sells or purchases since` });
      } else if (f.sells === 0 && f.buys === 0 && (f.checkedAt === undefined || now - f.checkedAt >= p.hours * H)) {
        out.park.push({ system: f.system, reason: `live ${ageH.toFixed(1)} h with no sells or purchases in the last ${p.hours} h` });
      }
    }
  }
  return out;
}
