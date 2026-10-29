/**
 * Keepers for a system whose own yards sell no keeper hull (DJ38's only yard lists an interceptor).
 *
 * A probe crosses gates (2026-10-29: THEO-C7 went YF38 -> VK87 -> DJ38 for 13.6k in jumps and became DJ38-EX8Z's keeper), so a
 * probe can be bought at a yard in another system and sent through. This picks that yard: the cheapest total of the hull's price and
 * its gate jumps, among yards where a ship of ours is already docked (a purchase needs one), within `maxHops` of the target.
 * Preferred hulls come first, as in keeperYard.ts. Pure: the caller supplies the graph and where ships are.
 *
 * Policy is data: `maxHops` 0 (the clause off) picks nothing.
 */
export interface DeliveryYard {
  systemSymbol: string;
  waypointSymbol: string;
  shipType: string;
  purchasePrice: number;
}

export interface DeliveryPolicy {
  /** Most gate jumps between the yard's system and the target's; 0 switches delivery off. */
  maxHops: number;
  /** Credits a gate jump is expected to cost (the learned average, or a flat guess). */
  jumpCost: number;
}

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = { maxHops: 0, jumpCost: 6_000 };

export interface DeliveryPick {
  yard: string;
  system: string;
  hull: string;
  price: number;
  hops: number;
  jumpCost: number;
  /** price + hops x jumpCost */
  total: number;
}

export interface DeliveryContext {
  /** Hull types worth buying, most preferred first. */
  hulls: readonly string[];
  /** Gate jumps from a system to the target, or undefined when no path through finished gates is known. */
  hopsFrom: (system: string) => number | undefined;
  /** Is one of our ships docked at this waypoint right now? */
  shipPresentAt: (waypoint: string) => boolean;
}

export function pickDeliveryYard(targetSystem: string, yards: readonly DeliveryYard[], ctx: DeliveryContext, policy: DeliveryPolicy): DeliveryPick | undefined {
  if (policy.maxHops <= 0) return undefined;
  for (const hull of ctx.hulls) {
    let best: DeliveryPick | undefined;
    for (const y of yards) {
      if (y.shipType !== hull || y.systemSymbol === targetSystem || !(y.purchasePrice > 0)) continue;
      const hops = ctx.hopsFrom(y.systemSymbol);
      if (hops === undefined || hops < 1 || hops > policy.maxHops) continue;
      if (!ctx.shipPresentAt(y.waypointSymbol)) continue;
      const total = y.purchasePrice + hops * policy.jumpCost;
      if (!best || total < best.total || (total === best.total && y.waypointSymbol < best.yard)) {
        best = { yard: y.waypointSymbol, system: y.systemSymbol, hull, price: y.purchasePrice, hops, jumpCost: policy.jumpCost, total };
      }
    }
    if (best) return best;
  }
  return undefined;
}

/** One line for the approval card and the log. */
export function deliveryNote(pick: DeliveryPick, targetMarket: string): string {
  return `delivered from ${pick.system}: ${pick.hops} gate jump${pick.hops === 1 ? "" : "s"} (about ${Math.round(pick.hops * pick.jumpCost).toLocaleString("en-US")}c) on top of the ${pick.price.toLocaleString("en-US")}c hull, ${pick.total.toLocaleString("en-US")}c in all, to ${targetMarket}`;
}

/** Has the delivered probe reached the target market's system? Then its hold is released and it works as a normal keeper. */
export function deliveryArrived(shipSystem: string | undefined, targetMarket: string): boolean {
  return shipSystem !== undefined && shipSystem === targetMarket.slice(0, targetMarket.lastIndexOf("-"));
}
