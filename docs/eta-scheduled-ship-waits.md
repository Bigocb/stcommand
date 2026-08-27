# ETA-scheduled ship waits ("Ben's approach", precisely stated)

Design doc for replacing the blocking, in-`Task` transit waits every ship
agent uses today with the deadline-scheduled pattern bturney/spacetraders
uses — self-scheduling a wake at the game's own predicted arrival time,
instead of blocking until it happens. Read all of §1 before scoping this
as a small change: the problem it fixes is real and already confirmed live
in this codebase's own source, not hypothetical, and the fix is more
invasive than the phrase "add a timer" suggests.

**Precise terminology, since we got this wrong once already:** this is not
"event-driven" in the push/webhook sense — SpaceTraders is plain REST, it
never notifies the app of anything. What bturney's app actually does is
compute `delay = api_reported_arrival - now` and self-schedule a single
check at that time, confirming with the API when it fires rather than
trusting the ETA blindly. Call this **ETA-scheduled polling**, not
event-driven — one well-timed check per predicted deadline instead of a
fixed-interval check of everything.

---

## 1. The confirmed problem this fixes

Every ship agent class's navigation primitive blocks synchronously for the
full transit duration:

```ts
// trader.ts:285, agent.ts:222, scout.ts:170, siphoner.ts:165 — same shape in all four
private async waitForArrival(): Promise<void> {
  for (;;) {
    const wait = new Date(this.ship.nav.route.arrival).getTime() - Date.now();
    if (wait > 0) { await sleep(wait + 1000); }
    await this.refresh();
    if (this.ship.nav.status !== "IN_TRANSIT") return;
  }
}
```

called unconditionally from `navigateTo()` right after issuing the
navigate command (`trader.ts:332-333`: `await this.api.navigateShip(...);
await this.waitForArrival();`), and `navigateTo()` is called from deep
inside `tick()`'s actual work — e.g. contract delivery
(`trader.ts:1239-1241`): `await this.navigateTo(result); await
this.ensureDocked(); await this.deliverCargo(this.ship);` all inside one
`tick()` call.

Every one of these agents drives production through `nextTask()` (Phase
6/7, confirmed live per README's Scheduler cutover), whose `run()`
callback does `const made = await this.tick();` — so a `Task.run()`
promise does not resolve until the ship's entire transit (which can be
many minutes) finishes.

**`Scheduler.runOnce()` (`scheduler.ts:114-133`) runs ready tasks
strictly sequentially:**

```ts
for (const task of ready) {
  let budget = this.budget.availableTokens();
  if (task.estimatedCalls > budget) continue;
  this.queue.splice(this.queue.indexOf(task), 1);
  const result = await task.run();   // <-- blocks the whole loop until this resolves
  this.budget.consumeTokens(result.actualCalls);
  ran += 1;
  if (result.next) this.enqueue(result.next);
}
```

One ship's task sitting inside a multi-minute `waitForArrival()` blocks
every other ready task in that tenant's queue — **including the
priority-0 rescue task** (`fleet.ts:2979`, `nextRescueTask()`) — from
running at all until it resolves. `Scheduler.runOnce()`'s admission sort
already puts rescue first when it's *ready*, but "ready and sorted first"
doesn't help if the loop is stuck `await`ing a lower-priority task's
`run()` that was already in flight when rescue became ready. This directly
undercuts the guarantee "Cutover, part 4" was built to establish: rescue
surviving a halt is a property of `Scheduler.runOnce()`'s admission logic
*only if the loop can actually get back to the queue* to re-evaluate it.

This has not been confirmed against a live production incident — it's a
structural reading of the code, not a bug report. It should be reproduced
(see §5) before being treated as settled, but the mechanism is
unambiguous: `for` + `await` inside it is sequential by construction.

## 2. Why the fix is smaller than bturney's, structurally

The good news: `Task` already has the field this needs.

```ts
// scheduler.ts:29-36
export interface Task {
  id: string;
  shipSymbol?: string;
  priority: Priority;
  estimatedCalls: number;
  earliestRunAt: number; // ms since epoch
  run(): Promise<TaskResult>;
}
```

