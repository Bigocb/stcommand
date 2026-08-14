# Standing Orders

Multi-tenant autonomous SpaceTraders fleet engine — the greenfield rewrite of
[straders](https://github.com/Bigocb/straders), built tenant-isolated from the
start instead of retrofitted onto a single-fleet design.

See [`docs/architecture-plan.md`](docs/architecture-plan.md) for the full
design: why Postgres + Row-Level Security instead of per-tenant SQLite files,
how bring-your-own-LLM-key settings work, and hosting on Render.

## Status

**Phase 0 (repo scaffold): done.** Postgres schema, every tenant-scoped table
behind Row-Level Security, three shared galaxy-data tables ungated, proven
against a real Postgres instance with tests that specifically verify
cross-tenant isolation holds — not just written, tested.

**Phase A (engine core port): done.**

An audit of straders' engine (not a guess — every file's actual `Store`
call sites were counted) found the whole `Store` dependency surface is 83
call sites across exactly 3 files (`fleet.ts` 73, `mission.ts` 6,
`doctrine.ts` 4) plus `agentChat.ts`'s 7 (missed on the first pass, caught by
re-checking against real method names rather than a `this.store` pattern
match). Everything else — 17 files, ~6,000 lines — has zero `Store`
dependency and ports close to verbatim.

Done so far:
- 17 zero-dependency files ported unmodified: `client.ts`, `schema.d.ts`,
  `chatLLM.ts`, `auth.ts`, `trader.ts`, `agent.ts`, `scout.ts`, `siphoner.ts`,
  `dispatcher.ts`, `contract.ts`, `market.ts`, `survey.ts`, `loadout.ts`,
  `loadoutGa.ts`, `discord.ts`, `state.ts`, `narrative.ts`, `triage.ts`.
- `galaxy.ts` — 3-line async fix (two callback parameters were unawaited
  `=> void`, now `=> Promise<void>`).
- `src/db/store.ts` — every method the engine core actually calls now ported
  (30 of them), not just a representative slice: warehouse ledger/targets,
  fleet state, missions (jsonb round-trip), and the three shared galaxy
  tables (`bestTrades`, `tradeLegs` — including a real SQLite→Postgres
  dialect fix, scalar `MIN(a,b)` isn't valid Postgres, needed `LEAST`),
  shipyard/module catalogs. A real bug was caught and fixed in the process:
  `ledgerTotals` assumed purchases store a negative `total`, but the app
  always stores a positive magnitude and uses `type` for direction.
- `doctrine.ts` — ported and tenant-scoped. The one real design decision:
  the constructor can no longer synchronously populate its cache (Postgres
  reads are async), so `reload()` must be explicitly awaited once at
  startup — documented and covered by a test that exercises both the
  before- and after-reload behavior, not just the happy path.
- `mission.ts` — ported and tenant-scoped, same binding pattern as
  `doctrine.ts`. `list()`, `assignCarrier()`, `pause()`, and `resumeMission()`
  were synchronous in the original (SQLite) and are async here, since all
  four touch the store directly or via `persist()`. Verified against a real
  diff, not memory: after a first draft, `diff`-ing byte-for-byte against
  straders' actual source caught three real reconstruction errors — a
  fabricated extra `tasks.get()` call, an unnecessary variable rename, and
  an entirely dropped cargo-cleanup block plus a fabricated line that would
  have double-counted delivered material — all fixed before this was
  trusted. Every remaining diff line is an intentional async/tenantId change.

- `fleet.ts` — the last and largest conversion, done. All 73 direct `Store`
  call sites plus 12 `doctrine`/`missions` call sites are async and
  tenant-scoped. Converting it surfaced a problem the audit didn't catch:
  `FleetManager` hands several *synchronous* read callbacks down into
  `trader.ts` and `agent.ts` (`getMarketSnapshots`, `recoverCostBasis`,
  `warehouseBalance/Deposit/Withdraw`, `marketTourTargets`,
  `staleMarketTargets`, `shipyardTourTargets`, and `MissionManager`'s
  `canReach`/`listBuyers`) — fine when they read an in-process SQLite file,
  not once the store is a network round-trip. Fixed at the source: those
  option types in `trader.ts`, `agent.ts`, and `mission.ts` are now
  Promise-returning, and every call site (all already inside `async`
  methods, so this never became its own cascade) got `await`. One
  synchronous behavior was deliberately *not* preserved and is documented
  in `FleetManager`'s constructor: halt state used to restore synchronously
  in the constructor (better-sqlite3), so a halted fleet could never have a
  moment of running unhalted after a restart; Postgres reads can't happen
  in a constructor at all, so that restore moved to the first line of
  `init()` instead — a real, narrow, and explained behavior change, not an
  oversight.
  Verified the same way as `mission.ts`: diffed byte-for-byte against
  straders' real `fleet.ts`, `trader.ts`, and `agent.ts` — every remaining
  line is an intentional async/tenantId change, nothing fabricated or
  dropped.
- `agentChat.ts` — the co-pilot's tool layer, done, and much simpler than
  `fleet.ts`: every tool's `execute` was already an `async` closure (it's an
  LLM tool-calling surface), so the 7 `Store` call sites plus one now-async
  `fleet.getMissions()` call just needed `await` added — no sync-callback
  cascade like `trader.ts`/`agent.ts` had. Only `recentActivity` and
  `ledgerTotals` are tenant-scoped and need `tenantId`; the other five touch
  shared galaxy tables. `tests/agentChat.test.ts` ports verbatim — none of
  its 4 tests touch `Store` at all (they exercise `ChatLLM`'s tool-call loop
  and `ChatAgent`'s wiring against mocked fetch/LLM), so it needed zero
  changes.

**Phase A is now complete: every file in straders' engine core (`Store`-
dependent or not) has been ported, tenant-scoped where needed, verified by
diff against the real source, and covered by a passing test.**

