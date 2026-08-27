# Standing Orders

A multi-tenant autonomous fleet engine for SpaceTraders, a programmable API
game where every action (register, navigate, mine, trade, buy ships) is an
HTTP endpoint. This context covers the domain language shared by the engine,
the HTTP/dashboard layer, and the tenancy model. See `docs/architecture-plan.md`
for the full design narrative and `docs/adr/` for individual decisions.

## Language

### Tenancy

**Tenant**:
One SpaceTraders agent and everything scoped to it — credentials, fleet,
missions, doctrine, chat history, LLM/Discord settings. Identified by
`tenants.id` (uuid); every tenant-scoped table carries a `tenant_id` column
enforced by Postgres Row-Level Security, not by query discipline.
_Avoid_: user, account, agent (when the in-game agent identity vs. the
tenant record distinction matters — they usually coincide but the tenant row
is the app's own concept)

**Session**:
A signed, httpOnly cookie (`<sessionId>.<hmac>`) mapping a browser to a
tenant. Created by `POST /api/gate/login` or `/api/gate/register`, resolved
by `resolveTenant` middleware on every request, cleared by
`POST /api/gate/logout`. The one table exempted from the automatic RLS
policy, since a session must be looked up by its own id *before*
`app.tenant_id` is known — that lookup is what establishes it.
_Avoid_: token (the session is not the SpaceTraders token; it references a
tenant that stores one, encrypted)

**Gate**:
The login/register screen and its two backing routes. A visitor pastes an
existing SpaceTraders agent token (login) or supplies a chosen symbol +
faction to mint a brand-new agent (register); both paths end in a session
cookie. Replaces straders' single shared `ST_DASHBOARD_TOKEN` — stcommand
has no shared secret, so "log out" is a real, meaningful action here that
straders' UI never needed.

**Tenant Worker** / **TenantWorker**:
The live, in-process bundle for one tenant: `{ api, store, state,
contracts, fleet, chat?, discord? }`. Held by `TenantRegistry`, one per
active tenant, booted lazily on that tenant's first authenticated request
and kept running for the life of the process — not the life of a request or
a browser tab. `getOrCreate` dedupes concurrent boots so two requests racing
in right after login can't double-start a fleet.
_Avoid_: worker process (it's an in-process object bundle, not a separate OS
process or thread)

**TenantRegistry**:
The class that owns the tenant-worker lifecycle: `getOrCreate` (boot or
return the existing worker), `stopAll` (graceful shutdown — stops every
booted `FleetManager`/`Scheduler`, the real fix for the fact that
`fleet.run()`'s coordinator loop has no natural end short of `maxTicks`).

**Row-Level Security (RLS)**:
The Postgres feature enforcing tenant isolation at the database layer: a
policy on each tenant-scoped table checks `tenant_id = current_setting
('app.tenant_id')::uuid`, applied even to a query with no `WHERE tenant_id`
clause at all. `FORCE ROW LEVEL SECURITY` additionally applies the policy to
the table owner, so a misconfigured superuser connection can't silently
bypass it. `app.tenant_id` is set once per request by `resolveTenant`
(`SET LOCAL`, transaction-scoped), never trusted to application code to
remember on every query.
_Avoid_: tenant filtering, scoping (when the guarantee specifically matters
— RLS is a database-enforced invariant, not an app-level convention)

**Shared galaxy data**:
Tables holding the same rows for every tenant on a given server reset —
`market_snapshots`, `market_latest`, `shipyard_inventory`, `module_catalog`,
`best_trades`, `trade_legs`. No `tenant_id` column, no RLS policy: the game
world is one shared fact base, only fleets are per-tenant.

**Bring-your-own key**:
The settings model for both the SpaceTraders token and the optional LLM
co-pilot key: each tenant funds and stores their own, encrypted at rest
(AES-256-GCM off one `SESSION_SECRET`). No shared credential the app could
spend on a tenant's behalf, and no global on/off flag for the co-pilot —
absence of a stored LLM key *is* "off" for that tenant.

### Fleet & ownership

**Fleet**:
One tenant's collection of owned ships, coordinated by one `FleetManager`
instance. Ships never span tenants.

**FleetManager**:
The per-tenant coordinator: a `run(maxTicks?)` loop (~2s cadence) whose
`tick()` drives route dispatch, warehouse/haul/mission-buy target
computation, keeper assignment, rescue, and (with a `scheduler` wired in)
enqueues every agent's next `Task`. Owns the ship role maps, the
`RouteDispatcher`, the `ShipRegistry`, and — when provided — the
`Scheduler`.

**Ship Role**:
One of `miner | trader | surveyor | tour | keeper | scout | siphoner |
warehouse | idle` — which agent class/behavior a ship is currently running.
Assigned once at boot/purchase (`assignRole`) and changed at runtime by
specific transitions (e.g. `maybeAssignKeepers()` converting an idle
miner/shuttle to a keeper).

**Owner** (ShipRegistry sense):
Who currently controls a ship's assignment, ranked by a fixed precedence
from strongest to weakest: `operator > rescue > mission > warehouse > keeper
> auto`. `operator` is a human's explicit dispatch/hold; `rescue` is a fuel
tender working a stranded ship; `mission` is a construction-supply carrier
assignment; `warehouse` is the designated warehouse ship; `keeper` is a
stationed market keeper; `auto` is the coordinator's own default role
assignment — the fallback for everything else. Distinct from **Ship Role**
above: Owner answers "who may reassign this ship," Role answers "what is it
currently doing."

**Claim**:
One `{ shipSymbol, owner, role, intent, since }` record — the single source
of truth `ShipRegistry` enforces for "who owns this ship right now,"
replacing what used to be up to eight independent, potentially
disagreeing mechanisms (role maps, the dispatcher, mission carrier
assignment, warehouse designation, keeper stationing, manual hold/mine-pin
flags). A claim from a stronger owner always succeeds over a weaker one's;
a weaker owner's claim against a stronger one is rejected unless the caller
passes `preempt: true`. The same owner re-claiming (e.g. updating role/
intent) always succeeds and preserves the original `since`.

**ShipRegistry**:
The class arbitrating claims (`claim`, `release`, `available`), persisted
per-tenant in `ship_claims` (RLS'd like every other tenant-scoped table).
As of the "Cutover, part 1" work, claims are a real gate at the moment of
mutation in `fleet.ts` (`holdShip`, `designateWarehouseShip`,
`pickMissionCarrier`, `assignMissionCarrier`, `maybeAssignKeepers`) — not
just an observational mirror.

**preempt**:
An explicit override flag on `claim()` that lets a weaker owner's claim
succeed anyway. Used only where one real decision is being *mirrored* into
the registry (e.g. `syncShipClaims()`'s resync, or an operator hold that's
already the strongest owner by construction), never to let genuinely
competing owners silently steamroll each other.

**Ship State** / **ship_state**:
A coarse, persisted lifecycle for one ship: `idle | assigned | travelling |
docked | returning | transacting`. `returning` distinguishes an
`IN_TRANSIT` ship already carrying cargo (heading toward a sale/delivery)
from one heading away from one. `transacting` overrides the nav-status
derivation whenever the driving agent's own `AgentStep` reports it's
mid-buy/sell/extract/siphon/survey — a real, narrow, occasionally-observed
state, not a manufactured one. Written by `FleetManager.syncShipStates()`
at the end of `init()` and every `tick()`; never stale by more than one
coordinator tick, survives a restart, queryable without the live in-process
worker via `GET /api/ship-state`.

**AgentStep**:
The per-agent "what is this ship's controlling agent doing this instant"
signal — `idle | { navigating, to } | { transacting, action, good? }` — set
immediately before, and cleared immediately after, each class's shared
`navigateTo()` entry point and its buy/sell/extract/siphon/survey API call
sites. Exposed via `getStep()`; optional on the `ControlledAgent`
interface, so a fixture without it is just treated as always-idle.
_Avoid_: agent status, activity (the term is deliberately narrow — dock/
orbit/chart/refuel-check are not "steps" in this sense)

**Cargo Manifest** / **ship_manifest**:
One row per (ship, good) actually held, reconciled every tick against the
ship's real `cargo.inventory` — upserted for goods currently held, deleted
for goods no longer there. Carries `cost_basis`/`basis_kind` (`actual`,
this ship's own last purchase price, or `estimated`, the fleet-wide
volume-weighted average, or `0` for cargo that arrived by mining/transfer/
contract fulfillment rather than a purchase) and an **intent**.

**Manifest Intent**:
Why a ship is holding a given good, one of four: `warehouse-deposit` (the
warehouse ship's own hold — takes priority over the other three even if
also mission-committed), `resale` (default — will be sold for profit),
`mission-delivery` (committed to an active construction mission, per
`MissionManager.committedShips()`), `held-position` (deliberately not
selling at a loss — re-derives `TraderAgent`'s own `exceedsLossFloor`
formula against `market_latest` for manifest-side classification; doesn't
gate the real sell decision, which still runs through each trader's own
live check).

**Rescue**:
The fleet-level, always-on task that finds and recovers stranded ships
(out of fuel, off-route). Runs regardless of halt state — `Scheduler`
admits only priority-0 tasks while paused, and rescue is priority 0 — and
regardless of anything else in `tick()`'s body; not contingent on any
particular ship role.

### Automation & scheduling

**Task** (Scheduler sense):
One unit of schedulable agent work: a priority, an `earliestRunAt` gate, an
`estimatedCalls` guess (for budget admission before the work runs), a `run`
callback returning a `TaskResult { actualCalls, next? }`. Returning `next`
chains another `Task` for the same agent; returning none ends that agent's
chain (used to enforce "a stopped agent's chain doesn't run forever").
_Avoid_: job (this codebase's "task" is unrelated to a durable, operator-
facing work item — it's scheduler-internal plumbing)

**Priority**:
A task's queue tier, 0 (highest) to 4 (lowest): `0 rescue · 1 mission · 2
trade/siphon · 3 survey/keeper · 4 telemetry`. While the fleet is paused,
only priority-0 tasks are admitted.

**Scheduler**:
The per-tenant priority task queue plus `SchedulerBudget` (a token-bucket
admission budget — deliberately separate from `Client`'s own per-tenant
HTTP rate limiter, which is what actually throttles requests to
SpaceTraders' 2/s cap; the scheduler's budget decides which *priority* gets
to spend that cap this pass, before any call is made). `runOnce()` sorts
ready tasks by priority, admits while budget allows, runs them, trues up
the budget from each result's real `actualCalls`, and enqueues any
returned `next`.

**nextTask() family**:
Each driven agent class's task-producer method(s) — `TraderAgent.nextTask()`,
`ShipAgent.nextTask()/nextSurveyTask()/nextTourTask()/nextKeeperTask()`,
`ScoutAgent.nextTask()`, `SiphonerAgent.nextTask()`. Each wraps — does not
reimplement — the same bounded work-unit method the agent's old blocking
`runLoop()`-family method already called (`tick()`, `surveyScout()`,
`tourScout()`, `keeperPoll()`), preserving identical timing/backoff. Every
`run()` callback starts with a stopped-agent guard
(`if (!this.running) return { actualCalls: 0 }`) so a retired agent's chain
terminates instead of running forever.

**syncSchedulerTasks()**:
`FleetManager`'s reconciliation: for every agent in a role map without an
enqueued task yet, enqueue its first one via the right `nextTask`-family
method. Idempotent per ship — once enqueued, an agent's own `next`-chaining
keeps it running without further help. Called from the same three points
as every other `sync*` method (end of `init()`, end of `tick()`, the halted
early-return branch).

**actualCalls**:
The real, measured delta of `Client.getCallCount()` across one task's
actual work — not a guess. `estimatedCalls` (needed before the work runs,
to decide admission) stays a heuristic by definition; `actualCalls` no
longer is.

### Trading & dispatch

**RouteDispatcher**:
Computes every profitable route once per cycle and hands each trader a
*distinct* assignment, so no two traders converge on the same good and
saturate one market. Operator overrides are respected until explicitly
cleared. The eventual coordinator for warehousing ("who hauls what, from
where").

**TraderAssignment** / **TraderRole**:
One trader's current job: `direct` (buy here, carry it, sell there — one
ship owns the whole round trip), `buy` (buy here, deposit into the
warehouse), `sell` (withdraw from the warehouse, sell there), `haul`
(withdraw from the warehouse, deliver to a mission/construction site), or
`contractBuy` (buy here, then just hold — the ship's own deliverCargo check
routes it to the contract destination on a later tick). `source` is `auto`
(dispatcher-allocated) or `manual` (operator override). `missionBuy: true`
exempts a `buy` assignment from the trader's `protectedGoods` block, which
otherwise refuses to buy a mission-reserved good.

**Warehouse**:
One designated ship's cargo hold, treated as fleet-wide inventory rather
than one trader's private cargo. `WarehouseTarget` (desired vs. current
balance) and `HaulTarget` (a mission material the warehouse already stocks
enough of to haul) feed the dispatcher's buy/sell/haul decisions.

**MissionBuyTarget** / **ContractBuyTarget**:
Goods sourced specifically to satisfy an active mission's or contract's
outstanding need — not a flat operator-set warehouse target. Sourced from
the cheapest known market since there's usually no profitable resale route
to derive a normal buy/sell pair from.

**Doctrine**:
The operator-tunable policy the engine flies by — cash floor, max loss
percent, minimum miner count, minimum trade margin, and similar values that
used to be hardcoded constants. Read synchronously from an in-memory cache
on every dispatcher/trader tick (a database round-trip per read would be
both slow and pointless); only `reload()` (awaited once at startup) and
writes (`set()`, `ensureShipTypeRule()`) touch the database.
`DoctrineRule.enforced` distinguishes a rule that's defined and shown in
the UI from one actually applied somewhere in the engine.

**Mission**:
A committed fleet task: deliver enough of each required material to a
construction site until it reports complete. Currently one `MissionKind`,
`SUPPLY_CONSTRUCTION`. Tracks `materials` (`MissionMaterial`: tradeSymbol,
required, fulfilled), an `assignedShip` (the mission carrier), and
`paused` (operator hold — no sourcing, no spending while true).
_Avoid_: contract (a Mission is this app's own construction-supply
commitment; a Contract is the game's own PROCUREMENT/TRANSPORT/SHUTTLE
object — related but distinct)

**MissionManager**:
Owns mission lifecycle (`list`, `assignCarrier`, `pause`,
`resumeMission`) and `committedShips()` — the lookup both `syncShipClaims()`
(claim owner derivation) and cargo-manifest `mission-delivery` tagging
share.

**Contract**:
The game's own mission object (`PROCUREMENT`/`TRANSPORT`/`SHUTTLE`, with a
deadline and payment terms), distinct from this app's Mission concept
above. `ContractManager` tracks outstanding `Deliverable`s (required minus
fulfilled units per good/destination) so a trader never sells a good an
active contract still owes at the same destination.

### Ship agents

**TraderAgent**:
Drives one ship's buy/sell trading loop against its `RouteDispatcher`
assignment. `clearLeftoverCargo()` and other sell paths check
`exceedsLossFloor()` before selling at a loss.

**ShipAgent**:
One class covering four roles off shared machinery — miner (`tick()`,
survival loop: orbit → navigate → extract → dock → sell → refuel →
repeat), surveyor (`surveyScout()`), tour scout (`tourScout()` — market/
shipyard intel refresh), keeper (`keeperPoll()` — reposition/refuel/dock/
snapshot at a stationed market).

**ScoutAgent** / **SiphonerAgent**:
Single-role agent classes: exploration/charting, and gas-giant siphon
extraction respectively (siphoning shares trade's priority tier with
mining — both are revenue-producing extraction).

**ShipGoal**:
A `ShipAgent` decision point: `mine | sell | refuel | buy | survey | idle`,
each carrying the target waypoint/good/units it needs.

**Keeper**:
A ship stationed at a market to periodically refresh its listing
(`keeperPoll()`/`keeperLoop()`). Converted from an idle miner/shuttle at
runtime by `maybeAssignKeepers()`, which also claims `keeper` ownership on
conversion.

**GalaxyAtlas**:
Shared (non-tenant-scoped) knowledge of explored systems/waypoints/jump
gates — the same data for every tenant, since it describes the game world
rather than any one fleet.

**Loadout** / **optimizeLoadouts**:
Ship module/mount configuration scoring and a genetic-algorithm optimizer
(`loadoutGa.ts`) that searches module/mount combinations against
`ModuleCatalogItem`/`MountCatalogItem` catalogs for a target ship class.

### Co-pilot & narrative

**ChatAgent** / **ChatLLM**:
The per-tenant LLM co-pilot's tool-calling loop. `ChatLLM` takes `{
apiKey, model, baseUrl }` (OpenAI-compatible chat-completions shape,
defaulting to Ollama Cloud) — the tenant's own bring-your-own key, never a
shared credential.

**NarrativeWriter**:
Generates human-readable fleet activity log entries from raw
activity/ledger events.

**DiscordRelay**:
Posts fleet activity to a tenant's configured Discord webhook. An exported
class instantiated per-tenant by `TenantRegistry` (not a module-level
singleton — the original straders code's `getDiscord()` was, which in a
multi-tenant process meant one tenant's ship purchases could post to
another tenant's channel the moment both had a webhook set). A webhook
change updates the live relay immediately, no restart needed.

### Migration discipline

**Dual-write** (this codebase's usage):
A migration phase where new logic runs for real, persisting real data every
tick, but nothing reads it as a gate yet — purely observational, alongside
the still-authoritative old mechanism. Not a long-term feature flag: once a
capability's cutover lands, the old path exists only as the fallback for
callers that haven't been updated (see e.g. `FleetOptions.scheduler`'s own
comment), not as a supported alternate mode to toggle back to.

**Cutover**:
The moment a dual-written capability actually starts gating real behavior
— e.g. `ShipRegistry.claim()` rejecting a mutation inline, or `fleet.run()`
enqueueing onto the `Scheduler` instead of starting the old `runLoop()`s.
Deliberately separate, later, higher-risk work from the dual-write phase
that precedes it, landed only once the parallel mechanism has run stable.
