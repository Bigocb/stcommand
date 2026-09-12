# Per-request API priority — threading Scheduler priority into the HTTP layer

Prompted by comparing stcommand's rate-limiting design against another
SpaceTraders app's API-governance approach. Not an incident writeup — no bug
has bitten us here yet. This documents a real gap found while comparing, so
the reasoning survives if we come back to it later.

## Current state (two disconnected priority systems)

stcommand already has two genuine priority mechanisms, and they don't talk
to each other:

1. **`Scheduler`/`SchedulerBudget`** (`src/engine/scheduler.ts`, landed per
   `docs/adr/0007-unified-scheduler-priority-queue.md`) — five Task tiers
   (0 rescue, 1 mission, 2 trade/siphon, 3 survey/keeper, 4 telemetry).
   `runOnce()` sorts ready Tasks by priority and admits them against a
   per-tenant token-bucket budget (`ratePerSec ?? 1.5, burst ?? 5`,
   scheduler.ts:116-118), highest priority first. This decides *which
   Task's `run()` gets to start this pass* — one Scheduler instance per
   tenant, no cross-tenant visibility.
2. **`RateLimiter`** (`src/core/client.ts:71-146`) — a real priority-queue
   token-bucket sitting in front of the actual `fetch()` calls.
   `acquire(priority = 1)` enqueues with lower-number-serviced-first and
   arrival-order tiebreak within a tier; `pump()` refills tokens and drains
   the queue. It's shared **across every tenant** via `tenantRegistry.ts:89`
   (`new RateLimiter(1.5, Math.ceil(1.5))`) — built specifically so a new
   tenant's boot doesn't starve behind established tenants' routine ticking.

The seam: `Client.priority` (client.ts:158) is a single mutable field per
tenant, flipped only twice — 0 during boot, 1 right after
(`setPriority()` calls at tenantRegistry.ts:275,528). Every ship and every
Task, once running, calls the API at the same priority (1) regardless of
whether the Scheduler admitted it as a priority-0 rescue or a priority-4
telemetry poll. A rescue Task and a telemetry Task, once both admitted,
queue at `RateLimiter.acquire()` as equals — rescue only got there first
because the Scheduler let it run sooner, not because the HTTP layer treats
it specially. `docs/control-plane-data-plane.md:307-311` already names this
seam ("that is the one place the kubelet analogy strains, since our nodes
share one 2 req/s pipe") without proposing a fix.

This mostly doesn't matter today because SchedulerBudget's admission rate is
tuned to roughly match RateLimiter's drain rate — in the common case nothing
piles up long enough for priority-within-the-queue to matter. It matters
when the shared limiter is actually contended: multiple tenants ticking at
once, or one tenant with an unusually deep backlog (e.g. many ships all
wanting a market refresh at once). That's exactly when a rescue call queuing
behind a pile of routine telemetry calls would cost real time.

## Proposed design

Map each Scheduler `Task.priority` (0-4) onto the existing `RateLimiter`
priority scale directly — no new taxonomy needed, since the tiers already
mean roughly the right thing ("how urgent is this unit of work").

1. **Thread priority through, not around, `Client`.** Add an optional
   `priority?: number` parameter to the handful of `Client` methods actually
   called from Task bodies that matter for urgency (navigate, dock, orbit,
   refuel, jump — the rescue-path calls), defaulting to `undefined` so every
   existing call site is unaffected. When set, pass it straight to
   `RateLimiter.acquire(priority)` instead of `this.priority`.
2. **Task carries its own priority down.** `Task.run()` already knows its
   own `priority` field (scheduler.ts). Give `Scheduler.runOnce()` a way to
   hand that value to the agent it's invoking — simplest is a
   `currentTaskPriority` set on the tenant's `Client` for the duration of
   that one `run()` call (mirrors the existing boot-priority pattern:
   `setPriority()` already flips a single mutable field around a bounded
   window), restored to 1 (routine) when `run()` resolves or throws. This
   avoids touching every call site inside `TraderAgent`/`ShipAgent`/etc. —
   they keep calling `this.api.someMethod()` unchanged, and the ambient
   priority set by the Scheduler just before invoking them takes effect at
   `RateLimiter.acquire()`.
3. **Rescue stays priority 0 end to end.** Concretely: a rescue Task's
   `run()` sets the Client to priority 0 for its duration, so every HTTP
   call it makes jumps the shared queue ahead of any tenant's routine
   ticking — closing the exact gap `control-plane-data-plane.md` flagged.

## Tradeoffs

- **Ambient priority (Client-scoped, set/restored around `run()`) vs.
  threading a parameter through every call.** Ambient is far less invasive
  (one Scheduler-side hook instead of dozens of call-site edits) but is a
  global mutable flip, same risk shape as the existing boot-priority
  toggle — a Task that spawns concurrent unawaited calls (rare today, worth
  checking for) could leak its priority onto work that isn't actually its
  own. Given the existing boot/routine toggle already accepts this risk and
  nothing in the codebase currently does unawaited fan-out from inside a
  Task's `run()`, ambient is the pragmatic choice; revisit if that changes.
- **Does this need Scheduler priority to reach every one of the 5 tiers, or
  just rescue?** Only rescue (priority 0) has a plausible urgent-preemption
  story today. Threading all 5 tiers costs nothing extra once the mechanism
  exists, so there's no reason to special-case just rescue in the
  implementation — but the practical payoff is concentrated there.
- **Risk of doing nothing:** stays latent until the shared limiter is
  actually contended by multiple tenants at once, at which point a rescue
  call queuing behind unrelated telemetry is a real, if rare, cost. Low
  urgency, real but narrow blast radius.

## Phased implementation

1. Add `priority` passthrough to `RateLimiter.acquire()` callers in
   `Client` (already supported by the class; just needs callers to use it).
2. Add the ambient "ScheduledTask priority" set/restore hook in
   `Scheduler.runOnce()` around each Task's `run()` call.
3. Verify with a test that a priority-0 Task's underlying HTTP calls acquire
   the RateLimiter queue ahead of a concurrently-queued priority-1 call
   (mirroring however `RateLimiter`'s existing priority ordering is already
   tested, if it is — check `tests/` for existing RateLimiter coverage
   first).
4. No doctrine/config surface needed — this is wiring, not a tunable.
