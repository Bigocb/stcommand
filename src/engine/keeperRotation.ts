/**
 * Take the keeper queue's turns by system, so one system with many gaps cannot hold the single request slot all day.
 *
 * Operator request (2026-11-17): the queue raises one `buyKeeperProbeForMarket` card at a time, and the order is best score first. SN86 had
 * 12 uncovered markets and every answered card was followed by another SN86 card, so B64 (heavy-freighter yard, no keeper polling it) never
 * got one. Now the system that was served least recently goes first: one card per system, then the next system's turn.
 *
 * Pure: the caller passes the ordered markets and when each system was last served (ms, absent = never). Stable within a system (its
 * markets keep their incoming order) and among systems served at the same time (they keep the incoming order of their first market),
 * so a system that has never had a card keeps the score order it had before. With `enabled` false it returns the input unchanged.
 */
export interface RotationPolicy { enabled: boolean }

/** `X1-SN86-K83` -> `X1-SN86`. A symbol with no dash is its own system. */
export function systemOf(waypoint: string): string {
  const i = waypoint.lastIndexOf("-");
  return i > 0 ? waypoint.slice(0, i) : waypoint;
}

export function rotateBySystem(markets: readonly string[], lastServedAt: ReadonlyMap<string, number>, policy: RotationPolicy): string[] {
  if (!policy.enabled || markets.length < 2) return [...markets];
  const order: string[] = [];
  const bySystem = new Map<string, string[]>();
  for (const m of markets) {
    const s = systemOf(m);
    let list = bySystem.get(s);
    if (!list) { list = []; bySystem.set(s, list); order.push(s); }
    list.push(m);
  }
  const rank = new Map(order.map((s, i) => [s, i]));
  order.sort((a, b) => (lastServedAt.get(a) ?? 0) - (lastServedAt.get(b) ?? 0) || rank.get(a)! - rank.get(b)!);
  return order.flatMap((s) => bySystem.get(s)!);
}

/** One line for the log: which system goes first and why. */
export function rotationReason(first: string | undefined, lastServedAt: ReadonlyMap<string, number>, nowMs: number): string {
  if (!first) return "";
  const s = systemOf(first);
  const at = lastServedAt.get(s);
  return at === undefined ? `${s} has not had a keeper card yet` : `${s} was last served ${Math.round((nowMs - at) / 60_000)} min ago`;
}
