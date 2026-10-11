# Handover: running the stcommand fleet and its code

Written 2026-10-11 for another model taking over from Claude when the
session's token budget runs out. Read this whole file before touching anything. It is
written to be self-contained, but two other files are the source of truth for their
subjects and you should read them too: `CLAUDE.md` (repo rules) and
`docs/new-player-guide.md` (how the game works for players).

**No secrets are in this file or in the repo.** Where a credential is needed, this file
names the environment variable. Get the value from the operator. Never paste a token into
a commit, a doc, a chat reply, or a log line.

---

## 1. What you are working on

`stcommand` is a multi-tenant automation service for **SpaceTraders**, a multiplayer
trading game with a weekly universe reset. It runs on Render as one Node/TypeScript process
with one `TenantWorker` per tenant. Each tenant is one player's fleet.

The live tenant is the operator's own (agent name THEO; tenant id `7e1ea899`). The current
universe's home system is **X1-JX83**. The operator's ships are named `THEO-<n>`.

The product has four surfaces:
- **Tower**: the phone UI at `/m` (`public/m.html`, `public/m.js`, `public/m.css`). Tabs:
  Home, Fleet, Metrics, Markets, Co-pilot, More.
- **Deck**: the desktop UI at `/deck` (`public/deck.js`, `public/deck.css`).
- **MCP server**: `/mcp`, the tools an AI agent calls (`src/mcp/tools.ts`). Ops tools
  `stcommand_ops_*` are registered from `src/ops/catalog.ts`.
- **Co-pilot**: a chat assistant (`src/engine/agentChat.ts`) with read tools and a
  propose-then-confirm action tool.

## 2. Where the code is

- `src/engine/` — the engine. Key files:
  - `fleet.ts` (`FleetManager`): the tick loop, route computation (`computeDispatchRoutes`),
    dispatch wiring, the reset watcher's hookup.
  - `dispatcher.ts` (`RouteDispatcher.recompute`): assigns routes to idle traders. Has the
    reachability checks (`whyUnreachable`), the cross-system positioning cost
    (`crossSystemPositioning`), the route-first matcher call, and the explain snapshot.
  - `matching.ts`: route-first matching (who gets the best routes first).
  - `galaxy.ts` (`GalaxyAtlas`): systems, gates, jump paths. `setPositioningHops()` sets the
    working jump limit from doctrine.
  - `jumpGraph.ts`: `findJumpPath`, `MAX_POSITIONING_HOPS` (default 3) and
    `MAX_POSITIONING_HOPS_CEILING` (10).
  - `trader.ts`: one trader ship's own behaviour: viable route checks, execution, fuel.
  - `doctrine.ts`: the doctrine catalog (`POLICY_CATALOG`) and live persisted values.
  - `dispatchExplain.ts`: the pure selector behind the `dispatch_explain` ops tool.
  - `metrics.ts`: builds the metrics payload from ledger rows.
  - `resetWatcher.ts`: detects the weekly reset and recovers tenants.
- `src/http/dashboard.ts` — the HTTP routes: `/api/metrics`, `/api/doctrine`, `/chat`,
  `/fleet/*`, `/settings/llm`. `executeCopilotAction` is here.
- `src/ops/catalog.ts` — ops tools (read-only investigation). `dispatch_explain` is here.
- `src/db/store.ts` — all SQL. `migrations/` — numbered SQL migrations (latest is 046).
- `docs/` — design docs. `docs/copilot-phase-2-plan.md` is the next build plan.
  `docs/reset-opening-playbook.md` is the operator's playbook for the start of a week.
  `CHANGELOG.md` gets one entry per shipped change. `docs/TODO.md` is open work.

## 3. House rules (from CLAUDE.md and the operator)

These are non-negotiable. Read `CLAUDE.md` for the full list.

