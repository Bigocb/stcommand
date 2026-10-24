/**
 * Which traders have gone without a route long enough to matter.
 *
 * A trader is "between routes" for a few seconds after every sale, and the Tower list read that as unassigned: ships came
 * and went from the Needs-a-decision list on their own (2026-10-24, THEOREM-17A). A trader that has had no route for
 * five minutes is a different thing, one worth a person's attention and an alert.
 *
 * Pure: the caller says which traders are idle right now and passes the previous first-seen times back in.
 */

/** Idle this long (ms) before Tower lists a trader as needing attention and an alert goes out. */
export const IDLE_ALERT_AFTER_MS = 5 * 60_000;

export interface IdleFacts {
  symbol: string;
  role: string;
  cargo: number;
  /** The row's own state: "stranded", "suspended", "manual hold", "parked" or anything else. */
  doing: string;
  /** The dispatcher has a route for it. */
  assigned: boolean;
  /** Flying, or sitting out a jump cooldown: it is going somewhere, so it is not idle however long the flight runs. */
  nav: string;
  cooldown: number;
}

/**
 * Not waiting on anything but a route: a trader with no assignment and an empty hold, on nobody's crew, not held, and
 * not moving. A ship in flight or in a jump cooldown is busy (2026-10-24: THEOREM-1B was listed as idle for 8 minutes
 * while it hopped around its system finding prices, and a long flight would have read the same), so the clock starts
 * when it comes to rest and starts over every time it moves.
 */
export function isIdleTrader(f: IdleFacts, crew: ReadonlySet<string>, contractDuty: ReadonlySet<string>): boolean {
  if (f.role !== "trader" || f.assigned || f.cargo > 0) return false;
  if (f.nav === "IN_TRANSIT" || f.cooldown > 0) return false;
  if (crew.has(f.symbol) || contractDuty.has(f.symbol)) return false;
  return !["stranded", "suspended", "manual hold", "parked"].includes(f.doing);
}

/** First-seen-idle times: ships idle now keep the time they were first seen, ships no longer idle drop out. */
export function trackIdle(prev: ReadonlyMap<string, number>, idleNow: Iterable<string>, now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const s of idleNow) next.set(s, prev.get(s) ?? now);
  return next;
}

/** Ships idle for at least `minMs`, longest first. */
export function idleLongerThan(since: ReadonlyMap<string, number>, now: number, minMs: number = IDLE_ALERT_AFTER_MS): { symbol: string; idleMs: number }[] {
  return [...since.entries()]
    .map(([symbol, at]) => ({ symbol, idleMs: now - at }))
    .filter((i) => i.idleMs >= minMs)
    .sort((a, b) => b.idleMs - a.idleMs);
}
