# Engine requirements

What the stcommand fleet-automation engine must do, and why — extracted
from the current implementation (`src/engine/*.ts`), the persistence
layer (`src/db/store.ts` and `migrations/*.sql`), the HTTP surface
(`src/http/*.ts`) that the dashboard and Tower actually call, and the
full incident history in `CHANGELOG.md`. This is a requirements
document, not a description of the current code: every requirement is
stated in behavioral terms, and cited against the real incident that
taught it whenever one exists. Someone should be able to build a
completely different engine from this document alone and satisfy the
same operator.

This document does not propose solutions — `docs/engine-redesign.md` is
the fresh design built from these requirements. The final section here,
"Where complexity looks accidental rather than essential," is the one
place this document editorializes, because separating essential from
accidental complexity is itself a requirements-level finding: knowing
which parts of the current system's shape are forced by the domain and
which are scar tissue is a precondition for designing well.

---

## 1. Ship roles: what each job actually is

The engine manages a fleet of hulls, each doing one job at a time. The
jobs that have emerged, and what each requires:

- **Trader** — flies a buy/sell (or haul, or contract-delivery) leg
  chosen by a central router, not chosen by the ship itself. Must not
  duplicate another trader's leg (two traders converging on the same
  buy/sell pair collapse the market — see §2). Must survive a restart
  mid-haul without losing track of cargo already purchased (§5).
- **Miner** — extracts resources at an asteroid field, using surveys a
  surveyor produces. Requires a fuel/cargo policy tuned for "sit still
  and extract," not "travel."
- **Surveyor** — produces surveys for miners; has no independent
  economic decision to make, only a production/consumption relationship
  with the miner role.
- **Siphoner** — same shape as miner, for gas giants, via a distinct API
  action (siphon vs. extract).
- **Tour** — visits waypoints (in-system and, via jump gates,
  cross-system) to refresh market/shipyard data. This is the primary
  source of the price data every trade decision depends on — a stale or
  missing tour means the whole routing system is reasoning from fiction.
  Must know when a system has nothing left to learn (must not re-tour a
  fully-known system forever — see the 2026-09-13 "explorer re-touring"
  incident, §7) and must have a way to reach new systems once its
  immediate neighborhood is exhausted (multi-hop backtracking, same
  incident).
- **Explorer** — charts genuinely new (never-visited) systems. Distinct
  from tour: a tour ship refreshes known markets, an explorer extends
  what's known at all.
- **Scout** — like tour, but dispatched at specific targets rather than
  roaming; also the role responsible for jumping to an unexplored system
  once its current one is fully charted so it doesn't idle forever
  (2026-09-13, "chart scouts jump to a new system").
- **Keeper** — a ship stationed at one waypoint, holding position, to
  keep that one market's data from going stale between tour visits. A
  keeper does **not** require a probe hull specifically — any hull can
  keep a market fresh, just less fuel-efficiently than a probe, because
  every role flies to its market and docks through the same navigation
  path (2026-09-14 role-mismatch-warning fix). The one genuinely
  irreducible constraint is **probes specifically**: a probe has
  effectively zero fuel and can never move itself, so a probe can only
  ever become a keeper by being *bought directly at* the target
  waypoint's shipyard — there is no "assign an existing probe to a
  distant market" path, full stop. This is essential complexity, not a
  workaround.
- **Warehouse** — one designated ship per tenant acting as a staging
  depot for buy/sell/haul coordination. Not a trading role in the
  arbitrage sense; more an operator-designated fixed point other
  activity (mining residue, contract staging) routes through.

**Cross-cutting requirement**: every role must be reachable by the same
per-ship operator controls (Hold/Release, Send-to-waypoint, Sell/Scrap,
role change) — a gap here is a real, repeated incident class. Keepers
specifically were excluded from `controlledAgent()`'s role-map lookup
for a period, so Hold/Sell/Send-to-waypoint/role-change/
designate-warehouse all failed for any keeper ship with "not under
fleet control" (2026-09-13). **Requirement**: role-scoped operator
controls must be defined once, generically over "whatever role map this
ship is currently in," not per-role, or every new role reintroduces this
gap.