1. **Dual push.** Every commit goes to the feature branch
   `claude/stcommand-ui-parallel-versions-fd5p9q` **and** to `main`. Render auto-deploys
   `main`, and a push to `main` restarts the live engine. Push to `main` only when the
   operator says so ("Main" has been the operator's word for it). Check first that the
   push fast-forwards: `git fetch origin main` then `git merge-base --is-ancestor origin/main HEAD`.
2. **No model names in commits, PRs, code comments, or pushed docs.** Commit trailers may
   carry the session link only. Check your commit message before you push.
3. **Don't move ships by hand** unless the operator asks. The dispatcher assigns traders.
   Keeper purchases come from keeper visits, not manual dispatch.
4. **Don't pause contracts.** Never disable a contract to free a ship.
5. **Confirm before anything outward-facing or hard to reverse.** A push to `main`, a fleet
   purchase, a doctrine change on the live tenant, and deleting data all need the operator's
   explicit go-ahead in this conversation.
6. **Read before you write.** Before a fleet action, read the current state (fleet status,
   approvals). After a call that errors or times out, read again before retrying: a
   `buy_ship` once reported as rejected had actually executed.
7. **Re-issuing a command to a ship already moving does nothing useful.**
8. **Don't store credentials in memory tools or docs.** The operator once asked for a
   memory service; the key is only ever an environment variable.

## 4. Environment and how to run things

- **Node, TypeScript.** Install with `npm install`. Typecheck with `npx tsc --noEmit -p .`.
- **Tests.** Run with
  `node --test --import tsx --env-file-if-exists=.env.test tests/*.test.ts`.
  Do not use `vitest`; the project uses `node --test`.
- **Local Postgres** is needed for `dashboard.test.ts` and some others. Start it with
  `sudo -u postgres pg_ctlcluster 16 main start`, then run `npm run -s migrate:test`. The
  test database settings are in `.env.test` (local only, gitignored).
- **Known failures.** The full suite has 91 failing test lines on the committed baseline
  (dashboard, doctrine, integration, fleet, floorRedirect and a markets filter test). They
  predate the current work. Before and after any change, run the full suite and compare
  the list of `not ok` lines with the baseline. Do not treat the 91 as your regressions,
  but do not add to them.
- **Environment variables** (values come from the operator; never print them):
  `DATABASE_URL` (Render Postgres; the read-only login cannot see tenant rows, because row
  level security hides them), `ADMIN_KEY` (admin page), `ST_ACCOUNT_TOKEN` (reset recovery
  needs it), the co-pilot LLM key (set in the dashboard's Settings, not in code).
- **Render**: the MCP tools for Render need a workspace to be selected. Ask the operator for
  the workspace id; do not pick one. Deploys take a few minutes after a push to `main`.
- **GitHub**: use the GitHub MCP tools or `gh api`. Do not open a pull request unless the
  operator asks.

## 5. The game, as this codebase models it

- **Reset.** The whole universe is regenerated weekly. Agent tokens from the old universe
  stop working. `resetWatcher.ts` notices (via the unauthenticated `GET /v2/` status
  endpoint), clears per-tenant state, and re-registers when `ST_ACCOUNT_TOKEN` is set.
  Shared galaxy tables are truncated on cleanup.
- **Markets.** Each good has buy and sell prices per market. Our own trades move the price
  about 4 to 5 percent per trade-volume lot, and it recovers slowly (a few percent an hour).
  Price is a function of stock.
- **Routes.** A route is a buy market, a sell market, and a good, with a profit per trip
  after fuel, slippage and any jump fees. `computeDispatchRoutes` builds them from stored
  market legs, dropping any that are unprofitable (the drops are counted by reason in
  `routeBuildReport`).
- **Gates.** A jump needs a finished gate at both ends. Construction status is in
  `galaxy_gate_construction`.
- **Jumps** cost about 5,000 credits each and a cooldown before the next action. A
  cross-system route's first trip must out-earn its positioning cost.
- **Fuel.** The game takes fuel up front when a flight starts. A ship on a long leg shows
  constant fuel until it arrives; that is normal.

## 6. Current state (as of 2026-10-11)

Live fleet (roughly): about 21 traders, 1 tour ship (THEO-3C), 1 siphoner (THEO-72), 1 miner (THEO-17), and a large number of keepers. The
operator reviews the numbers on Tower's Metrics page.

Recent work, all on `main` at `2c196d8`:
- `dispatch_explain` ops tool: for each idle trader, the reason each route was refused, plus
  `routeBuild` (legs dropped before the dispatcher, with a sample).
- Named cross-system refusal reasons ("no finished gate path within the jump limit", "the
  first trip does not cover the N-jump positioning cost", "the relay through X is beyond
  its fuel range", and so on).
- Relay fuel is checked at every intermediate gate on a multi-jump route, not only the
  first.
- Doctrine clause **"Positioning jumps"** (`positioningHops`): default 3, operator set it to
  **5** on 2026-10-10. Hard ceiling **10** in code (`MAX_POSITIONING_HOPS_CEILING`). Tower
  now has value boxes for numeric doctrine rules.
- Cross-system positioning cost now includes the ship's flight to its gate, so the nearest
  ship wins ties (commit `bc680b0`, verified in tests, not yet checked against the live
  match log).
- Metrics "Since reset" window on Tower and Deck (commit `2c196d8`). Verified by tests for
  the arithmetic; the endpoint's live behaviour is not yet checked against the pnl numbers.
- The reset-opening playbook gained a section on building out from markets already traded.

Open items, in rough priority order:
1. **Verify the nearest-ship fix live.** Read `dispatch match` lines from the logs (the
   `stcommand_ops_logs` tool with text `dispatch match`). Ties should now go to the ship
   nearest its gate.
2. **Verify Since reset live.** Open Tower Metrics, choose Since reset, and compare the
   totals with `stcommand_ops_pnl` for the same span.
3. **Watch jump spend against matched net** on the 5-jump setting. If jumps grow faster
   than matched net over a couple of hours, the operator may lower the limit to 4.
4. **Copilot phase 2.** Build it from `docs/copilot-phase-2-plan.md`, starting with phase
   2.0 (extract the shared action layer, no behaviour change).
5. **Tower caches its script for up to four hours.** A phone may need a hard refresh to
   see new UI. A cache-busting fix was proposed and not built.
6. **Memory service.** The operator chose Cognee Cloud. The endpoint is reachable but the
   key was not set in this session. Do not store keys; ask the operator.
7. **The public `brain-mcp` endpoint** answered unauthenticated requests. Flagged to the
   operator; no change made.

## 7. How to work on this safely

- Start by reading the state: fleet status, approvals, the last hour of ledger and pnl.
  Don't change anything in the first few minutes.
- Make one change at a time. Test it, commit it to the feature branch, and only then ask
  about `main`.
- For dispatcher changes, add a test in `tests/dispatcherExplain.test.ts` or a sibling
  file. Use the existing `route()` helper pattern, and pass the positional arguments to
  `recompute` in the same order as the function signature.
- If a live number looks wrong, check the explain output and the routeBuild sample before
  changing code. Most "missing routes" turned out to be a silent filter, a stale market, or
  a limit working as designed.
- When you finish a shipped change, add a `CHANGELOG.md` entry written for someone who was
  not in the conversation.

## 8. Things that went wrong, so you don't repeat them

- The early "missing routes" question was first answered by guessing. Read the reason the
  dispatcher records, and the route-build drops, before you change a limit or a filter.
- Two ships in the same system looked identical to the matcher because cross-system
  positioning ignored where they stood. Positioning must use the ship's own position.
- A Tower panel had only on/off switches for doctrine, so a limit could not be changed from
  a phone. Check that a control exists in Tower, not only on Deck, before saying a setting
  is editable.
- A rolling metrics window mixed the old universe's trades into the new one's totals. Use
  "since reset" for weekly scores.
- The operator asked for things to be "pushed". Each push to `main` deploys, so confirm the
  scope first and say what the deploy will change.
