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
