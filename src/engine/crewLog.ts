import type { ActivityEntry } from "../db/store.js";

/**
 * What earns a hull a log entry, and which ones get written.
 *
 * The whole cost and quality argument for the crew log lives in this file.
 * Logging every hull on a timer is both the expensive option and the boring
 * one: eighteen crewed hulls on the captain's-log cadence is ~108 model
 * calls an hour against the fleet log's six, and most of those entries would
 * say "I navigated to A3."
 *
 * So a hull logs when something happened *to it*, not when a clock ticks.
 * That makes every entry about something, and it staggers the feed for free
 * because the events are already staggered.
 *
 * Both functions here are pure. That is deliberate: "how often would this
 * fire, and about what" is the question worth answering before any tokens
 * are spent, and a pure function can answer it against a real activity
 * history with no model, no database and no fleet.
 */

/** A hull, as much of it as this file needs. */
export interface CrewShip {
  symbol: string;
  crew?: { current?: number; capacity?: number; morale?: number };
  fuel?: { current?: number; capacity?: number };
  /** Worst component condition, 0-100. */
  condition?: number;
  nav?: { systemSymbol?: string; waypointSymbol?: string; status?: string };
  stranded?: boolean;
}

export type TriggerKind =
  | "stranded"
  | "condition"
  | "fuel"
  | "windfall"
  | "loss"
  | "morale"
  | "arrival"
  | "haul";

export interface CrewEvent {
  shipSymbol: string;
  kind: TriggerKind;
  /** 0-100. Higher wins a scarce budget slot. */
  notability: number;
  /** One line of ground truth. Every generated entry must be about this. */
  detail: string;
  /** ISO timestamp of the underlying event. */
  timestamp: string;
}

/** A crewed hull has a captain. A probe does not. */
export function isCrewed(ship: CrewShip): boolean {
  return (ship.crew?.current ?? 0) > 0;
}

const LOW_FUEL_PCT = 20;
const POOR_CONDITION_PCT = 50;
const LOW_MORALE = 40;

/**
 * Everything the crewed fleet could currently write about, most notable
 * first.
 *
 * `knownSystems` is the set of systems a hull has already logged from, so
 * arriving somewhere genuinely new reads as an event and the fiftieth
 * docking at the home station does not.
 */
