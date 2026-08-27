# A unified priority Scheduler, replacing per-agent blocking loops

Every agent role used to drive itself with its own blocking `while` loop
(`TraderAgent.runLoop()`, `ShipAgent.runLoop/surveyLoop/tourLoop/
keeperLoop()`, `ScoutAgent.runLoop()`, `SiphonerAgent.runLoop()`) — N
independent loops per tenant with no shared notion of priority or budget.
`Scheduler` (`src/engine/scheduler.ts`) replaces that with one priority
task queue per tenant (0 rescue · 1 mission · 2 trade/siphon · 3
survey/keeper · 4 telemetry) plus `SchedulerBudget`, a token-bucket
admission budget deliberately separate from `Client`'s own per-tenant HTTP
rate limiter — the client limiter is what actually throttles requests to
SpaceTraders' 2 req/s cap; the scheduler's budget is its own accounting for
which *priority* gets to spend that cap this pass, before any of those
calls happen.

Landed the same dual-write-then-cutover way as ShipRegistry: **Phase 5**
built the queue itself, running per tenant but driving nothing (no
`enqueue()` caller existed yet). **Phases 6-7** gave every agent class a
`nextTask()`-family method wrapping its existing bounded work-unit method
(`tick()`, `surveyScout()`, `tourScout()`, `keeperPoll()`) — same timing/
backoff behavior, just returned as a chainable `Task` instead of driven by
a `while` loop — while `fleet.run()` kept starting the old loops
unchanged. **Cutover, part 2** is where it actually started driving
ships: `FleetManager` gained an optional `scheduler`; when one's provided,
`run()` stops starting any `runLoop()`-family loop at all, and every agent
is driven end-to-end by its `nextTask()` chain instead. The opt-in shape
(no scheduler → old behavior, unchanged) meant every pre-existing test
kept passing without modification; only the new scheduler-specific tests
exercise the cutover path. `TenantRegistry` now always constructs and
passes a scheduler, so in a real deployment the old loops never run at
all — the fallback exists for callers that haven't been updated, not as a
supported alternate mode.

**Cutover, part 4** closed the one priority guarantee that wasn't actually
guaranteed yet: rescue used to "always run regardless of halt" only because
of where its call happened to sit in `tick()`'s body. `nextRescueTask()`
is now a real priority-0 `Task` going through the same admission queue as
everything else, relying on `Scheduler.runOnce()`'s own pause-admits-
priority-0-only rule rather than a `tick()` implementation detail.

See CONTEXT.md's Task/Priority/Scheduler/nextTask() entries and README's
Phases 5-7 and "Cutover, parts 2 and 4" sections for the full narrative.
