/**
 * A short readable tag for the route a trade belonged to, stamped on its ledger row so a sale can say which trip it
 * closed ("X1-CM13-B7>X1-CM13-H60 auto circuit1"). Pure: the trader passes in what it holds.
 *
 * Source of the buy and sell waypoints is the route pinned when the cargo was bought (it survives the live assignment
 * changing mid-trip); the assignment adds who chose it (auto / manual) and the circuit leg, but only when it is for the
 * same good, so a later assignment cannot be mislabelled onto an old trip.
 */
export interface TaggedLeg { buyAt?: string; sellAt?: string }
export interface TaggedAssignment { good: string; buyAt?: string; sellAt?: string; source: string; circuit?: { leg: number } }

export function routeTag(good: string, held: TaggedLeg | undefined, assignment: TaggedAssignment | undefined): string | undefined {
  const a = assignment?.good === good ? assignment : undefined;
  const buyAt = held?.buyAt ?? a?.buyAt;
  const sellAt = held?.sellAt ?? a?.sellAt;
  if (!buyAt && !sellAt) return undefined;
  const parts = [`${buyAt ?? "?"}>${sellAt ?? "?"}`];
  if (a) parts.push(a.source);
  if (a?.circuit) parts.push(`circuit${a.circuit.leg}`);
  return parts.join(" ");
}

export interface ParsedRouteTag { buyAt: string; sellAt: string; source?: string; circuit?: number }

/** Read a tag back into its parts ("A>B auto circuit1"); undefined for a missing or unreadable tag. */
export function parseRouteTag(tag: string | null | undefined): ParsedRouteTag | undefined {
  if (!tag) return undefined;
  const [pair, ...rest] = tag.split(" ");
  const [buyAt, sellAt] = (pair ?? "").split(">");
  if (!buyAt || !sellAt) return undefined;
  const circuit = rest.map((p) => /^circuit(\d)$/.exec(p)?.[1]).find((x) => x !== undefined);
  const source = rest.find((p) => p === "auto" || p === "manual");
  return { buyAt, sellAt, source, circuit: circuit ? Number(circuit) : undefined };
}
