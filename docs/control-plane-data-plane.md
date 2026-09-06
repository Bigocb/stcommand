# Control plane / data plane: the fleet as a reconciled cluster

Design doc for restructuring the automation engine from "a coordinator loop
that also flies ships, plus ship agents that also plan" into the shape
every containerized network already uses: a **control plane** that knows
everything and touches nothing, a **data plane** that executes one step at
a time and never waits, and a **registry** both read from without copying.

The vocabulary is deliberately Kubernetes + Envoy/Istio, because the
mapping is close to one-to-one and because it names the rules the current
code breaks. Read §1 first: every item in it is a confirmed live failure in
this codebase, not a hypothetical.

Companion to `docs/eta-scheduled-ship-waits.md` (which made *transits*
non-blocking and is the first instance of the pattern this doc
generalizes) and ADR 0006/0007 (ShipRegistry arbiter, unified scheduler),
both of which survive here in changed roles.

---

## 1. The confirmed problem: the two planes are fused

Not "the loop is single-threaded." At 2 req/s of API budget one thread is
plenty. The problem is that anything which *waits* waits for everyone,
because control decisions sit on the data path and data-plane work sits in
the control loop.

**Control plane that flies ships.** `FleetManager.tick()` (`fleet.ts:3596`)
awaits `autoExplore()` → `exploreSystem()` → `jumpShip()`/`dispatchShip()`
→ `agent.dispatchTo()` → `navigateTo()` with `schedulerDriven=false`,
which is a blocking `sleep(ETA)`. `FleetManager.run()` awaits `tick()`
serially. While one scout flies a leg: no dispatch recompute, no keeper
assignment, no repair, no status sync, no gate refresh.

**Data plane that blocks the scheduler.** `Scheduler.runOnce()`
(`scheduler.ts:123-131`) is `for (task of ready) await task.run()`.
`ShipAgent.waitCooldown()` (`agent.ts:223`) sleeps for the cooldown;
`mineAndRefine()` (`agent.ts:1007-1073`) loops up to 60 extractions each
ending in that sleep — one miner task can own every ship in the tenant,
including priority-0 rescue, for an hour. `SiphonerAgent.siphonUntilFull()`
is the same shape. Doctrine has `minerTarget 4` enabled, so `maybeBuyShip()`
will arm this the first time the buy conditions are met.

**Data plane that plans from a private, decaying copy of the world.** Each
agent is seeded once at construction via `withWorld()` with
`waypointPositions` and `markets`. Every distance, "am I at a market,"
nearest-fuel and sell-target decision is made against that copy. Four
separate live bugs in two days (cross-system refuel targets, "requires 1048
more fuel" CRUISE decisions, a scout idling on a fuel pump reporting itself
stranded, tour scouts rejecting their whole target list) came from the copy
going stale, and each fix added another `reseedAgentWorlds()` push. The
fix is not more pushes.

**Control decisions made in four places at once.** `RouteDispatcher`
assigns routes, but traders also pick sell targets locally; `fleet.ts`
decides repair, but the tour loop keeps flying the ship (`runCriticalRepair`
→ `dispatchShipHop` fires one hop and returns → `repairShip` throws "must
be docked" → `releaseTo` → tour resumes → next tick re-diverts; DAGGER-8
did this every 5-10 s all day at condition 0.00). Nothing owns "what is
this ship doing," so two owners fight.

**"After the navigate" is dead code.** In scheduler mode a navigate throws
`NavigationPending`, so everything written after it in that tick never
runs and the next tick must re-derive intent from ship state. Some paths do
(idempotent re-entry), some don't (`surveyScout` survey-on-arrival, keeper
reposition, shipyard tour dock/record, refuel-detour recursion). A tour
that flew for 7.5 hours and recorded zero prices was this.

---

## 2. The model

```
Doctrine  (spec — the cluster we want)
  └─ controllers  (reconcile observed vs desired → per-ship intents)
       └─ arbiter  (exactly one intent per ship, by priority)
            └─ ShipIntent  (desired state, versioned, pushed by reference)
                 └─ ship executor  ("kubelet": one API call per step, never waits)
                      └─ SpaceTraders API
                           └─ telemetry  (observed state) → Registry → controllers
```