## 2. The dispatch/routing problem

The engine must continuously compute which trade is worth making and
assign it to exactly one ship, without any two ships converging on the
same opportunity and destroying it.

- **Profitability** must be computed from live-enough price data (see
  §7, galaxy knowledge) — buy price, sell price, distance/fuel cost, and
  a margin floor below which a route isn't worth flying at all (a
  configurable "marginFloor" — too tight and legitimate routes flap
  between viable/rejected as prices tick, confirmed live on DRAGOM-1
  flapping on a 19-20c margin against a 20c floor until loosened to
  10c).
- **No two traders may claim the same (good, market) leg
  simultaneously.** Two independent live incidents produced fleet-market
  self-destruction: (a) a burst of sales spread thin across *many*
  routes crashed a whole system's prices because a flat per-route
  cooldown only reacts after a *specific* route is sold into — the fix
  had to track recent *volume sold per market* and discount a route's
  score proportionally, decaying over a rolling window, not a hard
  timer (2026-09-13/14); (b) a second idle trader was handed the
  *identical* leg a first trader was already flying mid-haul, because
  the "busy trader reserves this leg" logic was keyed differently
  (bare good) from the "new work item" key (good+market qualifier) — two
  keys that never collided (2026-09-14).
- **Fuel-range must gate assignment, not just be advisory.** A route
  computed and displayed is not automatically flyable — a same-system
  route can exceed a small hull's tank on the buy leg, the sell leg, or
  both; a cross-system route additionally requires a *confirmed* jump
  gate connection, not just a plausible one (2026-09-13/14, two separate
  live incidents: THEO-11's sell-leg distance check, and DRAGOM's
  jump-gate-confirmed-before-assignable rule).
- **A restart must not orphan an in-progress trade.** A trader that
  bought cargo in multiple lots, then restarted before its full trip was
  recorded, must not (a) forget what it already paid for, or (b) get
  handed a *different* good while still physically holding the first —
  see §5 for the restart-survival requirement this implies.
- **A busy trader must be treated specially by the router**, not
  reassigned every recompute cycle — the router's own "carry forward a
  busy trader's assignment" protection only covered ships it had a
  live in-memory record for, which a restart wipes; it had to also
  independently recognize "this ship is reporting real cargo in the
  hold" and leave it alone even with no record (2026-09-14, THEO-1
  stuck-cargo incident).
- **Contracts and construction missions are demand sources, not
  independent ship-pickers.** Both feed the same router (as
  `contractBuy`/`haul` assignment kinds) rather than running their own
  parallel ship-assignment logic — this keeps "who gets this ship" to
  one arbitration path instead of two competing ones.

## 3. The manual-override-vs-automatic-decision precedence problem

This is the core problem this whole exercise exists to address, so it
gets the most careful treatment.

**The requirement, in the operator's own words**: *"the logic should
fall through to the engine choice if there is no manual set"* — a
manual directive for a ship must unconditionally win while it is in
effect, and the engine's own automatic goal-selection must only ever
act as a fallback when nothing manual is set for that ship, never as a
second, competing proposal that can race a manual one.

Breaking that down into concrete sub-requirements, each with real
history behind it:

1. **There must be exactly one source of truth for "what is this ship
   doing right now."** Every historical incident in this class traces
   to *two* systems each believing they owned a ship and neither
   checking with the other:
   - A repair diversion and a tour agent alternately drove the same
     hull every 5-10 seconds all day, at 0% hull condition, because
     nothing arbitrated between "the repair controller claimed this
     ship" and "the tour agent is still flying it" — they simply took
     turns (`docs/control-plane-data-plane.md` §1, DAGGER-8).
   - Eight independent, partially-overlapping mechanisms have existed
     at once for "what controls this ship": role maps, an operator
     hold/dispatch flag living on the agent instance, a suspension
     boolean, a route-assignment map plus a *separate* manual-override
     map, a warehouse-ship field, a mission-carrier field, a keeper
     station map, and a mining-pin field — with three independently
     written "is this ship free?" checks, none of them agreeing with
     each other by construction (`docs/ship-control-state-audit.md`).
   - **Requirement**: a ship's current directive must be resolvable to
     exactly one value, read from exactly one place, by every subsystem
     that needs to know it (the dashboard, the scheduler, every role's
     own tick logic, the router). Anything that maintains a second,
     independent notion of "is this ship taken" is a bug waiting to
     happen, confirmed repeatedly.

