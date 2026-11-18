/**
 * What a trader may spend on cargo, given the wallet and the cash floor (doctrine `cashFloor`).
 *
 * 2026-11-18: with the wallet under the 100k floor the spendable amount was 0, the route build sized every leg at 0 units and
 * dropped all 8,051 stored legs, and no trader could buy anything: the fleet could not trade its way back above the floor.
 * Cargo is cash that comes back within the trip, so below the floor a trader may still spend a share of the wallet
 * (doctrine `cashFloorTradeSharePct`); the floor keeps protecting the rest, and ship and keeper purchases keep the full floor.
 *
 * Pure: no I/O, no clock. Share 0 (clause off) is the old rule, `max(0, credits - floor)`.
 */
export function tradeBudget(credits: number, floor: number, sharePct: number): number {
  const c = Number.isFinite(credits) ? Math.max(0, credits) : 0;
  const aboveFloor = Math.max(0, c - Math.max(0, floor));
  const share = Math.max(0, Math.min(100, Number.isFinite(sharePct) ? sharePct : 0));
  if (share <= 0) return aboveFloor;
  return Math.max(aboveFloor, Math.floor((c * share) / 100));
}

/** One line for the log: why the budget is what it is. */
export function tradeBudgetReason(credits: number, floor: number, sharePct: number): string {
  const b = tradeBudget(credits, floor, sharePct);
  const above = Math.max(0, credits - floor);
  return b > above
    ? `trade budget ${b} (${sharePct}% of a ${Math.round(credits)} wallet; the ${floor} floor would leave ${above})`
    : `trade budget ${b} (wallet less the ${floor} floor)`;
}