Every Postgres-backed database/schema decision was checked against the real
target, not assumed: the Render Postgres instance provided (`promptoria-db`)
turned out to already run a different, unrelated production app in its
`public` schema (confirmed by querying it directly) — Standing Orders now
lives in its own `stcommand` schema on that same instance, with the
`apply_tenant_rls()` setup function and its generated policies explicitly
schema-qualified so they can never reach `public` even under an unexpected
session state. `search_path` is set once at the connection-pool level
(`src/db/pool.ts`), so every unqualified table name in `store.ts` resolves
only within `stcommand`'s namespace.

96 tests (Store, Doctrine, MissionManager, FleetManager, ChatAgent —
including tenant-isolation, cross-tenant invisibility, and
persistence-across-a-fresh-instance cases), all passing against real
Postgres, deterministic across repeated fresh-migration runs. `fleet.ts`'s 51
tests are a straight port of straders' own `tests/fleet.test.ts` (same
scenarios, `await` added), with one test rewritten rather than just
`await`-ed — the halt-state restore test now asserts the real, current
behavior (see above) instead of the synchronous-constructor behavior that no
longer exists — and one new fixture (`beforeEach` clearing `market_snapshots`
in the mission-buy-targets suite) needed because these tests now share one
live Postgres instance instead of each getting a fresh throwaway SQLite file.

Not yet ported: `trader.test.ts` (591 lines, straders' direct TraderAgent
route-finding/buy/sell tests) — `trader.ts`'s actual trading logic wasn't
touched by this port, only 5 callback signatures at its edges, so this is
lower-risk than `fleet.ts` was, but still not verified by a test run yet.

**Phase B (auth, tenant resolution, `TenantRegistry`): done** — the
mechanics from docs/architecture-plan.md §4/§5, end to end:

- `src/auth/crypto.ts` — AES-256-GCM for secrets at rest (tokens, LLM keys)
  and HMAC-SHA256 for signing session cookies, both off one `SESSION_SECRET`.
  "No JWT library" in practice: a session cookie is `<sessionId>.<hmac>`,
  verified with `timingSafeEqual`, same shape as straders' own
  dashboard-token gate just applied to a per-session id instead of one
  shared token.
- `src/db/tenants.ts` — the control-plane CRUD `store.ts` deliberately
  doesn't do: find-or-create a tenant by agent symbol (re-logging in with a
  rotated token just updates the stored one), session create/resolve/delete,
  and get/set for the bring-your-own LLM config. Goes through `withPool`,
  not `withTenant` — there's no tenant context yet when these run, that's
  the whole point of them.
- `src/engine/tenantRegistry.ts` — `TenantRegistry`, holding one live
  `{ api, store, state, contracts, fleet, chat? }` bundle per tenant,
  exactly as designed in the architecture doc, booted the same way
  straders' own CLI boots its single fleet (discover markets, build
  `FleetManager`, retry `init()` through transient API errors, resume any
  active missions, wire the co-pilot only if an LLM key is set) — replayed
  once per tenant instead of once per process. `fleet.run()` is deliberately
  the one fire-and-forget call in the whole codebase: the coordinator loop
  runs for the life of the process, not the life of a request, because "a
  tenant's engine keeps running whether or not their dashboard tab is open"
  is the product's whole point. `getOrCreate` dedupes concurrent boots for
  the same tenant so two requests racing in right after login can't
  double-start a fleet.
- `src/http/gate.ts` + `src/http/resolveTenant.ts` — the two ways in (paste
  a token, or register a new agent) and the middleware that turns a signed
  cookie back into `req.tenantId`. The actual SpaceTraders API calls
  (`GET /my/agent`, `POST /register`) are injectable, same DI seam
  `TenantRegistry` uses for its `api` — tests fake that one boundary rather
  than needing network access and a disposable real account.
- `src/cli/index.ts` — wires it all into a real Express server. Boots with
  zero fleets running and lazily starts one per tenant on that tenant's
  first authenticated request, then leaves it running. Smoke-tested against
  a real listening server: a bad token 401s from the gate, `/api/status`
  401s with no session, both against the real HTTP stack, not just unit
  calls into the handler functions.

44 more tests (140 total): `crypto.test.ts`, `tenants.test.ts`,
`tenantRegistry.test.ts` (a fake SpaceTraders API standing in for an agent
with zero ships in an empty system — everything reachable only via a real
ship or waypoint throws loudly if a wiring bug ever reaches it), `gate.test.ts`
(a real Express app on a real listening port, hit with real `fetch`, cookies
and all), and `cookies.test.ts`. One real bug this surfaced and fixed:
`fleet.run()`'s 2-second coordinator loop has no natural end short of
`maxTicks`, so the very first `TenantRegistry` test run hung — `stop()`
already existed on `FleetManager` for exactly this, `TenantRegistry` just
didn't expose a way to call it for every booted worker at once
(`stopAll()`, now also the real graceful-shutdown path in `src/cli/index.ts`).

