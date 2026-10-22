/**
 * Contracts whose delivery point cannot be reached by gate.
 *
 * 2026-10-22: a PROCUREMENT contract for 132 PRECIOUS_STONES delivering to X1-NH60-ZA5E (21 jumps from home, owing 17k in total) was
 * accepted and sourced. THEOREM-21 bought 40 and then failed "no verified gate path (<= 10 hops)" every 12 seconds for over two
 * hours. Backtracking could not have helped: there is no shorter path, the destination is simply past the 10-jump ceiling.
 * Pure helpers: whether a failure is that kind, and how long a delivery that hit one is left alone.
 */

/** How long a contract delivery that found no gate path is left alone before it is tried again (a gate may have been built). */
export const CONTRACT_DELIVERY_BACKOFF_MS = 30 * 60_000;

/** True for the errors the trader throws when a destination has no usable gate path. */
export function isNoGatePathError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no verified gate path|no jump gate from|has no jump gate waypoint/i.test(msg);
}