export function detectCrewEvents(
  ships: CrewShip[],
  activity: ActivityEntry[],
  opts: { knownSystems?: Map<string, Set<string>>; windfallCredits?: number } = {},
): CrewEvent[] {
  const known = opts.knownSystems ?? new Map<string, Set<string>>();
  const events: CrewEvent[] = [];
  const crewed = new Map(ships.filter(isCrewed).map((s) => [s.symbol, s]));
  const now = new Date().toISOString();

  // ── state-derived: the hull's own condition right now ──────────
  for (const ship of crewed.values()) {
    if (ship.stranded) {
      events.push({
        shipSymbol: ship.symbol, kind: "stranded", notability: 100, timestamp: now,
        detail: `stranded at ${ship.nav?.waypointSymbol ?? "an unknown waypoint"} with no way to move`,
      });
      continue; // A stranded hull has one thing on its mind.
    }
    const condition = ship.condition;
    if (condition !== undefined && condition < POOR_CONDITION_PCT) {
      events.push({
        shipSymbol: ship.symbol, kind: "condition", timestamp: now,
        notability: 60 + Math.round((POOR_CONDITION_PCT - condition) / 2),
        detail: `worst component down to ${condition}%`,
      });
    }
    const cap = ship.fuel?.capacity ?? 0;
    const cur = ship.fuel?.current ?? 0;
    if (cap > 0) {
      const pct = (cur / cap) * 100;
      if (pct < LOW_FUEL_PCT) {
        events.push({
          shipSymbol: ship.symbol, kind: "fuel", timestamp: now,
          notability: 55 + Math.round(LOW_FUEL_PCT - pct),
          detail: `fuel at ${cur}/${cap}`,
        });
      }
    }
    const morale = ship.crew?.morale;
    if (morale !== undefined && morale < LOW_MORALE) {
      events.push({
        shipSymbol: ship.symbol, kind: "morale", timestamp: now,
        notability: 50 + (LOW_MORALE - morale),
        detail: `crew morale down to ${morale}`,
      });
    }
  }

  // ── activity-derived: what the hull actually did ───────────────
  // A windfall is relative to this fleet's own trading, not an absolute
  // figure: 40,000 credits is a great day for a starter fleet and noise for
  // a mature one, and a hardcoded threshold would go quiet exactly as the
  // fleet got interesting.
  const sells = activity.filter((a) => a.kind === "sell" && (a.credits ?? 0) > 0);
  const median = medianOf(sells.map((a) => a.credits ?? 0));
  const windfallAt = opts.windfallCredits ?? Math.max(median * 2, 1);

  for (const entry of activity) {
    const ship = crewed.get(entry.shipSymbol);
    if (!ship) continue; // uncrewed hulls have nobody to write it up
    const credits = entry.credits ?? 0;

    if (entry.kind === "sell" && credits >= windfallAt) {
      events.push({
        shipSymbol: ship.symbol, kind: "windfall", timestamp: entry.timestamp,
        notability: 70, detail: entry.detail,
      });
    } else if (entry.kind === "buy" && credits < 0 && Math.abs(credits) >= windfallAt) {
      events.push({
        shipSymbol: ship.symbol, kind: "loss", timestamp: entry.timestamp,
        notability: 45, detail: entry.detail,
      });
    } else if (entry.kind === "extract") {
      events.push({
        shipSymbol: ship.symbol, kind: "haul", timestamp: entry.timestamp,
        notability: 25, detail: entry.detail,
      });
    } else if (entry.kind === "navigate") {
      const system = ship.nav?.systemSymbol;
      const seen = system ? known.get(ship.symbol)?.has(system) : true;
      if (system && !seen) {
        events.push({
          shipSymbol: ship.symbol, kind: "arrival", timestamp: entry.timestamp,
          notability: 65, detail: `first arrival in ${system} — ${entry.detail}`,
        });
      }
      // A routine hop is not an event. This is the branch that keeps the
      // feed from being a movement log with adjectives.
    }
  }

  return events.sort((a, b) => b.notability - a.notability);
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface SelectOptions {
  /** Entries permitted this pass. Zero means the feature is off. */
  budget: number;
  /** shipSymbol -> ms since that hull last logged. Absent means never. */
  lastLoggedAt?: Map<string, number>;
  /** A hull may not log twice inside this window. */
  perShipCooldownMs?: number;
  now?: number;
}

const PER_SHIP_COOLDOWN_MS = 20 * 60_000;

/**
 * Choose which events actually get written.
 *
 * Three rules, in order:
 *
 *  1. One entry per hull per pass. A ship that is stranded *and* out of fuel
 *     *and* miserable has one story, not three.
 *  2. A hull that logged recently stays quiet, however loud its telemetry —
 *     otherwise the ship in the worst trouble monopolises the whole feed and
 *     the other seventeen never appear.
 *  3. Most notable first, up to the budget.
 *
 * Rule 2 is why the budget alone is not enough. A budget bounds the *cost*;
 * the cooldown is what keeps the feed a fleet's voice rather than one hull's.
 */
export function selectForLogging(events: CrewEvent[], opts: SelectOptions): CrewEvent[] {
  if (opts.budget <= 0) return [];
  const now = opts.now ?? Date.now();
  const cooldown = opts.perShipCooldownMs ?? PER_SHIP_COOLDOWN_MS;
  const chosen: CrewEvent[] = [];
  const used = new Set<string>();

  for (const event of events) {
    if (chosen.length >= opts.budget) break;
    if (used.has(event.shipSymbol)) continue;
    const last = opts.lastLoggedAt?.get(event.shipSymbol);
    if (last !== undefined && now - last < cooldown) continue;
    used.add(event.shipSymbol);
    chosen.push(event);
  }
  return chosen;
}
