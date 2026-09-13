# Architecture overview

A system-by-system breakdown of how stcommand is put together, for
anyone picking this codebase up cold. Written 2026-09-13 from the
current state of the code — update it when a layer described here
changes shape, rather than letting it drift into fiction.

## The shape of the problem

stcommand runs autonomous SpaceTraders fleets for multiple tenants (real
operator accounts, each with its own agent token) from one Node process.
Each tenant's fleet ticks independently and continuously — buying,
selling, mining, exploring, repairing — while a human operator watches a
dashboard and occasionally intervenes (reassigns a ship, approves a
purchase, adjusts a doctrine setting). The two hard constraints that
shape almost everything below:

- **SpaceTraders rate-limits by source IP, not by agent token.** Every
  tenant sharing this server's egress IP shares one rate budget unless a
  tenant has its own forward proxy configured.
- **The process restarts often** (every deploy, several times a day).
  Anything that isn't durably persisted is gone on the next boot —
  several real incidents this project's history trace back to state that
  looked persistent but was only ever in memory.

## Tenancy

`TenantRegistry` (`src/engine/tenantRegistry.ts`) owns the map of tenant
ID → running `FleetManager` instance (plus its `SpaceTraders` API client,
`ChatAgent`, Discord relay, etc.) and boots them concurrently
(`Promise.allSettled`). A `RateLimiter` is shared across every tenant
*unless* that tenant has a `PROXY_URL_<AGENTSYMBOL>` env var set, in
which case its `Client` routes through its own forward proxy (via
`undici`'s own `fetch`/`ProxyAgent` pair — deliberately not mixed with
Node's global `fetch`, which is backed by a different, incompatible
internal `undici`) and gets its own budget instead of sharing the pool.

