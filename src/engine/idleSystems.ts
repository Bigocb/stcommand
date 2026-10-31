/**
 * Live systems that nobody trades in: park their keepers, unpark them when sales come back.
 *
 * Operator idea (2026-10-30): a system with no sales at all for hours is only costing API calls (a keeper polls about 0.18 times a
 * minute). A live system more than `hours` past its release with zero sells in the last `hours` hours is idle; a parked one that has
 * sells again is not. Parking only stops the polling: the keepers stay on their markets and still cover them.
 *
 * Pure: no I/O, no clock. Policy is data: hours 0 (the clause off) decides nothing. Every decision carries a one-line reason.
 */
export interface IdlePolicy {
  /** Age and sell window in hours; 0 = off. */
  hours: number;
}

export const DEFAULT_IDLE_POLICY: IdlePolicy = { hours: 0 };

export interface IdleFacts {
  system: string;
  releasedAt: number;
  /** Sells into the system's markets over the last `hours` hours. */
  sells: number;
  /** Its keepers are parked for being idle right now. */
  parked: boolean;
  /** When they were parked (ms). */
  parkedAt?: number;
  /** When they were last unparked for a re-check (ms): no parking again for `hours` after it. */
  checkedAt?: number;
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
      if (f.sells > 0) out.unpark.push({ system: f.system, reason: `${f.sells} sell(s) in the last ${p.hours} h` });
      // A parked system's prices go stale, so traders see no routes there and nothing sells to unpark it: after `hours` it is opened for
      // one more window to show whether its routes are back.
      else if (f.parkedAt !== undefined && now - f.parkedAt >= p.hours * H) out.unpark.push({ system: f.system, reason: `re-check: parked ${((now - f.parkedAt) / H).toFixed(1)} h, its prices are stale` });
    } else if (ageH >= p.hours && f.sells === 0 && (f.checkedAt === undefined || now - f.checkedAt >= p.hours * H)) {
      out.park.push({ system: f.system, reason: `live ${ageH.toFixed(1)} h with no sells in the last ${p.hours} h` });
    }
  }
  return out;
}
