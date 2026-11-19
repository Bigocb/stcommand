/**
 * Order a system's keeper markets so the shipyards come first.
 *
 * A keeper docked at a yard reads that yard's stock and prices, and one stationed at any yard of a system can buy the rest of its
 * keepers there. So when a system is queued, its yard markets go first (a yard is also a market, e.g. A2); the first probe delivered
 * then opens the system for local buying. Stable: each group keeps its incoming (best score first) order. Pure.
 */
export function yardsFirst(markets: readonly string[], yards: ReadonlySet<string>): string[] {
  return [...markets.filter((m) => yards.has(m)), ...markets.filter((m) => !yards.has(m))];
}

/**
 * Shipyards that unlock a system go to the very front (clause keeperYardsUnlockFirst, 2026-11-19). A system where none of our keepers
 * is stationed has no ship docked at any of its yards, so serviceableFirst() puts every one of its markets behind every market of a
 * system that has one: on 2026-11-19 RZ24's four listed yards waited 9.5 h behind about 400 markets. A probe can be delivered across
 * gates (keeperDeliveryHops), and the first keeper docked at a yard lets the rest of the system be bought there with no jumps. So a
 * yard in a system with no keeper of ours jumps the queue; one such yard per system (the first in the incoming order), since once it is
 * covered the system is serviceable. Stable otherwise. Pure.
 */
export function unlockYardsFirst(priority: readonly string[], isYard: (market: string) => boolean, systemsWithKeeper: ReadonlySet<string>, blocked: ReadonlySet<string> = new Set()): string[] {
  const systemOf = (m: string): string => m.slice(0, m.lastIndexOf("-"));
  const front: string[] = [];
  const seen = new Set<string>();
  for (const m of priority) {
    const sys = systemOf(m);
    if (!isYard(m) || systemsWithKeeper.has(sys) || blocked.has(sys) || seen.has(sys)) continue;
    seen.add(sys);
    front.push(m);
  }
  const lead = new Set(front);
  return [...front, ...priority.filter((m) => !lead.has(m))];
}
