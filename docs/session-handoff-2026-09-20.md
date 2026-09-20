# Session handoff — 2026-09-20 stcommand live-ops session

**Purpose of this doc**: a new Claude session (or any other agent) picking
up this work cold needs everything below to continue without re-deriving
it. Read this whole file before touching anything. It covers repo state,
live production state, what shipped this session, what's still open, and
hard-won conventions/pitfalls specific to this repo.

## 0. Repo basics

- Repo: `Bigocb/stcommand` (multi-tenant SpaceTraders fleet-automation web
  app). Working branch: `claude/stcommand-ui-parallel-versions-fd5p9q`.
- **Dual-push is mandatory**: Render only auto-deploys from `main`, but
  the real working branch is the feature branch above. **Every commit
  must be pushed to both** — pushing only to the feature branch strands
  it and nothing deploys. Standard sequence:
  ```
  git fetch origin main claude/stcommand-ui-parallel-versions-fd5p9q
  # check for divergence, merge if needed (never force-push — other
  # sessions/subagents push to these same branches)
  git push -u origin claude/stcommand-ui-parallel-versions-fd5p9q
  git push origin claude/stcommand-ui-parallel-versions-fd5p9q:main
  ```
- Full repo-level conventions live in `CLAUDE.md` at the repo root — read
  it in full, it's short and covers things this doc doesn't repeat (the
  MCP server's own operating instructions, reset-recovery procedure, the
  "check logs before concluding a ship is stuck" pitfall, P&L reporting
  method, etc.).
- Render service: `srv-da0veurl550s73eg2sog`, workspace
  `tea-d78npo450q8c73f2n45g`, public URL `https://stcommand.onrender.com`.
  Use the Render MCP tools (`list_logs`, `list_deploys`, `get_service`)
  with those IDs — no need to re-discover them.

## 1. Live production state as of this session

- Tenant `4eb2f63b`, agent symbol **THEO**, home system **X1-SN30**
  (headquarters `X1-SN30-A1`), ~868k credits, 9 ships (THEO-1 through
  THEO-9, though only THEO-1/2/3/4/5 were actively touched this session).
