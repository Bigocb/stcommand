/**
 * Send tour ships to price the queued systems (the "fresh-system hybrid", run by hand in the 2026-11-01 week and written down in
 * docs/journal/2026-11-01.md, standing rules; the operator's idea of 2026-11-07: "a ship jumps into the first staged system and tours it,
 * the system opens once about half its markets are priced, the ship moves on when coverage is enough").
 *
 * A staged system has its keepers bought and parked (a parked keeper polls nothing), so until it is released nobody reads its markets and
 * traders have no routes there. A tour ship that sits in the system prices every market in about an hour; the release rule's priced-share
 * test (`releaseMinPricedPct`) then lets it open. This module decides which free tour ship goes to which queued system, and which ships
 * are free to move on.
 *
 * A system NEEDS a tour while it is staged (scouted too when `includeScouted`), not held, reachable, and under `moveOnShare` of its
 * listed markets priced. A ship is FREE when it is a tour or explorer ship that nobody has pinned, has the fuel, is not on a system that
 * still needs it, and has stayed `minStayMs` where it was sent. The nearest free ship in gate hops goes to each uncovered system, best
 * ready system first, and at most `maxShips` ships work at once.
 *
 * Pure: no I/O, no clock (the caller passes `now`), no globals. Policy off (maxShips 0) decides nothing, which is today's behaviour.
 * Every send carries a one-line reason; notes say why a system got no ship.
 */

export interface QueueTourPolicy {
  /** Most tour ships working queued systems at once. 0 = off. */
  maxShips: number;
  /** Farthest, in gate hops, a ship is sent. */
  maxHops: number;
  /** A ship under this share of its tank is not sent: it refuels at stops, but a nearly empty one strands on a long walk. */
  minFuelShare: number;
  /** A staged system with at least this share (0..1) of its markets priced no longer needs a tour: the release rule has what it needs. */
  moveOnShare: number;
  /** A ship stays where it was sent at least this long before it is taken for another system. */
  minStayMs: number;
  /** Tour scouted systems too, when no staged one needs a ship. Off: only staged systems (their keepers are already bought). */
  includeScouted: boolean;
}

export const DEFAULT_QUEUE_TOUR_POLICY: QueueTourPolicy = {
  maxShips: 0,
  maxHops: 12,
  minFuelShare: 0.25,
  moveOnShare: 0.8,
  minStayMs: 20 * 60_000,
  includeScouted: false,
};

/** A queued system, in the shape the fresh-system tick already builds (QueueFacts in systemRelease.ts). */
export interface TourTarget {
  system: string;
  state: "scouted" | "staged";
  held: boolean;
  addedAt: number;
  stagedAt?: number;
  /** Markets on its list. 0 = nothing to price. */
  markets: number;
  /** Staged only: share of its keepers in place; the more ready a system is, the sooner it is worth pricing. */
  readyShare?: number;
  /** Share of its listed markets with a price snapshot of any age; undefined = unknown, treated as unpriced. */
  pricedShare?: number;
  /** false = no finished gate path from our ships: never sent. undefined = unknown, treated as reachable. */
  reachable?: boolean;
}

export interface TourShip {
  symbol: string;
  /** The system it is in now. */
  system: string;
  fuel: number;
  fuelCap: number;
  /** The system it is walking toward, when it has a destination. */
  heading?: string;
  /** Operator hold or pin: never touched. */
  held: boolean;
  /** When it was last sent by this module (ms); undefined = never sent. */
  sentAt?: number;
}

export interface TourSignals {
  now: number;
  targets: readonly TourTarget[];
  ships: readonly TourShip[];
  /** Gate hops between two systems; undefined = no known path. A caller's lookup, so this module stays pure. */
  hops: (from: string, to: string) => number | undefined;
}

export interface TourSend {
  ship: string;
  system: string;
  hops: number;
  reason: string;
}

