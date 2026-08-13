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

Not yet built: a frontend to actually serve (this is the JSON API only,
same shape as straders' `/api/*` — the static dashboard HTML/JS itself
hasn't been ported) and a settings-page route for editing LLM config (the
storage side — `getTenantLlmConfig`/`setTenantLlmConfig` — has existed
since Phase B; nothing reads/writes it over HTTP yet).

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
| `npm run migrate` | Apply `migrations/001_init.sql` against `DATABASE_URL` |
| `npm test` | Run the test suite (needs `TEST_DATABASE_URL`, defaults to a local `stcommand` db) |
| `npm run typecheck` | Typecheck (`tsc --noEmit`) |
| `npm run build` | Build to `dist/` |
