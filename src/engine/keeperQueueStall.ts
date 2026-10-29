/**
 * When an approved keeper purchase cannot run because none of our ships is at its shipyard, the keeper queue used to wait on it
 * for ever: the approval slot is one row per kind, so a request nobody can carry out blocked every other market's card (2026-10-29:
 * CK45-D44 sat approved with no ship at CK45-A2 and KX84, SF98 and the rest got nothing).
 *
 * This decides when such a request is let go, and which market is left alone afterwards so the queue does not ask for it again in
 * the same minute. Pure: times come in as arguments. Policy is data (a doctrine clause); grace 0 keeps the old behaviour.
 */
export interface StallPolicy {
  /** Minutes an approved request may wait for a ship at its yard before it is released. 0 = wait for ever (the old behaviour). */
  graceMin: number;
  /** Minutes the released market is left out of the queue before it may be asked for again. */
  cooldownMin: number;
}

export const DEFAULT_STALL_POLICY: StallPolicy = { graceMin: 0, cooldownMin: 120 };

/** Has a request that first found no ship at its yard at `sinceMs` waited long enough to be released? */
export function shouldRelease(sinceMs: number, nowMs: number, policy: StallPolicy): boolean {
  return policy.graceMin > 0 && nowMs - sinceMs >= policy.graceMin * 60_000;
}

/** Is this market still being left alone after its request was released? */
export function inCooldown(untilMs: number | undefined, nowMs: number): boolean {
  return untilMs !== undefined && untilMs > nowMs;
}

/** One line for the log. */
export function releaseReason(market: string, yard: string, waitedMin: number, policy: StallPolicy): string {
  return `released the approved keeper request for ${market}: no ship of ours was at ${yard} after ${Math.round(waitedMin)} min, and it was blocking every other market. ${market} is left out of the queue for ${policy.cooldownMin} min, or until a ship docks at ${yard}`;
}

/**
 * Markets in systems where one of our ships is already at a keeper-hull yard come first, the rest keep their order behind them.
 * A card for a market whose yard has no ship of ours can only be bought once a ship happens to dock there, and until then it holds
 * the queue's single slot (2026-10-29: approved cards for PK42-A2 and DQ39-C14B held the slot while CK45, where THEO-AA sat at the
 * yard, waited for its cards). Nothing is dropped: with no serviceable market the list is unchanged.
 */
export function serviceableFirst(priority: readonly string[], serviceableSystems: ReadonlySet<string>): string[] {
  const systemOf = (m: string): string => m.slice(0, m.lastIndexOf("-"));
  return [...priority.filter((m) => serviceableSystems.has(systemOf(m))), ...priority.filter((m) => !serviceableSystems.has(systemOf(m)))];
}