export interface TourDecision {
  send: TourSend[];
  notes: string[];
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Does this queued system need a ship in it? */
export function needsTour(t: TourTarget, p: QueueTourPolicy): boolean {
  if (t.held || t.reachable === false || t.markets <= 0) return false;
  if (t.state === "scouted" && !p.includeScouted) return false;
  return t.pricedShare === undefined || t.pricedShare < p.moveOnShare;
}

export function decideQueueTours(s: TourSignals, p: QueueTourPolicy): TourDecision {
  const out: TourDecision = { send: [], notes: [] };
  if (p.maxShips <= 0) return out;

  // Staged before scouted, then the most ready (keepers in place) first, then the oldest: a ready system is the next to open.
  const rank = (t: TourTarget): number => (t.state === "staged" ? 0 : 1);
  const needing = s.targets
    .filter((t) => needsTour(t, p))
    .sort((a, b) => rank(a) - rank(b) || (b.readyShare ?? 0) - (a.readyShare ?? 0) || (a.stagedAt ?? a.addedAt) - (b.stagedAt ?? b.addedAt) || a.system.localeCompare(b.system));
  if (!needing.length) {
    out.notes.push(`no ${p.includeScouted ? "queued" : "staged"} system needs a tour (held, unreachable, or ${pct(p.moveOnShare)} of its markets priced)`);
    return out;
  }
  const needs = new Set(needing.map((t) => t.system));

  // A ship working a system that still needs it (in it, or walking to it) keeps that system covered and uses a slot.
  const working = s.ships.filter((x) => !x.held && needs.has(x.heading ?? x.system));
  const covered = new Set(working.map((x) => x.heading ?? x.system));
  let slots = p.maxShips - working.length;
  const uncovered = needing.filter((t) => !covered.has(t.system));
  if (!uncovered.length) {
    out.notes.push(`${needing.length} system(s) need a tour and each has a ship (${working.map((x) => `${x.symbol}→${x.heading ?? x.system}`).join(", ")})`);
    return out;
  }
  if (slots <= 0) {
    out.notes.push(`${uncovered.map((t) => t.system).join(", ")} need a tour but ${working.length} of ${p.maxShips} ships are already working`);
    return out;
  }

  const workingSet = new Set(working.map((x) => x.symbol));
  const fueled = (x: TourShip): boolean => x.fuelCap > 0 && x.fuel / x.fuelCap >= p.minFuelShare;
  const stayed = (x: TourShip): boolean => x.sentAt === undefined || s.now - x.sentAt >= p.minStayMs;
  const free = s.ships.filter((x) => !x.held && !workingSet.has(x.symbol) && fueled(x) && stayed(x));
  if (!free.length) {
    const why = s.ships.length ? `${s.ships.length} tour ship(s), none free (held, busy on a system that needs it, low on fuel, or just sent)` : "no tour or explorer ship";
    out.notes.push(`${uncovered.map((t) => t.system).join(", ")} need a tour: ${why}`);
    return out;
  }

  const taken = new Set<string>();
  for (const t of uncovered) {
    if (slots <= 0) {
      out.notes.push(`${t.system} needs a tour but all ${p.maxShips} ships are working`);
      continue;
    }
    let best: { ship: TourShip; hops: number } | undefined;
    for (const x of free) {
      if (taken.has(x.symbol)) continue;
      const h = x.system === t.system ? 0 : s.hops(x.system, t.system);
      if (h === undefined || h > p.maxHops) continue;
      if (!best || h < best.hops || (h === best.hops && x.fuel / x.fuelCap > best.ship.fuel / best.ship.fuelCap)) best = { ship: x, hops: h };
    }
    if (!best) {
      out.notes.push(`${t.system} needs a tour: no free ship within ${p.maxHops} gate hops`);
      continue;
    }
    taken.add(best.ship.symbol);
    slots--;
    const where = t.state === "staged" ? `staged, ${pct(t.readyShare ?? 0)} of keepers in place` : "scouted";
    out.send.push({
      ship: best.ship.symbol,
      system: t.system,
      hops: best.hops,
      reason: `${t.system} (${where}) has ${t.pricedShare === undefined ? "an unknown share" : pct(t.pricedShare)} of ${t.markets} market(s) priced, under ${pct(p.moveOnShare)}; ${best.ship.symbol} is the nearest free ship, ${best.hops} hop(s) away with ${pct(best.ship.fuelCap > 0 ? best.ship.fuel / best.ship.fuelCap : 0)} fuel`,
    });
  }
  return out;
}