2. **Manual directive must always outrank automatic proposals — not by
   convention, but by a real, enforced priority order that every
   proposal goes through.** The unresolved live incident this whole
   task is modeled on (a manual dispatch getting overridden or raced by
   an automatic proposal moments later) is exactly what happens when
   "manual wins" is a convention scattered across call sites rather
   than a single arbitration rule. A workable design needs one
   ranked-priority resolution step that every directive — manual or
   automatic — passes through, with manual/operator intent at the top
   of that ranking unconditionally (ahead even of rescue, since an
   operator holding a stranded ship in place for inspection is still a
   deliberate choice the automation must respect).

3. **An automatic proposal must never be allowed to *compete* with a
   manual directive — it must not even be considered a candidate while
   a manual directive is active for that ship.** "Automatic loses the
   tie-break" is not sufficient if automatic logic is still evaluated
   and can still, through some other path, act on the ship (e.g., a
   trader independently self-claiming a route the moment it finds
   itself with no assignment, regardless of whether the fleet is trying
   to hold it — confirmed live: a designated warehouse ship, held with
   no work, self-claimed a fresh trade route and flew off with it, 2026,
   because nothing but a still-standing "hold" record was stopping that
   independent fallback path from firing). **Requirement**: automatic
   goal-selection must be structurally incapable of acting on a ship
   whose manual directive is currently in force, not merely
   deprioritized against it.

