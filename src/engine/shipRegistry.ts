import type { Store } from "../db/store.js";

/**
 * Greenfield Phase 4: a single source of truth for "who owns this ship right
 * now" — the design doc's diagnosis is that straders' engine has eight
 * independent mechanisms (role maps, the dispatcher, mission carrier
 * assignment, warehouse designation, keeper stationing, manual
 * hold/mine-pin flags, ...) that can each think they control a ship, with
 * nothing arbitrating between them. ShipRegistry is that arbiter: one claim
 * per ship, ranked by a fixed precedence, enforced in one place instead of
 * trusted to every call site separately.
 *
 * Precedence, highest to lowest: operator (a human's explicit dispatch/hold)
 * > mission (a construction-supply carrier assignment) > warehouse (the
 * designated warehouse ship) > keeper (a stationed market keeper) > auto
 * (the coordinator's own role assignment — the default for everything else).
 * A claim from a stronger owner always succeeds over a weaker one's claim;
 * a weaker owner's claim against a stronger one's is rejected unless the
 * caller explicitly passes `preempt: true`. The same owner re-claiming
 * (updating role/intent, e.g. the coordinator reassigning an auto ship's
 * role) always succeeds and keeps the claim's original `since`.
 *
 * This phase's actual integration into fleet.ts (see FleetManager.syncShipClaims)
 * is a MIRROR, not a gate: it derives each ship's current owner/role from the
 * same role maps/dispatcher/mission/warehouse state fleet.ts already
 * maintains and writes that as this ship's claim, once per coordinator tick
 * — exactly the design doc's own "dual-write" period (see its Migration
 * Path section), where the old mechanisms stay authoritative and the
 * registry is populated in parallel, not yet the thing any dispatch
 * decision actually checks before acting. That's deliberately conservative,
 * not a shortcut: cutting fleet.ts's dozen mutation call sites over to
 * calling `claim()`/`release()` as their actual gate is real, separate
 * surgery the design doc itself scopes as a later step once the registry
 * has run stable in parallel — see README's Greenfield section.
 */

// "rescue" added for Phase 2 of docs/ship-control-state-audit.md: a fuel
// tender is a fleet subsystem driving a ship via raw API calls exactly like
// a mission carrier, and it never claimed through the registry at all before
// this — meaning syncShipClaims()'s once-per-tick mirror had no way to know
// a suspended tender wasn't just "auto" (free), and would relabel it that
// way on the very next tick, making availableFor() treat it as claimable by
// a mission or keeper. Ranked above mission (a stranded ship is more urgent
// than delaying a delivery) but below operator (an explicit hold always
// wins, same rule as everywhere else).
// "repair" added alongside the ship-condition feature: a critically low-
// condition ship gets actively diverted to a shipyard the same way a
// stranded ship gets a rescue tender — same reasoning as "rescue" above,
// this is a fleet subsystem driving a ship via raw API calls, so it must
// claim through the registry or syncShipClaims() would relabel it "auto"
// mid-dispatch. Ranked just below rescue (0 fuel is more urgent than bad
// condition — a stranded ship can't act at all, a low-condition one still
// can) but above mission, since a mission shouldn't be able to grab a ship
// that's actively being routed to get fixed.
export type Owner = "operator" | "rescue" | "repair" | "mission" | "warehouse" | "keeper" | "auto";
export type ShipRole = "miner" | "trader" | "surveyor" | "tour" | "keeper" | "scout" | "siphoner" | "warehouse" | "idle";

export interface Claim {
  shipSymbol: string;
  owner: Owner;
  role: ShipRole;
  intent: Record<string, unknown>;
  since: string; // ISO
}

const PRECEDENCE: Record<Owner, number> = { operator: 0, rescue: 1, repair: 2, mission: 3, warehouse: 4, keeper: 5, auto: 6 };

export class ShipRegistry {
  private claims = new Map<string, Claim>();

  /**
   * Claim a ship for `owner`. Succeeds and returns the new claim when: the
   * ship has no existing claim, the existing claim is already `owner`'s (an
   * update, not a takeover — `since` is preserved), the existing owner has
   * equal-or-weaker precedence than `owner`, or `opts.preempt` is true.
   * Otherwise returns `undefined` and leaves the existing claim untouched.
   */
  claim(shipSymbol: string, owner: Owner, role: ShipRole, intent: Record<string, unknown> = {}, opts?: { preempt?: boolean }): Claim | undefined {
    const existing = this.claims.get(shipSymbol);
    if (existing && existing.owner !== owner && PRECEDENCE[owner] > PRECEDENCE[existing.owner] && !opts?.preempt) {
      return undefined;
    }
    const rec: Claim = { shipSymbol, owner, role, intent, since: existing?.owner === owner ? existing.since : new Date().toISOString() };
    this.claims.set(shipSymbol, rec);
    return rec;
  }

  /** Release `shipSymbol`, but only if it's currently claimed by `owner` — releasing someone else's claim is a no-op. */
  release(shipSymbol: string, owner: Owner): void {
    const existing = this.claims.get(shipSymbol);
    if (existing && existing.owner === owner) this.claims.delete(shipSymbol);
  }

  ownerOf(shipSymbol: string): Claim | undefined {
    return this.claims.get(shipSymbol);
  }

  /** Every currently-tracked ship `forOwner` could successfully claim right now (unclaimed-by-anything-stronger). */
  available(forOwner: Owner): string[] {
    const rank = PRECEDENCE[forOwner];
    return [...this.claims.values()].filter((c) => PRECEDENCE[c.owner] >= rank).map((c) => c.shipSymbol);
  }

  size(): number {
    return this.claims.size;
  }

  async loadAllClaims(tenantId: string, store: Store): Promise<void> {
    this.claims.clear();
    // ClaimRow.role is a plain string at the storage boundary (it's whatever
    // fleet.ts's own role strings are — "miner", "idle", etc.); this class's
    // own claim() call sites are the only ones that ever write it, and they
    // only ever pass a real ShipRole, so this cast just re-asserts that at
    // the read side of the round-trip.
    for (const row of await store.getAllClaims(tenantId)) this.claims.set(row.shipSymbol, row as Claim);
  }

  /** Writes every currently-tracked claim. Not dirty-tracked (same simplification as syncShipStates/syncShipManifests) — see the class doc comment. */
  async persistDirtyState(tenantId: string, store: Store): Promise<void> {
    for (const claim of this.claims.values()) await store.recordClaim(tenantId, claim);
  }
}
