# API capacity as a doctrine-level scarcity policy

The most speculative of the four — generalizes a pattern that already works
elsewhere in the codebase (`explorerCreditFloor`/`exploringEnabled`) to a
resource that isn't currently modeled as scarce at all: API call budget.

## Current state

Doctrine (`src/engine/doctrine.ts`) already has the right shape for this
kind of policy. `PolicyDefinition`/`DoctrineRule` (35-65) supports a
master-switch + tunable-value pattern; `isEnabledOr(key, fallback)`
(377-381) and `value(key, whenOff)` (341-353) let a caller read "is this
behavior on" and "what's the value when it's off/not adopted" separately.
The `explorerCreditFloor`/`exploringEnabled` pair (160-165, landed this
session) is the working template: a master switch gates a behavior, a floor
value protects a resource (credits) from being fully consumed by that
behavior even when it's enabled.

Nothing today applies this pattern to API capacity. Two places set
rate/burst constants directly, both as constructor-option defaults rather
than doctrine-read values:
- `SchedulerBudget` (scheduler.ts:116-118): `ratePerSec ?? 1.5, burst ?? 5`,
  per tenant.
- `RateLimiter` (client.ts:218-219, tenantRegistry.ts:89): hardcoded `1.5`
  rate, shared across all tenants.

There's also no aggregated visibility into how saturated the budget
actually is. `Client.getCallCount()` (client.ts:342-343) exists and is used
per-Task to compute `actualCalls` deltas for `TaskResult` reporting (trader/
siphoner/scout/agent/fleet all consume it individually) — but nothing sums
this across ships, across tenants, or exposes a "% of shared budget
consumed this tick" figure anywhere. A doctrine policy that reads "are we
API-constrained right now" would need this plumbing built first; it doesn't
exist as a byproduct of anything else today.

## Proposed design

Model API capacity the same way `explorerCreditFloor` models credits: not
as a single tunable number, but as a **switch + floor** pair, because the
actual decision this doctrine needs to drive isn't "what's our rate limit"
(that's physically fixed by SpaceTraders, not ours to tune) — it's "when
capacity is scarce, which class of work backs off first."

1. **New doctrine rule: `apiCapacityGuardEnabled`** (master switch,
   default off/not-adopted — this is speculative infrastructure, shouldn't
   silently activate). When enabled, a per-tick check compares aggregate
   recent call volume (see plumbing below) against the shared limiter's
   known drain rate.
2. **New doctrine rule: `apiCapacityBackoffFloor`** — the lowest Scheduler
   priority tier that's still admitted when the guard judges capacity
   scarce (default: 3, meaning telemetry (4) is the first and only thing
   shed under pressure; everything at 3 and above keeps running). This
   mirrors the credit-floor pattern exactly: a value that only matters when
   the switch is on, read via `value(key, whenOff)` collapsing to "no
   backoff" when the guard is disabled or not adopted.
3. **New plumbing: aggregate call-rate tracking.** `getCallCount()` is
   per-Client; add a lightweight shared counter (module-level or on the
   shared `apiLimiter`/`RateLimiter` itself, since that's already the
   cross-tenant shared object) tracking calls-per-second over a short
   rolling window. This is the one genuinely new piece of infrastructure
   here — everything else in this design reuses existing Doctrine and
   Scheduler mechanics.
4. **Enforcement point**: `Scheduler.runOnce()`'s existing admission sort
   (scheduler.ts:139) — when the guard is active and scarce, skip admitting
   Tasks whose priority is below `apiCapacityBackoffFloor` for that pass,
   same as `SchedulerBudget`'s existing token-bucket admission gate, just
   an additional condition on top of it.

This deliberately does **not** try to make `SchedulerBudget`'s or
`RateLimiter`'s rate/burst constants themselves doctrine-tunable. Those are
set to match SpaceTraders' actual, physically-fixed rate limit — making them
operator-adjustable invites someone dialing them up and getting real 429s
in production (a documented, deliberate constraint per
`docs/adr/0005-one-process-n-tenant-workers-on-render.md`-adjacent
reasoning about the shared-IP rate limit). The switch/floor pattern governs
*behavior under scarcity*, not the scarce resource's actual size — same
distinction `explorerCreditFloor` draws (it doesn't let you tune the fleet's
total credits, only how much of them exploring is allowed to spend).

## Tradeoffs

- **Is this solving a real problem yet?** No confirmed incident where API
  capacity scarcity caused a bad outcome — this is the most speculative of
  the four documents, explicitly flagged as such. The three-tenant scale
  running today doesn't stress the shared limiter enough for this to matter
  in practice.
- **New plumbing cost**: the aggregate call-rate counter is a real piece of
  new infrastructure, not just wiring existing pieces together (unlike the
  other three documents in this set). That raises the bar for building this
  now versus waiting for the multi-tenant-scale-up that would actually
  justify it.
- **Coupling to `rate-limiter-saturation-plan.md`**: a queue-depth-based
  signal (once that plan's cap/shedding lands) might be a simpler and more
  direct "are we scarce" signal than a separate call-rate counter — worth
  revisiting this design once that plan is implemented, since it may
  remove the need for new plumbing here entirely (queue depth against cap
  is already a saturation measure).

## Recommendation on sequencing

Given the speculative nature and the dependency called out above: **don't
build this until either (a) tenant count grows enough that shared-limiter
contention is observed in practice, or (b) `rate-limiter-saturation-plan.md`
lands and its queue-depth signal turns out to make this cheap rather than
requiring new plumbing.** Documented now so the reasoning and the template
(switch + floor, matching `explorerCreditFloor`) aren't rediscovered from
scratch later — not queued for near-term implementation.

## Phased implementation (if/when undertaken)

1. Land `rate-limiter-saturation-plan.md` first; re-evaluate whether its
   queue-depth tracking already answers "are we scarce" before building a
   separate call-rate counter.
2. Add `apiCapacityGuardEnabled`/`apiCapacityBackoffFloor` to Doctrine
   `DEFAULTS`, both defaulted off/inert.
3. Wire the scarcity check into `Scheduler.runOnce()`'s admission sort.
4. Add a dashboard surface for the aggregate signal (even before the guard
   is enabled) — visibility alone might be enough to inform whether the
   guard is ever worth turning on, without needing the enforcement half at
   all initially.