4. **A manual directive must be explicit about how it ends.** Three
   distinct end conditions are all real requirements, not one:
   - **Explicit release** — the operator un-holds the ship.
   - **Completion** — the directive was a one-shot instruction (e.g.,
     "go scrap this ship") that finishes and should not linger as a
     phantom directive afterward. A directive that has no natural
     completion (a plain "hold here, do nothing") is itself the
     terminal state — standing down *is* fully executing it, not a
     placeholder waiting for something else.
   - **Superseding directive** — a new manual instruction for the same
     ship replaces the old one outright.
   A directive that isn't cleared on any of these leaves a stale
   instruction in force forever: a released ship kept reporting `want:
   hold <waypoint>` and sat parked at a gate instead of resuming its
   role, because nothing explicitly retracted the old committed
   directive when the operator's release removed only the *proposal*
   feeding it (2026-09-13, "released ship standing down forever against
   its own stale hold"). **Requirement**: release must be an explicit,
   first-class action that clears the previous directive record, not an
   inference from "the operator stopped asking for it."

5. **A manual directive that names a destination must survive a ship
   that is mid-transit when it's issued or when a restart happens.**
   Two failure shapes are both real:
   - The directive itself must be durable (survive a process restart)
     — an in-memory-only "the operator wants this ship here" is exactly
     the kind of state this codebase's history shows gets silently
     wiped on every deploy (several times a day).
   - A transit already underway cannot be recalled mid-flight (the game
     API has no "cancel navigation") — so a directive issued while a
     ship is in transit must be honored at the next real decision point
     (arrival), not attempted immediately against a ship that can't
     act on it yet, and must not be lost in the interim.

6. **A ship must be able to report, unambiguously, "I know what's
   wanted of me and it isn't what I'm currently doing."** The dashboard
   and Tower both need to show a ship's *intended* goal side-by-side
   with its *observed* state specifically so a stalled ship (wants X,
   doing nothing, or wants X, still doing Y) is visible without reading
   raw logs — this was cited as the reason the desired/observed split
   exists at all, and it is exactly the diagnostic surface an operator
   needs to *notice* a manual-vs-automatic race in the first place,
   before it's ever fixed structurally.

7. **A directive that has been superseded mid-task must be detectable
   by the ship carrying it out, not just by the controller that changed
   its mind.** A ship that started a multi-step job (bought cargo for
   route A) needs a way to notice, before spending money on the next
   step, that the plan for it has since changed (route A was swapped
   for route B by the router) — otherwise it completes work against a
   plan nobody wants anymore. A real incident bought cargo for one
   route and then executed the leg for a route the dispatcher had since
   swapped to, because nothing checked whether the assignment was still
   the one the ship started under (`docs/control-plane-data-plane.md`
   §4, DAGGER-17/ANTIMATTER incident).

## 4. Multi-tenancy: what's shared vs. isolated

- **Rate limiting is by source IP, not by agent token.** Every tenant
  sharing this process's egress IP genuinely shares one API rate budget
  unless that tenant has its own forward proxy (and therefore its own
  IP) configured. This is a hard external constraint, not a design
  choice — any redesign must still treat "the shared IP's rate budget"
  as a scarce resource multiple tenants draw from.
- **Data that is a fact about the galaxy itself must be shared across
  every tenant; data that is one tenant's ships, money, or history must
  be strictly isolated.** This split is real prior art worth treating
  as a hard requirement, not just current architecture: `CLAUDE.md`'s
  `SHARED_GALAXY_TABLES` (systems, factions, market snapshots/latest
  prices, shipyard inventory, module catalog, jump costs, gate
  construction status — every one of these is true regardless of who's
  looking) vs. `TENANT_GAME_TABLES` (ship state, contracts, missions,
  warehouse, financial/activity history — every one of these belongs to
  one tenant's play). Getting this split wrong has a concrete, already-
  observed cost in both directions: DRAGOM's Markets tab showed prices
  and routes for systems DRAGOM had never visited, priced entirely off
  other tenants' exploration, because shared-table reads weren't scoped
  to what *this* tenant had actually charted (2026-09-12) — a shared
  table still needs a tenant-scoped view over it.
- **Deliberately excluded from the "wipe this on a reset" definition of
  tenant data**: doctrine settings (an operator's margin-floor
  preference isn't wrong just because the universe reset), the co-pilot
  chat log, login sessions, and operator-action/play-profile tracking
  (a manual override from the dead universe is still a real historical
  data point for comparing play styles across resets). **Requirement**:
  "what belongs to this tenant" and "what's safe to discard on a
  universe reset" are two different questions with two different
  answers for some tables — conflating them would either lose
  operator-configured preferences or keep genuinely stale galaxy facts
  around.
- **A tenant's own rate/proxy configuration must not affect other
  tenants** — a per-tenant forward proxy gives that tenant its own
  budget entirely separate from the shared pool (confirmed: mixing
  proxy transport with the shared native fetch implementation caused
  outright failures or silent hangs, so the isolation has to be real at
  the transport layer, not just logical).

## 5. Restart survival

**The process restarts often** — every deploy, several times a day.
This single fact is the single largest source of historical incidents
in this codebase, and it generalizes to a hard requirement: **anything
that determines what a ship should be doing, what it has already done,
or what the galaxy looks like, must be durable, or the engine must be
provably indifferent to losing it.**

What must never be lost across a restart (each backed by a real
incident where it *was* lost):

- **An in-progress multi-lot trade's committed cargo/route.** Lost
  once, mid-restart, between two lot purchases — the ship came back up
  with no memory of the trip, got reassigned a different, unexecutable
  good, and sat full and stuck forever (2026-09-14).
- **Learned per-gate-pair jump costs and gate-construction status.**
  Both lived only in an in-memory map at one point; with deploys
  happening several times a day, a learned cost or a confirmed gate
  never survived long enough to replace its conservative placeholder,
  so cross-system routing never converged on real numbers — this had to
  be fixed *twice*, independently, once for each cache, because they
  were two separate in-memory structures with the same bug shape
  (2026-09-13).
- **A paused construction mission's paused state.** A periodic
  "refresh material counts" reconcile pass wrote the mission's DB row
  back to unpaused on every call because it derived the persisted flag
  from a per-call argument that wasn't always passed, rather than from
  the true in-memory state — a mission a human had explicitly paused
  quietly resumed itself on the next restart, with no operator action
  and no log admitting it (2026-09-14).
- **A manual hold/release/scrap/tour-destination instruction.** Must be
  replayed at boot from durable storage, or an operator's explicit
  "hold this ship" instruction evaporates on the next deploy.
- **A durable, restart-independent "who decided what" record for the
  operator approval gate** (see §6) — an in-memory await of a human
  decision is worthless in a process that restarts multiple times an
  hour; the gate has to be polled from durable storage on every tick,
  never held as a live Promise.
- **The background galaxy-wide crawl's progress**, so a restart doesn't
  restart the crawl from page 1 (acceptable to restart *deliberately*
  after a universe reset, since the whole galaxy is genuinely different
  then — but not on an ordinary deploy).

What is **acceptable** to lose (and the engine should not overbuild
durability for): a ship's very next scheduled tick timing (recomputed
trivially from live ship state on the next poll), in-memory rate-limiter
token counts (harmless to reset to full), and the exact wall-clock
moment of a cooldown/transit wait (re-derived from the game's own
`nav.route.arrival`, which is itself the source of truth, not a local
guess).

## 6. The operator-approval gate

Some autonomous engine decisions are consequential enough (real money,
hard to undo) that a human should be able to intervene before they
execute, without the fleet ever stalling if nobody's watching. The
concrete requirements:

- **Gating must not be a second suspension mechanism.** A pending or
  denied request is a guard clause a decision function checks every
  tick, not a state that freezes anything else about that ship or
  subsystem — the function that requested approval reruns on every
  cycle regardless.
- **An unanswered request must resolve itself after a bounded timeout**,
  to a policy-defined default (`approve` — matching this system's
  historical fully-autonomous behavior for a fleet nobody's actively
  watching — or `deny` for anything harder to reverse). A human who
  never looks at the dashboard must not permanently stall the fleet.
- **A denial must hold for a cooldown window before the same kind of
  request is allowed to ask again** — otherwise the very next tick
  re-proposes the identical decision and asks again immediately, which
  is not what a human "no" means.
- **A decision that resolves to "proceed" is not safe to consume until
  its real-world precondition is verified *at the moment of
  execution*, not just at the moment it was requested.** This was
  learned the hard way, twice, on the same feature: an approved
  purchase request sat un-acted-on because the only path that would
  ever notice the decision required a ship to happen to revisit the
  exact shipyard again (2026-09-13); fixed by re-issuing the same
  request kind unconditionally every tick — which then surfaced a
  *second* bug, where the approval was correctly noticed but consumed
  and then failed, because the ship that had triggered the request had
  since moved on and no ship was actually there anymore to complete the
  purchase (SpaceTraders requires a ship physically docked at a
  shipyard to buy there). **Requirement**: "decided" and "safe to
  execute" are two different questions, and the gate must not collapse
  them.
- **A decision must not be silently lost.** Consuming an approval and
  then having the underlying action fail must not burn the operator's
  decision — a failed purchase after a correctly-approved request left
  the operator having to approve the same thing twice with no visible
  error the first time (2026-09-13).
- **Deliberately not every consequential action needs a gate.** Ship
  repairs were investigated and deliberately left ungated — they're
  cheap, frequent, and delaying one for a decision risks losing the
  ship to a critical failure, which is the opposite of what a gate is
  for. Ship sell/scrap turned out to already be fully human-driven (only
  reachable from an explicit dashboard/Tower click) with no autonomous
  path to gate in the first place. **Requirement**: gating decisions
  need their own judgment call per action type — "consequential and
  autonomous" is the bar, not "costs money" alone.

## 7. Galaxy knowledge: charting, surveying, markets, jump-gate topology

- **Waypoint traits (including whether a waypoint has a market or
  shipyard at all) are only revealed by the game once *someone* — any
  agent, not necessarily this tenant — has charted that waypoint.** A
  system scanned before it was charted can cache as permanently
  trait-less, hiding a market that genuinely exists today. Requirement:
  any cache of "what's at this waypoint" needs a deliberate, bounded
  re-fetch path for exactly this case (checked once per system per
  gap-detection event, not on every tick, since that would defeat rate
  limiting) — confirmed live as the root cause of a tour ship reporting
  "no reachable target" in a system that in fact had four marketed
  waypoints (2026-09-13).
- **A background, tenant-agnostic crawl of the whole known galaxy is a
  distinct requirement from any one tenant's own exploration.** The
  public cartography page and cross-tenant awareness (e.g., a rival
  fleet sharing a home system) both need data no single tenant's fleet
  will ever fully gather on its own, and this crawl must not compete
  for any tenant's rate budget — it has to run over the game's public,
  unauthenticated endpoints only.
- **Jump-gate connectivity has three states that must be represented
  distinctly, not collapsed to a boolean**: unknown (never checked),
  confirmed complete (a real jump succeeded, or the construction
  endpoint confirmed it), and confirmed incomplete (the game explicitly
  rejected a jump attempt with "under construction"). A route may be
  *computed* without a confirmed gate (useful to show the operator what
  becomes possible once it's confirmed) but must never be *assigned* to
  a trader without one.
- **Gate-construction and jump-cost knowledge is one-way and
  self-correcting from live evidence, never downgraded by a stale
  cached guess.** A background sweep that treats *any* API error the
  same as "definitely complete" permanently poisons the cache on a
  transient failure — this happened live and then compounded, because
  nothing downstream ever re-validated a bad cached "complete" against
  a real rejected jump; the fix was to (a) only treat a genuine 404 as
  proof of "no construction record" and (b) treat a live rejection as
  stronger evidence than any cached guess and correct the cache
  immediately on one (2026-09-13).
- **A ship that hits a doomed jump/gate must record that fact and stop
  retrying it identically forever.** This exact bug shape (retry an
  identical rejected jump every ~10-90 seconds, unbounded) recurred
  independently across at least four different code paths over this
  project's history — the dedicated explorer's jump selection, the
  opportunistic "borrow an idle ship to explore" path, the stranded-
  ship rescue-by-jump path, and the tour-dispatch multi-hop path — each
  needing the identical fix (check the cache before attempting, record
  a live rejection, fall through to something useful instead of
  retrying) applied separately because the protection existed in one
  sibling path and was never generalized (2026-09-12/13, four separate
  changelog entries).
- **A ship standing exactly on its own next target must not price a
  round-trip refuel it doesn't need.** Confirmed as the root cause of
  two multi-hour stuck incidents (a scout parked on an uncharted
  waypoint with no market, and a surveyor re-surveying its own asteroid
  field) — a refuel-budget check that always prices "get there and
  back to the nearest market" is wrong when "there" is zero distance
  and nothing is about to travel.
- **Route/jump-gate estimation must degrade gracefully in the absence
  of confirmed data**, and say so honestly: the public route planner,
  lacking any scanned connectivity for most system pairs, deliberately
  assumes every system connects to its six nearest physical neighbors
  and labels the result "(estimated)" rather than returning nothing —
  real scanned data silently takes over once it fully covers a
  requested path.

## 8. Error handling: a ship must never get permanently stuck

This is a first-class requirement in its own right, not a side effect
of getting other things correct, because it has been violated
repeatedly, in structurally similar ways, across nearly every subsystem
in this codebase's history:

- **A doomed action must not be retried identically forever.** Every
  incident cited in §7's jump-gate bullet is one instance of this
  general rule; so is a scout that refused to even *attempt* a leg it
  couldn't afford at CRUISE when DRIFT (slower, cheaper) could likely
  have covered it — the fix was to stop pre-emptively refusing and let
  the real navigate call (with its own automatic DRIFT fallback) be the
  final authority, rather than a local fuel-budget guess (2026-09-13).
- **A stalled external call must not hang a ship's whole task chain
  forever.** A live incident: two independent ships each went dark for
  30-50+ minutes after an HTTP call to the game API that neither
  resolved nor rejected — no timeout existed at all on the transport
  layer, so nothing ever caught it. Two independent ships hitting the
  identical hang point in one session is what proved this was systemic
  rather than a fluke. **Requirement**: every outbound call to the
  external API needs a bounded timeout that converts a hang into a
  real, catchable failure the existing retry/backoff path can act on.
- **A ship that runs out of fuel away from a market must fail fast
  (a distinct, recognizable "stranded" condition), not retry a doomed
  navigate call every cycle with no backoff.** Confirmed live across
  multiple ships and multiple fleet-driven goals (repair, scrap, hold,
  explore, tender) simultaneously — the same bug, once fixed centrally
  at the one place all five of those goals share, rather than needing
  five separate fixes.
- **"Stranded" detection must be derived independently from live ship
  state, not gated on whichever controller's intent the ship happens to
  be under** — otherwise a ship stranded mid rescue-goal, mid repair-
  goal, etc. can fall through a gap where nothing is watching for it.
  (Still an open, unexplained gap as of this writing per
  `docs/TODO.md`: stranded ships were correctly detected but a rescue
  plan was never generated for two of them for hours — flagged as
  worth tracing further, not yet root-caused. Included here because "we
  don't fully understand why this failed once" is itself a real
  requirement signal: rescue-plan generation needs to be provably
  reachable from every stranded-ship state, not just observed to
  usually work.)
- **A role that self-selects work (a trader with no assignment
  self-claiming a route) must respect a standing directive that says
  "do nothing," or that directive is worthless.** Confirmed live: a
  warehouse-designated, held ship self-claimed a fresh trade route and
  flew off with it because nothing but a still-current "hold" record
  stopped its own independent fallback path from firing — this is the
  same requirement as §3.3, restated at the level of "any autonomous
  fallback logic," not just the primary goal-selection path.
- **A UI or control-flow decision derived from durable server state
  must be re-derived on every load, never latched from a one-time
  response.** An onboarding gate that decided whether to show a
  setup screen from a single login response, rather than re-checking
  the durable flag on every page load, caused a fleet to stay paused
  for hours after every restart with a log line that said only "fleet
  paused" — no reason, no owner, because nothing had asked the durable
  source of truth again after the first check.

## 9. Where complexity looks accidental rather than essential

Some of the complexity documented above is genuinely required by the
domain: probes cannot self-navigate and so must be bought exactly where
they'll stand; the game API has no way to cancel an in-flight transit;
one process shares one egress IP's rate budget across every tenant
unless a proxy is configured; jump-gate construction is a real,
three-state fact the game reports honestly. None of that goes away
under a different implementation — any redesign still has to carry it.
Call this **essential complexity**.

But a large share of the incident history above is a different shape:
the same underlying problem, patched multiple times, in slightly
different places, because each fix addressed one symptom without
removing or consolidating the mechanism that produced it. That's
**accidental complexity** — not because any one fix was wrong, but
because the system accumulated several independent, overlapping answers
to what is really one question, asked in one place, then had to keep
reconciling them by hand. The evidence for this, specifically:

- **Ship ownership had eight independent, only-partially-overlapping
  mechanisms at once** — role maps, an operator-hold flag living on the
  agent instance, a suspension boolean, a route-assignment map plus a
  *separate* manual-override map, a warehouse-ship field, a
  mission-carrier field, a keeper-station map, and a mining-pin field —
  with three independently hand-written "is this ship free?" checks,
  none sharing a definition (`docs/ship-control-state-audit.md`, itself
  written specifically to name this pattern after two same-day bugs —
  "a ship stuck in manual hold after mission duty ended" and "a ship
  stuck suspended and reporting stranded after rescue duty" — turned
  out to be the *same* defect wearing different clothes: "a subsystem
  borrowed a ship, and handed back only part of what it took"). The
  domain genuinely requires *some* notion of ownership; it does not
  require eight of them.
- **The keeper-probe approval race got three separate live fixes in one
  session**, each patching a slightly different failure mode of the
  same underlying problem ("an approved purchase isn't safe to execute
  the instant it's approved — the world may have moved on since"):
  first a stale-cached-position check (the candidate ship may have
  physically moved since the fleet's last snapshot of it), then a
  dock-vs-orbit check (the candidate ship may be *at* the right
  waypoint but not in the specific nav state the purchase needs), then
  a "hold the touring ship in place until its own approval resolves"
  rule (stop the ship that triggered the request from moving on before
  the decision even lands). Each fix is individually correct and each
  is a narrower case of one general rule the design should state once:
  *a decision that authorizes spending against real-world state must
  re-verify that state at the moment of spending, not trust it from the
  moment the decision was requested.* Patched three times because
  nothing said this once.
- **The doomed-retry-loop bug recurred independently in at least four
  separate code paths** — dedicated explorer jump selection, the
  opportunistic "borrow an idle ship" explore path, the stranded-ship
  jump-rescue path, and the multi-hop tour-dispatch path — each needing
  the identical construction-status-cache-and-skip fix applied
  separately, because the first instance of the fix lived inside one
  sibling function and nothing generalized it. This is accidental
  complexity in the purest form: one genuine mechanism (a cache of
  "known-doomed jump attempts, checked before retrying") that should
  exist exactly once, implemented instead as N ad-hoc copies discovered
  one incident at a time.
- **The "control plane flies ships directly" pattern is explicitly
  self-diagnosed, in progress, and only half-migrated as of this
  writing.** `docs/control-plane-data-plane.md` documents a deliberate
  migration (controllers should only ever *propose* a goal; a single
  shared executor should be the only thing that ever moves a ship) and
  its own tracking table shows two of six migration steps still
  incomplete: exploration and rescue both still fly ships directly from
  inside the controller that decided on them, the same pattern that
  produced the DAGGER-8 repair/tour fight before repair was migrated
  off it. The document's own text is explicit that "every failure since
  the refactor traces here" — this is not a hypothetical risk, it is
  the single most concrete, self-acknowledged unfinished migration in
  the codebase, and it sits directly on top of the precedence problem
  this whole exercise is about (manual dispatch for one role — scouts —
  is documented as still using its own private `manualGoal` flag rather
  than the shared intent board that every other role now goes through:
  a literal, current instance of "two ownership channels for one
  ship," not merely a historical one).
- **Per-agent, per-role copies of world state (waypoint positions,
  market data) were each seeded once and then aged independently.**
  Four separate live bugs in two days traced to one of these private
  copies going stale relative to the shared source of truth, and each
  fix added *another* explicit "push fresh data into this copy" call
  site rather than removing the copy — the self-diagnosis in
  `docs/control-plane-data-plane.md` §1 states plainly: "the fix is not
  more pushes." This is a textbook case of essential-looking
  complexity (every agent needs to know where things are) turning out
  to have an accidental shape (every agent needing its *own, separately
  refreshed* copy, rather than a shared reference).
- **The "manual" word means three unrelated things** across the
  ownership audit: an operator hold (a directive about the whole ship),
  a trade-route override (a directive about one assignment layer), and
  a mining-field pin (a directive about one input to one role's
  planning) — independently settable, independently cleared, sharing no
  code and no single check. The domain does need all three concepts;
  it does not need them to be three unrelated, independently-fallible
  mechanisms that happen to share a name.

The throughline: this codebase's incident history is not "many
unrelated bugs." It is a small number of *recurring shapes* — no single
owner of a ship, a decision trusted stale instead of re-verified at
execution time, a private copy of shared state drifting from the
source of truth, a retry with no memory of having failed the identical
way before — each rediscovered independently, several times, in
different subsystems, because the general rule each incident actually
taught was never stated and enforced in one place. `docs/engine-
redesign.md` treats eliminating these *shapes*, not just fixing their
individual instances, as a primary design goal — see that document's
own opening section for how each maps onto the fresh design, and where
the fresh design still carries comparable complexity because the
underlying problem turned out to be genuinely hard, not merely
under-consolidated.
