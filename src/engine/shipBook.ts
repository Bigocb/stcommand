/**
 * Ship book: answer a ship's step-start read from what the fleet already knows, instead of `GET /my/ships/:id`.
 *
 * Single-ship reads were about 15 calls a minute at 183 ships (2026-10-15), the largest use of the game-API budget after
 * market snapshots. Most of them told us nothing new: the game changes a ship only when we act on it, and almost every
 * action's response carries the parts it changed (`nav`, `fuel`, `cargo`, `cooldown`). The only changes that happen on
 * their own are a transit arriving and a cooldown running out, and both are fixed by times we already hold.
 *
 * So the book keeps each ship's last full read, folds every action response into it, and marks the ship unknown when an
 * action's effect can't be seen (a failed or unanswered request, an action whose response carries none of those parts,
 * the target of a transfer). A clean copy younger than the policy's age limit, advanced to now, stands in for a read.
 *
 * Two modes, set by policy:
 * - **shadow** (always on): every real read is first compared with what the book would have served, and the agreement
 *   is counted. It changes nothing.
 * - **serve** (doctrine clause `shipBook`, off by default): `serve()` returns the copy, and the read is skipped.
 *
 * Pure apart from the clock, which is injected. The API client feeds it (see Client.observeShip); ShipProxy.refresh()
 * asks it through SpaceTradersAPI.bookedShip().
 */

import type { ShipObserver } from "./shipSnapshots.js";

export interface ShipBookPolicy {
  serve: boolean;
  /** Oldest full read a copy may rest on. Every ship still gets a real read at least this often. */
  maxAgeMs: number;
}

export const DEFAULT_SHIP_BOOK_POLICY: ShipBookPolicy = { serve: false, maxAgeMs: 5 * 60_000 };

/** The parts of a ship the book tracks. Everything else rides along from the last full read. */
const PARTS = ["nav", "fuel", "cargo", "cooldown"] as const;

/** Action paths whose response carries every part the action changes (or changes none). Anything else marks the ship unknown. */
const KNOWN_ACTIONS = new Set([
  "orbit", "dock", "navigate", "warp", "jump", "refuel", "purchase", "sell", "extract", "extract/survey", "siphon",
  "survey", "jettison", "transfer", "refine", "nav", "chart", "scan/ships", "scan/systems", "scan/waypoints",
  "negotiate/contract",
  // Contract delivery and construction supply (see shipsTouched): they return the ship's cargo and change nothing else.
  "deliver-cargo",
]);

interface Entry {
  ship: Record<string, unknown>;
  /** When the full read under this copy was taken. */
  readAt: number;
  /** False while an action's effect is unknown. */
  clean: boolean;
  /** Sequence number of the latest action started on this ship. */
  lastStart: number;
}

export interface ShipBookSummary {
  reads: number;
  /** Reads the book could have answered. */
  servable: number;
  /** Of those, how many matched the fresh read on status, waypoint, fuel, cargo and cooldown. */
  matched: number;
  mismatches: Record<string, number>;
  /** Reads the book could not have answered, by reason. */
  unservable: Record<string, number>;
  /** Reads skipped because the book served them. */
  served: number;
}

function emptySummary(): ShipBookSummary {
  return { reads: 0, servable: 0, matched: 0, mismatches: {}, unservable: {}, served: 0 };
}

type Nav = { status?: string; waypointSymbol?: string; systemSymbol?: string; route?: { arrival?: string; destination?: { symbol?: string; systemSymbol?: string } } };
type Cooldown = { remainingSeconds?: number; totalSeconds?: number; expiration?: string };

/** A copy as it stands at `now`: a transit whose arrival has passed is in orbit at its destination, an expired cooldown is clear. */
export function advanceShip<T extends Record<string, unknown>>(ship: T, now: number): T {
  const out: Record<string, unknown> = { ...ship };
  const nav = ship.nav as Nav | undefined;
  if (nav?.status === "IN_TRANSIT" && nav.route?.arrival && Date.parse(nav.route.arrival) <= now) {
    out.nav = {
      ...nav,
      status: "IN_ORBIT",
      waypointSymbol: nav.route.destination?.symbol ?? nav.waypointSymbol,
      systemSymbol: nav.route.destination?.systemSymbol ?? nav.systemSymbol,
    };
  }
  const cd = ship.cooldown as Cooldown | undefined;
  if (cd?.expiration) {
    const left = Math.max(0, Math.ceil((Date.parse(cd.expiration) - now) / 1000));
    out.cooldown = { ...cd, remainingSeconds: left };
  }
  return out as T;
}

/** The fields a step-start read is used for, for comparing a copy with a fresh read. */
function fingerprint(ship: Record<string, unknown> | undefined): Record<string, unknown> {
  const nav = ship?.nav as Nav | undefined;
  const cargo = ship?.cargo as { units?: number; inventory?: { symbol: string; units: number }[] } | undefined;
  const cd = ship?.cooldown as Cooldown | undefined;
  return {
    status: nav?.status,
    waypoint: nav?.waypointSymbol,
    fuel: (ship?.fuel as { current?: number } | undefined)?.current,
    cargo: `${cargo?.units ?? "?"}:${(cargo?.inventory ?? []).map((i) => `${i.symbol}=${i.units}`).sort().join(",")}`,
    // Within two seconds: a fresh read rounds the remaining time.
    cooldown: (cd?.remainingSeconds ?? 0) > 0 ? Math.round(Date.parse(cd?.expiration ?? "") / 2000) : 0,
  };
}