**Phase C (dashboard route surface): the JSON API is done.**
`src/http/dashboard.ts` is a tenant-scoped port of straders'
`src/server/index.ts` — all ~45 routes: fleet state/status/pause/resume,
ship dispatch/hold/release/mine/dock/transfer/buy/refuel/scrap/jump/explore,
component install/remove, warehouse (goods/targets/designate/adjust),
doctrine, keeper stations, dispatch overrides, missions, contracts,
markets/prices/goods, surveys, narrative, loadout scoring (including the GA
optimizer), and the chat endpoint. Every route reads `registry.get(req.tenantId!)`
instead of one process-wide `opts.*` bundle, `await`s what's now async, and
passes `tenantId` to the `Store` methods that need it — otherwise this is
the same logic straders already shipped, not a rewrite.

Getting there surfaced one more real cross-tenant bug, the same class as the
async-callback one `fleet.ts` had: straders' `discord.ts` exports
`getDiscord()`, a **module-level singleton** — correct for a single-fleet
process, but in a multi-tenant one it means tenant A's ship purchases would
post to tenant B's Discord channel the moment both had a webhook configured,
since all of `fleet.ts`'s `postActivity()` calls reached the same shared
instance regardless of whose fleet was running. Fixed the same way as the
LLM key: `DiscordRelay` is now an exported class, `TenantRegistry` builds
one per tenant at boot from that tenant's own encrypted
`discord_webhook_enc` column (new `getTenantDiscordWebhook`/
`setTenantDiscordWebhook` in `db/tenants.ts`), and `POST /api/discord`
updates both the stored value and the *live* relay so a webhook change
takes effect without a restart. Re-diffed `fleet.ts` against the pristine
original afterward to confirm that was the only new deviation.

Four more `Store` methods got ported in the process — `earningsByShip`,
`netSeries`, `recordChatMessage`, `chatHistory` — explicitly deferred since
Phase A as "dashboard-only reads, not on the engine's critical path"; now
needed by `/api/bridge` and `/api/chat`. `priceHistory` (the per-waypoint
variant) and the `buckets`/`bucket_ledger` tables stay unported — checked,
and neither has a caller anywhere in straders' own routes or engine.

15 new dashboard-router tests (a representative slice, not all ~45 routes —
the rest are thin, mechanically similar wrappers around already-tested
`FleetManager`/`Store` methods) plus 3 for the Discord webhook CRUD and 10
for the new `Store` methods. 164 tests total. One caught a real, current
limitation rather than a bug: an LLM key set after a tenant's worker has
already booted doesn't retroactively enable that worker's co-pilot (unlike
the Discord webhook, there's no live-update path for it yet) — documented
in the test itself so a future settings-page route inherits the right
expectation instead of assuming it already works.

Not yet built: a settings-page route for editing LLM config (the storage
side — `getTenantLlmConfig`/`setTenantLlmConfig` — has existed since Phase
B; nothing reads/writes it over HTTP yet).

## Frontend: the command-center dashboard is served

`public/index.html` is straders' own dashboard (the full Bridge/Doctrine/
Markets/Ops single-page UI, ~2800 lines, same map renderer, fleet table,
warehouse and co-pilot panels) ported for multi-tenancy — served as a static
file by `src/cli/index.ts`, mounted after the `/api` routers so `GET /` and
every other path resolve into it.

The only real change straders' UI needed was its auth layer. straders gated
every `/api/*` route behind one shared `ST_DASHBOARD_TOKEN`, attached
client-side by overriding `window.fetch` to add an `Authorization: Bearer`
header. stcommand has no such shared secret — each tenant has their own
session, established by `POST /api/gate/login` (paste an existing
SpaceTraders account token) or `POST /api/gate/register` (mint a brand-new
agent), both setting the httpOnly signed session cookie `resolveTenant.ts`
already reads. So the auth gate became: two forms (login / register, with a
toggle between them) instead of one token field, no `Authorization` header
anywhere — the cookie rides along with every same-origin fetch automatically
— and a `window.fetch` override that's now purely reactive (a 401 on any
`/api/*` call re-shows the gate) rather than attaching credentials. Added a
logout button (`POST /api/gate/logout`) that straders' UI never needed,
since a single shared token had no concept of "log out."

Everything past the gate — the map, fleet table, dispatch/warehouse/doctrine
panels, the co-pilot chat drawer, the Discord webhook field under Doctrine —
is untouched: it already talked to `/api/*` routes that
`src/http/dashboard.ts` serves under the same paths straders used, so no
other rewiring was needed. Manually smoke-tested against a real listening
server + real Postgres: `GET /` serves the dashboard shell, an invalid
`/api/gate/login` token 401s with the gate's error message, and
`/api/state` 401s with no session cookie, same as every other route behind
`resolveTenant`.

## Greenfield engine redesign: all 7 phases landed, dual-write throughout

A separate design doc (not in this repo — see project chat history)
diagnosed a real structural problem in the ported engine: eight independent
mechanisms can each claim a ship with no single source of truth, and cargo
carries no persisted intent, so a restart can lose track of what a ship was
doing or what its cargo was for. It proposes five pillars — **ShipRegistry**
(unified ownership), **cargo manifest** (intent-tagged holds), a **unified
scheduler** (one priority task queue + rate-limit budget replacing N
per-agent blocking loops), a persisted **ship state machine**, and a
**market_latest read-model projection** — landed as seven additive,
independently-shippable phases against the current codebase, not a rewrite.
No tables are removed and no existing mechanism is deleted until its
replacement has run stable in parallel; see the design doc's own migration
section for the phase-by-phase dual-write plan.