`earliestRunAt` is already exactly bturney's `Process.send_after` delay,
expressed as an absolute timestamp instead of a relative one. Every
`nextTask()`-family method already uses it for fixed backoffs (`Date.now()
+ 30_000` on an idle tick, `+ HALT_POLL_MS` while halted). Nothing new
needs to be added to `Scheduler` itself — no persisted timeline table, no
separate re-arm-on-boot mechanism to build, unlike bturney's `Timeline`
module, which had to be built from nothing. This codebase's own
`TenantRegistry.getOrCreate()`/`fleet.init()` already re-derives live ship
state on every (re)boot instead of resuming exact remaining transit time,
and that stays true either way — this design doesn't change reboot
behavior, only in-process scheduling behavior.

The actual work is entirely in the four agent classes' control flow.

## 3. The hard part: `tick()` currently assumes navigation blocks

Making `waitForArrival()` non-blocking means `navigateTo()` returns the
instant the navigate API call completes, *before* the ship arrives. But
existing call sites chain a transact step immediately after navigating,
inside the same synchronous `tick()` call — the contract-delivery example
above is one of several (`runBuy`/`runSell`/`runHaul`/`runContractBuy` all
follow the same "navigate, then act" shape). If `navigateTo()` returns
early, that transact step would fire against a ship that hasn't arrived
yet.

**The fix is not to remember "what leg was I on."** This codebase already
has a working precedent for exactly this problem: `ship_state`/
`ship_manifest`/`ship_claims` never store *intent* as the thing trusted on
resume — they're re-derived from real, authoritative ship state
(`cargo.inventory`, `nav.status`) every tick (see CONTEXT.md's Cutover/
Dual-write entries). The same principle applies here: once `nextTask()`'s
scheduled wake fires at the real arrival time, `tick()` runs again from
scratch, reads the ship's real (now-arrived) `nav.status`, and naturally
proceeds to the transact step on *that* call — no persisted resume marker
required, as long as every navigate+transact call site is safe to
re-enter as two separate `tick()` calls instead of one.

That "as long as" is the one thing this doc can't resolve without a
per-call-site audit — see §4, item 1.

## 4. Proposed design

**New non-blocking navigation primitive**, used only by the scheduler-
driven path:

```ts
// Returns the real arrival timestamp (ms) once the navigate call is
// issued, or undefined if the ship was already there (no wait needed).
// Does NOT wait for arrival — the caller schedules its own resume.
private async beginNavigation(waypoint: string): Promise<number | undefined> {
  // ... same pre-navigate logic navigateTo() already has: system check,
  // refuel-if-low, ensureInOrbit() ...
  await this.api.navigateShip(this.symbol, waypoint);
  return new Date(this.ship.nav.route.arrival).getTime();
}
```

`navigateTo()` itself is unchanged and keeps blocking — `runLoop()` (the
pre-cutover fallback path, still exercised by every test file that doesn't
wire a `scheduler`) keeps working exactly as today. Only `tick()`'s
scheduler-facing shape changes.

**`nextTask()`'s `run()` callback becomes arrival-aware:**

```ts
run: async (): Promise<TaskResult> => {
  if (!this.running) return { actualCalls: 0 };
  if (this.halted()) return { actualCalls: 0, next: this.nextTask(Date.now() + HALT_POLL_MS) };
  const before = this.api.getCallCount();
  try {
    const result = await this.tick(); // tick() itself now returns richer info than boolean
    if (result.arrivesAt) {
      // Just issued a navigate; resume exactly when the game says we'll
      // land, not on the old made/idle 0ms-or-30s backoff.
      return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(result.arrivesAt) };
    }
    return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (result.made ? 0 : 30_000)) };
  } catch (err) {
    const actualCalls = this.api.getCallCount() - before;
    this.handleTickError(err);
    return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
  }
},
```

`tick()`'s return shape needs to grow from `boolean` to something like
`{ made: boolean; arrivesAt?: number }` so a call site that just started a
transit can report the real deadline instead of `made: true` triggering an
immediate (`+0ms`) re-run — which, today, is exactly what causes the
tight-loop-into-a-multi-minute-block behavior in the first place: `made ?
0 : 30_000` means "if we did something, go again immediately," and the
"something" was starting a transit that then blocks for the rest of its
own duration.

