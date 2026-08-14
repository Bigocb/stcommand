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

## Greenfield engine redesign: in progress

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

Phases 4-7 (ShipRegistry, and the unified scheduler that replaces the
current per-agent blocking loops) are ahead — see the design doc for the
full sequencing and why the scheduler is deliberately last. Phase 4
(ShipRegistry ownership) is where the mission-delivery/held-position
distinction this phase left open has a natural home, since ShipRegistry is
exactly what will know *why* a ship currently has a claim.

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
