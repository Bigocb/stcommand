/**
 * The dispatch routes a screen needs (issue #87): every good's first route in the list's own order (the screens look a good up with
 * routes.find(r => r.good === g), and the list is already ranked), plus the best `top` by profit per trip (the boards show the top
 * few), in the list's order. Pure.
 */
export function screenRoutes<T extends { good: string; profitPerTrip?: number | null }>(all: readonly T[], top = 100): T[] {
  const keep = new Set<number>();
  const seen = new Set<string>();
  all.forEach((r, i) => { if (!seen.has(r.good)) { seen.add(r.good); keep.add(i); } });
  [...all.keys()].sort((a, b) => (all[b]!.profitPerTrip ?? 0) - (all[a]!.profitPerTrip ?? 0)).slice(0, top).forEach((i) => keep.add(i));
  return [...keep].sort((a, b) => a - b).map((i) => all[i]!);
}
