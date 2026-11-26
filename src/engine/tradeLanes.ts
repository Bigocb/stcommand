import { pickProxy } from "./lanePool.js";

/**
 * Trade lanes: a trader's own calls (buys, sells, docks, navigation, jumps, its market reads) leave through a proxy of its own
 * instead of the box's IP (issue #71, operator 2026-11-21: "there is room to add proxy lanes for the actual engine/trading").
 *
 * Why: SpaceTraders limits by source IP (measured 2026-11-02), and every write leaves from the box's one IP, capped at 105 calls a
 * minute. About 1.6 calls a minute per trader means that cap, not cash, decides how many traders the fleet can run. apiLanes.ts moves
 * only read-only background calls to proxies; this module adds the second class: everything an enrolled trader does while it runs
 * its own task.
 *
 * Rules:
 *  - Only ships in `ships` (the clause tradeLaneShips: the first N traders by symbol) and only calls made from that ship's own
 *    scheduler task (the caller passes the task's ship). Calls from fleet loops, the dispatcher or boot stay where they were.
 *  - Each ship keeps to one proxy (rendezvous hashing on the ship over the trade slots), so its calls stay in order on one IP; the
 *    next proxy in its own order takes over only while that one's breaker is open, and the box when every trade slot is out.
 *  - Trade slots are the proxies after the ones the read lanes use (`firstSlot`), so trading never queues behind keeper reads.
 *  - A write that fails at the network level through a proxy is NOT retried (retryAfterNetworkFailure): the game may have done it
 *    and only the answer was lost. The caller sees an error and the ship book marks the action's effect unknown, the same as any
 *    other unanswered action; the next read settles it. (10-08: a buy reported failed had executed, and a second buy followed.)
 *
 * Pure: no I/O, no clock. Clause off (enabled false) = every request takes the path it took before, which the tests pin.
 */

export interface TradeLanePolicy {
  enabled: boolean;
  /** Enrolled ships (exact symbols). */
  ships: ReadonlySet<string>;
  /** Index of the first proxy slot trade lanes may use; slots before it belong to the read lanes. */
  firstSlot: number;
}

export const TRADE_LANES_OFF: TradeLanePolicy = { enabled: false, ships: new Set(), firstSlot: 0 };

/** The first `count` traders by symbol: a stable set, so a ship does not move in and out as others are bought. */
export function enrolledShips(traders: Iterable<string>, count: number): Set<string> {
  const n = Math.max(0, Math.floor(count));
  return new Set([...traders].sort().slice(0, n));
}

/**
 * The ships whose own calls use the ship proxies: the first `traderCount` traders by symbol (clause tradeLaneShips) and, with the
 * clause shipLanes on, every other ship that runs its own task (keepers, tour ships, explorers, scouts). Pure.
 */
export function laneShips(traders: Iterable<string>, traderCount: number, others: Iterable<string>, othersOn: boolean): Set<string> {
  const ships = enrolledShips(traders, traderCount);
  if (othersOn) for (const s of others) ships.add(s);
  return ships;
}

export interface TradeLaneRequest {
  /** The ship whose task made the call; undefined for fleet loops, the dispatcher and boot. */
  ship: string | undefined;
  /** Limiter priority: 0 is boot and never moves. */
  priority: number;
}

export interface TradeLanePick {
  /** Index into the client's full slot list. */
  slotIndex: number;
  reason: string;
}

/**
 * The proxy slot for this request, or undefined to use the normal path (the read-lane rule, then the box).
 * `slotIds` is every configured slot in order; `allows(id)` is that slot's breaker.
 */
export function tradeLaneFor(req: TradeLaneRequest, policy: TradeLanePolicy, slotIds: readonly string[], allows: (id: string) => boolean): TradeLanePick | undefined {
  if (!policy.enabled || !req.ship || req.priority <= 0) return undefined;
  if (!policy.ships.has(req.ship)) return undefined;
  const first = Math.max(0, Math.floor(policy.firstSlot));
  const tradeIds = slotIds.slice(first);
  if (tradeIds.length === 0) return undefined;
  const pick = pickProxy(req.ship, tradeIds, allows);
  if (!pick) return undefined;
  return { slotIndex: first + tradeIds.indexOf(pick.id), reason: `trade lane ${pick.id}: ${pick.reason}` };
}

/** May a request that failed at the network level be sent again? Reads yes; a write that went through a trade lane no. */
export function retryAfterNetworkFailure(method: string, viaTradeLane: boolean): boolean {
  return method.toUpperCase() === "GET" || !viaTradeLane;
}

/**
 * May a request the proxy answered with 401/403/407 be sent again on the box? A read always (a refused read is harmless). A write
 * only on 407, which is the proxy refusing us before anything reached the game; a 401/403 could be the game's own answer.
 */
export function retryOnBoxAfterProxyRefusal(method: string, status: number, viaTradeLane: boolean): boolean {
  if (method.toUpperCase() === "GET" || !viaTradeLane) return true;
  return status === 407;
}
