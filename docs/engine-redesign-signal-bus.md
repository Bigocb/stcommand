# Engine redesign — a signal-bus architecture

An alternative ground-up design, built from `docs/engine-requirements.md`
alone (same ground rule as `docs/engine-redesign.md`: no knowledge of
`src/engine/`'s actual code informs the shape below). This is **not**
a replacement for `docs/engine-redesign.md` — both exist so the operator
can compare a narrow, ownership-scoped arbiter (`DirectiveBoard`/
`Registry`) against a broad, everything-is-an-event architecture on the
same requirements. §5 gives a direct, opinionated comparison and a
recommendation.

---

## 1. The bus: what a signal actually is, and who may touch it

### Schema

A signal is not "stuff happens" — it is a typed, versioned, immutable
fact, plus a small envelope every publisher and subscriber can rely on
without reading the payload:

```ts
interface Signal<T = unknown> {
  id: string;                 // ULID — sortable, unique, carries its own timestamp
  tenantId: string | null;    // null only for genuinely galaxy-wide facts (§4)
  topic: string;              // "ship.arrived", "market.snapshot", "approval.decided", ...
  schemaVersion: 1;           // payload shape versioning, from day one
  causedBy?: string;          // the Signal.id this one is a reaction to, for tracing a chain
  publishedAt: number;        // ms since epoch, server-assigned, never client-supplied
  origin: "operator" | "fleet" | "external";  // WHO caused this — see §3
  payload: T;
}
```

`origin` is not decoration. It is the one field this design treats as
load-bearing for precedence (§3), and every publisher must set it
honestly — an operator HTTP handler publishes `origin: "operator"`; a
controller reacting to registry state publishes `origin: "fleet"`; a
signal derived straight from the game API (a ship's own reported
arrival) publishes `origin: "external"`.

### Topics: a closed, typed vocabulary — not "publish anything"

A genuinely open bus (any string, any shape) is exactly the kind of
under-specified plumbing that produces new versions of the requirements
doc's §9 pattern — an "arrival" event structurally different in three
places because nothing constrained what one had to look like. This
design keeps topics closed and versioned centrally, one file per
concern, matching the requirements doc's own organization:

| Topic family | Example topics | Published by |
|---|---|---|
| `ship.*` | `ship.arrived`, `ship.departed`, `ship.docked`, `ship.fuel-low`, `ship.stranded`, `ship.condition-critical` | The executor, from observed ship state only (§2) |
| `directive.*` | `directive.proposed`, `directive.committed`, `directive.released` | The arbiter subscriber (§3) — nothing else may publish these |
| `market.*` | `market.snapshot`, `market.stale` | Tour/scout/trader executors on dock; the staleness sweep |
| `shipyard.*` | `shipyard.scanned` | Same, on a shipyard dock |
| `gate.*` | `gate.confirmed-complete`, `gate.confirmed-incomplete` | The executor, on a real jump attempt or construction check |
| `approval.*` | `approval.requested`, `approval.decided`, `approval.expired` | The approval gate only |
| `route.*` | `route.computed`, `route.assigned`, `route.abandoned` | The trade controller |
| `tenant.*` | `tenant.reset-detected`, `tenant.token-dead` | The reset-detection poller, `Client`'s auth-failure path |
| `budget.*` | `budget.saturated`, `budget.starved` | The scheduler |

**Publish authorization is per topic family, not per process** — a
topic family has exactly one kind of publisher, enforced at the bus
layer (a publish call carries a capability token scoped to a topic
prefix; the bus rejects a mismatched publish rather than trusting the
caller). This is the direct fix for one of the requirements doc's
named accidental-complexity patterns: three independently-written "is
this ship free" checks existed because nothing stopped three different
places from each deciding they got to answer that question. Here,
`directive.committed` has exactly one publisher — the arbiter — by
construction, not by convention.

**Subscribe is open** — any controller, any HTTP handler, any
background job may subscribe to any topic. Restricting *reads* would
just reinvent the private-copy problem the requirements doc's §9 calls
out (four bugs from agents each holding their own decaying snapshot);
the bus's entire value is that reading a fact and reading it fresh are
the same action.

### Delivery and durability — worked through explicitly, not hand-waved

The requirements doc is unambiguous that a restart must never
permanently strand a ship, and that a restart happens several times a
day. That constrains this bus hard:

- **Every signal is durably appended before it is delivered to any
  subscriber.** One Postgres table, `signals`, append-only, per-tenant
  RLS on `tenantId` (null-tenant rows — galaxy-wide facts — bypass RLS
  by design, matching the shared/tenant split in requirement §4). A
  publish is a single `INSERT ... RETURNING id`; nothing is "in flight"
  in memory only. This is non-negotiable given the restart-survival
  requirement — an in-memory event bus (Node `EventEmitter`, a plain
  pub/sub library) loses every event mid-flight on every deploy, which
  is exactly the failure mode that produced the "learned jump cost
  reset on every restart" incident (requirements doc §5), generalized
  to *everything*, not just two caches. That is not an acceptable
  regression to accept for architectural cleanliness.
- **Delivery is at-least-once, via a durable cursor per subscriber, not
  a live push.** Each subscriber (the arbiter, the trade controller,
  the tour controller, the approval-gate consumer, the registry
  updater) owns a durable `subscriber_cursor(tenantId, subscriberName)
  -> last_signal_id_processed` row. A subscriber's tick is: read
  signals with `id > cursor` for topics it cares about, process them,
  advance the cursor — in one transaction per batch, so a crash mid-
  batch replays the whole batch rather than silently skipping it.
  **This is intentionally the exact same shape the requirements doc
  already prescribes for the approval gate** ("DB-polled, not an
  in-memory await ... `request()` is instead meant to be called again
  on every normal tick") — generalized from one mechanism to the whole
  system's communication, not a new pattern invented for this design.
- **At-least-once means every subscriber must be idempotent against
  reprocessing the same signal**, which is a real cost this design
  accepts openly rather than hiding: a `market.snapshot` reapplied
  twice must not double-count anything (it's a last-write-wins upsert,
  trivially idempotent); a `directive.committed` reapplied twice must
  not re-fly a leg twice (the executor's action is itself idempotent —
  "navigate to X" issued twice against a ship already navigating to X
  is a no-op, matching how the current codebase's own `navigateTo()`
  already treats a same-target call). Every topic's payload contract
  states its idempotency shape explicitly; this is part of what
  "closed, typed vocabulary" (above) buys — an open bus could not make
  this guarantee per-topic at all.
- **Ordering is per-tenant, per-topic-family, by `id` (ULID, so
  insertion order and sort order agree) — not globally, and not
  cross-family.** A global total order across every tenant and every
  concern is both unnecessary (nothing in the requirements needs
  tenant A's market snapshot ordered relative to tenant B's ship
  arrival) and would become the exact kind of shared bottleneck the
  requirements doc's rate-limiting/multi-tenancy section warns against
  (one lock serializing unrelated tenants' work). Cross-topic causal
  order within one tenant (a `directive.committed` must be visible to
  the executor before the `ship.arrived` it produces) is achieved by
  the publish-then-read discipline above, not by a global sequence
  number.
- **Replay is a first-class operation, not an afterthought.** Because
  signals are durable and cursor-based, a new subscriber (or one
  recovering from a bug) can replay from `id = 0` and reconstruct its
  own view of the world entirely from the signal log — this is the
  natural home for the requirements doc's "detect a reset proactively"
  open idea (§7/CLAUDE.md): a `tenant.reset-detected` signal, once
  published, can be replayed by every interested subsystem (cleanup
  job, dashboard banner, crawler restart) independently, instead of
  each needing its own bespoke polling loop.
- **Retention is bounded, deliberately, with an explicit compaction
  rule**, because "durable forever" for high-frequency topics
  (`ship.arrived`, `market.snapshot`) is a real, unbounded-growth cost
  the requirements doc never asked for. Two retention classes: **event
  topics** (`ship.*`, `market.*`, `approval.*`) are pruned once every
  subscriber's cursor has passed them and a short grace window (a day)
  elapses; **fact topics** where only the *latest* value matters
  (`directive.committed` per ship, `market.snapshot` per waypoint/good)
  are additionally materialized into a plain queryable table on write
  (the "current directive" table, the "current market price" table),
  so a subscriber that only needs "what's true right now" never has to
  replay history to find out — it queries the materialized view, and
  only a subscriber that needs the *sequence of changes* replays the
  log. This split matters: without it, "what is this ship's current
  directive" becomes an O(log length) scan instead of an O(1) lookup,
  which the requirements doc's own restart-survival needs answered
  fast at every boot.

---

## 2. Everything as events: mapping Document 1's systems onto the bus

| Requirements-doc system | Publishes | Subscribes to | Notes |
|---|---|---|---|
| Ship executor | `ship.arrived`, `ship.docked`, `ship.fuel-low`, `ship.stranded`, `ship.condition-critical`, `market.snapshot` (on dock), `gate.confirmed-*` (on jump attempt) | `directive.committed` (its own ship only) | The only publisher of ground-truth ship observations — matches requirement §8's "status is written by the thing that observed it" |
| Trade controller | `route.computed`, `route.assigned`, `directive.proposed{kind:"trade"}` | `market.snapshot`, `ship.*` (fleet-wide, for availability), `directive.committed` (to know what's already claimed) | Never publishes `directive.committed` itself — see §3 |
| Tour/Explore/Keeper controllers | `directive.proposed{kind:"tour"\|"explore"\|"keep"}` | `market.stale`, `gate.*`, `ship.*` | Same shape as Trade |
| Repair/Rescue controllers | `directive.proposed{kind:"repair"\|"rescue"}` | `ship.condition-critical`, `ship.stranded`, `ship.fuel-low` | Rescue subscribes fleet-wide across every role, per requirement §8's explicit "not just miners+traders" finding |
| **Arbiter** | `directive.committed`, `directive.released` | `directive.proposed` (every kind, every origin) | Sole publisher of `directive.committed` — see §3 |
| Approval gate | `approval.requested`, `approval.decided`, `approval.expired` | HTTP layer's operator decisions, `ship.*` (to re-verify a precondition before consuming a decision — requirement §6) | Same DB-polled state machine as today, expressed as bus topics |
| Galaxy crawler | `market.snapshot`, `gate.confirmed-*` (galaxy-wide, `tenantId: null`) | nothing (it observes the public API directly) | The one publisher allowed to write `tenantId: null` facts outside the reset-cleanup path |
| Reset detector | `tenant.reset-detected` | the public status endpoint (external, not the bus) | Closes the requirements doc's open "detect a reset proactively" item — every interested subsystem replays this one signal instead of each polling independently |
| Scheduler | `budget.saturated`, `budget.starved` | `directive.committed` (to know what work exists to schedule) | Diagnostic signals — nothing currently *needs* to react to them, but they replace ad hoc log lines with a queryable, replayable record, directly answering the "log explorer" parked idea in `docs/TODO.md` |
| HTTP dashboard/Tower layer | `directive.proposed{origin:"operator", ...}` (hold, dispatch, scrap, role change) | everything, read-only, for rendering | The dashboard becomes a pure subscriber — "desired vs. observed" is just "last `directive.committed`" vs. "last `ship.*`" for that ship, no separate query path needed |

This is the concrete answer to the operator's framing: dispatcher,
approvals, galaxy crawler, scheduler, and keeper logic all genuinely
fit this model without forcing — each already had a natural "thing
that happened" this design just makes explicit and shared, rather than
each maintaining its own notion of "have I told the other systems
yet."

---

## 3. The precedence problem, on the bus — and an honest answer about where the logic actually lives

**Direct answer, stated up front**: the bus itself does **not**
enforce precedence. Precedence is enforced by exactly one subscriber —
the arbiter — which is the sole authorized publisher of
`directive.committed`. The bus's contribution to solving the original
bug is real but narrower than "the bus fixes it": it guarantees the
arbiter sees every proposal (operator and automatic) through one
durable, ordered, replayable channel, and it guarantees every other
subsystem learns the *committed* outcome through that same channel
rather than by polling a role map or calling into another module's
private state. What it does **not** do is decide who wins — that
logic is exactly as centralized, and exactly as necessary, as the
`DirectiveBoard.commit()` function in `docs/engine-redesign.md`. A bus
with no arbiter subscriber, and every controller allowed to publish
`directive.committed` directly, would reproduce the original bug
exactly — two publishers racing to write the "true" answer, now over a
message bus instead of over shared memory. This design does not do
that, but it is a real design choice, not a property the bus
architecture gives you for free.

### Walkthrough: the motivating case, on the bus

```
t0   TradeController's reconcile pass reads current directive.committed
     signals + market.snapshot signals, decides ship S should trade,
     and PUBLISHES:
       Signal{ topic: "directive.proposed", origin: "fleet",
               tenantId: T, payload: {ship: S, kind: "trade",
               priority: 2, detail: {buyAt: A, sellAt: B}} }
     This is durably appended (signals table) at t0. It is a proposal,
     not yet a commitment — nothing downstream of the arbiter has
     acted on it.

t0+ε Operator clicks "Send to waypoint W". The HTTP handler PUBLISHES:
       Signal{ topic: "directive.proposed", origin: "operator",
               tenantId: T, payload: {ship: S, kind: "manual-dispatch",
               priority: 0, detail: {waypoint: W}} }
     Also durably appended, at t0+ε — strictly after t0 in the
     per-tenant signal order, because publish is a plain durable
     append with a server-assigned, monotonic id.

t1   The arbiter subscriber's next poll reads every unconsumed
     directive.proposed signal since its cursor — BOTH of the above,
     in id order. It applies the exact same resolution rule as
     DirectiveBoard.commit() in the narrower design: an operator-
     origin proposal for ship S exists, so the fleet-origin proposal
     is discarded before any priority comparison. The arbiter
     PUBLISHES exactly one:
       Signal{ topic: "directive.committed", tenantId: T,
               causedBy: <the operator proposal's id>,
               payload: {ship: S, kind: "manual-dispatch",
               waypoint: W, version: N} }
     and advances its cursor past both proposals — the trade proposal
     is consumed (read) but produces no committed signal; it is not
     silently lost, it is visibly, traceably superseded (the arbiter's
     own log/trace can show "trade proposal <id> for S was discarded
     in favor of operator proposal <id>", which is strictly better
     audit trail than the narrower design's in-memory discard, purely
     as a side benefit of everything being a durable, replayable
     event).

t2   The executor subscribes to directive.committed for its own ship
     only. It reads the new commitment and issues the navigate action
     — same as the narrower design, it is structurally incapable of
     ever reading directive.proposed directly, so a race where it acts
     on the fleet's proposal before the arbiter resolves it cannot
     occur (there is nothing for it to read at that topic).

t3   The executor's navigate call itself PUBLISHES ship.departed, and
     later ship.arrived, with origin: "external" (ground truth from
     the game API). TradeController's next reconcile pass reads
     directive.committed for S, sees it's manual-dispatch (not trade),
     and does not re-propose trade for S — same outcome as the
     narrower design's controller-side "not eligible" check, arrived
     at the same way: read the current committed fact, don't propose
     against a ship that already has one.

t4   Operator releases S. HTTP handler PUBLISHES
     directive.proposed{origin:"operator", kind:"release"}. Arbiter
     commits directive.released. TradeController's next reconcile
     pass sees no current directive for S and is free to propose
     trade again, normally — "fall through to the engine choice"
     happens the same way it does in the narrower design: there was
     never a separate fallback path, just the absence of an
     overriding fact.
```

**The race is closed for the identical reason it's closed in the
narrower design** — one function (the arbiter) is the only path by
which "committed" gets decided, and it discards competing fleet-origin
proposals before comparing priorities, rather than merely ranking them
lower. The bus adds: every step of that resolution is now a durable,
replayable, independently-auditable fact (`causedBy` chains let you
answer "why did S end up doing X" by literally replaying the signal
log, not by reading source and inferring intent), and every other
subsystem's view of "what's S doing" comes from the *same* channel as
the arbiter's own — there is no second query path (a role map, a cache)
that could disagree with what the arbiter decided. What it does not
add: any actual simplification of the resolution rule itself. That
logic is exactly as much code, doing exactly as much work, as
`DirectiveBoard.commit()`.

---

## 4. Multi-tenancy, restart survival, galaxy data — how the bus model handles the rest of Document 1

- **Multi-tenancy**: every signal carries `tenantId` (or `null` for
  galaxy-wide facts), and RLS on the `signals` table enforces isolation
  the same way it already does for every other tenant-scoped table.
  Rate-limiting stays outside the bus entirely — the bus is about
  *information flow*, not about admission against the shared API
  budget, which remains the scheduler's own token-bucket concern
  (§2's `budget.*` topics are diagnostic signals *about* that budget,
  not a mechanism for enforcing it).
- **Restart survival**: covered in depth in §1 — durable append,
  durable per-subscriber cursor, idempotent replay. This is arguably
  where the bus model is at its strongest relative to the narrower
  design: restart survival in `docs/engine-redesign.md` requires
  remembering, case by case, "this piece of state must be durable" for
  each of the ~6 categories the requirements doc's §5 lists. Under the
  bus model, durability is a property of the *infrastructure itself* —
  a new subsystem gets restart survival for free the moment it
  subscribes correctly, rather than needing its own explicit "load
  this at boot" step written by hand. That is a genuine, structural
  advantage, not just a reframing.
- **Galaxy data / approvals / "systems sharing data poorly"**: this is
  the strongest case for the bus specifically *beyond* ship control —
  see §5.

---

## 5. Honest comparison against `docs/engine-redesign.md`, and a recommendation

### Where the bus is genuine overkill

For the **ship-ownership/precedence problem specifically** — the
original motivating bug — the bus buys nothing that
`DirectiveBoard`/`Registry` didn't already buy, and costs real,
concrete complexity to get it:

- **A second durable mechanism to reason about.** The narrower design
  has one table (`ship_directives`) with one current-value-per-ship
  semantics — trivial to query, trivial to reason about ("what does
  this ship want right now" is one row). The bus version needs the
  same information reconstructed from a log plus a materialized
  current-value table (§1's compaction rule) to answer the identical
  question at the identical speed — the materialized table *is*
  `ship_directives` again, just now sitting downstream of an event
  pipeline instead of being the primary record.
  Requiring at-least-once idempotency, cursor management, and replay
  semantics for a fact that only ever has one live value per ship
  (what this ship is doing right now) is solving a harder problem than
  the one that exists. Event sourcing earns its cost when the
  *history* of changes matters as much as the current value (audit,
  replay-to-any-point-in-time, multiple independent projections of the
  same stream) — ship directives, as specified in the requirements
  doc, need none of that: nothing in Document 1 asks "what was ship S
  doing three hours ago," only "what is it doing now, and did that
  come from the operator."
- **The precedence rule itself does not get simpler or safer.** As
  stated plainly in §3: the bus does not enforce precedence, a
  subscriber does, and that subscriber is line-for-line the same logic
  as `DirectiveBoard.commit()`. Adopting a bus architecture *for this
  problem specifically* is indirection without a corresponding
  correctness or simplicity win — the same bug (two publishers racing
  to declare the "true" directive) is exactly as possible on a bus with
  no correctly-scoped arbiter as it is with no correctly-scoped
  `DirectiveBoard` — the architecture doesn't prevent the mistake, a
  disciplined single-writer convention does, and that convention has
  to be enforced by hand either way (topic-publish authorization in
  this design, or "nothing but the arbiter writes committed intents"
  in the narrower one — structurally similar effort).

### Where the bus genuinely helps beyond what `DirectiveBoard`/`Registry` solves

The operator's own framing — "many systems trying to share data but
maybe not doing it well, or efficiently" — is broader than ship
ownership, and the requirements doc documents real instances of it
*outside* ship control that the narrower design does not target,
because it was deliberately scoped to ship ownership only:

- **The approval gate's "decided but not yet acted on" gap** (three
  separate live incidents, requirements doc §6) is structurally a
  missing-event problem: an approval was decided, and the only way the
  engine would find out was if some unrelated code path happened to
  call `ApprovalGate.request()` again for the same reason. A bus with
  `approval.decided` as a real, durable, subscribable signal is a
  materially better fit for this specific case than either design's
  ship-ownership mechanism touches — this is a genuine point in the
  bus's favor, independent of the precedence problem.
- **Cross-cutting observability** — "what happened and why," across
  every subsystem, not just ships — is something the narrower design
  doesn't provide at all (it has per-ship desired-vs-observed, and
  nothing broader), and the bus provides essentially for free via
  `causedBy` chains and replay. The parked "log explorer" idea in
  `docs/TODO.md` is close to a direct ask for exactly this.
- **Proactive reset detection** (the open idea in `CLAUDE.md`/
  `docs/TODO.md`) is naturally a single `tenant.reset-detected` signal
  that every interested subsystem (cleanup, dashboard banner, crawler
  restart) reacts to independently, versus the current shape where
  each interested subsystem would need its own bespoke poll-and-
  compare loop.
- **Restart survival as a structural property rather than a per-
  mechanism discipline** (§4) is real, though it's worth being honest
  that the narrower design's restart survival is also fully solvable
  by hand — it's not *incapable* of restart survival, it just requires
  remembering to apply the same discipline (durable-first, replay-at-
  boot) to each new piece of state individually, versus getting it
  "for free" by using the bus correctly.

### The recommendation

**Build the narrower `DirectiveBoard`/`Registry` design from
`docs/engine-redesign.md` for ship ownership and precedence — that
problem does not benefit from bus indirection, and a single durable
table with one arbiter function is the more honest, more debuggable
solution to the specific bug this whole exercise started from.**

**Separately, and not urgently, consider a scoped event log — not a
universal bus — for exactly the cases in §5's "genuinely helps"
list: approval decisions, cross-tenant reset detection, and general
observability.** That could be implemented narrowly (a `signals` table
carrying only `approval.*`, `tenant.reset-detected`, and a handful of
diagnostic topics, consumed by a small number of subscribers) without
committing every subsystem — dispatcher, keeper logic, galaxy crawler —
to publish/subscribe as their *only* communication mechanism. Forcing
ship-executor-to-controller communication through a durable bus, when
that communication is naturally "read the current committed directive
and the current registry state," adds a layer of indirection (topic
schemas, subscriber cursors, idempotency contracts) around a problem
that a shared in-memory `Registry` plus one durable table already
solves cleanly and cheaply.

In short: the operator's instinct that "systems are sharing data
poorly" is correct and real (§9 of the requirements doc documents it
thoroughly), but the fix that instinct is pointing at is **mostly**
"stop each system from keeping its own private, independently-stale
copy of shared facts" — which `docs/engine-redesign.md`'s single
`Registry` already delivers for galaxy/market data, and its single
`ship_directives` table already delivers for ownership — **not**
"replace every direct call between subsystems with an event bus." A
full bus is the right tool when many independent consumers need the
*history* of a stream of facts, replayed at their own pace, with
audit trails across concerns; ship control and galaxy-state sharing, as
specified in Document 1, mostly need one correct, shared, current
answer, not a stream. Building the full bus everywhere would trade a
real, already-diagnosed problem (private stale copies, §9) for a new
one (a distributed-systems-shaped consistency/idempotency/replay
surface for problems that don't need it) — worth doing narrowly, not
worth doing as the whole architecture.

---

## 6. Explicit open questions left for the operator

1. **Is the approval-gate/observability win (§5) worth building a
   `signals` table at all, even scoped narrowly**, given the narrower
   design already solves the approval gate's core "decided but not
   consumed" bug with the "re-verify at execution time" rule from
   `docs/engine-redesign.md` §5 — without needing a bus? The bus makes
   that fix *cleaner* (an explicit `approval.decided` event instead of
   an unconditional re-poll every tick) but does not fix anything the
   narrower design's rule leaves broken. This is a real judgment call
   between "cleaner" and "another moving part," not a correctness
   question.
2. **If a scoped event log is built, who owns deciding which topics
   live on it** versus staying as an ordinary durable table read
   directly (as this document recommends for ship directives)? Left
   open deliberately — this document argues for narrow scope but does
   not draw the exact line.
3. **Retention/compaction tuning** (§1's grace window, materialized-
   view freshness) is left as an operational parameter, not specified
   numerically here, matching the requirements doc's own stance that
   these are tunable policy values, not engineering constants.
4. **Would the operator actually use the audit-trail/observability
   capability** (replaying `causedBy` chains to answer "why did this
   ship do that") enough to justify even the narrow-scope bus's
   added surface? This is genuinely a product question about how the
   operator debugs live incidents today (per `docs/TODO.md`'s parked
   "log explorer" idea, there's real appetite for *some* version of
   this) versus how much value a formal event log adds over better
   structured logging alone, which is a much smaller lift.
