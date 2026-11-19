/**
 * Where to buy a good a contract still needs: the market with the lowest LANDED cost at the delivery point, not the
 * cheapest sticker price in the home system.
 *
 * Why it exists (2026-11-18/19, issue #54): contract buying only ever looked at the agent's home system
 * (`materialBuyers(good, homeSystem)`). A FOOD contract for X1-YH41-A1 bought 149 units in home-system X1-KJ19 at
 * 3,468-4,422 each (578,778c), 2 jumps from the destination, while FOOD sold at about 2,203 in X1-S96, 1 jump away.
 * About 250k was overpaid, plus an extra jump each trip.
 *
 * Landed cost = price x units still needed + jumps from the buy system to the destination x jump cost x 2 (out and back
 * for each load). Policy off reproduces the old rule exactly: the cheapest home-system market, whatever its age.
 * With the policy on, home-system markets stay candidates at any age (as before) and markets in other systems are added
 * when their price is fresh enough and a finished gate path to the destination is known.
 *
 * Pure: no I/O, no clock. The caller supplies the market rows, the hop counter and `now`.
 */

export interface SourceCandidate {
  waypoint: string;
  system: string;
  purchasePrice: number;
  /** Epoch ms the price was read. */
  observedAt: number;
}

export interface SourcePolicy {
  /** Off = home-system cheapest only (the old rule). */
  enabled: boolean;
  /** A market outside the home system needs a price newer than this. */
  maxAgeMin: number;
  /** Credits per gate jump. */
  jumpCost: number;
}

export interface SourceContext {
  homeSystem: string;
  destinationSystem: string;
  /** Units still needed. */
  units: number;
  now: number;
  /** Gate jumps between two systems, 0 for the same system, undefined when no finished path is known. */
  hops: (from: string, to: string) => number | undefined;
}

export interface SourceChoice {
  waypoint: string;
  purchasePrice: number;
  hops: number;
  landedCost: number;
  /** One line for the log. */
  reason: string;
}

export const CONTRACT_SOURCE_OFF: SourcePolicy = { enabled: false, maxAgeMin: 90, jumpCost: 6_500 };

const homeOnly = (cands: SourceCandidate[], home: string): SourceCandidate | undefined =>
  cands.filter((c) => c.system === home && c.purchasePrice > 0).sort((a, b) => a.purchasePrice - b.purchasePrice)[0];

export function chooseContractSource(cands: SourceCandidate[], ctx: SourceContext, policy: SourcePolicy): SourceChoice | undefined {
  const units = Math.max(1, ctx.units);
  const landed = (c: SourceCandidate, hops: number): number => c.purchasePrice * units + hops * 2 * policy.jumpCost;
  const home = homeOnly(cands, ctx.homeSystem);

  if (!policy.enabled) {
    if (!home) return undefined;
    const hops = ctx.hops(home.system, ctx.destinationSystem) ?? 0;
    return { waypoint: home.waypoint, purchasePrice: home.purchasePrice, hops, landedCost: landed(home, hops), reason: `home system ${ctx.homeSystem}, cheapest at ${home.purchasePrice}` };
  }

  const maxAgeMs = policy.maxAgeMin * 60_000;
  let best: { c: SourceCandidate; hops: number; cost: number } | undefined;
  for (const c of cands) {
    if (!(c.purchasePrice > 0)) continue;
    const isHome = c.system === ctx.homeSystem;
    if (!isHome && !(ctx.now - c.observedAt <= maxAgeMs)) continue;
    const hops = ctx.hops(c.system, ctx.destinationSystem);
    if (hops === undefined) {
      if (!isHome) continue; // no known path: an away market can't be used
    }
    const h = hops ?? 0;
    const cost = landed(c, h);
    if (!best || cost < best.cost || (cost === best.cost && c.purchasePrice < best.c.purchasePrice)) best = { c, hops: h, cost };
  }
  if (!best) return undefined;

  let reason = `${best.c.waypoint} at ${best.c.purchasePrice}, ${best.hops} jump(s) to ${ctx.destinationSystem}: landed ${Math.round(best.cost)} for ${units}u`;
  if (home && home.waypoint !== best.c.waypoint) {
    const homeHops = ctx.hops(home.system, ctx.destinationSystem) ?? 0;
    reason += ` (home ${home.waypoint} at ${home.purchasePrice} would land ${Math.round(landed(home, homeHops))})`;
  }
  return { waypoint: best.c.waypoint, purchasePrice: best.c.purchasePrice, hops: best.hops, landedCost: best.cost, reason };
}
