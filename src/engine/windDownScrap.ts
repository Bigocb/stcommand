import type { ShipObserver } from "./shipSnapshots.js";

/**
 * Reset wind-down retirement: before the weekly universe reset, ships that have no work left are
 * flown to the nearest known shipyard and scrapped, so the week ends in credits rather than hulls.
 *
 * Two triggers, added to one queue and drained by the same code:
 *
 *   1. **The window opening** — every ship that is not a trader, whatever its role. By then none of
 *      them has work to do: no new buys start in the window (see resetWindDown.ts) and nothing is
 *      handed to an empty hull.
 *   2. **A sale that EMPTIES a hold**, at any time inside the window, for any role. This is what
 *      retires traders, which hold every unit of cargo still in flight, and it is also what retires
 *      a loaded miner, siphoner or feed carrier the moment its own agent sells out — see
 *      shouldRetire() for why such a ship is queued rather than scrapped on the spot.
 *
 * Role-general on purpose: the predicate is "not a trader" over the whole ShipRole union, so a
 * fleet carrying miners, siphoners, surveyors, tours, scouts or explorers behaves the same way one
 * carrying only keepers and traders does.
 *
 * Everything here is pure except WindDownScrapper, which only records.
 */

/** Inside the last stretch this close to the reset, cargo still aboard is worth nothing anyway — it
 *  is destroyed by the reset, not sold — so a ship still holding is scrapped regardless of its
 *  cargo. Without this, a ship whose own agent never manages a sale would sit in the queue past the
 *  reset and never be retired at all, which is the one outcome the window exists to prevent. */
export const SCRAP_DEADLINE_MIN = 15;

/**
 * Every ship that is not a trader, up to `limit`, excluding the ones already on their way to a yard.
 *
 * A trader is the one role left out, and not as a special case: traders are the ships that still
 * have something to do during the window (they hold the cargo that has to be sold), and they are
 * retired instead by trigger 2, the moment they sell out. Everything else goes now.
 */
export function shipsToRetire(
  ships: readonly { symbol: string; role: string }[],
  alreadyQueued: ReadonlySet<string>,
  limit: number,
): string[] {
  return ships
    .filter((s) => s.role !== "trader" && !alreadyQueued.has(s.symbol))
    .slice(0, limit)
    .map((s) => s.symbol);
}

/**
 * Whether a queued ship should be sent to the yard on this tick.
 *
 * A ship still holding cargo waits. Scrapping it destroys that cargo for a fraction of the hull's
 * price, and this codebase has no way to make a miner sell on demand that would not reimplement its
 * own sell path — sellCargoInLots()'s chunking against a market's transaction cap, the
 * jettison-when-refused fallback, the field-to-market leg. Its own agent already sells when the hold
 * fills (agent.ts's sellAllCargo), and WindDownScrapper catches it then. So patience is free and
 * reimplementation is not.
 *
 * Past SCRAP_DEADLINE_MIN that patience is pointless: the reset destroys whatever is aboard anyway,
 * so the deadline strictly beats the cargo and the ship is scrapped holding whatever it has.
 */
export function shouldRetire(cargoUnits: number, minutesLeft: number): { retire: boolean; reason: string } {
  if (minutesLeft <= SCRAP_DEADLINE_MIN) {
    const aboard = cargoUnits > 0 ? ` with ${cargoUnits} unit(s) aboard` : "";
    return { retire: true, reason: `reset in ${Math.ceil(Math.max(minutesLeft, 0))} min: deadline, scrapping${aboard}` };
  }
  if (cargoUnits > 0) {
    return { retire: false, reason: `holding ${cargoUnits} unit(s): waiting for its own sale before retiring` };
  }
  return { retire: true, reason: `reset in ${Math.ceil(minutesLeft)} min: hold is empty, retiring this ship` };
}

/**
 * Remembers ships that emptied their hold while the window was open, for the fleet's next tick.
 *
 * An observer rather than a hook in the trading code because every sell in this codebase goes
 * through the one API client — agent.ts's trader sell, agent.ts's sellCargoInLots, feed.ts's own
 * sellCargo — so one hook covers all of them, and any added later, where four call sites would not.
 *
 * It only RECORDS. onShipActionDone() runs synchronously on the response path, and retiring a ship
 * (fleet.sellShip) both awaits and does a live ship read; neither belongs there. The tick drains it,
 * the same level-triggered shape as proposeOperatorHolds().
 */
export class WindDownScrapper implements ShipObserver {
  private readonly soldOut = new Set<string>();

  onShipRead(): void {}
  onShipAction(): void {}

  /**
   * A successful /sell answered. The response carries the hold as it stands after the sale
   * (schema.d.ts's sell-cargo 200: agent, cargo, transaction), so an emptied hold is visible here.
   * Only an emptied hold counts: a partial sale — a market's own transaction cap, sellCargoInLots()
   * selling a mined load in chunks — leaves cargo to be sold first, which is shouldRetire()'s job.
   */
  onShipActionDone(_token: number, primary: string | undefined, action: string | undefined, data: unknown): void {
    if (action !== "sell" || !primary) return;
    const units = (data as { cargo?: { units?: number } } | undefined)?.cargo?.units;
    if (units === 0) this.soldOut.add(primary);
  }

  /** Every ship seen to sell out since the last call, then forget them. */
  take(): string[] {
    const out = [...this.soldOut];
    this.soldOut.clear();
    return out;
  }
}

/**
 * The wind-down's own record, kept past the reset. The server log that would have said why most of the fleet was not retired on 2026-10-18 (26 scrapped of 239,
 * 215 hulls left at the reset) is in memory and was wiped by the reset restart, so the decisions are written to fleet_events, which survives (ops timeline,
 * kinds retire_dispatched, retire_failed, wind_down_summary).
 */
/** A failure message with the system and waypoint names taken out, so the same reason on different ships counts as one. */
export function retireReasonKey(message: string): string {
  return message.replace(/X1-[A-Z0-9]+(?:-[A-Z0-9]+)?/g, "<place>").replace(/\d+/g, "#").slice(0, 120);
}
export interface RetireStats { dispatched: number; failed: number; reasons: ReadonlyMap<string, number> }
/** One line for the timeline: where the wind-down stands. */
export function windDownSummary(s: RetireStats & { queued: number; remaining: number; flying: number; minutesLeft: number }): string {
  const top = [...s.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}x ${k}`).join("; ") || "none";
  return `wind-down, ${Math.max(0, Math.round(s.minutesLeft))} min to reset: ${s.remaining} non-trader hulls left, ${s.queued} queued, ${s.flying} flying to a yard, ${s.dispatched} sent, ${s.failed} refused (top reasons: ${top})`;
}