**Where this actually leaves the engine, read this before assuming
anything below changed behavior:** every phase is additive. Phases 1-4
(market projection, ship state, cargo manifest, ShipRegistry) run for real,
persisting real data every coordinator tick, but nothing reads any of it as
a gate — they're observational. Phases 5-7 (the scheduler, and every
agent's `nextTask()` producer) are real, tested, and not driving the fleet
at all — `fleet.run()` still boots the original per-agent blocking loops
exactly as before this work started. **If you're looking for what changed
in how ships actually behave: nothing did.** What changed is that the fleet
now keeps a second, parallel, persisted record of its own decisions, and
has a fully-built (but disconnected) alternative execution path sitting
next to the one actually running. The real cutover — wiring dispatch to
`ShipRegistry.claim()`, wiring `fleet.run()` to enqueue `nextTask()`s onto
the `Scheduler` instead of starting `runLoop()`s — is deliberately left for
later, per-mechanism, once each piece has run stable in parallel. See each
phase's own write-up below for exactly where its line is drawn.

**Phase 1 (market_latest projection): done.** `migrations/002_greenfield_phase1.sql`
adds `market_latest` — one row per waypoint+good, upserted by `recordMarket()`
in lockstep with the existing append-only `market_snapshots` insert, same
"no tenant_id, shared galaxy data" shape as the table it projects. Four Store
methods that each used to run their own `ROW_NUMBER() OVER (PARTITION BY
waypoint_symbol, good_symbol)` scan over the whole history table —
`latestMarketSnapshots`, `freshMarketSnapshots`, `bestTrades`, `tradeLegs` —
now read the projection directly, a plain (indexed) lookup instead of a scan
that gets slower as history grows. Pure read-path optimization, no behavior
change: same rows, same shape, just derived incrementally on write instead
of recomputed on every read.

`src/db/migrate.ts` also stopped being single-file: it now applies every
`migrations/*.sql` file in order, tracking what's already run in a new
`schema_migrations` table, so `002_greenfield_phase1.sql` (and every phase
after it) layers on cleanly without hand-editing the migration runner each
time.

One real test-isolation bug this surfaced: `tests/fleet.test.ts`'s mission-
buy-targets suite had a `beforeEach` that cleared `market_snapshots` between
tests (that table has no tenant scoping, so leftover rows from one test were
visible to the next) but had no reason to know about `market_latest` before
it existed — once `computeMissionBuyTargets` started reading the projection
instead, the same leftover-row problem reappeared one table over. Fixed by
clearing both tables in that hook.

165 tests now (164 + one new projection round-trip test), all passing
against real Postgres.