- **THEO-1** (role: miner) was pinned to mine at `X1-SN30-XC5F`
  (COMMON_METAL_DEPOSITS asteroid) as a test of the buy-side manipulation
  strategy for FAB_MATS — **the user paused this experiment** partway
  through (see §3) and reassigned THEO-1 to **trader** role. Its cargo at
  pause time held ~24 IRON_ORE / 12 ALUMINUM_ORE, unsellable at the
  target market (see §3's refining discovery) — that cargo should get
  sold off naturally now that it's a trader, no action needed unless it's
  still stuck.
- **3 other agents share THEO's home waypoint** `X1-SN30-A1`:
  `BBSOPS9K2X`, `FLEET9325`, `VOYAGE-42` — all still at starting balance
  (175,000c, 2 ships) as of this session, confirmed via the live public
  `/v2/agents` directory (188 agents total, paginated). Worth periodically
  re-checking via the new System Agents running-tally feature (§2).
- The user provided a live SpaceTraders agent JWT for THEO directly in
  chat earlier in this session (after a server reset). It was written to
  `/tmp/st_token.env` in *this* sandbox container and used to query the
  live API directly and to log into the deployed app
  (`/tmp/st_cookies.txt` holds the resulting session cookie). **Neither
  file will exist in a fresh session's container** — if live API/dashboard
  access is needed again, either ask the user to re-share the token, or
  do everything through the deployed app's own `/api/*` routes via the
  Render MCP tools' log output instead of direct API calls. **Never echo
  the token itself back to the user or into any file committed to the
  repo** — this was an explicit constraint honored all session.

## 2. What shipped this session (chronological, newest last)

All of this is already committed, pushed to both branches, and deployed
(each item confirmed live via Render logs or a direct API check before
moving on — see each commit message on `claude/stcommand-ui-parallel-versions-fd5p9q`
for full reasoning, this is a summary):

1. **Manipulation-routes finder** (`FleetManager.findManipulationRoutes`,
   `src/engine/fleet.ts`) — given a target good (FAB_MATS, then
   ADVANCED_CIRCUITRY added later), finds the market that exports it and
   suggests nearby asteroids whose trait category plausibly deposits its
   upstream inputs (`DEPOSIT_TRAIT_HINTS`, a heuristic, not confirmed
   survey data). Backed by `GET /api/manipulation-routes` and
   `GET /api/manipulation-routes/history` (price/sell tracking via the
   existing `market_snapshots`/`ledger` tables — no new persistence for
   that part).
2. **Ported that finder's UI to all four surfaces**: Deck (`deck.js`),
   v6 desktop (`v6.js`, in the existing Ops tab), v6's own mobile reflow
   (`#mobile-view` in `v6.html`, a *different* thing from Tower — v6 has
   its own `<=680px` responsive layout separate from Tower), and Tower
   (`m.js`, in the More tab).
3. **Real bug found and fixed live**: the finder's "Assign" button called
   `/api/fleet/dispatch` (`FleetManager.sendShipTo`) — a same-system
   **park-and-hold**, not a mining instruction. THEO-1 sat idle at its
   assigned asteroid for ~an hour before this was caught (user noticed
   and asked about it). Fixed in three layers, all necessary:
   - Assign now calls `/api/fleet/mine` (`FleetManager.mineAt`) for
     ASTEROID_FIELD/ENGINEERED_ASTEROID candidates instead, which pins a
     miner/surveyor to actively extract — GAS_GIANT candidates still use
     the old hold (no siphon-pin equivalent exists), now labeled "Hold"
     not "Assign" so the distinction is visible.
   - `mineAt()` itself never cleared a *pre-existing* hold from an
     earlier `sendShipTo()` call — `holdWaypoint`/`this.operatorHolds`
     stayed set, and `proposeOperatorHolds()` re-proposes that hold goal
     at priority 0 every tick regardless of the mine pin. Fixed by
     clearing `holdWaypoint` in the same `updateShipManualState()` call.
   - `init()`'s restore-on-boot loop read `shipManualState` once per ship
     then applied both `minePin` and `holdWaypoint` from that one stale
     snapshot — reinstating the very hold `mineAt()` just cleared, on the
     very next redeploy. Fixed by skipping the hold restore when a
     `minePin` is also present. Added a regression test for this exact
     restart scenario (`tests/fleet.test.ts`).
4. **Refining gap discovered and warned about**: mining an asteroid only
   ever yields raw ore (`IRON_ORE`, `COPPER_ORE`, etc.), but the target
   market imports the *refined* good (`IRON`, `COPPER`) — confirmed live
   by checking the actual `/refine` API error, which also settled that
   `MODULE_MINERAL_PROCESSOR_I`/`MODULE_GAS_PROCESSOR_I` (which THEO-1
   has) are **not** valid refinery modules despite the name; only
   `MODULE_ORE_REFINERY_I`/`MODULE_FUEL_REFINERY_I` work, and **no ship in
   the fleet has either**. The finder now flags each input with
   `needsRefining` + a fleet-wide `fleetCanRefine` check, rendered as a
   warning line in all three frontends. `REFINE_RECIPES`/`REFINERY_MODULES`
   were exported from `src/engine/agent.ts` for `fleet.ts` to reuse rather
   than duplicating the game-data table.
5. **User paused the manipulation experiment**, reassigned THEO-1 to
   trader (`POST /api/fleet/role`). Added `ADVANCED_CIRCUITRY` to the
   finder's default good list per request (its own direct inputs are
   manufactured goods — ELECTRONICS/MICROPROCESSORS — not raw ore, so it
   likely shows no candidate asteroids; the finder only looks one level
   of inputs deep, no recursive supply-chain walk).
6. **Buy-price line added to the Prices & snapshots chart** (v6 desktop
   only — `renderPriceChart()` in `v6.js`, `goodPriceHistory()` in
   `src/db/store.ts` now also aggregates `purchase_price` alongside the
   existing `sell_price`). **Note**: the user asked to undo this change
   right after it shipped, then immediately said "stop that was an
   accident" before anything was reverted — so **this change was never
   reverted and is still live**. If it comes up again, that's the
   context.
7. **Running credits tally for agents in the home system** — new shared
   table `agent_credit_snapshots` (migration
   `migrations/022_agent_credit_snapshots.sql`), populated every hourly
   `GalaxyCrawler.crawlAgents()` pass (`src/engine/galaxyCrawler.ts`),
   queried via new `Store.agentCreditHistory()` /
   `GET /api/agents-in-system/history`. v6 desktop's existing "Agents in
   system" panel (Galaxy tab) now shows a signed credits delta since the
   earliest recorded point per agent, not just the current snapshot. Unit
   tests added in `tests/store.test.ts`. **Only shipped to v6 desktop** —
   Deck and Tower don't have this panel yet (see §4, Pass C of the Deck
   plan).
