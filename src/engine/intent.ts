/**
 * Desired state, one per ship — `docs/control-plane-data-plane.md` §4.
 *
 * This is the Pod spec of the fleet. Controllers propose what they each want
 * a ship to be doing; the arbiter resolves competing proposals down to
 * exactly one, by priority; the ship's executor reads only the winner.
 *
 * The rule this exists to enforce is "exactly one owner per ship". Without
 * it, two subsystems drive the same hull at once and fight: the repair
 * diverter claimed a ship while its tour agent kept flying it, so the ship
 * was released and re-diverted every few seconds, all day, wearing itself
 * down further on each cycle. Ownership as a claim/release protocol did not
 * prevent that because nothing arbitrated between the two claimants — they
 * simply took turns.
 */

/** 0 rescue · 1 repair · 2 earn · 3 explore and upkeep · 4 idle. Lower wins. */
export type IntentPriority = 0 | 1 | 2 | 3 | 4;

export type Goal =
  /** Fly the route the dispatcher assigned; the trader agent owns the detail. */
  | { kind: "trade" }
  | { kind: "mine" }
  | { kind: "siphon" }
  | { kind: "survey" }
  /** Refresh market prices on a rotation. */
  | { kind: "tour" }
  /** Sit at one market keeping its prices fresh. */
  | { kind: "keep"; waypoint: string }
  /** Reach and chart one system. One system per intent, replaced on arrival. */
  | { kind: "explore"; system: string }
  | { kind: "repair"; yard: string }
  /** Carry fuel to a stranded ship. */
  | { kind: "tender"; to: string }
  /** Operator hold, or nothing worth doing. */
  | { kind: "hold"; waypoint?: string };

/**
 * The safety rules a ship enforces locally, without asking. These travel with
 * the intent rather than living in the agent so that the control plane can
 * tighten them per ship (a nearly-worn hull gets a higher condition floor)
 * without the data plane growing a policy of its own.
 */
export interface IntentPolicy {
  /** Never leave a market below this much fuel. */
  fuelReserve: number;
  /** Modes this ship may fly. DRIFT is opt-in: it turns a minutes-long leg
   *  into an hours-long one and has stranded real value in transit. */
  flightModes: ("CRUISE" | "BURN" | "DRIFT")[];
  /** Never depart a shipyard below this condition. */
  conditionFloor: number;
}

export const DEFAULT_POLICY: IntentPolicy = {
  fuelReserve: 5,
  flightModes: ["CRUISE", "BURN"],
  conditionFloor: 0.5,
};

export interface ShipIntent {
  ship: string;
  /** Bumped only when the goal materially changes — see IntentBoard.commit(). */
  version: number;
  priority: IntentPriority;
  goal: Goal;
  policy: IntentPolicy;
  /** Why this ship is doing this, in the operator's words. Surfaced verbatim. */
  reason: string;
  /** Which controller proposed it, for attribution on the dashboard. */
  source: string;
}

export interface IntentProposal {
  ship: string;
  priority: IntentPriority;
  goal: Goal;
  reason: string;
  source: string;
  policy?: Partial<IntentPolicy>;
}

/** True when two goals mean the same work, so the version need not move. */
export function sameGoal(a: Goal, b: Goal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "keep" && b.kind === "keep") return a.waypoint === b.waypoint;
  if (a.kind === "explore" && b.kind === "explore") return a.system === b.system;
  if (a.kind === "repair" && b.kind === "repair") return a.yard === b.yard;
  if (a.kind === "tender" && b.kind === "tender") return a.to === b.to;
  if (a.kind === "hold" && b.kind === "hold") return a.waypoint === b.waypoint;
  return true;
}

/**
 * Goals the ship's own agent cannot carry out, because the fleet drives them
 * directly: a repair diversion, a fuel ferry, an operator hold.
 *
 * An agent that sees one of these must stand down. Before agents read the
 * board at all, ownership was enforced only by `suspend()` — a second,
 * parallel mechanism whose ordering the agent never checked — which is how
 * the repair diverter and the tour agent ended up alternately driving the
 * same hull every few seconds for a day. Standing down on the intent itself
 * removes the race rather than sequencing it.
 */
export function drivenByFleet(goal: Goal): boolean {
  // `explore` belongs here for now because exploration really is flown by the
  // fleet (autoExplore launches exploreSystem, which jumps and tours the ship
  // itself). When the executor learns to fly an explore goal on its own task,
  // this is the line that changes.
  //
  // Anything listed here MUST be cleared when the fleet finishes with the
  // ship — see FleetManager's forgetIntent() calls — or the agent stands down
  // against a stale intent and the hull never moves again.
  return goal.kind === "repair" || goal.kind === "tender" || goal.kind === "hold" || goal.kind === "explore";
}