| Kubernetes / Envoy | Fleet | Today's code it replaces |
|---|---|---|
| Node | Ship — hull, cargo, mounts, tank = allocatable | `Ship` |
| Pod spec | `ShipIntent` | `TraderAssignment`, `manualGoal`, `repairPlans`, `dispatchTo()` |
| kubelet | Ship executor | `navigateTo/ensureDocked/refuelIfNeeded` ×4 files |
| Pod status / conditions | Telemetry: nav, fuel, cargo, condition, `Blocked{reason}` | `ship_state`, `getStep()`, `isStranded()` |
| Controllers | Trade, Explore, Keeper, Repair, Rescue, Fleet | `RouteDispatcher.recompute`, `autoExplore`, `maybeAssignKeepers`, `maybeRepairFleet`, `rescueStranded`, `maybeBuy*` |
| Scheduler (binding) + preemption | Arbiter | `ShipRegistry` claims |
| etcd | Registry (in-memory, one per tenant) | `GalaxyAtlas` + `this.positions` + `this.markets` + 4 per-agent copies |
| CDS (clusters) | `fuel`, `market`, `shipyard`, `gate`, `buy:<GOOD>`, `sell:<GOOD>` | ad-hoc filters over `this.markets` |
| EDS (endpoints, locality, health) | waypoint + system + coords + snapshot age / supply / price trend | `waypointPositions`, `market_latest` |
| RDS / VirtualService | the route half of a `ShipIntent` | `TraderAssignment` |
| Locality-aware LB | prefer same-system endpoint, fail over across the gate | the same-system guards added by hand |
| Outlier ejection | eject a `sell:GOOD` endpoint whose price collapsed | (the price-over-time doctrine idea) |
| Traffic splitting | weighted sell endpoints, capacity = `tradeVolume` | (everyone dumps at H56) |
| `observedGeneration` | `intentVersion` in telemetry | — |
| kubelet sync period | resync floor for idle/blocked ships (~30 s) | 30 s `!made` backoff |
| Taints | ship can't take a goal: no hold, tank too small, condition < floor | `availableFor()` |
| `kubectl describe pod` | per-ship desired vs observed vs blocked reason | the investigation we did by hand for DAGGER-13/14/15 |

### The four rules (the ones §1 breaks)

1. **Controllers never call the kubelet.** Nothing above the executor
   awaits a ship. `tick()` flying a ship is the API server ssh'ing into a
   node.
2. **The kubelet never chooses a route.** A ship picks *endpoints* within
   policy (nearest healthy fuel, nearest yard, which gate); it never picks
   *which good to trade* or *whether to explore*. Route = control plane;
   endpoint selection = data plane. This is exactly Envoy's split between
   RDS and EDS/LB.
3. **Level-triggered, not edge-triggered.** Every controller is
   `reconcile(registry, spec) → intents`: observed vs desired, act on the
   diff. There is no "after the navigate"; there is only the next diff.
4. **Status is written by the thing that observed it.** The control plane's
   view of a ship comes from that ship's step reports, not from a
   `getMyShips` poll racing the executor.
5. **A data-plane primitive either changes the world or raises.** No
   movement, dock or transaction may fail by logging and returning: to its
   caller that is indistinguishable from success, and the next statement
   will act on the plan's world instead of the real one. Envoy ejects an
   endpoint it cannot reach; it does not quietly deliver to the nearest
   one instead.

### Rule 5, and why it was missing

Rules 1–4 are all about *ownership and freshness* — who drives a hull, and
whose reading of the world is current. Every bug §1 catalogues is a
contention bug, and the intent board answers all of them. Rule 5 covers the
class none of them touch: one agent, uncontested, correctly owning a ship
and doing the wrong thing because a step it called failed silently.

The case that forced it. `TraderAgent.jumpToSystem()` had four failure
paths that logged and returned. Its caller's next moves are `ensureDocked()`,
`liveSellPrice(route.sellAt)` and a purchase or sale — so a ship that never
moved traded at whatever market it was standing on, while the logs printed
the route's waypoints. DAGGER-F ran that every ~45 seconds for over twenty
minutes, parked in X1-ZU53, "buying" at X1-RD37-D20E and "selling" at
X1-TV75-X20F, at 9,036c a cycle. `want:` said `trade`, which was true; the
fleet line said `DAGGER-F(trader)`, which was true; every instrument agreed
the system was healthy. The only true signal was the credit balance, and a
human noticed it before any of the telemetry did.

Rule 4 already covered this and was scoped too high. The log line
`bought 18u ANTIMATTER at X1-RD37-D20E` is status written by something that
did not observe it — it printed desired position as observed position. We
wrote that rule about the control plane not inventing ship state and never
applied it inside the agent, where the same substitution was happening.