export class ShipBook implements ShipObserver {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private stats = emptySummary();
  private policy: ShipBookPolicy = DEFAULT_SHIP_BOOK_POLICY;

  constructor(private readonly now: () => number = Date.now) {}

  setPolicy(policy: ShipBookPolicy): void {
    this.policy = policy;
  }

  /** Why the book can't answer for this ship now, or undefined when it can. */
  private unservableReason(symbol: string, now: number): string | undefined {
    const e = this.entries.get(symbol);
    if (!e) return "no copy";
    if (!e.clean) return "unknown effect";
    if (now - e.readAt > this.policy.maxAgeMs) return "too old";
    return undefined;
  }

  /** The ship as the book knows it, when serving is on and the copy can be trusted. Counts the read it saves. */
  serve(symbol: string): Record<string, unknown> | undefined {
    if (!this.policy.serve) return undefined;
    const now = this.now();
    if (this.unservableReason(symbol, now) !== undefined) return undefined;
    this.stats.served += 1;
    // A copy, so a caller that edits its ship in place can't edit the book.
    return structuredClone(advanceShip(this.entries.get(symbol)!.ship, now));
  }

  /** A full single-ship read: compare it with what the book would have served (shadow), then keep it. */
  onShipRead(symbol: string, ship: unknown): void {
    if (!ship || typeof ship !== "object") return;
    const now = this.now();
    this.stats.reads += 1;
    const reason = this.unservableReason(symbol, now);
    if (reason) {
      this.stats.unservable[reason] = (this.stats.unservable[reason] ?? 0) + 1;
    } else {
      this.stats.servable += 1;
      const was = fingerprint(advanceShip(this.entries.get(symbol)!.ship, now));
      const is = fingerprint(ship as Record<string, unknown>);
      const missed = Object.keys(is).filter((k) => was[k] !== is[k]);
      if (missed.length === 0) this.stats.matched += 1;
      for (const k of missed) this.stats.mismatches[k] = (this.stats.mismatches[k] ?? 0) + 1;
    }
    const prev = this.entries.get(symbol);
    this.entries.set(symbol, { ship: structuredClone(ship) as Record<string, unknown>, readAt: now, clean: true, lastStart: prev?.lastStart ?? 0 });
  }

  /** Kept for the observer interface; the start/done pair below carries what the book needs. */
  onShipAction(): void {}

  /** An action is about to be sent for these ships: their state is unknown until it answers. Returns a token for onShipActionDone. */
  onShipActionStart(symbols: readonly string[]): number {
    const token = ++this.seq;
    for (const s of symbols) {
      const e = this.entries.get(s);
      if (e) {
        e.clean = false;
        e.lastStart = token;
      }
    }
    return token;
  }

  /**
   * The action answered. Fold the parts its response carries into `primary`'s copy; it is clean again only if the
   * action is one whose response shows all it changed, and no later action on the ship has started since. `others`
   * (a transfer's receiving ship) stay unknown until their next read.
   */
  onShipActionDone(token: number, primary: string | undefined, action: string | undefined, data: unknown): void {
    if (!primary) return;
    const e = this.entries.get(primary);
    if (!e) return;
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const ship = { ...e.ship };
    for (const p of PARTS) if (d[p] && typeof d[p] === "object") ship[p] = structuredClone(d[p]);
    e.ship = ship;
    if (e.lastStart === token && action !== undefined && KNOWN_ACTIONS.has(action)) e.clean = true;
  }

  /** The counts since the last call, then start over. */
  takeSummary(): ShipBookSummary {
    const out = this.stats;
    this.stats = emptySummary();
    return out;
  }
}

/** One log line for a summary. */
export function describeShipBookSummary(s: ShipBookSummary, serving: boolean): string {
  const pct = s.servable ? Math.round((s.matched / s.servable) * 100) : 0;
  const misses = Object.entries(s.mismatches).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const why = Object.entries(s.unservable).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  return `ship book (${serving ? "serving" : "shadow"}): ${s.reads} reads · ${s.servable} could have been served, ${s.matched} matched (${pct}%) · mismatches: ${misses} · not servable: ${why} · ${s.served} reads saved`;
}

/** Where an action request touches ships: the ship in its path (or the body's shipSymbol off a ship path), any other ship it names, and the action. */
export function shipsTouched(method: string, path: string, body: unknown): { primary?: string; others: string[]; action?: string } {
  if (method === "GET") return { others: [] };
  const named = (body as { shipSymbol?: unknown } | undefined)?.shipSymbol;
  const bodyShip = typeof named === "string" ? named : undefined;
  const m = /^\/my\/ships\/([^/?]+)\/([^?]+)/.exec(path);
  if (m) {
    const primary = m[1]!;
    return { primary, others: bodyShip && bodyShip !== primary ? [bodyShip] : [], action: m[2] };
  }
  // Contract delivery and construction supply name the ship in the body and return its cargo.
  if (bodyShip && (/^\/my\/contracts\/[^/]+\/deliver$/.test(path) || /\/construction\/supply$/.test(path))) {
    return { primary: bodyShip, others: [], action: "deliver-cargo" };
  }
  return bodyShip ? { others: [bodyShip] } : { others: [] };
}
