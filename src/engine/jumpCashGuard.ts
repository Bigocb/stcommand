/**
 * Jump cash guard (operator request, 2026-11-18, INC-07 follow-up).
 *
 * A gate jump costs about 6-8k. With the wallet at 22k, three jumps emptied it, and nothing stopped a trader from starting a
 * route that needed one: the dispatcher nets jump fees against the route's profit, but never asks whether the wallet can carry
 * them. This guard says no to any NEW route that needs a gate jump (to reach the buy market, or to carry the cargo to the sell
 * market) while the wallet is under the floor. A ship already carrying cargo keeps its leg (the dispatcher holds it before this
 * check runs), so cargo is never stranded.
 *
 * Pure: no I/O, no clock. Floor 0 (clause off) means no guard, exactly today's behaviour.
 */
export function jumpCashBlock(credits: number | undefined, floor: number | undefined, needsJump: boolean): string | undefined {
  if (!needsJump) return undefined;
  if (floor === undefined || !Number.isFinite(floor) || floor <= 0) return undefined;
  if (credits === undefined || !Number.isFinite(credits)) return undefined; // unknown wallet: behave as before
  if (credits >= floor) return undefined;
  return `wallet ${Math.round(credits)}c is under the ${Math.round(floor)}c jump floor (doctrine jumpCashFloor): no new route that needs a gate jump`;
}