Rule 3 is the structural fix, and the codebase was already split on it.
`MissionManager.stepCarrier()` and `stepRescue()` are level-triggered: they
re-check `nav.waypointSymbol` before every step and a failed move simply
makes no progress that tick. `runCriticalRepair()` re-reads the ship and
compares against the yard before repairing. Only the trader's route runs
straight through — navigate, dock, buy, navigate, dock, sell — with no diff
between statements, which is the only place in the engine where a silent
no-op can reach a transaction. `assertAt()` is rule 3's precondition
retrofitted to that one procedure; the durable fix is to make a trade a
sequence of reconciled steps like the carrier already is.

Two things this leaves open:

- **The movement primitive is still not one primitive.** Step 3 below
  claims `ShipProxy` unified navigation across roles. `TraderAgent`
  overrides `navigateTo()` — and that override is where the cross-system
  logic lives, so the hardest movement code is the one copy the
  consolidation missed.
- **There is no outcome telemetry.** Everything we added reports *intent*,
  and intent was never wrong here. Realized profit per completed route,
  against the margin the dispatcher planned, is the signal that would have
  made this visible in seconds instead of hours.

---

## 3. Registry

One in-memory object per tenant. Small: a few hundred waypoints, a few
dozen markets. Agents hold a **reference**, never a copy — the "push" is
free because there is nothing to push. `withWorld()`, `reseedAgentWorlds()`,
`chartSystemFor()`, the `isMarketWaypoint` callback and the per-agent
`waypointPositions`/`markets` maps all go away.

```ts
interface Registry {
  version: number;                       // bumped on every mutation
  position(wp: string): Pos | undefined; // undefined ⇒ Infinity everywhere, fail closed
  systemOf(wp: string): string;
  isMarket(wp: string): boolean;         // trait, not "we hold prices"
  endpoints(cluster: Cluster, opts?: { locality?: string }): Endpoint[];
}
type Cluster = "fuel" | "market" | "shipyard" | "gate" | `buy:${string}` | `sell:${string}`;
interface Endpoint {
  waypoint: string; system: string; x: number; y: number;
  health: "healthy" | "stale" | "ejected" | "unknown";
  weight: number;                        // capacity proxy (tradeVolume) for traffic splitting
  price?: number; supply?: string; ageMin?: number;
}
```

- **Health is derived, not stored**: snapshot age against
  `snapshotMaxAgeMin` (currently 90, *enabled* — the `whenOff` argument is
  the disabled fallback, not a default), supply, and later price trend.
- **Locality = system.** `endpoints("fuel", { locality: here })` is the
  in-system pool; an empty pool is the *only* reason to consider a
  cross-system endpoint. This is the in-system/cross-system rule stated once
  instead of as guards in six functions.
- **Mutation is event-driven**: a dock records a market into the registry
  before the step returns; a chart, jump, or gate check likewise. Background
  inputs keep their cadences (`market_latest` per tick, gate construction
  every 10 min). No timer pushes anything to a ship.
- **Multi-process later**: if this ever runs as more than one instance, the
  registry stops being a shared reference and needs `LISTEN/NOTIFY` or a
  channel. One tenant, one process: keep it in memory.

---

## 4. Intents and the arbiter

```ts
interface ShipIntent {
  version: number;
  ship: string;
  priority: 0 | 1 | 2 | 3 | 4;         // rescue 0 · repair 1 · trade 2 · explore/keep 3 · idle 4
  goal:
    | { kind: "trade"; good: string; buyAt: string; sellAt: string; maxUnits: number }
    | { kind: "tour"; waypoint: string }          // dock + record, one stop per intent
    | { kind: "explore"; system: string }         // jump, chart, survey, one system per intent
    | { kind: "repair"; yard: string }
    | { kind: "tender"; to: string; fuelUnits: number }
    | { kind: "keep"; waypoint: string }
    | { kind: "hold" };                           // manual / suspended
  policy: {
    fuelReserve: number;                          // never leave a market below this
    flightModes: ("CRUISE" | "BURN" | "DRIFT")[]; // DRIFT only when listed
    conditionFloor: number;                       // never depart a yard below this
  };
}
```

**Exactly one intent per ship.** The arbiter resolves controllers'
proposals by priority. This alone ends the repair-vs-tour fight and
replaces `ShipRegistry`'s claim/release protocol for ships (the registry's
*ownership* idea survives as "who holds the intent").