Tenants and their session/auth data live in Postgres
(`src/db/tenants.ts`), gated by row-level security keyed on
`app.tenant_id` (see `src/db/pool.ts`'s `withTenant()`). Almost every
tenant-scoped table carries a `tenant_id` column and an RLS policy; a
handful of tables are deliberately **shared, no `tenant_id`** — anything
that's a fact about the galaxy itself rather than about one tenant's
observation of it (`galaxy_jump_costs`, `galaxy_gate_construction`,
`market_snapshots`/`market_latest`, `shipyard_inventory`,
`module_catalog`). This is a recurring subtlety: a query against a
shared table needs to be scoped by the requesting tenant's own charted
systems (`FleetManager.getChartedSystems()`) at the application layer,
since RLS can't do it for a table with no tenant column.

## FleetManager: one tenant's whole fleet

`FleetManager` (`src/engine/fleet.ts`, by far the largest file) is the
center of gravity. Per tenant, it:

- Holds one agent per role in separate `Map<string, Agent>`s: `miners`,
  `traders`, `surveyors`, `tours`, `explorers`, `keepers`, `scouts`,
  `siphoners`, plus a special-cased `warehouseShip`. A ship's role is
  either derived (`assignRole()`, based on cargo capacity/mounts/frame)
  or a durable manual override (`setShipRole()`, persisted via
  `fleet_flags` and reapplied at boot by
  `restorePersistedManualRoles()`).
- Runs one `tick()` per scheduler cycle: refresh credits, chart occupied
  systems, refresh gate-construction status, run contract logic, compute
  dispatch routes, resolve every `maybe*()` controller (buy a ship, buy a
  scout, buy a siphoner, install a scanner, resolve a pending
  keeper-probe approval, repair, explore), commit ship intents, then let
  the scheduler actually drive each ship's next real action.
- Exposes the read/write surface the HTTP dashboard layer calls into —
  `getIntel()`, `computeDispatchRoutes()`, `fleetStatusSummary()`,
  `setShipRole()`, `sellShip()`, etc.

### Roles, briefly

| Role | Job |
|---|---|
| `trader` | Runs a `RouteDispatcher`-assigned trade leg (arbitrage, warehouse buy/sell, contract buy, mission haul) — see `TraderAgent` (`trader.ts`). |
| `miner` | Extracts resources at an asteroid field, feeding the warehouse or a trader pickup. |
| `surveyor` | Generates surveys for miners to consume (`SurveyPool`). |
| `tour` | Visits waypoints across a system (and beyond, via jumps) to keep market/shipyard data fresh — the main source of the price data routes are computed from. |
| `explorer` | Charts new systems the fleet hasn't seen (`chartOccupiedSystems()`/`autoExplore()`). |
| `scout` | Similar to a tour ship but tasked at specific targets (see `scout.ts`). |
| `siphoner` | Extracts gas giants' resources (`siphoner.ts`), parallel to mining. |
| `keeper` | A stationary probe/satellite parked at one waypoint to keep its market data from going stale without a full tour revisit. |
| `warehouse` | One designated ship acting as a staging point for buy/sell/haul coordination — not really a "role" in the trading sense, more an operator-designated depot. |

### Routing: `RouteDispatcher`

`computeDispatchRoutes()` (fleet.ts) computes every profitable
buy/sell/haul candidate from fresh market snapshots, then
`RouteDispatcher.recompute()` (`dispatcher.ts`) hands each trader a
*distinct* assignment (`TraderAssignment`: `direct`/`buy`/`sell`/`haul`/
`contractBuy`, each with a good, price data, and profit) so no two
traders converge on the same good and collapse the market. A
cross-system `direct` assignment additionally requires
`GalaxyAtlas.canJump()` to be true for that system pair — a route can be
computed and displayed without a confirmed gate, but never *assigned*
without one (this exact gate was the subject of two real incidents; see
`CHANGELOG.md`'s gate-construction/jump-cost persistence entries).

### Intent: what a ship wants vs. what it's doing

`ShipIntentBoard` (`intent.ts`) is a small arbitration layer: every
`maybe*()` controller *proposes* a goal for a ship (trade, mine, tour,
explore, keep, repair, tender, hold, scrap, survey, siphon) each tick,
and `intents.commit()` resolves conflicting proposals to one committed
goal per ship, respecting priority (an operator hold beats a rescue,
which beats routine work) and stickiness (a busy ship keeps its current
goal unless something strictly more urgent preempts it). `agentStep.ts`
is what actually turns a committed intent into ship movement/actions.
This intent/commit split is also what backs the dashboard's "wants" vs.
"doing" display — the observed state (`nav.status`) and the intended one
(`intent.goal.kind`) are surfaced side by side specifically so a stalled
ship (wants X, doing nothing) is visible without reading logs.

### Scheduling and rate limiting

`Scheduler` (`scheduler.ts`) is a priority queue (0 rescue, 1 mission, 2
trade, 3 survey/keeper, 4 telemetry) that admits tasks against a shared
token-bucket budget (`SchedulerBudget`), so rescue work always gets
through even when the fleet is saturated. `ShipRegistry`
(`shipRegistry.ts`) is the "who currently owns this ship" claim table —
`operator`/`rescue`/`repair`/`mission`/`warehouse`/`keeper`/`auto` — used
to stop two controllers from both trying to fly the same hull at once.

### Operator approval gate

`ApprovalGate` (`approvals.ts`) lets a small number of consequential,
engine-initiated decisions pause for a human instead of executing
outright, without ever blocking the fleet if nobody's watching:
`request(kind, opts)` is DB-polled (not an in-memory await, since the
process restarts constantly), auto-decides after a timeout
(`onTimeout: "approve"|"deny"`), and holds a denial for a cooldown
window (default 15 minutes, no backoff/escalation) before asking again.
As of 2026-09-13 only two decisions are gated this way (`buyShip`,
`buyKeeperProbe`) — see `docs/TODO.md` for the open item to gate more.
One subtlety worth remembering: a decision that resolves to "buy" isn't
safe to consume until whatever real-world precondition the purchase
needs (e.g., SpaceTraders requiring one of the agent's own ships
physically docked at a shipyard to buy there) is actually true *right
now*, not just true when the request was first made.

## Galaxy knowledge

`GalaxyAtlas` (`galaxy.ts`) is the fleet's map of the universe: charted
systems/waypoints, learned per-gate-pair jump costs
(`jumpCosts`/`recordJumpCost()`), and gate-construction status
(`gateConstruction`/`canJump()`/`refreshGateConstruction()`). Both of
the latter two caches are also durably persisted to shared
(no-`tenant_id`) tables and reloaded at boot (`loadJumpCosts()`,
`loadGateConstruction()`) — an in-memory-only cache here is exactly the
bug class that broke cross-system routing twice in one day (2026-09-13):
the pricing side (`jumpCosts`) and the gate-confirmation side
(`gateConstruction`) both needed the same fix independently.
`GalaxyCrawler` (`galaxyCrawler.ts`) is the background process that
walks the whole known galaxy for the public cartography page, separate
from any one tenant's fleet.

## Persistence

`Store` (`src/db/store.ts`) is the one class every tenant-scoped and
shared-table read/write goes through — ledger entries, fleet role
overrides, market snapshots, shipyard/module catalogs, held routes,
pending approvals, doctrine settings, replay samples, and more.
Migrations (`migrations/*.sql`, run via `src/db/migrate.ts`) are plain
SQL, applied automatically at boot. The recurring persistence pattern
introduced repeatedly this project's history: identify an in-memory-only
cache that would otherwise be silently wiped on restart, add a durable
table (shared vs. tenant-scoped depending on whether the fact belongs to
the galaxy or the tenant), add a `Store` read/write pair, and load it
once at `FleetManager.init()`.

## HTTP / dashboard layer

`src/cli/index.ts` boots the Express app: health check first (for
Render's zero-downtime deploys), then session/auth routes
(`session.ts`, `cookies.ts`, `gate.ts`), the public cartography page
(`cartography.ts`), the admin screen (`admin.ts`), then the tenant
dashboard API (`dashboard.ts` — bridge/markets/dispatch/fleet/contracts/
missions/approvals/warehouse/keeper endpoints), then `uiVersions.ts`
(explicit routing for versioned frontend builds), then
`express.static` serving whichever UI version is current.

### Frontend versions

`public/v2.html` through `v6.html` (plus matching `.js`/`.css`) are
successive frontend iterations, kept side by side rather than replaced
in place — `uiVersions.ts`'s own comment explains why (a direct link to
an older version should keep working). **v6 is the current default**
(`index: "v6.html"` in `src/cli/index.ts`). Shared, version-independent
logic (API calls, session handling, the reactive store, domain
formatting, map math) lives in `public/shared/*.js`, imported as ES
modules — this was a deliberate extraction (Phase 0 of a larger
refactor) to stop each new version from re-copying identical fetch/state
code.

v6 has two largely independent presentations sharing the same data
store: a desktop layout (`.view[data-view=...]` sections, switched by
`setView()`/`currentView`) and a mobile layout (`#mobile-view`'s
`.m-screen[data-mscreen=...]` sections, switched independently by
`setMobileView()`/`mobileView`). This split is the source of at least
one real bug (2026-09-13: mobile's Ops screen was simply missing an
Approvals pane the desktop `view-ops` section had) and is the subject of
an open TODO item — whether the mobile side should be redesigned
mobile-first rather than kept as a condensed reflow of the desktop
layout.

## Doctrine

`Doctrine` (`doctrine.ts`) is the tenant's own tunable-settings layer —
named rules (`minerTarget`, `snapshotMaxAgeMin`, `autoKeeperProbes`,
margin floors, etc.) with a value, an enabled flag, and whether they're
actually wired into a real decision ("enforced") — surfaced to the
operator as the dashboard's Standing Orders sliders/toggles. Contracts
(`contract.ts`) and construction missions (`mission.ts`) are separate
subsystems with their own accept/fulfill lifecycles, each feeding demand
into the same `RouteDispatcher` via `contractBuy`/`haul` assignments
rather than running their own independent ship-picking logic.

## What's deliberately not covered here

This is a map of the shape, not an exhaustive reference — the real
detail for any one piece lives in that file's own comments (this
codebase leans heavily on "why" comments at the point of the decision
rather than a separate design doc for everything). The `docs/*.md`
design/exploration docs referenced from `docs/TODO.md` cover specific
proposed changes (API request priority, rate-limiter saturation,
mutation safety, API-capacity doctrine, the k8s exploration) in more
depth than belongs here.
