/**
 * Multi-hop jump paths between systems, with a hard cap.
 *
 * The cap is a code constant on purpose, not a setting: it is the one number
 * that bounds how much a mistaken cross-system assignment can burn (a jump is
 * ~5,000-5,700c), so changing it should be a reviewed commit. See the
 * "Cross-System Trading: PRD and Design" doc.
 */
export const MAX_POSITIONING_HOPS = 3;

/**
 * Shortest path from `from` to `to` (inclusive of both ends) over a graph the
 * caller describes, or undefined if there is none within `maxHops` jumps.
 * `neighbors(system)` must return only systems reachable in ONE jump right
 * now — i.e. the caller owns the "is this gate usable" decision. Pure: no I/O.
 *
 * A zero-hop path (from === to) is `[from]`.
 */
export function findJumpPath(
  from: string,
  to: string,
  neighbors: (system: string) => string[],
  maxHops: number = MAX_POSITIONING_HOPS,
): string[] | undefined {
  // Never honor a larger bound than the constant, whatever a caller passes.
  const limit = Math.min(maxHops, MAX_POSITIONING_HOPS);
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  let frontier = [from];
  for (let depth = 1; depth <= limit; depth++) {
    const next: string[] = [];
    for (const sys of frontier) {
      for (const n of neighbors(sys)) {
        if (seen.has(n)) continue;
        seen.add(n);
        prev.set(n, sys);
        if (n === to) {
          const path = [n];
          let cur = n;
          while (prev.has(cur)) {
            cur = prev.get(cur)!;
            path.unshift(cur);
          }
          return path;
        }
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return undefined;
}
