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

Not yet started: Phase B — the gate/auth screen, `TenantRegistry` (the
runtime that resolves an incoming request to a tenant and hands back the
right per-tenant engine instance), and the bring-your-own-LLM-key settings
page. See `docs/architecture-plan.md` for the design of all three.

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
