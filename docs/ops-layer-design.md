# Ops layer — monitoring & investigation API

Status: **phase 1 built** (this doc + `src/ops/`), phase 2 designed below.

## Why this exists

A live fleet gets debugged the same way every time: *is that ship really where
the status says? why wasn't that route assigned? what did we actually make?
is something stuck, rate-limited, or running twice?* Until now each question
meant a bespoke SQL query against a row-level-secured database, a Render log
search drowned in 100-line `fleet:` snapshots, or reading `dispatcher.ts` and
doing the arithmetic by hand. Every one of those was done more than once in a
single session (2026-10-03). This layer turns them into named, read-only,
documented tools so the answer is one call, not an investigation.

## Principles

1. **Read-only.** Nothing in `src/ops/` changes game or fleet state. Actions
   stay in the existing action tools (`dispatch_*`, `set_ship_role`,
   `assign_route`, …). An investigation tool must be safe to call at any
   moment, in any state, including mid-incident.
2. **One implementation, two doors.** Each tool is defined once
   (`src/ops/catalog.ts`: name, description, zod input, `run(ctx, args)`).
   `src/ops/mcp.ts` exposes it as `stcommand_ops_<name>` for a connected agent;
   `src/http/ops.ts` exposes it as `GET /api/ops/<name>?…` behind the normal
   dashboard session. Adding a tool = adding one object to the catalog.
3. **Say how fresh the answer is.** The recurring trap is trusting a cached
   value: the fleet status's ship position is each agent's last-tick snapshot
   and can trail the live game by a task cycle. Tools return `live` vs
   `cached` side by side wherever both exist, and `asOf` timestamps otherwise.
4. **Bounded output.** Defaults are small (`limit`, windows). A tool that can
   return 70k characters of fleet snapshots must not by default.
5. **Tenant-scoped.** Every tool runs against the caller's own `TenantWorker`;
   SQL goes through `withTenant()` (row-level security) or `withPool()` for the
   shared galaxy tables — no raw connection strings, no tenant id parameters.
6. **Explain, don't just report.** Where the app makes a decision (dispatch,
   keeper purchase, tender), phase 2 captures *why* at decision time so the
   answer isn't reconstructed afterwards.

## Catalog

| Tool | Answers | Phase |
|---|---|---|
| `logs` | Recent server log lines, filterable by text/ship/age, with the `fleet:` snapshot and keeper-snapshot noise **off by default**. In-memory ring buffer (resets on restart). | 1 |
| `ship_live` | One ship, live from the game API vs the agent's cached view, plus role, intent, held/manual state, tour destination, keeper pin, dispatcher assignment and its own recent log lines. | 1 |
| `stuck` | Ships that look wrong: stranded, out of fuel, transit overdue, agent snapshot behind live state, suspended. Severity-ranked. | 1 |
| `pnl` | Profit & loss for a window done the CLAUDE.md way: matched trading net (sum of `realized_pnl` on sells), cash flow by ledger type incl. `JUMP`, per-ship leaders, jump count/cost. | 1 |
| `ledger` | Filtered ledger rows (ship/good/type/waypoint/window). | 1 |
| `keepers` | Keeper coverage per market: covered / en-route / pending, duplicates (>1 keeper on a market), uncovered priority markets. | 1 |
| `instances` | Server instances seen recently (heartbeats), which are alive, process uptime, rolling 429 count — "is an old instance still running / are we rate-limited". | 1 |
| `survey_candidates` | Systems within N gate hops of a system ranked by unpriced markets: market count, shipyards, priced/fresh counts, gate-complete flags. ("Where should the scout go?") | 1 |
| `market_freshness` | Every market in a system with goods count, newest snapshot age and keeper status. | 1 |
| `assignments` | The dispatcher's current assignments incl. manual overrides. | 1 |
| `run_results` | The weekly scoreboard (`run_results`): one row per agent per reset — final cash, wallet delta, trading net, ships, spend, top ships/goods. `captureNow=true` adds a mid-week preview row (the one tool that writes, only to that table). | 1 |
| `dispatch_explain` | For a trader or good: the work list the dispatcher saw on its last cycle with raw profit, crowding penalty (`impactCost`), net score, and the reason each item was rejected for that ship (claimed / buyer cap / unreachable / below margin floor). Needs a small capture inside `recompute()`. | 2 |
| `route_board` | The routes the Tower/Deck list shows, joined with who is assigned and the score after penalties, so "+400k/trip" and "nobody on it" can be reconciled at a glance. | 2 |
| `trace_ship` | Timeline for one ship over a window: activity, ledger rows, nav legs, role/intent changes, approvals — one merged, time-ordered list. | 2 |
| `deploy_check` | Pre-deploy safety: which ships hold in-memory-only orders (tender plans, mid-jump tours) that a restart would drop; post-deploy: migration status, instance overlap, first-tick health per role. | 2 |
| `fuel_plan` | For a ship + destination: the legs, fuel per leg at each flight mode, nearest fuel stops, and whether it can complete without stranding. | 2 |
| `db_read` | A small allow-list of parameterised read queries (never free SQL) for things that don't deserve their own tool yet. | 2 |

## Architecture

```
src/ops/
  types.ts      OpsTool / OpsContext
  classify.ts   pure logic (stuck classification, keeper report) — unit tested
  catalog.ts    the tools (one object each)
  mcp.ts        registerOpsTools(server, worker)  → stcommand_ops_<name>
src/http/ops.ts createOpsRouter(worker)           → GET /api/ops, /api/ops/:name
src/core/logBuffer.ts   process-wide ring buffer behind `logs`
src/db/store.ts         ops* read methods (ledger, pnl, galaxy graph, freshness, instances)
```

* **Auth** is unchanged: the MCP door is the per-tenant bearer key, the HTTP
  door is the dashboard session cookie. No new credentials.
* **Cost.** Only `ship_live` calls the game API (one `getShip`). Everything
  else reads in-memory state or Postgres.
* **Adding a tool.** Append to `OPS_TOOLS`. Keep logic that can be pure in
  `classify.ts` with a test; keep SQL in `Store` as an `ops*` method.

## Phase 2 notes

* `dispatch_explain` is the highest-value gap. `RouteDispatcher.recompute()`
  already computes everything needed; it just discards it. The plan is a
  `lastDiagnostics` object (cycle time, the work list with `profitPerTrip`,
  `impactCost`, net score, and per-trader the top rejected items with reason
  codes) assigned at the end of each non-throttled recompute — a few hundred
  bytes of bookkeeping, no behaviour change.
* The `logs` ring buffer is per process by design (it is debugging
  scaffolding, not an audit log). Durable history lives in `operator_actions`
  and the ledger; phase 2's `trace_ship` merges those.
* A browser page over `/api/ops` (a table per tool) is a natural follow-up but
  not needed for the agent use case.
