/**
 * Scout probes for staged systems (clause stagedScoutProbe, operator idea 2026-11-19).
 *
 * A staged system is released by the tour path once a tour ship is in it and half its listed markets are priced. When no free
 * tour ship is close, buy a probe at the nearest shipyard where one of our ships is docked (a yard sells only to a ship standing
 * there) and send it on that tour. Tested on X1-ZU90: probe bought 16:51, in the system 17:27, released 17:55, about 51k in all
 * against 250-300k for its seven keepers.
 *
 * Pure: the caller supplies the systems that need a tour, how near the nearest free tour ship is, the yards, the hop lookup and
 * the cash. No I/O, no clock.
 */

export interface ScoutProbePolicy {
  /** Most a probe may cost: its price plus the jumps to the system. 0 = off. */
  maxCost: number;
  /** A free tour ship this many gate hops away or nearer goes instead; farther than this (or none free) and a probe is bought. */
  shipHops: number;
  /** Estimated cost of one gate jump. */
  jumpCost: number;
  /** The wallet must keep at least this much after the probe and its jumps. */
  minCashAfter: number;
}

export const DEFAULT_SCOUT_PROBE_POLICY: ScoutProbePolicy = { maxCost: 0, shipHops: 2, jumpCost: 6_500, minCashAfter: 500_000 };

export interface ScoutNeed {
  system: string;
  /** Gate hops of the free tour ship the queue would send, undefined = none free or none within its reach. */
  shipHops?: number;
}

export interface ProbeYard {
  yard: string;
  system: string;
  /** Last known probe price there. */
  price: number;
}

export interface ScoutProbeBuy {
  system: string;
  yard: string;
  price: number;
  hops: number;
  cost: number;
  reason: string;
}

export interface ScoutProbeDecision {
  buy?: ScoutProbeBuy;
  notes: string[];
}

/**
 * At most one probe a pass: the first system (in the order given, the queue's) with no free tour ship within `shipHops`, bought at
 * the yard with the lowest price + hops x jumpCost, if that is within `maxCost` and leaves `minCashAfter` in the wallet.
 */
export function decideScoutProbe(needs: readonly ScoutNeed[], yards: readonly ProbeYard[], hops: (from: string, to: string) => number | undefined, wallet: number, p: ScoutProbePolicy): ScoutProbeDecision {
  const out: ScoutProbeDecision = { notes: [] };
  if (p.maxCost <= 0) return out;
  for (const n of needs) {
    if (n.shipHops !== undefined && n.shipHops <= p.shipHops) continue;
    const ship = n.shipHops === undefined ? "no free tour ship" : `the nearest free tour ship is ${n.shipHops} hop(s) away (over ${p.shipHops})`;
    let best: ScoutProbeBuy | undefined;
    for (const y of yards) {
      const h = y.system === n.system ? 0 : hops(y.system, n.system);
      if (h === undefined) continue;
      const cost = y.price + h * p.jumpCost;
      if (!best || cost < best.cost) best = { system: n.system, yard: y.yard, price: y.price, hops: h, cost, reason: "" };
    }
    if (!best) {
      out.notes.push(`${n.system}: ${ship}, and no yard with a probe and one of our ships docked has a gate path to it`);
      continue;
    }
    if (best.cost > p.maxCost) {
      out.notes.push(`${n.system}: ${ship}; cheapest probe ${best.yard} costs about ${best.cost} with ${best.hops} jump(s), over the ${p.maxCost} limit`);
      continue;
    }
    if (wallet - best.cost < p.minCashAfter) {
      out.notes.push(`${n.system}: ${ship}; a probe from ${best.yard} (about ${best.cost}) would leave the wallet under ${p.minCashAfter}`);
      continue;
    }
    best.reason = `${ship}; probe at ${best.yard} for ${best.price} plus ${best.hops} jump(s), about ${best.cost} in all`;
    out.buy = best;
    return out;
  }
  return out;
}