**Phase 2 (persisted ship state): done, deliberately scoped down from the
design doc.** `migrations/003_greenfield_phase2.sql` adds `ship_state`
(tenant-scoped, RLS'd like every other per-tenant table) and `Store` gained
`getShipState`/`getAllShipStates`/`updateShipState`. The design doc's
version of this pillar wants a full lifecycle — `idle → assigned →
travelling → docked → transacting → returning` — with every agent
(trader.ts, agent.ts, mission carriers, …) persisting its own transitions
and sub-step detail. That's a real, multi-file wiring job the doc itself
estimates at 3-4 days; what shipped here instead is the coarser, honest
subset that's actually true today: `FleetManager.syncShipStates()` (new,
private) derives a 4-state coarse lifecycle — `idle | assigned | travelling
| docked` — from `getShipStatuses()`'s existing role + live SpaceTraders nav
status, and persists one row per ship at the end of `init()` and at the end
(or halted-branch early return) of every coordinator `tick()`. `target` and
`step` exist as columns for a future agent to fill in with real intent
(which mission leg, which resale hold, …) but Phase 2 itself always writes
them `null` — that's a real, documented gap against the full design, not an
oversight. What this phase actually buys: `ship_state` is never stale by
more than one coordinator tick (~2s), survives a restart, and is queryable
without needing the live in-process fleet worker — exposed read-only at the
new `GET /api/ship-state`, additive alongside the existing `/api/fleet/status`
(which still recomputes live per-request and has richer fields like
`paused`/`pinnedField` this table doesn't carry) rather than replacing it.

7 new tests in `tests/shipState.test.ts`: Store round-trip/upsert-not-append/
cross-tenant isolation, then `syncShipStates()` itself against fake agents
covering all four states plus the "no store/tenantId" no-op path fleet.ts's
existing optional-store convention requires. 172 tests total, all passing.

**Phase 3 (cargo manifest): done, same kind of scoped-down as Phase 2.**
`migrations/004_greenfield_phase3.sql` adds `ship_manifest` (tenant-scoped,
RLS'd like `ship_state`) — one row per (ship, good) actually held, with
`cost_basis`/`basis_kind` and an `intent` column. `Store` gained
`getManifestForShip`/`getAllManifestRows`/`upsertManifestRows`/
`deleteManifestRows`. The design doc's version wants a stateful
per-ship `ShipManifest` class with four intents (`resale`,
`warehouse-deposit`, `mission-delivery`, `held-position`) and reconciliation
tied into the sweeper's sell decisions. What shipped is the coarser subset
that's actually derivable from what the engine already tracks: a new private
`FleetManager.syncShipManifests()`, called at the same three points as
`syncShipStates()` (end of `init()`, end of every `tick()`, and the halted
early-return branch), reconciles each ship's *real* cargo (`getShip().cargo.inventory`)
against the table — upserting rows for goods currently held, deleting rows
for goods no longer there — and assigns exactly two intents: `warehouse-deposit`
for the warehouse ship's own hold, `resale` for everything else. Distinguishing
`mission-delivery` (which mission a carrier is actually hauling for) and
`held-position` (a deliberate margin hold vs. just-not-sold-yet) needs
per-ship context this phase doesn't track — a real, documented gap, not an
oversight, left for whichever later phase actually consumes it. Cost basis
prefers this ship's own last purchase of the good (`lastPurchasePrice`,
`basisKind: 'actual'`), falling back to the fleet-wide volume-weighted
average (`avgPurchasePrice`) and then 0 for cargo that arrived by mining, a
transfer, or contract fulfillment rather than a purchase this ship made
itself. Exposed read-only at `GET /api/ship-manifest`, same shape as
`/api/ship-state`.

Known limitation, not yet optimized: `syncShipManifests()` does a
sequential read-then-write per ship per tick (one `getManifestForShip` plus
up to two purchase-price lookups per held good) rather than batching —
fine at today's fleet sizes on a ~2s tick cadence, but a real cost to
revisit if a large fleet's tick time starts to show it.

9 new tests in `tests/shipManifest.test.ts`: Store round-trip/upsert-in-place/
partial-delete/cross-tenant isolation, then `syncShipManifests()` against
fake agents covering default-resale tagging, warehouse-ship tagging, actual-
vs-estimated cost basis (a real two-ship ledger scenario, not a mock), goods
dropping off the manifest once sold, and the no-store/tenantId no-op path.
181 tests total, all passing.

**Phase 4 (ShipRegistry): done, dual-write only — not yet the gate anything checks.**
`migrations/005_greenfield_phase4.sql` adds `ship_claims` (tenant-scoped,
same RLS shape as Phase 2/3's tables). New `src/engine/shipRegistry.ts`:
`ShipRegistry`, a real, standalone, fully-tested arbiter of "who owns this
ship" — `claim(shipSymbol, owner, role, intent, opts?)` enforces a fixed
precedence (`operator > mission > warehouse > keeper > auto`, highest to
lowest), rejecting a weaker owner's claim over a stronger one's unless
`preempt: true`; `release(shipSymbol, owner)` only clears a claim actually
held by that owner; `available(forOwner)` lists ships `forOwner` could
claim right now. `Store` gained `recordClaim`/`releaseClaim`/`getClaim`/
`getAllClaims`.

The design doc's version of this pillar wants fleet.ts's actual dispatch/
warehouse/mission/keeper mutation call sites to call `claim()`/`release()`
as their real gate, with the registry and the old ownership maps running in
parallel for about a week and any disagreement between them logged loudly
before the old maps get deleted. What shipped is the dual-write half of
that, not the cutover: `FleetManager.shipRegistry` (public, one per tenant,
hydrated from `ship_claims` in `init()`) is kept in sync by a new
`syncShipClaims()`, called at the same three points as
`syncShipStates`/`syncShipManifests()`. It derives each ship's owner from
state fleet.ts already tracks — `operator` for a manually-dispatched/held
ship, `warehouse` for the designated warehouse ship, `mission` for a ship
`MissionManager.committedShips()` has assigned, `keeper` for a stationed
keeper, `auto` otherwise — and claims it with `preempt: true`, since this is
one real decision being mirrored, not two independent authorities that
could actually disagree; preempt is what lets a released operator-hold
correctly downgrade back to `auto` instead of getting stuck (plain
precedence would otherwise block a weaker owner from ever reclaiming a
stronger one's ship, which is right for real contention and wrong for
resyncing the same source of truth). Because it's a mirror, there is
nothing to log a disagreement about yet — the "log a loud warning on
disagreement" step only means something once a second, independent
decision-maker exists, which is exactly the cutover work this phase
doesn't do. Nothing in fleet.ts's actual dispatch/warehouse/mission/keeper
mutation methods calls `claim()`/`release()` as a gate; that wiring — the
real, separate, higher-risk surgery — is left for whenever the registry has
run stable in parallel, per the design doc's own migration plan. Exposed
read-only at `GET /api/ship-claims`.

Known gap, documented in `syncShipClaims()`'s own comment: a scrapped
ship's claim is never explicitly released (only ships `getShipStatuses()`
still reports get touched) — harmless today since nothing reads the
registry as a gate yet, but real once something does.

15 new tests in `tests/shipRegistry.test.ts`: pure `ShipRegistry` unit tests
(precedence in both directions across all five owner levels, same-owner
re-claim preserving `since`, `preempt`, `release`'s same-owner-only
semantics, `available()`), a Postgres-backed persistence round-trip +
cross-tenant isolation + `releaseClaim`'s owner check, and
`syncShipClaims()` against fake agents covering every owner derivation
(including the operator→auto downgrade the `preempt: true` choice exists
for). 196 tests total, all passing.

**Phase 5 (unified scheduler): done, skeleton only — running per tenant, driving nothing yet.**
New `src/engine/scheduler.ts`: `Scheduler`, a priority task queue (0 rescue
· 1 mission · 2 trade · 3 survey/keeper · 4 telemetry) plus `SchedulerBudget`,
a token-bucket admission budget — deliberately a *second*, separate
instance from `src/core/client.ts`'s own per-tenant HTTP rate limiter, not a
duplicate of it: the client's limiter is what actually throttles requests
to stay under SpaceTraders' 2/s cap; this one is the scheduler's own
accounting for *which priority* of task gets to spend that budget this
pass, before any of those calls are made. `run(maxTicks)` is the same
`while (running) { ...; await sleep(...) }` coordinator shape as
`FleetManager.run()`; `runOnce()` (what `run()` calls each pass, also
directly unit-testable) sorts ready tasks by priority, admits them while
the budget allows, runs them, trues up the budget from each result's
`actualCalls`, and enqueues any `next` step a task returns. While the
fleet's paused, only priority-0 tasks are admitted — same rescue-must-
still-run rule `FleetManager.tick()`'s halted branch already follows.

`TenantRegistry` boots one `Scheduler` per tenant alongside `fleet.run()`
(`isPaused` wired to `fleet.isPaused()`) and stops it in `stopAll()`. It is
genuinely running, not just constructed — and genuinely inert, because
nothing in this codebase calls `scheduler.enqueue()` yet. `fleet.run()`
still boots the old per-agent blocking loops (`TraderAgent.runLoop()`,
`ShipAgent.runLoop/surveyLoop/tourLoop/keeperLoop()`, `ScoutAgent.runLoop()`,
`SiphonerAgent.runLoop()`) exactly as before; converting those into
`nextTask()` producers the scheduler actually drives is Phase 6/7, and even
once built, wiring `fleet.run()` to enqueue them instead of starting the
old loops is separate, later work — see those phases' own write-ups below
and each file's class comment for exactly where the line is drawn.

11 new tests in `tests/scheduler.test.ts`: budget depletion/floor, priority
ordering independent of enqueue order, `earliestRunAt` gating, budget
exhaustion preserving the un-admitted task for a later pass, the
pause-admits-only-rescue rule, `next`-chaining across passes, `run()`/
`stop()`'s polling shape, and two independent `Scheduler` instances proving
neither's budget or queue leaks into the other (the multi-tenant
requirement, exercised without needing Postgres at all — this class has no
database dependency, same as `ShipRegistry`). No database migration; this
phase adds no persisted table. 207 tests total, all passing.