**Computed every tick, applied at step boundaries, under hysteresis.**
Unlike an Envoy route, switching a ship mid-trip has a real cost (cargo in
hold, fuel spent, half a leg flown). Don't churn:

| Situation | Replace intent? |
|---|---|
| Idle / empty hold / docked | Yes, freely |
| Mid-trade, route still positive | No — finish the trip |
| Mid-trade, margin gone negative | Yes, at next dock — sell here |
| Higher-priority controller (rescue, repair) | Preempt at the next step boundary (a transit can't be cancelled anyway) |
| `explore` | One system; replace on arrival |
| `keep` | Indefinite; replaced only by rebalancing |

The ship reports the `version` it is executing. `desired v14, executing
v12` is visible drift, not a mystery.

---

## 5. Ship executor (the kubelet)

One implementation, shared by every role. Replaces the four copies of
`navigateTo()`/`ensureDocked()`/`ensureInOrbit()`/`refuelIfNeeded()`/
`waitForArrival()` in `agent.ts`, `trader.ts`, `scout.ts`, `siphoner.ts`.

```ts
step(intent: ShipIntent, observed: Ship, registry: Registry): Action
type Action =
  | { do: "dock" } | { do: "orbit" } | { do: "setMode"; mode: FlightMode }
  | { do: "navigate"; to: string } | { do: "refuel" } | { do: "repair" }
  | { do: "buy" | "sell"; good: string; units: number }
  | { do: "chart" } | { do: "extract" | "siphon" | "survey" }
  | { do: "wait"; until: number }                 // transit arrival, cooldown expiry
  | { do: "blocked"; reason: string };            // cannot execute this intent
```

Rules:

- **One API call per step. No `sleep` anywhere in the data plane.**
  Transit → `wait(arrival)`; cooldown → `wait(expiry)`; mining → one
  `extract` per step, the loop is the scheduler re-running the step. This
  generalizes `NavigationPending` into the normal case and makes the
  serial scheduler harmless: serial execution of one-call steps at 2 req/s
  is indistinguishable from concurrent.
- **Every step reports** observed ship state + `intentVersion` +
  action + outcome into the registry. That is the control plane's only
  source of ship truth.
- **Local safety invariants, enforced without asking**: never leave a
  market below `fuelReserve`; never fly a leg longer than the tank; never
  choose a flight mode not in `policy.flightModes`; never set a mode from
  an unmeasured distance (`Infinity` ⇒ leave CRUISE); never depart a yard
  below `conditionFloor`; always record the market you are docked at.
- **Blocked, not retried.** An intent the ship cannot execute (no healthy
  fuel endpoint in locality, leg > tank, not a market) returns
  `blocked(reason)` once. The controller replans. No 10-second retry loops
  against the same rejected navigate.
- **Endpoint selection is local** (rule 2): nearest healthy `fuel` in
  locality for a detour, nearest `shipyard`, the gate for the route's
  system. Route choice is never local.
- **Resync floor**: an idle or blocked ship re-steps every ~30 s (one
  `getShip`), because someone else's dock may have changed its world.

The `Scheduler` keeps its priority queue and `SchedulerBudget` (admission
against the API budget is still needed — that is the one place the
kubelet analogy strains, since our nodes share one 2 req/s pipe) and loses
nothing else: with no blocking steps it is a timer wheel over
`(ship, resumeAt)`.

---

## 6. Controllers

Each is a pure function `reconcile(registry, doctrine, intents) →
proposals`. Each defends one invariant; profit is emergent from all of them
holding — the HPA pattern (declare `targetCPU: 70%`, not "as fast as
possible").

| Controller | Invariant | Violation → proposal | Today |
|---|---|---|---|
| Fleet | ship counts per doctrine; cash ≥ `cashFloor` | buy / scrap / promote | `maybeBuyShip/Scout/Siphoner` |
| Trade | no idle trader while a positive route exists; ≤1 direct trader per good; second-best route per good when goods < traders | `trade` | `RouteDispatcher.recompute` (already this shape) |
| Explore | no charted market unsnapshotted > N min; no reachable system uncharted | `tour` to nearest idle scout; `explore` for a system | `autoExplore`, `marketTourTargets`, `sectorTourTargets` |
| Keeper | `keeperCount` at each home market | `keep` | `maybeAssignKeepers` |
| Repair | no ship condition < `repairConditionFloor` | `repair` (preempts) | `maybeRepairFleet` + `runCriticalRepair` |
| Rescue | no ship below reserve away from a fuel endpoint — **all roles**, not miners+traders | `tender` | `getStrandedShips`, `makeRescuePlan` |

`FleetManager.tick()` becomes: refresh registry inputs → run controllers →
arbitrate → done. Every 2 s, unconditionally, zero API calls of its own
beyond the registry inputs it already reads.

**Doctrine is the manifest.** It already is: `minerTarget`, `keeperCount`,
`cashFloor`, `repairConditionFloor`, `snapshotMaxAgeMin`. Operator edits
doctrine or pins a manual intent = `kubectl apply`. Bridge triage = alerts
on violations a controller *cannot* clear — that is what "needs your help"
should mean.

---

## 7. What this does to the review findings

| Finding | Under this design |
|---|---|
| Scheduler blocked by cooldowns / mining loops | Impossible — steps cannot sleep |
| Coordinator blocked by transits | Impossible — controllers never await a ship |
| Critical repair never succeeds | `repair` intent: navigate → wait → dock → repair; arbiter locks the ship |
| Rescue blind to tours/scouts/siphoners | Rescue controller reads the registry |
| Dead code after `navigateTo` | No "after"; arrival is the next step |
| Stale per-agent caches | No copies |
| Trader 50 % refuel gate not leg-aware | `fuelReserve` policy + leg > tank invariant |
| Retry loops on rejected navigates | `blocked`, replanned |
| All traders dump at one market | traffic splitting over `sell:GOOD` endpoints |
| Cross-system starvation under the 90-min window | health per *side* (buy side ages slower) is a registry policy, one place |
| "Why is DAGGER-13 sitting there?" | desired vs observed vs `blocked(reason)`, per ship, on the dashboard |

---

## 8. Migration — all six steps built

Every step below is implemented on `claude/stcommand-ui-parallel-versions-fd5p9q`.
Two things this document called for are deliberately *not* done, and are
recorded here rather than left as silent gaps:

- **Manual dispatch is still its own mechanism.** `dispatchTo()` sets a
  `manualGoal` on the agent, which is a second ownership channel beside the
  intent board. Converting it to a `hold` intent is the remaining piece of
  step 4.
- **Agents execute their own goals, they do not yet execute *from* the goal.**
  An agent stands down when the fleet owns its hull, and takes its target
  from the intent where it has one, but a trader still derives its route
  from the dispatcher rather than reading `goal.kind === "trade"`. The
  distinction stops mattering only once `explore` moves off the fleet and
  onto the ship's own task.


1. **Data plane cannot block.** `CooldownPending(resumeAt)` alongside
   `NavigationPending`; `mineAndRefine`/`siphonUntilFull` become one
   extraction per task; `waitCooldown()` throws in scheduler mode;
   scout honours `refuelIfNeeded()`'s return. Retire `runLoop()`. This
   alone removes the serial hazard. Small.
2. **Registry by reference.** Extract `Registry` over `GalaxyAtlas` +
   `market_latest`; agents read it; delete the per-agent maps,
   `withWorld`, `reseedAgentWorlds`, `chartSystemFor`, `isMarketWaypoint`.
   Mostly deletion.
3. **One executor.** Extract `ShipExecutor` (nav/dock/refuel/record/mode)
   from the four agents; agents become `step()` producers over it. This is
   the shared module; it is where "in-system and cross-system flawless"
   lands, because every arrival becomes explicit.
4. **Intents + arbiter.** `ShipIntent`; repair, rescue, explore, manual
   dispatch become intents. Blocking `autoExplore`/`dispatchTo` path dies.
5. **Controllers.** The `maybe*` functions return proposals instead of
   acting; `tick()` runs the list.
6. **Telemetry-driven registry + dashboard.** Step reports feed observed
   state; UI shows intent vs observed per ship.

Cross-system is where the interesting complexity lives and is deliberately
*after* the executor exists: jump cost learning (`learnedJumpCost`), gate
construction as endpoint health, multi-hop fuel planning
(`canReachTarget`'s BFS becomes the executor's route planner), and
locality failover policy all attach to the registry/executor boundary and
have nowhere honest to live until it exists.

---

## 9. Non-goals (for now)

- Real xDS transport / multi-instance. One process, shared reference.
- Concurrency in the scheduler. Non-blocking steps make it unnecessary at
  our API budget.
- Replacing `RouteDispatcher`'s economics. It becomes the Trade controller
  as-is; traffic splitting and price-impact sizing are follow-ups on top.
- Touching the UI beyond surfacing intent/observed/blocked.
