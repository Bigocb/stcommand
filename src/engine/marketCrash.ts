/**
 * Sell-market aftermath: what a market probably pays now, after our own sales pushed its price down.
 *
 * 2026-10-23, X1-YB39-BD3D: THEOREM-152 sold 360 LAB_INSTRUMENTS (5836 -> 4609, -21%) and an hour later was assigned
 * the same route at 5836; THEOREM-173 sold 580 ELECTRONICS (2949 -> 2210, -25%) and its route still read 2949. The
 * price on a route is the last snapshot, and a trader snapshots a market when it docks, before it sells. So the number
 * stays at the pre-sale level until another ship happens to visit. The recent-volume discount in the dispatcher fades
 * after 30 minutes, long before the market has refilled. Both ships bought for a market that no longer paid and
 * trekked nine jumps to sell elsewhere.
 *
 * Pure: the caller passes our recent sales into one (good, market), the route's listed price and the snapshot's time.
 * Recovery is modelled as a straight line from the last sale's price back to the first sale's price over
 * `recoveryMin` minutes. That figure is a guess until the analysis engine has measured sell-side recovery; it is a
 * setting for that reason. `recoveryMin` 0 switches the whole thing off.
 */

export interface SaleImpact {
  /** Units in this lot. */
  units: number;
  /** When it sold, ms. */
  at: number;
  /** What each unit fetched. */
  price: number;
}

export interface CrashPolicy {
  /** Minutes a market takes to refill to its pre-sale price; 0 = off. */
  recoveryMin: number;
}

export interface SellEstimate {
  /** The price to plan with: the listed price less the part of our own dump that has not yet refilled. */
  price: number;
  /** Listed price minus `price`, per unit; 0 when nothing applies. */
  shortfall: number;
  /** One line for the log; undefined when nothing was adjusted. */
  reason?: string;
}

export const DEFAULT_CRASH_POLICY: CrashPolicy = { recoveryMin: 0 };

/**
 * Estimated sell price now. Only sales made after the snapshot count: a snapshot taken after them already shows the
 * depressed price, and counting them again would charge the same dump twice.
 */
export function estimateSellPrice(sales: readonly SaleImpact[], listedPrice: number, snapshotAt: number, now: number, policy: CrashPolicy): SellEstimate {
  const unchanged: SellEstimate = { price: listedPrice, shortfall: 0 };
  if (!(policy.recoveryMin > 0) || !(listedPrice > 0)) return unchanged;
  const windowMs = policy.recoveryMin * 60_000;
  const unseen = sales.filter((s) => s.at > snapshotAt && s.at >= now - windowMs && s.price > 0).sort((a, b) => a.at - b.at);
  if (!unseen.length) return unchanged;
  const first = unseen[0]!;
  const last = unseen[unseen.length - 1]!;
  if (last.price >= first.price) return unchanged; // the price did not fall, so there is nothing to refill
  const progress = Math.min(1, Math.max(0, (now - last.at) / windowMs));
  const expected = last.price + (first.price - last.price) * progress;
  const price = Math.min(listedPrice, expected);
  const shortfall = listedPrice - price;
  if (shortfall <= 0) return unchanged;
  const units = unseen.reduce((s, x) => s + x.units, 0);
  return {
    price: Math.round(price),
    shortfall: Math.round(shortfall),
    reason: `our ${units}u sold ${first.price}c -> ${last.price}c, about ${Math.round(progress * 100)}% refilled, planning on ${Math.round(price)}c not ${Math.round(listedPrice)}c`,
  };
}

/** The route's profit after the dump, for one trip of `units`; negative means the market no longer pays for the trip. */
export const profitAfterShortfall = (profit: number, shortfall: number, units: number): number => profit - shortfall * units;