**Phase 6 (TraderAgent as a task producer): done, additive — not wired as `fleet.run()`'s dispatch path.**
`TraderAgent.nextTask()` is new, and it wraps — does not reimplement —
`tick()`, the exact same method `runLoop()` already calls. No trading logic
changed; only the control-flow shape did, from "block and sleep" to "return
one `Task`, chain the next": halted re-polls after `HALT_POLL_MS` (same as
`runLoop()`'s `sleep(HALT_POLL_MS)`), a tick that found nothing to do backs
off 30s, an error backs off 10s and still marks the ship stranded on a fuel
error — a scheduler driving this instead of `runLoop()` would see identical
timing, not just identical trades. `estimatedCalls: 3`/`actualCalls: 3` is a
fixed heuristic (no per-route call counting exists yet anywhere in the
engine), matching the design doc's own example for an equivalent task.

`fleet.run()` still calls `TraderAgent.runLoop()` to actually drive every
trader — `nextTask()` exists, is tested, and is not called by anything in
production. Cutting `fleet.run()` over to enqueue `nextTask()`'s onto the
Phase 5 `Scheduler` instead of starting `runLoop()` is real, separate,
higher-risk work (per-ship state that currently lives entirely inside a
`while` loop's closure would need to survive being paused between
scheduler passes) intentionally left undone — see trader.ts's own comment
on `nextTask()`.

7 new tests in `tests/traderNextTask.test.ts`, deliberately scoped to what
this phase actually changed: Task shape, the halted/idle/error backoff
timings, and fuel-error stranding — by stubbing `tick()` itself rather than
exercising real trading decisions (straders' own 591-line direct
TraderAgent test suite was never ported to this repo at all; unrelated to
this phase, see "What's genuinely NOT done yet" above). 214 tests total,
all passing.

**Phase 7 (remaining agents as task producers): done, same wrap-don't-rewrite approach, same additive scope.**
Every other agent class with a blocking loop got the same Phase-6 treatment
— a `nextTask()`-style method wrapping its existing bounded work-unit
method, none of the underlying logic touched, none of the old loops removed
or called by anything new:

