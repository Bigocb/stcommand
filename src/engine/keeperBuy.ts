/**
 * Keeper-probe purchasing without an operator in the loop, and without a ship
 * having to happen to dock.
 *
 * Two pure decisions, both used by FleetManager's keeper-probe paths:
 *
 *  - keeperAutoApprove(): may this purchase skip the approval card? Only when the
 *    `autoApproveKeeperProbes` clause is on, the price is at or under its cap and
 *    the credits are spendable. A probe is cheap (28,959c on 2026-10-22) next to
 *    the price data it brings, which is why a cap, not a prompt, is the control.
 *  - pickShipAtYard(): which of our ships can stand in for "a ship docked at the
 *    shipyard" (SpaceTraders sells a ship only to an agent that has one there).
 *    A keeper already stationed at the yard is always there, so a market's probe
 *    can be bought without waiting for a passing ship to dock.
 *
 * Pure: no I/O, no clock. Clause off must reproduce today's behaviour (every
 * purchase asks the operator), which keeperAutoApprove({clauseOn:false}) does.
 */

export interface KeeperAutoApproveInput {
  clauseOn: boolean;
  /** Highest price the operator allows without asking, in credits. */
  capCredits: number;
  price: number;
  /** Whether the wallet can pay it above the cash floor (FleetManager.canAfford). */
  spendable: boolean;
  /** Cash the wallet must still hold after paying; 0 or undefined = no extra reserve (the clause keeperAutoApproveMinCash is off). */
  keepCash?: number;
  /** The wallet's credits now; only read when keepCash is set. */
  credits?: number;
  /** Net profit an hour the fleet must be making (clause keeperAutoApproveMinRate); 0 or undefined = no rate test. */
  minRatePerHour?: number;
  /** The fleet's net over the last hour (matched profit minus jump fees and fuel); undefined = not known yet. */
  ratePerHour?: number;
}

export function keeperAutoApprove(i: KeeperAutoApproveInput): { approve: boolean; reason: string } {
  if (!i.clauseOn) return { approve: false, reason: "autoApproveKeeperProbes is off: the operator decides" };
  if (!Number.isFinite(i.price) || i.price <= 0) return { approve: false, reason: `price ${i.price} is not a real quote` };
  if (i.price > i.capCredits) return { approve: false, reason: `${i.price}c is over the ${i.capCredits}c auto-approve cap` };
  if (!i.spendable) return { approve: false, reason: `${i.price}c is more than the spendable credits` };
  if (i.keepCash && i.keepCash > 0 && (i.credits ?? 0) - i.price < i.keepCash) {
    return { approve: false, reason: `paying ${i.price}c would leave ${Math.max(0, (i.credits ?? 0) - i.price)}c, under the ${i.keepCash}c to keep: the operator decides` };
  }
  // A cash reserve alone can drain while nothing sells (operator 2026-11-19: "5m with a rate of 0 would clean out the wallet"), so
  // with a rate floor set the fleet must also be earning. An unknown rate asks rather than guesses.
  if (i.minRatePerHour && i.minRatePerHour > 0) {
    if (i.ratePerHour === undefined || !Number.isFinite(i.ratePerHour)) return { approve: false, reason: "the fleet's hourly rate is not known yet: the operator decides" };
    if (i.ratePerHour < i.minRatePerHour) {
      return { approve: false, reason: `the fleet is making ${Math.round(i.ratePerHour)}c an hour, under the ${i.minRatePerHour}c an hour for automatic keepers: the operator decides` };
    }
  }
  return { approve: true, reason: `${i.price}c is within the ${i.capCredits}c auto-approve cap` };
}

/**
 * The fleet's net over the hour before `now`: realized profit on sales minus jump fees and fuel, from ledger rows. Pure. The
 * keeper auto-approve rate test reads it; it is rebuilt from the durable ledger, so it is a cache, not state to persist.
 */
export function hourlyNet(rows: readonly { ts: number; type: string; total: number; pnl: number | null }[], now: number): number {
  let net = 0;
  for (const r of rows) {
    if (r.ts < now - 3_600_000 || r.ts >= now) continue;
    if (r.type === "SELL") net += r.pnl ?? 0;
    else if (r.type === "JUMP" || r.type === "REFUEL") net -= Math.abs(r.total);
  }
  return Math.round(net);
}

export interface ShipAtWaypoint { symbol: string; role: string; waypoint: string; nav: string }

/**
 * A ship that is at `yard` and not mid-flight, preferring one that has no other
 * job there: a keeper first (it is permanently stationed and docking it costs
 * nothing), then any other role. Undefined when none of ours is there.
 */
export function pickShipAtYard(ships: readonly ShipAtWaypoint[], yard: string): string | undefined {
  const here = ships.filter((s) => s.waypoint === yard && s.nav !== "IN_TRANSIT");
  return (here.find((s) => s.role === "keeper") ?? here[0])?.symbol;
}

/**
 * The marketplaces of a freshly toured system that the keeper priority list does not hold yet, in waypoint order. Used when a
 * system has passed the explorer's worth threshold: every market in it gets a keeper, the way the operator did by hand.
 * Waypoint symbols are upper-case already; the list is compared exactly.
 */
export function marketsNeedingKeepers(
  waypoints: readonly { symbol: string; traits?: readonly { symbol: string }[] }[],
  listed: readonly string[],
): string[] {
  const have = new Set(listed);
  return waypoints
    .filter((w) => (w.traits ?? []).some((t) => t.symbol === "MARKETPLACE") && !have.has(w.symbol))
    .map((w) => w.symbol);
}

/**
 * Is a system already ours to trade in, so it must never be queued behind the fresh-system gate? The home system is live from the
 * start, and so is any system with a keeper already on one of its markets. 2026-11-10 12:57: a keeper probe jumping through the home hub
 * made the jump-intake judge X1-PT36 as if an explorer had found it; it was queued with its one unlisted market, every home route was
 * held behind the gate, and trading stopped for 33 minutes.
 */
export function systemAlreadyLive(
  system: string,
  home: string,
  waypoints: readonly { symbol: string }[],
  coveredMarkets: ReadonlySet<string>,
): boolean {
  if (system === home) return true;
  return waypoints.some((w) => coveredMarkets.has(w.symbol));
}

/** Distinct goods a market trades, from the lists a remote market read returns even with no ship there (prices need a ship; these do not). */
export function distinctGoods(m: { imports?: readonly string[]; exports?: readonly string[]; exchange?: readonly string[]; tradeGoods?: Record<string, unknown> }): number {
  return new Set([...(m.imports ?? []), ...(m.exports ?? []), ...(m.exchange ?? []), ...Object.keys(m.tradeGoods ?? {})]).size;
}

/**
 * Split candidate markets into those worth a keeper and those too thin to be (fewer than `minGoods` goods). A market whose
 * goods count is unknown is kept, never dropped on a guess, and minGoods 0 keeps everything (the clause off). A shipyard is never
 * thin (`isYard`, operator 2026-11-03): a keeper docked at a yard is what reads its stock and prices, so a yard with 3 goods is
 * still worth a probe.
 */
export function splitThinMarkets(
  candidates: readonly string[],
  goodsOf: (market: string) => number | undefined,
  minGoods: number,
  isYard: (market: string) => boolean = () => false,
): { keep: string[]; thin: { market: string; goods: number }[] } {
  const keep: string[] = [];
  const thin: { market: string; goods: number }[] = [];
  for (const market of candidates) {
    const goods = goodsOf(market);
    if (goods !== undefined && goods < minGoods && !isYard(market)) thin.push({ market, goods });
    else keep.push(market);
  }
  return { keep, thin };
}