8. **`docs/deck-remaining-build-plan.md`** — a detailed, verified handoff
   spec for a *different, lower-context coding model* (kimi-2.7-code or
   deepseek 4.1 flash) to continue building out `/deck`'s remaining gaps.
   See §4 below for what it covers; don't duplicate that content here,
   just know it exists and is up to date as of this session.

## 3. How bugs were actually diagnosed this session — reusable technique

Every real bug found this session (§2.3, §2.4) was confirmed **against
live evidence**, not inferred from reading code alone:
- Render logs, filtered by exact distinctive log-message substrings
  (e.g. `"THEO-1: extracted"`, `"operator hold at"`) combined with a
  `startTime`/tenant filter — generic ship-symbol searches return
  enormous volumes of periodic `fleet:` tick-summary noise.
- Direct SpaceTraders API calls (`curl` through the pre-configured proxy,
  using the token in `/tmp/st_token.env` when available) to check ship
  cargo, market import/export lists, and — critically — to provoke the
  *actual* server error message (`/refine`'s `"Ship does not have any
  refinery modules"` response, which named the exact two valid module
  symbols) rather than guessing what the game accepts.
- **This repo's explicit, user-enforced rule**: never assert an
  explanation as fact without verifying it first. Earlier in this
  session (before this window) the user directly called out a guessed
  explanation with "where is the proof of that, does it describe that
  npc functionality somewhere or are you guessing" — say "I don't know,
  let me check" rather than a plausible-sounding guess, every time.

## 4. Open / pending items for the next session

- **`docs/deck-remaining-build-plan.md`'s four passes are not started**:
  (A) Fleet per-ship action sheet (biggest gap — zero action buttons
  exist on Deck's Fleet screen today), (B) Trade Ops write actions
  (dispatch assign/clear, warehouse designate/release), (C) port the new
  System Agents + credits tally panel (§2.7) and a Factions list onto
  Deck's Map screen, (D) wire Doctrine's enable/disable toggle. That doc
  is self-contained and verified — hand it to whichever model/session
  picks up Deck work next; it does not need this handoff doc's context
  to be actionable on its own.
- **Tower (mobile) and v6's own `#mobile-view` reflow don't have the
  System Agents + credits tally panel either** — only v6 desktop's
  Galaxy tab does. Not yet requested by the user; mention if relevant.
- **THEO-1's leftover ore cargo** (IRON_ORE/ALUMINUM_ORE from the paused
  mining experiment) — should sell off naturally now it's a trader, but
  hasn't been explicitly re-checked since the role change. Worth a quick
  live-log check if the user asks about THEO-1's status.
- **The manipulation-routes strategy itself remains paused**, per the
  user's explicit call ("pausing the experiment"). Don't resume it or
  reassign any ship to mine via the finder without the user asking again.
- No other explicit user requests are currently in flight beyond this
  handoff doc itself.

## 5. Environment notes specific to this sandbox

- This container has **no persistent Postgres** by default — the
  configured `TEST_DATABASE_URL` (`.env.test`) points at a remote Render
  Postgres that was unreachable from this sandbox (`node --test` against
  it timed out). Verified-working workaround used repeatedly this
  session: install/start local Postgres 16 (already present in this
  image — `service postgresql start`), create a throwaway
  `stcommand`/`stcommand_dev` role+database matching `tests/*.ts`'s own
  fallback connection string, run migrations with
  `node --import tsx -e "...runMigrations..."` (see any commit this
  session for the exact one-liner), run the real test suite against it,
  then `DROP DATABASE`/`DROP ROLE` and `service postgresql stop` when
  done. **Always clean up afterward** — don't leave the local DB running
  or `.env.test` renamed/moved (one step this session temporarily moved
  `.env.test` aside and restored it after — verify it's back in place if
  picking up mid-session).
- No local Postgres running right now (cleaned up after last use) —
  recreate it with the steps above if tests need to run against a real DB
  again; typecheck (`npx tsc --noEmit`) and `node --check <file>.js` don't
  need a DB and should always be run first regardless.