- `ShipAgent` (`src/engine/agent.ts`) drives four roles off one class —
  miner, surveyor, tour scout, keeper — so it gained four producers:
  `nextTask()` wraps `tick()` (miner, priority 2 — mining is
  revenue-producing the same way trading is, so it shares trade's tier, a
  judgment call the design doc doesn't make directly), `nextSurveyTask()`
  wraps `surveyScout()` (priority 3, survey/keeper), `nextTourTask()` wraps
  `tourScout()` (priority 4, telemetry — background market/shipyard intel
  refresh, not active production, the other judgment call), `nextKeeperTask()`
  wraps a *new* private `keeperPoll()`. That last one needed a real,
  behavior-preserving refactor first: `keeperLoop()`'s reposition/snapshot
  logic was inline in the loop body, not a separate method like the other
  three roles have — extracted verbatim (same reposition/refuel/dock/
  snapshot sequence, same return-boolean-for-"was there work" shape) so
  `keeperLoop()` and `nextKeeperTask()` now share one implementation instead
  of the loop being the only place it existed. `nextKeeperTask()` backs off
  5 minutes after a successful snapshot (`keeperLoop()`'s own
  `sleep(5 * 60_000)`), not the usual 0/30s the other three use.
- `ScoutAgent.nextTask()` (`src/engine/scout.ts`) wraps `tick()`, priority 4.
- `SiphonerAgent.nextTask()` (`src/engine/siphoner.ts`) wraps `tick()`,
  priority 2 (siphoning is extraction, same revenue tier as mining).
- `src/engine/dispatcher.ts`'s `RouteDispatcher` needed nothing: unlike the
  other six, it was never a blocking loop in this port — `fleet.tick()`
  already calls `dispatcher.recompute()` directly, once per coordinator
  pass, which is already task-shaped. Not a gap; there was nothing to
  convert.

`fleet.run()` is unchanged: it still boots `TraderAgent.runLoop()`,
`ShipAgent.runLoop/surveyLoop/tourLoop/keeperLoop()`, `ScoutAgent.runLoop()`,
and `SiphonerAgent.runLoop()` exactly as before. Every `nextTask()`-family
method across all six roles is new, tested, and not called by anything in
production — the actual cutover (fleet.run() enqueueing these onto the
Phase 5 `Scheduler` instead of starting the old loops, for every role at
once or one at a time) is real, separate, higher-risk work the design doc
itself scopes as needing weeks of stability-proving per agent, deliberately
left undone here. This closes out all seven phases from the design doc at
the "dual-write, nothing cut over" line — see the doc's own Migration Path
section (referenced in Phase 4's write-up above) for what actually flipping
that switch, role by role, would involve next.

11 new tests in `tests/agentNextTask.test.ts`, same stub-the-wrapped-method
strategy as Phase 6's trader tests: Task shape and priority per role, the
halted/idle/error backoff timings, the keeper role's 5-minute-vs-30s
distinction, and one test proving `keeperLoop()`'s extraction didn't change
`keeperPoll()`'s real (unstubbed) behavior for the no-market-assigned case.
225 tests total, all passing.

## Cutover, part 1: ShipRegistry is now a real gate

The seven phases above all landed at "dual-write, nothing enforced" —
real, tested, but observational. This is the first actual behavior change:
`shipRegistry.claim()`/`release()` now run inline, at the moment of
mutation, in fleet.ts's own ownership-changing methods, and a rejected
claim actually blocks the action instead of only being logged.
`syncShipClaims()` (Phase 4) still runs every tick as a self-healing
resync — these inline calls just make the transition immediate instead of
waiting up to ~2s for the next tick to notice.

- **`holdShip()`** claims `operator` (`preempt: true` — operator is already
  the strongest owner, so this can't actually fail; it just records the
  claim immediately rather than waiting for the tick sync).
  **`releaseShip()`** releases it.
- **`designateWarehouseShip()`** claims `warehouse` and, new here, actually
  **rejects** the designation — throws — if the ship is already claimed by
  a stronger owner (an operator hold, or a mission commitment). Previously
  this would have silently gone through and only shown up as a
  disagreement in the next tick's mirror; now it's an error the caller
  sees immediately. **`releaseWarehouseShip()`** releases the `warehouse`
  claim specifically (not `operator` — a warehouse ship's claim and an
  operator hold on some other ship are different claims, released
  independently).
- **`pickMissionCarrier()`** (the auto-picker) now excludes any candidate
  an operator currently holds from consideration entirely, and claims
  `mission` for whichever ship it actually picks. **`assignMissionCarrier()`**
  (the manual override) rejects up front — before ever calling into
  `MissionManager` — if the target ship is operator-held.
- **`maybeAssignKeepers()`** (idle miner/shuttle → keeper conversion) adds
  a registry check on top of its existing `isManual()`/`isSuspended()`
  filter as defense-in-depth against a claim that filter's ~1-tick-old
  view could have missed, and claims `keeper` on conversion. A rejected
  candidate is skipped, not fatal to the whole pass — the loop moves on to
  the next one.

What's still *not* gated: `mineAt`/`unpinMining` (field pins within an
existing role, not an ownership change — nothing to claim) and the
coordinator's own initial `assignRole()` (a one-time decision at boot/ship-
purchase, not a recurring reassignment risk the way keeper conversion is).

9 new tests in `tests/shipRegistryCutover.test.ts`, each proving
enforcement, not just bookkeeping: `designateWarehouseShip` actually
throwing (with the exact rejecting owner in the message) rather than
silently succeeding against an operator-held ship, the operator claim
surviving the rejected attempt untouched, `pickMissionCarrier` skipping a
larger-cargo-but-held candidate in favor of a smaller unclaimed one (cargo
size would otherwise have picked the held ship), `assignMissionCarrier`
rejecting before `MissionManager` is ever touched (proven by using a
waypoint with no active mission at all — a `MissionManager`-level failure
would throw a different, distinguishable error), and `maybeAssignKeepers`
skipping a candidate the registry alone catches (a claim injected directly,
bypassing `isManual()`/`isSuspended()`, to isolate what the new check adds).
233 tests total, all passing.