/**
 * Why an agent is standing down, in the operator's words, or undefined when
 * it is free to act. Shared by every agent so the log line reads the same
 * whichever role hits it.
 */
export function standDownReason(intent: ShipIntent | undefined): string | undefined {
  if (!intent || !drivenByFleet(intent.goal)) return undefined;
  const target =
    intent.goal.kind === "repair" ? ` → ${intent.goal.yard}`
    : intent.goal.kind === "tender" ? ` → ${intent.goal.to}`
    : intent.goal.kind === "explore" ? ` → ${intent.goal.system}`
    : intent.goal.kind === "hold" && intent.goal.waypoint ? ` at ${intent.goal.waypoint}`
    : "";
  return `${intent.goal.kind}${target} (${intent.source}): ${intent.reason}`;
}

/** Goals a ship should be allowed to finish rather than be switched off mid-way. */
function isEarning(goal: Goal): boolean {
  return goal.kind === "trade" || goal.kind === "mine" || goal.kind === "siphon";
}

export interface CommitOptions {
  /**
   * Whether a ship is mid-task in a way that costs real money to interrupt —
   * cargo in the hold, a leg half flown. A busy ship keeps an equal-or-lower
   * priority earning goal instead of being churned onto a new one, which is
   * the same reason RouteDispatcher carries a busy trader's assignment
   * forward rather than reassigning it every cycle.
   */
  busy?: (ship: string) => boolean;
  /** Injectable for tests. */
  now?: () => number;
}

export interface IntentChange {
  ship: string;
  from?: ShipIntent;
  to: ShipIntent;
}

/**
 * Collects proposals and resolves them. One instance per tenant, living
 * beside the registry: controllers write, the executor reads.
 */
export class IntentBoard {
  private readonly committed = new Map<string, ShipIntent>();
  private proposals: IntentProposal[] = [];

  /** A controller's opinion about one ship. Losing a proposal is normal. */
  propose(p: IntentProposal): void {
    this.proposals.push(p);
  }

  /**
   * Resolve this pass's proposals into at most one intent per ship.
   *
   * Highest priority wins. Ties go to the first proposal, so controller order
   * is a deliberate tiebreak rather than an accident of Map iteration. A busy
   * ship keeps an earning goal it is already executing unless something
   * strictly more urgent (rescue, repair) preempts it — a preemption still
   * takes effect at the ship's next step boundary, since a transit already in
   * flight cannot be recalled.
   *
   * Returns only what actually changed, so callers can log and act on the
   * diff rather than re-deriving it.
   */
  commit(opts: CommitOptions = {}): IntentChange[] {
    const busy = opts.busy ?? (() => false);
    const byShip = new Map<string, IntentProposal>();
    for (const p of this.proposals) {
      const best = byShip.get(p.ship);
      if (!best || p.priority < best.priority) byShip.set(p.ship, p);
    }
    this.proposals = [];

    const changes: IntentChange[] = [];
    for (const [ship, winner] of byShip) {
      const current = this.committed.get(ship);

      if (current && busy(ship) && isEarning(current.goal) && winner.priority >= current.priority && !sameGoal(current.goal, winner.goal)) {
        // Mid-trip with cargo aboard: let it finish. Switching now strands
        // whatever it bought for the old route, and the churn meant
        // assignments never settled long enough to be flown.
        continue;
      }

      const policy: IntentPolicy = { ...DEFAULT_POLICY, ...(current?.policy ?? {}), ...(winner.policy ?? {}) };
      const unchanged =
        current !== undefined &&
        sameGoal(current.goal, winner.goal) &&
        current.priority === winner.priority &&
        current.reason === winner.reason;
      if (unchanged) continue;

      const next: ShipIntent = {
        ship,
        // The version tracks the *work*, so a re-proposal of the same goal
        // with a new reason does not look like a new assignment to anything
        // comparing desired against executing.
        version: current && sameGoal(current.goal, winner.goal) ? current.version : (current?.version ?? 0) + 1,
        priority: winner.priority,
        goal: winner.goal,
        policy,
        reason: winner.reason,
        source: winner.source,
      };
      this.committed.set(ship, next);
      changes.push({ ship, from: current, to: next });
    }
    return changes;
  }

  current(ship: string): ShipIntent | undefined {
    return this.committed.get(ship);
  }

  all(): ShipIntent[] {
    return [...this.committed.values()];
  }

  /** Drop a ship entirely — scrapped, or removed from the fleet. */
  forget(ship: string): void {
    this.committed.delete(ship);
    this.proposals = this.proposals.filter((p) => p.ship !== ship);
  }

  /** Pending proposals not yet committed, for diagnostics. */
  pending(): readonly IntentProposal[] {
    return this.proposals;
  }
}