**Retry-on-early-wake, matching bturney's own defensive pattern.** A
resumed task firing at `arrivesAt` should not assume the ship has actually
arrived — a slow API round trip or a slightly-off game clock can land the
wake a moment early. `tick()`'s first action on resume should be
`refresh()` (already exists) followed by an explicit `nav.status ===
"IN_TRANSIT"` check; if still in transit, return a short retry
(`Date.now() + 2_000`) rather than proceeding into transact logic against
stale state. `waitForArrival()`'s own retry loop already establishes this
is the right defensive shape — the non-blocking version just needs the
same check moved to the top of the *next* `tick()` call instead of inside
a loop.

## 4a. What needs auditing before this is implementable

Per agent class, every call site that currently does "navigate, then
immediately act" in one `tick()` call needs to be checked for whether
splitting it across two `tick()` invocations (issue nav → return; arrive →
re-enter `tick()`, decide fresh) changes behavior:

- **`trader.ts`**: contract delivery (`tick():1239`), `runBuy`, `runSell`,
  `runHaul`, `runContractBuy`, `runArbitrage`, `clearLeftoverCargo` — each
  needs confirming that "not yet at the target, not yet acted" is a safe,
  idempotent state to re-decide from scratch on the next call (it almost
  certainly is, since the dispatcher assignment and cargo/position are all
  read fresh at the top of `tick()` already — but confirm this explicitly
  for each rather than assuming it from the pattern holding in one case).
- **`agent.ts`** (`ShipAgent`, four roles): mine/survey/tour/keeper each
  have their own navigate-then-act shape in `tick()`/`surveyScout()`/
  `tourScout()`/`keeperPoll()`.
- **`scout.ts`**, **`siphoner.ts`**: same audit, smaller surface (each is
  single-role).

This is the real cost of this design — not writing `beginNavigation()`,
but confirming four agent classes' worth of call sites are safe to
interrupt mid-sequence. Budget this as the majority of the implementation
effort, not the scheduling change itself.

## 4b. Alternative considered: fix the scheduler's concurrency instead

A smaller, lower-risk fix exists that solves the *acute* problem (rescue
starvation, one ship blocking others) without touching any agent's `tick()`
at all: make `Scheduler.runOnce()` admit and run multiple ready tasks
concurrently instead of sequentially `await`ing each one before moving to
the next. Reserve `estimatedCalls` from the budget at admission time,
true it up to the real `actualCalls` when each task's promise actually
resolves (asynchronously, not blocking admission of the next task), and
re-enqueue each task's own `next` as it completes rather than in loop
order.

This does **not** give the efficiency/precision benefits ETA-scheduling
provides (still checks on the old fixed backoffs, still no reboot-timing
benefit) — but it directly fixes the confirmed priority-inversion risk in
§1 with a change confined entirely to `scheduler.ts`, zero risk to trading/
mining logic, and no per-agent-class audit required.

**Recommendation:** ship §4b first — it's small, isolated, and fixes the
concrete bug. Treat the full ETA-scheduled redesign (§4/§4a) as the
follow-up once §4b has proven the scheduler is otherwise sound, the same
dual-write-then-cutover discipline this codebase already uses for every
other structural engine change (see `docs/adr/0008`).

## 5. Verification

**Reproducing §1 before trusting it's real:** a test with two enqueued
tasks — one whose `run()` never resolves (a `Promise` that hangs
deliberately) and one that should be admitted after it — proving the
second task never runs while the first is in flight. This is a `scheduler.
test.ts`-level test, no Postgres needed (`Scheduler` has no DB dependency,
per its own class comment).

**For §4b:** a similar test proving two concurrently-enqueued tasks with
different resolve times both start before either finishes, and that budget
accounting (`estimatedCalls` reserved on admission, `actualCalls` trued up
on completion) doesn't double-spend or under-charge across overlapping
tasks.

**For §4/§4a, per agent class:** a test issuing a navigate, asserting the
returned `Task.next.earliestRunAt` matches the real `nav.route.arrival`
(not a fixed backoff), then a second `tick()` call after simulating
arrival, asserting the deferred transact step now runs. `tests/
traderNextTask.test.ts` and `tests/agentNextTask.test.ts` already stub
`tick()` rather than exercising real trading decisions (per their own
scoping note) — this needs new tests that exercise the real navigate-then-
transact call sites, not just the wrapper.