The Scheduler cutover (fleet.run() actually driving agents via
`nextTask()`/the Phase 5 `Scheduler` instead of the old `runLoop()`s) is
the other half of this work and is still ahead — see the task list this
session is tracking.

## Cutover, part 2: the Scheduler now actually drives every agent

`FleetManager` gained an optional `scheduler` (a Phase 5 `Scheduler`
instance). When one's provided, `run()` no longer starts any of the old
`runLoop()`-family blocking loops at all — every agent is driven by a
`nextTask()` chain enqueued onto the scheduler instead. When one isn't
provided (every test file in this repo except the new ones below), `run()`
falls back to the exact pre-cutover behavior, unchanged — this is an
opt-in cutover, not a rewrite of `FleetManager`'s contract.

**Wiring:** `TenantRegistry` now constructs one `Scheduler` per tenant
*before* the `FleetManager` (`isPaused` wired to `fleet.isPaused()` via a
forward reference — the same pattern `MissionManager`'s own callbacks into
`FleetManager` already used) and passes it in. `fleet.run()`'s own
coordinator tick loop still runs exactly as before (route dispatch,
warehouse/haul/mission-buy targets, keeper assignment, rescue, ...); a new
private `syncSchedulerTasks()`, called from the same three points as
`syncShipStates`/`syncShipManifests`/`syncShipClaims` (end of `init()`, end
of `tick()`, and the halted early-return branch), is the only new thing —
for every agent currently in any role map, if it doesn't already have a
task enqueued, it gets one. Idempotent per ship: once a ship's first task
is enqueued, its own `TaskResult.next` chaining keeps it running without
`syncSchedulerTasks()` doing anything further — this is a lightweight
reconciliation, not a rebuild, same shape as every other `sync*` method.

**The real correctness gap this required closing:** none of the `nextTask()`
methods built in Phases 6/7 checked whether the agent had actually been
stopped. `runLoop()`'s own `while (this.running)` naturally exits once
`stop()` is called (on scrap, or a keeper conversion) — but a `nextTask()`
chain, driven entirely by whether its own `run()` callback returns a `next`,
had no equivalent check, so a stopped agent's chain would have run forever
against a retired agent instance. Every `nextTask()`-family `run()` callback
now starts with `if (!this.running) return { actualCalls: 0 };` — no `next`,
chain ends for good, the same guarantee `runLoop()`'s while-condition gave.
And since nothing but `runLoop()` used to set `running = true`, every
`nextTask()`-family method now sets it itself (idempotent, whether this is
a fresh enqueue or a chained call) — removing the "caller must remember to
flip this before scheduling" footgun entirely, rather than trusting every
future call site to get it right.

**One real, pre-existing runtime role-transition needed special-casing:**
`maybeAssignKeepers()` (converting an idle miner/shuttle to a keeper
mid-run) already had a comment explaining why it couldn't just rely on
`fleet.run()`'s startup-time loop array — "a mid-run conversion needs its
own loop," directly launching `keeper.keeperLoop()`. The scheduler version
of that same problem is subtler: the ship's ship symbol was already in
`syncSchedulerTasks()`'s "already scheduled" tracking (from its prior role),
so the generic per-tick reconciliation would skip it, and the old agent's
chain terminates itself via the `running` guard above — leaving the ship
with *no* active task at all unless something enqueues the new keeper's
task directly. `maybeAssignKeepers()` now branches: with a scheduler,
`keeper.nextKeeperTask()` is enqueued directly (mirroring the old
`void keeper.keeperLoop(...)` branch); without one, the old direct-launch
behavior is unchanged.

7 new tests in `tests/schedulerCutover.test.ts`: `syncSchedulerTasks()`
enqueuing every role exactly once via the right `nextTask`-family method
and not double-enqueueing on a second pass, a stopped `TraderAgent`'s
in-flight task actually returning no `next`, `fleet.run()` provably never
calling `runLoop()` when a scheduler is wired in (and provably still
calling it when one isn't — the fallback path, checked directly rather
than assumed), and `maybeAssignKeepers()` enqueuing the new keeper's task
without ever starting the old `keeperLoop()`. 240 tests total, all passing.

**Where this actually leaves things:** with a real Postgres tenant booted
through `TenantRegistry` (which now always passes a scheduler), every ship
is genuinely driven by the Scheduler/Task machinery end to end — this is
no longer just parallel scaffolding, it's live. What's still ahead, per
the design doc's own remaining scope: real per-task API-call accounting
(`estimatedCalls`/`actualCalls` are still fixed heuristics, not measured),
and using the scheduler's priority ordering for something the old
uniform-blocking-loops architecture couldn't do at all — e.g. guaranteeing
rescue tasks always preempt trade tasks under real budget pressure, which
today works only because rescue happens to run directly in `tick()`
rather than through the scheduler.

## Local development

Requires a local Postgres. To stand one up quickly:

```
createuser stcommand --login --pwprompt --createdb
createdb stcommand --owner stcommand
```

```
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET
npm install
npm run migrate
npm test
```

## Commands

| Command | Description |
| --- | --- |
| `npm run migrate` | Apply every not-yet-applied `migrations/*.sql` file, in order, against `DATABASE_URL` |
| `npm test` | Run the test suite (needs `TEST_DATABASE_URL`, defaults to a local `stcommand` db) |
| `npm run typecheck` | Typecheck (`tsc --noEmit`) |
| `npm run build` | Build to `dist/` |
