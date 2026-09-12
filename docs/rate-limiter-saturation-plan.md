# RateLimiter queue cap and shedding — surviving multi-tenant overload

Companion to `api-request-priority-plan.md`, split out because it's a
different failure mode: not "which request goes first" but "what happens
when far more requests arrive than the shared pipe can ever drain."

## Current state

`RateLimiter` (`src/core/client.ts:71-146`) has no bound on `this.queue`.
`acquire()` always pushes; nothing ever rejects. In practice this hasn't
bitten us because `SchedulerBudget`'s per-tenant admission rate
(`ratePerSec ?? 1.5, burst ?? 5`, scheduler.ts:116-118) is tuned to roughly
match `RateLimiter`'s own drain rate (`1.5`, tenantRegistry.ts:89) — by
convention, not by any enforced coupling between the two.

That convention only protects a single tenant against itself. `RateLimiter`
is shared **across all tenants** (`tenantRegistry.ts:89`), while
`SchedulerBudget` is instantiated **per tenant** — every tenant's Scheduler
believes it has its own 1.5 req/s budget to admit against, but they're all
draining the same physical 1.5 req/s pipe underneath. N tenants ticking at
once can jointly admit N × 1.5 req/s worth of Tasks into a limiter that can
only ever drain 1.5 req/s total. This is precisely the scenario
`RateLimiter`'s own priority-queue design was built to survive gracefully
(per its doc comment, client.ts:85-105) — but nothing currently stops the
queue itself from growing without bound while that happens, and nothing
sheds stale or duplicate work once it's queued.

Two related gaps, worth naming separately even though the fix is the same
component:
- **No cap.** An unbounded queue under sustained multi-tenant load doesn't
  fail loudly — it just makes every request wait longer, including
  priority-0 rescue calls once contention gets deep enough for FIFO ordering
  within a tier to actually matter.
- **No dedup.** Two Tasks (same tenant or different) wanting the same fact —
  e.g. two ships both about to request the same market's current
  price — both enqueue independently. `RateLimiter.acquire()` and the
  Scheduler's own admission are both unconditional pushes; nothing merges
  requests keyed on "what data is this actually for."

## Proposed design

1. **Cap the queue, decide what "full" means.** Add a `maxQueueDepth`
   constructor option to `RateLimiter` (default generous enough not to
   trigger under normal single- or dual-tenant load — needs measuring
   against real queue depth during a multi-tenant boot, not guessed).
   When `acquire()` would push past the cap, **reject the enqueue** rather
   than silently queuing indefinitely: return a rejected promise the caller
   already has to handle (every `Client` method awaiting `acquire()` already
   propagates rejections from the underlying `fetch()`, so this isn't a new
   error-handling shape for callers).
2. **Shed by priority and age, not FIFO-of-everything.** When the queue is
   at or near cap and a *lower*-priority item would need to be evicted to
   make room for a higher-priority arrival, evict the oldest lowest-priority
   entry rather than rejecting the new (higher-priority) one. This only
   matters once `api-request-priority-plan.md`'s per-request priority
   threading lands — before that, everything arrives at priority 1 and
   "lowest priority" is meaningless. Sequencing: ship priority threading
   first, add shedding second.
3. **Don't build dedup into RateLimiter itself.** Deduplicating "two Tasks
   want the same market snapshot" is a caller-side concern — it requires
   knowing what a request is *for* (a cache key), which `RateLimiter`
   deliberately doesn't know (it queues opaque acquire-then-run units). If
   this becomes a real cost, the right layer is a short-lived
   request-coalescing cache in front of the specific hot endpoints (market/
   shipyard snapshots are the obvious candidates, and largely already
   cached — `loadSystem()`/market caching noted as a cache hit after first
   boot in `unimplemented-api-features-plan.md`'s investigation). Not
   scoping this into the RateLimiter change; noting it so it isn't
   rediscovered as if new.

## Tradeoffs

- **Reject vs. block-until-space.** Rejecting is simpler and fails fast —
  a caller that can't get a slot finds out immediately instead of hanging
  indefinitely behind an ever-growing queue. The cost is that callers need
  to handle "the API layer said no, not just slow" as a distinct outcome
  from a normal HTTP failure. Given `Client.request()` already has no
  network-exception handling at all (see `ambiguous-mutation-safety-plan.md`
  — a much bigger gap in the same file), this would need to land alongside
  or after that fix so both failure modes get handled consistently rather
  than the queue-full case falling into an equally-uncaught path.
- **What's the right cap number?** Genuinely don't know without measuring —
  this needs an actual multi-tenant-boot queue-depth trace before picking a
  default, not a guess baked into the design. Flagging as a concrete
  precondition for implementation, not deferring the whole feature on it.
- **Urgency:** low today — three tenants at 1.5 req/s shared is not close to
  the failure mode this protects against. Becomes relevant if tenant count
  grows materially, or if a single tenant's boot/backlog burst grows a lot
  (e.g. a large fleet resuming after a long outage, all wanting fresh state
  at once).

## Phased implementation

1. Measure actual queue depth during the worst observed multi-tenant boot
   (3 tenants restarting together is achievable today via a deploy) —
   confirms whether this is theoretical or already brushing a real ceiling.
2. Add `maxQueueDepth` + reject-on-full to `RateLimiter`, unconditionally
   (safe regardless of priority-threading status — with everything at
   priority 1, this still bounds worst-case memory/latency even without
   smart shedding).
3. Land `api-request-priority-plan.md`'s per-request priority threading.
4. Add priority-aware eviction (lowest-priority-oldest-first) once (3) makes
   priority differentiation meaningful.
5. Test: simulate N concurrent tenants each pushing more than their fair
   share into the shared limiter; assert the queue never exceeds
   `maxQueueDepth` and that a rescue-priority acquire still gets serviced
   promptly under load.
