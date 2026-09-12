import type { Store } from "../db/store.js";

/**
 * Operator approval gate: a small number of consequential, engine-initiated
 * decisions (right now: an autonomous ship purchase — see
 * FleetManager.maybeBuyShip()) propose themselves here and wait for a human
 * decision instead of executing outright, without ever blocking the fleet
 * if nobody's watching.
 *
 * Deliberately DB-polled, not an in-memory await: this app restarts on
 * every deploy (sometimes several times an hour), and a Promise held across
 * that would just be lost — the engine would silently re-decide from
 * scratch with no memory an approval was ever asked for. `request()` is
 * instead meant to be called again on every normal tick, the same way
 * `proposeScrapGoals()`/`proposeOperatorHolds()` re-propose their own
 * persisted state each cycle rather than latching an in-memory decision.
 */
export type ApprovalDecision = boolean | undefined; // true=approved, false=denied, undefined=still waiting

export interface ApprovalRequest {
  shipSymbol?: string;
  detail: string;
  cost?: number;
  /** How long an unanswered request waits before ApprovalGate decides on
   *  its own — see `onTimeout`. */
  timeoutMs: number;
  /** What happens if nobody decides before `timeoutMs` elapses. "approve"
   *  matches today's fully-automatic behavior for a fleet nobody's
   *  watching; "deny" is the safer default for anything hard to undo. */
  onTimeout: "approve" | "deny";
  /** How long a denial holds before this `kind` is allowed to ask again —
   *  without this, the very next tick would just re-propose the same
   *  decision and ask again immediately. Defaults to 15 minutes. */
  denyCooldownMs?: number;
}

const DEFAULT_DENY_COOLDOWN_MS = 15 * 60_000;

export class ApprovalGate {
  constructor(
    private readonly store: Store | undefined,
    private readonly tenantId: string | undefined,
    private readonly log: (msg: string) => void,
  ) {}

  /**
   * Ask whether `kind` may proceed right now. Returns `true`/`false` once
   * decided (by the operator, or by the timeout policy), or `undefined`
   * while still waiting — the caller should treat `undefined` as "do
   * nothing this tick, ask again next time" (exactly like any other
   * propose-and-wait check in this engine).
   *
   * No persistence configured (store/tenantId missing — tests, or a tenant
   * mid-boot) behaves as if every request were pre-approved, matching the
   * engine's behavior before this gate existed rather than freezing.
   */
  async request(kind: string, opts: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.store || !this.tenantId) return true;
    const store = this.store;
    const tenantId = this.tenantId;
    const now = Date.now();

    // Anything ApprovalGate still owes a reaction to: either awaiting a
    // decision, or decided by the operator on the dashboard but not yet
    // picked up here.
    const row = await store.getUnconsumedApproval(tenantId, kind);
    if (row) {
      if (row.status === "pending") {
        if (new Date(row.expiresAt).getTime() > now) return undefined; // still waiting on a decision
        const approved = opts.onTimeout === "approve";
        await store.decideApproval(tenantId, row.id, approved ? "auto_approved" : "expired", true);
        this.log(`approval ${kind} timed out with no operator decision — ${approved ? "auto-approved" : "auto-denied"}: ${row.detail}`);
        return approved;
      }
      // The operator already decided (approved/denied) on the dashboard;
      // this is the engine's first chance to act on it.
      await store.consumeApproval(tenantId, row.id);
      const approved = row.status === "approved" || row.status === "auto_approved";
      this.log(`approval ${kind} ${approved ? "approved" : "denied"} by operator: ${row.detail}`);
      return approved;
    }

    const last = await store.getLastDecidedApproval(tenantId, kind);
    if (last?.status === "denied" && last.decidedAt) {
      const cooldown = opts.denyCooldownMs ?? DEFAULT_DENY_COOLDOWN_MS;
      if (now - new Date(last.decidedAt).getTime() < cooldown) return false; // still in the "no" window
    }

    await store.createPendingApproval(tenantId, kind, opts.shipSymbol, opts.detail, opts.cost, new Date(now + opts.timeoutMs).toISOString());
    this.log(`approval requested: ${kind} — ${opts.detail}`);
    return undefined;
  }
}
