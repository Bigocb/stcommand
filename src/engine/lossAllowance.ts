/**
 * Which loss floor — if any — applies to a sale of one good. Pure: the caller
 * supplies the cost basis, the fleet's percentage floor and, when the good is
 * on a pinned route, that route's own allowance.
 *
 * A manually pinned ("direct") route is the operator overriding the fleet's
 * policy for one ship, so it deliberately outranks the percentage floor. Before
 * this, "outranks" meant "has no floor at all": a pin could sell at any price,
 * including below the cost of the cargo, and the only alternative was the
 * fleet-wide maxLossPct, which is far too strict for clearing a position into a
 * market paying slightly under cost. The operator asked for the middle option —
 * "you may lose up to N credits a unit on this route, and no more" — which is
 * what an allowance is.
 *
 * Three states, and the `undefined`/`null` split is the whole point:
 *   undefined  not a pinned leg: the fleet's percentage floor applies.
 *   null       pinned, with no allowance set: no floor at all. This is the
 *              pre-existing behaviour and must stay that way, or every route
 *              pinned before the allowance existed would start refusing to sell.
 *   number     pinned, with an allowance: cost basis minus that many credits per
 *              unit. A large allowance can drive the floor negative, which is
 *              the same thing as "no floor" and needs no special case.
 */
export interface LossAllowanceInput {
  /** What this ship paid per unit for the good, or undefined/0 when unknown. */
  cost: number | undefined;
  /** The fleet doctrine's maxLossPct — the percentage floor when no pin applies. */
  maxLossPct: number;
  /** The pinned route's allowance for this good, as described above. Omit for an unpinned good. */
  allowance?: number | null;
}

/**
 * The lowest unit price this good may sell at, or undefined when nothing holds
 * it back (no cost basis, or a pinned route with no allowance).
 */
export function sellFloor(i: LossAllowanceInput): number | undefined {
  if (i.cost === undefined || i.cost <= 0) return undefined;   // no basis: nothing to measure a loss against
  if (i.allowance === null) return undefined;                 // pinned, no allowance: the operator's route sells regardless
  if (i.allowance !== undefined) return i.cost - i.allowance; // pinned, capped: cost less the allowed loss per unit
  return i.cost * (1 - i.maxLossPct / 100);                   // fleet floor
}

/** True when `price` is under the floor that applies to this good. */
export function belowSellFloor(i: LossAllowanceInput & { price: number }): boolean {
  const floor = sellFloor(i);
  return floor !== undefined && i.price < floor;
}
