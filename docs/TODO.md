# Open items

Master list of things in flight — live-ops issues, ideas raised but not
acted on, and decisions pending. Update this as things open and close;
don't let it go stale. When an item closes, move it to `CHANGELOG.md`
(if something shipped) rather than just deleting it.

## Live ops — needs a decision or action

- [ ] **A wrong "gate complete" is never re-verified (found 2026-10-24, JM97).** Both the crawler and `refreshGateConstruction` treat a gate recorded complete as
  final; the fleet's reader also records a 404 as complete, which the crawler's own comment says may be wrong (an uncharted waypoint 404s). JM97 was
  recorded complete while 0 of 1,600 FAB_MATS were supplied. A live rejection now corrects it (see CHANGELOG), but nothing finds the next one before a
  ship does. Options: stop recording a 404 as complete (leave unset), or spot-check gates recorded complete that lie on a ship's planned path before the
  first jump (one public `/construction` read, no token).
- [ ] **Gate-construction reads slow the maintenance pass (2026-10-24).** `maybeRefreshGateConstruction` takes 8 to 28 seconds a pass because the fleet's
  own authenticated reads are priority 4 and wait on the 90 calls a minute limiter; the pass also delays ship purchases and keeper buying
  (`maybeBuyScout` 8.7s, `advanceKeeperMarketQueue` 8s). The crawler also logged 45 HTTP 400 answers in one 160-gate pass that nothing explains.

- [ ] **Always be expanding: engine-managed keeper rotation and big hulls (raised 2026-10-24, operator).** The 2026-10-23 peaks (9.2M/h and 9.7M/h against a
  7.3M/h day) came from bulk freighters selling into systems that had just gained keeper coverage; yield per unit decayed as we sold into them, and the
  keeper list has been capped by the API budget since about 19:00. Plan, evidence and phases (0 measure the yield-since-coverage curve, 1 free budget,
  2 `keeperRotation.ts` behind a clause, 3 hull placement, 4 fresh-system pipeline): `docs/fresh-system-expansion-plan.md`.

- [ ] **Opening automation: queued tasks and saved templates, run by the reset automation (raised 2026-10-18, operator).** Today the first hours of a
  week are done by hand: the command ship tours until there are good routes, then trades to build cash; once it has sold its cargo, buy one contract
  ship and one tour ship; then the gate feeds and mission pacing (`docs/reset-opening-playbook.md`). The operator wants the reset automation to run
  that opening at the start of next week, and the same tool usable in the middle of a week. Shape agreed so far:
  (1) a **task list** the operator can add to before the reset (like the plan list in the Artifacts game): each task has a trigger ("when the command
  ship has sold its hold", "when cash passes N", "when a route over N a trip exists", "when FAB_MATS has a price") and an action (set a ship's role, buy
  a named ship type at the cheapest yard, assign a ship to contract duty, start a feed, set mission pacing, set a doctrine value);
  (2) **saved templates**: a named set of such tasks (for example "Standard opening") that can be picked and applied in one go, copied, and edited;
  (3) it carries over the reset: the template chosen before the reset is applied by the reset recovery once the new agent is registered and the first
  ships exist.
  Design notes: build it as a pure module (`src/engine/openingTasks.ts`) with a policy object, like `chain.ts` and `pace.ts` (CLAUDE.md "Build new
  logic as self-contained modules"): trigger and action are data, the evaluator takes the fleet facts and returns what is due plus a one-line reason, and
  a caller applies it; ship ships behind a doctrine clause that is off, and an off clause must change nothing. Every spending action goes through the
  existing approval gate unless the template marks it pre-approved with a cash cap. Re-checks and retries must be safe (CLAUDE.md "check the fleet
  before acting": read state first, and never re-issue after an error until a read shows it did not happen), so a task carries a done marker keyed by
  the universe (`<agent>@<reset date>`). Store tasks and templates in tables kept across the reset (like `doctrine`), not in the wiped game tables.
  Decided by the operator (2026-10-18): (a) a template names the ship by **hull** (ship type, for example SHIP_LIGHT_SHUTTLE), bought at the cheapest
  yard that has it; (b) a task is a **sequence of steps**, not one action, so "buy a shuttle, convert it to a trader, assign contract duty" is a single
  task whose later steps act on the ship the first step bought (the task keeps that ship's symbol, and a step that fails stops the task and says why);
  (c) the **co-pilot can add and edit tasks** as well as the operator, through the same approval and audit trail (`operator_actions`); (d) **no fixed
  checklist first**: build the trigger-and-steps shape from the start.

- [ ] **Thin-market sinks: size and gate a trade by the destination's depth (raised 2026-10-18, operator).** THEOREM-64 lost ~523k on VIRAL_AGENTS
  (X1-KQ90-C16D to X1-QD90-A1): bought 80u at 31,127c on a plan that priced the sink at 41,081c, then sold into a market that paid 27,294c for the first
  18 units and 20,428c for the next 18 (about a quarter off per lot), twice. The between-lot guard and the unwired below-floor approval are fixed
  (CHANGELOG 2026-10-18); what is not is that the planner sends 80 to 225-unit holds of expensive goods into markets that cannot absorb them. VIRAL_AGENTS
  cost roughly 3.3M over two days on two ships (THEOREM-BC 2026-10-17, 2.55M). Facts to start from: `ops_analysis` already measures impact per lot per market
  (`medianImpactPerLot`; VIRAL_AGENTS@X1-QD90-A1 sell 0.25, never recovered; JEWELRY on the same sink earned 37% of its estimate), and the route model's
  calibration factors are advisory only. Options: (1) cap a trip's units by the sink's measured per-lot impact so the expected average fill, not the top
  quote, clears the margin; (2) skip a sink whose last measured impact per lot is over a limit and has not recovered; (3) size by capital at risk (a 2.5M
  hold against a thin market is a 12% swing); (4) fewer lots (`maxLotsPerTrip`, now 6) for expensive goods. Build it as a pure module with a doctrine
  clause that ships off, like `routeHeat.ts` (CLAUDE.md "Build new logic as self-contained modules"). Also worth fixing while there: `ops_analysis`
  `routes.worst` omits a trip with units still held, so this loss was missing from it.
  Related, done: loss floor `maxLossPct` set to 10% on 2026-10-18 (was 15%).

- [ ] **Park unsold cargo in a stash ship so the trader can keep trading (raised 2026-10-18, operator; a manual first version).** A ship holding cargo is given no route (trader.ts: a held
  lot counts as busy), so one lot waiting for a price to recover idles a whole hull: THEOREM-7 held 20u ADVANCED_CIRCUITRY (cost 4,319.5, A4 bid 2,670, loss about 33k, floor 3,888) for
  30+ minutes while it earned about 26k an hour on average. Idea: move the lot into another ship's hold and sell it from there when the price is right, or when a deadline passes. This is the old
  warehouse idea (a big ship that holds product until the price is good), cut down to hours: unsold goods die at the weekly reset, so it only fits goods whose price comes back within a few
  hours (A4's ADVANCED_CIRCUITRY bid recovered about 190 an hour, so about 6 hours to the floor), and the wind-down must sell whatever is parked.
  What exists: `api.transferCargo` (`client.ts`, used by feeds), the parked warehouse code (`/api/warehouse/*`, store tables, dispatcher paths, retired doctrine rules, CHANGELOG 2026-10-05
  "Warehousing parked"). What is missing: an MCP tool to move cargo between two ships at the same waypoint. Manual first version: (1) `stcommand_transfer_cargo` (both ships at one waypoint,
  checks hold room, records an operator action); (2) the operator parks an idle ship with room (THEOREM-6 was on hold with an empty 40 hold) next to the lot's ship and moves it; (3) sell from the
  stash ship with the existing trade and sell tools; (4) the cost basis has to travel with the cargo (`heldCost` is per ship and good in trader.ts), or the loss floor judges the stash sale against
  nothing and the realized P&L is wrong. Later: a stash seller that watches the live bid and sells at the floor or a deadline, and the impact book deciding when a lot is worth parking at all.
  Related: "Market impact book" below (it would avoid most of the lots that end up parked).

- [ ] **Market impact book: a shared "recover to X%" rule for traders, applied automatically (raised 2026-10-18, operator).** Missions already have `recoverPct`
  (`src/engine/mission.ts`: remember the ask just before the last lot, buy the next only once the ask is back within X% of it). Traders have no equivalent between
  lots, only a static per-ship `lotSize`/`maxLots` (`shipLotPolicy.ts`), a route rest after a disappointing trip (`routeHeat.ts`) and the loss floor (`lotGuard.ts`).
  Evidence, 2026-10-18 (THEOREM, X1-YM69, only our own trades appear in the market feed): the price impact per 20-unit lot grows as stock falls (ADVANCED_CIRCUITRY
  at D44 +4.0%, +4.8%, +5.6%, +6.5%, +7.6%, +8.2%, +43% over 120 units; MEDICINE at G57 +5.5% to +9.6% a lot; selling MEDICINE at G58 -5%, -7%, -9% a lot), and there was
  no recovery in the 17 to 29 minutes after our last lot. THEOREM-1's MEDICINE loop G57 to G58 made +52k, +13k, then bought round 3 at 3907 and 4283 against sell
  prices of 3622 to 3860.
  Design agreed so far: (1) **a trader must not wait for recovery** (a market needs about a tick, 30 minutes, so waiting idles the ship); when the ask is over the limit
  it stops buying there and leaves with what it holds, or takes the next-best route; (2) a **shared baseline book** per market and good (pure module, e.g.
  `src/engine/impactBook.ts`): the ask and bid before our first lot after the market was quiet, the units pushed since, when; every ship reads the same book so two
  ships never treat a worn market as fresh; (3) one check before each lot: is the ask within X% of baseline; (4) the **dispatcher reads the same book** and skips a
  cooling leg when it builds routes, which is what spreads purchases across waypoints without an operator choosing; (5) X comes from a doctrine clause that ships off
  (a weight of 0 or the clause off must reproduce today's behaviour, with a test), later per-market from the analysis engine's measured `medianImpactPerLot` and recovery.
  Build it as a self-contained module (CLAUDE.md "Build new logic as self-contained modules"). Open: how the book learns a market has recovered (a keeper's fresh read is
  the obvious source); what X should default to (the observed per-lot impact is 4 to 10%, so 10 to 15% over baseline looks like a first guess to test); whether a part-full
  hold should still go if the remaining margin is good. Related: "Thin-market sinks" above (size and gate a trade by destination depth); this item is the buy-side and
  between-lot half, that one the sell side and trip size. Opening-task automation (below) is unrelated.
  **Update 2026-10-18:** guards 1, 2 and 4 of `docs/buy-guards-plan.md` are built — the sink check before the first lot, the between-lot buy stop, and the per-route round limit,
  all behind `buyGuardImpactPct` and `routeRoundsMax` (both off). What remains here is the shared impact book (a baseline per market/good every ship reads) and the dispatcher
  skipping a cooling leg, which is (2) and (4) above. Follow-up found in the review of PR #8: a refused trip blocks the key `good@buyAt`, so a refusal on MEDICINE E52 > G58 also
  rests E52 > E51 for five minutes even when that sink pays well. A route-level key (`good|buyAt|sellAt`, the shape `routeHeat.routeKey` already uses) fixes it and means changing
  the three `deadRoutes` checks in `trader.ts`; the plan specified the buy-market key, so it was left as specified.

- [ ] **Scout the neighbouring systems once the gate opens (raised 2026-10-13, operator).** Gate X1-CM13-I61 (needs 1,600 FAB_MATS +
  400 ADVANCED_CIRCUITRY) links to X1-FP91, X1-CK71, X1-CH68, X1-P74 and X1-GR36. First targets: **X1-FP91** (523 away; 92 waypoints,
  59 asteroids, an engineered asteroid, a gas giant, 2 asteroid bases: the closest copy of home) and **X1-CH68** (994 away; 70 waypoints,
  45 asteroids, 2 gas giants, 7 orbital stations). Plan: a light freighter to each as a tour ship (`dispatch_tour`), plus an explorer,
  probably a shuttle, to chart. Only type/coordinates/waypoint types are known from the public API; markets and traits need a ship there.
  Nothing to do until the gate completes. X1-P74 (274 away, 28 waypoints) is the cheap fallback.

- [ ] **Pick mining fields automatically, per input market (raised 2026-10-12, operator).** For every market the gate chain buys
  an input from, rank minable asteroids by distance and measured deposit share (`miningFieldsReport`, `src/engine/miningFields.ts`,
  already pure and tested), start a looping survey tour over the nearest unsurveyed ones, and propose a mine feed + field + collector
  (a proposal the operator approves, like keeper probes). Needs a decision on how many surveys count as enough (the table uses 10)
  and whether a field already used by another feed is shared or avoided.

- [ ] **Contracts: follow-ups to the metrics work (raised 2026-10-11).** (1) Goods bought for a contract by one ship and
  delivered by another are costed from the deliverer's own purchases (`lastPurchasePrice`); a transfer would be costed at
  0. (2) The estimate of cost to finish ignores a delivery trip's fuel. (3) The week-comparison view should show contract
  income and the headline net with contracts. (4) Rows from before migration 049 have no advance or delivery rows; no
  backfill is planned. (5) A contract's opportunity cost (ships tied up that could trade) is not in the numbers.

- [ ] **Test the decision model through OpenRouter (raised 2026-10-11, operator).** Jev access is limited early access, so to
  exercise the router and the attention feed end to end now, add a second `Judge` adapter (`src/engine/openRouterClient.ts`,
  next to `jevClient.ts`) behind the same port; `getJudge()` picks it when `OPENROUTER_API_KEY` is set and no `TYPESAFE_API_KEY`
  is. To settle: (1) the adapter asks a chat model the same typed questions and parses a JSON reply into `Answer`s (noul ->
  probability, choice -> probabilities); a chat model's stated confidence is NOT calibrated like Jev's, so use token logprobs
  where the chosen model supports them and otherwise treat the numbers as plumbing-only, never as a basis for acting;
  (2) the host is fixed to `https://openrouter.ai/api/v1` (same rule as Jev's: fleet state must never go to an unverified
  host) and CLAUDE.md's "host is fixed" note needs the second adapter added; (3) keep `sanitizeState`/`redactSecrets` in front
  of it unchanged, since state leaves the server; (4) tag every row in `judge_decisions` with the provider and model so
  OpenRouter results are never read as Jev's calibration; (5) pick a small cheap model and a hard per-minute call cap, as the
  feed asks about every ship that looks worth a second opinion; (6) this tests plumbing and prompts only: whether the real
  Jev is calibrated still needs its own key and the week of shadow logging in the item below.

- [ ] **Rename the project to tailwinds (raised 2026-10-11, operator; plan only, not started).** `stcommand` appears about 625
  times in ~70 files; most are harmless, a few are not. Order: (1) safe and mechanical: `package.json` name, README, CONTEXT.md,
  `docs/`, `guide.html` title, UI titles, and `.mcp.json` (rename the server and fix its URL: it still points at the shut-down
  `stcommand.onrender.com`); leave CHANGELOG history as written, add one line noting the rename; keep or migrate the
  `stcommand-cartography-bookmarks` localStorage key so saved bookmarks survive. (2) needs both names for a release: the 65 MCP
  tools (`stcommand_*` -> `tailwinds_*`, with the old names as aliases, since agents, saved prompts, CLAUDE.md and
  `PLAYER_INSTRUCTIONS` use them), the `STCOMMAND_MCP_TOKEN` env var (read both), and the `sctk_` key prefix (never invalidate
  existing keys; a new prefix for new keys is optional, accept both). (3) leave alone or do last in a maintenance window: the
  `stcommand` Postgres schema, role and `search_path` (invisible to users; `DB_SCHEMA`, `scripts/assert-test-schema.mjs` and the
  `stcommand_test` schema must change together), and the GitHub repo (redirects work, but session repo scoping, remotes and the
  dual-push convention in CLAUDE.md reference it; the feature branch name is fixed by the environment). Decisions needed first:
  rename the tools or only the branding; UI name "Tailwinds" or keep Deck/Tower; rename the schema and repo or not.

- [ ] **Look into splitting the front end into its own project (raised 2026-10-11, operator).** Tower and Deck are static
  files in `public/` served by the engine process, so a front-end-only change redeploys and restarts the server, which
  drops the live fleet loop for a CSS fix. To look into: (1) serve `public/` from a separate static host (or a separate
  deploy of the same repo) that talks to the engine over `/api`; (2) what that does to session cookies, CORS and the
  `/shared` module paths; (3) whether a cheaper step does most of it, such as the engine reading `public/` from disk on
  each request so a files-only deploy needs no restart; (4) how the two stay version-matched when an API shape changes.

- [ ] **Decision model: evaluate before it does anything (raised 2026-10-11, operator).** The router and the attention feed
  are built and off (CHANGELOG 2026-10-11). To do: (1) get a `TYPESAFE_API_KEY` (access is limited early access; the docs do not
  say how, and Vercel's AI Gateway lists it as `typesafe-ai/jev`); (2) turn on `jevAttention` and `jevRouter` for a week and
  read `judge_decisions`: do high-confidence flags match what happened? (3) only then consider using confidence to act, for
  example recommending approvals (the provider's "confidence-gated routing" pattern fits our `/confirm` gate); (4) a Deck
  panel for the attention feed (Tower has one); (5) a way to mark outcomes in `judge_decisions.outcome` so calibration can be
  scored; (6) the dispatch-loop case (THEO-62: a match every minute that never starts) is not caught by the repeated-line
  rule because its lines differ, so it needs its own fact.

- [ ] **Finish the week-keyed history (raised 2026-10-11, operator).** The ledger is kept and keyed by agent and reset
  date (CHANGELOG 2026-10-11). Still to do: (1) a week-over-week comparison view in Tower/Deck and an ops tool over
  `Store.ledgerWeeks()`; (2) `activity`, `bucket_ledger` and the wealth samples are still wiped each reset and unkeyed;
  (3) let the reset watcher detect a reset and clean up without `ST_ACCOUNT_TOKEN`, so only re-registration needs it
  (on the new server it stays "disabled" with no token, so the cleanup never ran); (4) rows written before the key
  existed and before the current week stay unkeyed and invisible, which is intended but worth a one-off backfill if old
  weeks should be comparable.

- [ ] **Plan infrastructure for gate-free ships (raised 2026-10-10, operator).** The new bulk freighter (THEO-85, bought
  2026-10-10 at MC94-E10B for 3,766,800c; 490 cargo, 4,000 fuel, speed 60) has a hyper/jump drive and does not need gates.
  Everything cross-system today assumes gates: `MAX_POSITIONING_HOPS` (3) and `GalaxyAtlas.jumpPath()`/`canJump()`, the
  `galaxy_gate_construction` completeness checks, `crossSystemTripCost()`/`crossSystemHops()` pricing in
  `computeDispatchRoutes()`, `TraderAgent.jumpToSystem()`, `FleetManager.jumpToward()`, tour `hopToward()`. Needed:
  (1) read a ship's drive capability from its modules/mounts (the shipyard listing for SHIP_BULK_FREIGHTER shows only
  cargo holds and crew quarters, so confirm what the live ship reports before building); (2) the real rules of the drive
  (range, fuel or other cost, cooldown, which API call: jump with a jump-drive module vs warp), then a per-ship reach model
  in place of the gate graph; (3) route costing per ship class, since a gate-free hull can trade any system pair in range
  (including systems whose gates are unfinished, e.g. YG40, ZZ69, JU15) at a different cost and trip time than a gated one;
  (4) dispatcher/matching must offer such a ship the whole in-range work list (`routeMatchTopN` helps here); (5) tour and
  mapping, so one such hull can chart or deliver to systems no gate reaches; (6) show the capability in Deck/Tower fleet
  rows. Follow the self-contained-module rule (pure planner, policy as a doctrine clause, switched off first).

- [ ] **Metrics follow-ups (raised 2026-10-10).** Shipped the Deck and Tower Metrics screens. Not built: profit per
  route (buy and sell are separate ledger rows, so this needs a trip id on both); trader utilization (share of time with
  cargo or flying to a buy market) which needs per-ship state history; contract and mission income (not in the ledger).

- [ ] **Mission price target as the control, not a guard (raised 2026-10-07, operator).** With `recoverPct` on, the
  ceiling sets the price the market is held at and the producer's refill sets the buying rate (see
  `docs/reset-opening-playbook.md`, "The ceiling is a target price"). Today the ceiling is `maxInflationPct` over a
  baseline seeded once (THEO F53: 1,051). Make it explicit: (1) a target price set relative to the opening price when
  the mission starts, shown as a price, not a percent; (2) adaptive: tighten the target when every input of the
  producer is at HIGH (production can sustain a lower price) and relax it, within a bound, while inputs are SCARCE;
  (3) show the resulting expected rate (units/hour at the target) on the chain panel so a too-low target that would
  stall the gate before the reset is visible. Also: never swap a mission carrier that still holds mission cargo
  (2026-10-07, THEO-2B sold 20 FAB_MATS bought at 1,464 back for 706 after being moved to a feed).

- [ ] **Trader starvation follow-ups (raised 2026-10-07, THEO-C/THEO-30 check).** Shipped: the scheduler pass cap,
  the boot gate, and one-call junk dumps for mining drones (CHANGELOG 2026-10-07). Measure the drones' call share after
  the deploy (`stcommand_ops_instances` byCaller). Still open: (2) Route churn: three times in 90 minutes the dispatcher reassigned
  THEO-C/THEO-30 while they were flying empty to the previous route's buy market; keep the current route unless the new
  one beats it clearly. (3) A server restart reshuffles assignments (THEO-C lost a 16.9k/trip EQUIPMENT leg one stop
  from its buy market for a 4.2k JEWELRY one); restore the last assignment of a ship already en route. (4) A restored
  operator hold loses a race with the trader's first tick: THEOREM_DEV_2-1, held at F52, logged "operator hold at F52"
  at 04:10:22 after a restart, then "no claimable route viable / discovering prices" at 04:10:26 and flew to H55 anyway.
  Every restart moved it (03:44, 04:10). The trader should not tick before the restore loop's holds are in place.
  (5) The dispatcher assigns legs below the trader's own `marginFloor`: 07:25, THEOREM_DEV_2-1 got FERTILIZERS G54 ->
  E49 (+96/unit) and 2-3 COPPER H55 -> A3 (+60) with the floor at 300; both traders rejected them and went "discovering
  prices", while FIREARMS E48 -> J62 sat at +1,141 and ASSAULT_RIFLES at +844 (fresh at both ends) unassigned.
  Fixed 2026-10-07: the dispatcher drops direct legs at or under `effectiveMarginFloor` before assigning, and a trader
  that refuses an auto leg hands it back (`RouteDispatcher.decline()`). Still open: check why its FIREARMS value
  (8,592) was a third of margin x tradeVolume (22,820). (6) The dashboard shows a mission/feed carrier's stale cached snapshot: 12:31 THEO-1
  read "in orbit at I59, fuel 180" (from 12:15) while it was docked empty at F53; a suspended agent's cache is never
  refreshed while the mission flies the ship. Refresh it from the mission's own reads, or show the live ship.

- [ ] **Engine flaws found starting THEOREM_DEV_2 fresh (raised 2026-10-06).** (1) A tour ship holds in place while
  a keeper-probe approval is pending (`tour scout: holding at ... — keeper probe approval pending`), so a new tenant's
  first tour never starts until someone decides. (2) `maybeBuyShip`'s "best-scored" fallback proposes drones even with
  `minerTarget`/`siphonTarget` 0; only `shipCap:FRAME_DRONE` 0 stops it. (3) An idle trader with no viable route
  ("discovering prices...") flies back and forth between the only two known markets, refuelling each time, instead of
  heading for an unpriced one. (4) A new tenant's command frigate is hull-classified as a miner at boot regardless of
  `minerTarget`. (5) An MCP tool error can surface as the literal text `[object Object]` (seen on
  `stcommand_dispatch_ship` for a ship mid-tour). (6) A tour shuttle can get stuck bouncing between two far markets
  (J61 <-> J62), refuelling every 4 minutes. [Likely fixed 2026-10-07: tour stepping stone, see CHANGELOG.]

- [~] **Batch ship reads: serve agents from a periodic `GET /my/ships` sweep (raised 2026-10-06, operator;
  Phase 1 SHIPPED 2026-10-06).** Every agent step starts with `GET /my/ships/:id` (`ShipAgent.refresh` /
  `TraderAgent.refresh`, ~85-90 per five minutes at 40 ships, the largest single use of the 90-a-minute budget),
  and it grows with every ship — at 100 ships it would be ~45 a minute on its own. `GET /my/ships` returns complete
  ships twenty per call, so a sweep is 2 calls at 40 ships and 5 at 100.
  - **Phase 1 (shipped): measure only.** `ShipSnapshotBoard` (`src/engine/shipSnapshots.ts`) takes a sweep every 30s
    (`FleetManager.sweepShips`, routine priority, ~4 calls a minute) and compares every single-ship read the fleet
    makes anyway with the latest sweep copy, counting only reads Phase 2 would really have served (copy under 30s
    old, ship hasn't acted since) and advancing the copy as Phase 2 would (finished transit = arrived, expired
    cooldown = clear). Logs `ship sweep: N single reads · E could have used the sweep, M matched (x%) · mismatches:
    <field counts> (status: <top transitions>) …` every five minutes. The copy is dated by when the sweep request
    was sent, so an action during the in-flight sweep counts as "acted since" (the first summary, 80% matched, was
    biased by dating it on response). **Next:** read a day of these lines. Phase 2 is worth it only if the
    match rate is very high and the mismatches are explainable.
  - **Phase 2: let `ShipProxy.refresh()` use the copy** when it is newer than the ship's last local update and under
    ~20s old; otherwise read as today. Every action that fails because the state was wrong (not docked, in transit,
    cargo mismatch) forces a fresh single read and one retry. Shorten the sweep to ~15s at that point. Cooldowns by
    their absolute `expiration`, never `remainingSeconds`.
  - **Phase 3:** route `FeedManager.getShip` / `MissionManager.getShip` (another ~25 per five minutes) and the
    dashboard snapshot's two-minute full list through the same copies; drop the separate list.
  - Watch: the per-ship "last updated" ordering (an action response must always beat an older sweep), and that the
    sweep itself never queues behind deferrable work (routine tier, one in flight at a time).
  - **2026-10-15 reading, 183 ships:** single-ship reads ran 119-153 per five minutes (about 28 a minute, close to a
    third of the 90-a-minute budget). Every read that could use a sweep copy matched it (100%), but from 19:57 no read
    could: at 183 ships a sweep is 10 pages at routine priority, and with the budget pegged it doesn't finish in time
    (`ships` calls waited 11 s on average, 57 s at most). The copies are good; the sweep can't keep up. Before Phase 2,
    either give the sweep a reserved share of the budget, or skip most single reads by trusting each ship's own last
    action response (it already returns nav, cargo and fuel) and reading only when an expected change is due (arrival,
    cooldown end) or a step fails.

- [~] **Rebuild the admin area from scratch (raised 2026-10-04, operator;
  first pass SHIPPED 2026-10-04 as Deck's Admin tabs — see CHANGELOG; remaining:
  confirm in use with `OPERATOR_AGENTS` set, then retire `public/admin.html`, the
  `/admin` route and `ADMIN_KEY`; a watcher pause/run-now switch; per-agent
  Health for non-operator tenants).** `public/admin.html` + `src/http/admin.ts` predate
  most of what now exists. A rebuild should surface, at minimum: the reset
  watcher (`reset_watch` status, next reset countdown, `ST_ACCOUNT_TOKEN`
  configured?, manual "run recovery now" / pause switch); the weekly
  scoreboard (`run_results` — a table and week-over-week comparison, play
  profile per week); the fleet timeline and cash curve (`fleet_events`,
  `run_timeline`, the ops `timeline` tool); the ops tools as pages (stuck,
  instances/rate limit, keepers, pnl, logs); tenant list/cleanup/impersonate
  as today. **Decided 2026-10-04:** auth moves to the normal tenant session
  plus an operator flag (retiring the shared `x-admin-key`), and Deck absorbs
  the admin pages (it is the desktop home; `public/admin.html` goes away).
  Also decided: the operator flag is an env list of agent symbols (e.g.
  `OPERATOR_AGENTS=THEO`; can't lock the operator out), and the Deck layout is
  tabs on one page or separate pages — NOT stacked sections.

- [ ] **Discuss: should a tender wait out a jump cooldown before flying
  to its fuel market? (raised 2026-10-03, operator wants to talk it
  through before anything changes — do NOT change it unprompted.)**
  `ShipProxy.runTenderGoalStep()` now calls `refresh()` + `waitCooldown()`
  at the top of every step (added with the stale-position fix, f4f92cb;
  same pattern repair/scrap/hold use). After a gate jump the ship carries
  a ~10 min cooldown, so THEO-6B sat in X1-Y84 for ~4–5 min before
  heading to the fuel market. Unverified belief: SpaceTraders only blocks
  jump/scan/survey/extract during a cooldown, not plain navigation, so the
  wait may be unnecessary for the non-jump steps (fly to market, buy,
  fly to the stranded ship) and could be limited to the jump hop. Trade-off:
  saves minutes per cross-system rescue vs. changing behaviour that works.
  Open questions: confirm navigation really isn't cooldown-gated (a
  one-off live test), and whether repair/scrap/hold would want the same
  relaxation or only tenders. Current decision: leave as is.

- [ ] **H56 IRON_ORE feed vs. trader buying pressure — live crew-size test,
  in progress 2026-09-26.** Context: H56 is a refinery market — it
  *imports* IRON_ORE (buys from the mine feed's miners) and *exports*
  IRON (sells to arbitrage traders like THEO-6/THEO-8, who resell it
  elsewhere, e.g. THEO-8 bought 80u IRON @ 83-86c and sold it at F52 for
  171c). When a trader buys IRON out faster than miners feed IRON_ORE in,
  H56's IRON price spikes and its supply rating degrades (SCARCE/LIMITED)
  — confirmed 9/25: IRON purchase price ran 90c→317c over ~4h under a
  thin, unbiased 3-ship crew. Two related fixes landed the same day:
  auto-wiring miner preference (`setMinerPreference`) so `mine` feeds bias
  survey/extraction toward the feed's own good, and changing `mine` feeds
  to top off the hold before selling (`stepCarrier()`'s `holdFreeSpace`
  check) instead of delivering on every small extraction batch. Since
  then IRON's price has fallen every hour, back down to 87c/ABUNDANT by
  9/26 20:00 as crew size grew 3→6→8. Operator is now running 10 miners +
  6 dedicated surveyors feeding H56, against one trader currently buying
  IRON there, and reports the price looks "balanced" — i.e. holding in
  the MODERATE-or-better supply band (operator's stated target) rather
  than sliding back to LIMITED/SCARCE. Update 2026-09-26 ~22:00-23:00:
  operator identified the two buyers as THEO-1 (steady, tagged `(feed)` —
  40u IRON every ~11min, a real chain buyer per `feed IRON →
  X1-SN30-F50`) and THEO-6 (also just assigned to that same chain at
  22:16, plus occasional opportunistic buys from THEO-8, untagged, not
  part of any feed). With both THEO-1 and THEO-6 buying against the
  10-miner/6-surveyor crew, IRON slipped from 89c/ABUNDANT (22:17) to
  106c/MODERATE (22:53) — still in the green zone but trending the wrong
  way. Operator's read: "10 miners isn't enough for that" (2 buyers) —
  reduced back to 1 buyer at ~22:55 to see if the price stabilizes/
  recovers. **Open**: no read yet on where it settles with 1 buyer, or
  what buyer:miner ratio is the actual breaking point. **Follow-up idea
  raised by operator**: once real price/supply bands are established for
  a route under buying pressure, feed the observed thresholds into the
  margin-gate/`force` logic so a feed could auto-react (e.g. bias crew
  size or throttle a chain's buy leg) instead of needing a human watching
  the dashboard.
- [ ] **Port `v2.js`–`v5.js`/`deck.js`'s Construction missions panels to
  `assignedShips`/multi-carrier.** `Mission.assignedShip` (singular) was
  replaced by `assignedShips`/`carrierTarget` (see CHANGELOG's
  multi-carrier entry) so a bottleneck material can run more than one
  ship. `v6.js`/`m.js` (Tower) were updated to match; the older desktop
  versions and Deck still read the now-gone `m.assignedShip` field in
  their own mission cards, so they'll show "no carrier yet" even when a
  crew is assigned. Assigning still works everywhere (the API is
  unchanged) — only the display regresses on those surfaces.
- [ ] **Protocol: auto-derived chain proposer for feeder tiers.** The
  engine and manual UI for a feeder tier now exist (`FeedManager`,
  `src/engine/feed.ts` — see CHANGELOG's feeder-tier entry): an operator
  can start/stop/toggle/crew-size a "buy `good` cheap, sell it into market
  X" tier by hand, one tier at a time. What's still not built is the
  *auto-derive* half of the original ask — walking backward from a
  construction site's outstanding material through export→import market
  matches to propose the whole tier chain at once (ore→refinery→
  intermediate→site), shown as an editable list the operator confirms
  before it starts, with one master toggle for the whole chain rather than
  per-tier toggles. First live test case: X1-SN30's ADVANCED_CIRCUITRY
  bottleneck at I60, chain ore→H56→F50→D40 (H56 imports IRON_ORE/
  ALUMINUM_ORE/COPPER_ORE and exports the refined IRON/ALUMINUM/COPPER
  that F50 imports; F50 exports ELECTRONICS, which D40 imports on the way
  to its own ADVANCED_CIRCUITRY export) — can be set up manually with
  three `/api/feeds/start` calls today; the proposer would do that in one
  step for any future system.
- [ ] **Verify Deck (`/deck`) live — feature-parity pass, 2026-09-27, not
  yet manually verified in a browser.** Overview/Fleet/Markets/Map/Ops/
  Doctrine all have real content now (passes A-D of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20), plus a new
  **Feeds** screen and this pass's additions (see CHANGELOG's "Deck
  feature-parity pass" entry): Feeder tiers/chains, Ops' Automation +
  Notes panels, Markets' segmented Routes/Yards/Prices control + the
  miner-preference mini-form, Fleet's ETA column, and Overview's
  "Matched" P&L tile. `npx tsc --noEmit` and `node --check public/deck.js`
  are clean and the HTML's div/id balance was checked mechanically, but
  none of it has actually been clicked through live — verify each new
  panel renders against real fleet data (a running feed, a ship
  IN_TRANSIT for the ETA column, at least one closed trade for Matched to
  show a number instead of "—") before calling this pass done. The ⌘K
  hint still renders but does nothing. Once live verification is
  complete: Fleet pass follows the same spec-then-build pattern, once
  Overview's approach is proven and its live-ops needs are understood.
- [ ] **Hosted MCP server (`docs/mcp-server-plan.md`) — first pass shipped
  2026-09-19, connection confirmed working live the same day.** Auth
  (`tenant_mcp_keys` + `POST/GET /api/mcp-keys`, minted from the
  dashboard's Book-mode settings panel), mounted at `/mcp`, 20 tools (10
  read-only, 10 write) covering dispatch/hold/release/jump/tour-dispatch/
  role/dock/refuel/buy/approvals plus a trading/pricing intel group
  (best price, price trend, shipyard inventory, known goods) — every
  write tool routes through the exact same `FleetManager` method the
  matching dashboard route calls (the doc's §3 constraint). Along the
  way: fixed `createMcpAuth` to accept a bare key (not just literal
  `Bearer <key>` — a real `.mcp.json` config committed by another session
  hit this), and added request-level logging to `/mcp` since Render
  doesn't capture request-type logs for this service at all (confirmed
  absent even for ordinary dashboard POSTs). Still to build (tracked in
  `src/mcp/tools.ts`'s own trailing comment): bridge, markets' routes
  view, galaxy overview, missions/contracts/warehouse/doctrine writes,
  the confirm-flag requirement on destructive actions.
  **Follow-up idea, not started**: the co-pilot (`agentChat.ts`'s
  `ChatAgent`) should never grow its own separate execution tools —
  its own header comment ("adding an execution tool later is one object
  in `tools`") invites exactly the divergent-path mistake this session's
  earlier fixes were about. When it needs to act, it should call the
  same handler logic `src/mcp/tools.ts` registers, not reimplement
  dispatch/hold/jump/etc. a second time. Written up in
  `docs/mcp-server-plan.md` §9 and `docs/engine-redesign.md` §9 (the
  latter generalizing this past ship ownership specifically — "any
  shared action surface needs one gate, not several").

- [ ] **Why doesn't the fuel-tender rescue ever reach a ship stranded
  mid-fleet-driven-goal?** Found 2026-09-14 investigating why THEO's
  overnight credit balance was flat: THEO-4 and THEO-9 (both mid-scrap,
  0 fuel, not at a market) sat stranded for hours. `getStrandedShips()`
  derives stranded status independently from live ship state (not
  intent-gated), so it should have flagged both — the `fleet-rescue`
  scheduler task ran every cycle the whole time — but no "ferrying Nu
  FUEL..." log line ever appeared for either ship. `StrandedError`
  (shipped same day, see CHANGELOG) stops the wasted retry loop these
  two ships were stuck in, but doesn't explain why `makeRescuePlan()`
  never produced a plan for them in the first place — that needs tracing
  into `rescueFailures`/`makeRescuePlan()` directly, ideally with live
  DB/dashboard access rather than log archaeology alone.

- [ ] **Wire crawled_waypoints into an actual map view.** Shipped
  2026-09-13: `GalaxyCrawler.crawlSystemsPage()` persists each system's
  public waypoint layout (`Store.mergeSystemWaypoints()`, migrations/020)
  into its own `crawled_waypoints` column — free data from a `GET
  /systems` call the crawler already makes, previously discarded. Shipped
  2026-09-14: Phase B (the crawler now runs on plain tokenless `fetch()`
  against the public API, no longer routed through any tenant's
  `SpaceTraders` client or sharing its rate limiter — `TenantRegistry
  .anyBootedApi()`, which existed solely for this, was removed) and Phase
  C (an ongoing opportunistic jump-gate sweep — once the systems crawl is
  done, `GalaxyCrawler` cycles through every known-but-unresolved gate
  from `crawled_waypoints`, calling the public, chart-gated `.../jump-gate`
  endpoint on the chance someone else has charted it since; hits are
  merged into `jump_gates` via the new `Store.mergeGateConnections()`,
  read-modify-write on just that column so it never touches
  `waypoints`/`crawled_waypoints`; a drained queue rebuilds and re-sweeps
  every 24h since "still uncharted" is a matter of *when*, not *if*, for
  a gate someone eventually visits). `GalaxyCrawler`'s constructor is now
  `(store, log)` — no longer takes a tenant-API getter.
  **Still not done**: nothing renders any of this yet. The public
  cartography page (`GET /api/cartography/systems`) only ever draws one
  dot per *system* (`listGalaxySystemPositions()`), never per-waypoint
  detail directly on the map itself — clicking a dot now opens a side
  panel with per-system waypoint/gate detail (shipped 2026-09-14, see
  CHANGELOG), but the map's dots themselves stay system-granularity.
  Jump-gate connections learned by the Phase C sweep specifically (as
  opposed to scanned tenant gates, which already show as connection
  lines) still aren't drawn. Tower's Map and desktop's galaxy view both
  read a tenant's own `GalaxyAtlas.listSystems()` (in-memory,
  tenant-scan-only), not this shared DB column at all.

- [ ] **Set up the A/B tenants once play-style tracking ships.** Operator
  plan 2026-09-13: THEO-2 as the "manual intervention" arm, compared
  against an unmodified-automation baseline tenant. **Profile labels
  done, same day** — operator has labeled the tenants via the admin
  page's Profile column. Still open: log a checkpoint on each labeled
  tenant (via the "Play style" panel) to get the system-attribute
  snapshot on record — the same manual strategy that works on THEO
  doesn't transfer to THEO-2 at all, because the two home systems aren't
  comparable (market/shipyard/gate counts differ), so this is worth
  doing specifically for that data point, not just the label. THEO's
  *own* early manual overrides (command ship → tour, approved two
  miners, bought and converted a third to trader) happened before this
  feature existed and can't be reconstructed automatically — log it as
  a checkpoint note too if still wanted on the record.
- [ ] **Tune the starter doctrine templates once real data exists.**
  Shipped 2026-09-13: `src/engine/systemClassifier.ts` classifies a
  tenant's home system (isolated / market_desert / shipyard_poor / hub /
  standard) from the same attributes the checkpoint captures, and the
  admin page's Play style panel shows the matching starter doctrine
  template with an "Apply template" button. The archetypes and every
  template value are a first-pass guess, not a tuned result — genuinely
  worth revisiting once THEO-2 (or any classified system) has enough
  runtime to show whether the suggested deltas actually help. Nothing
  applies itself; it's a suggestion the operator clicks to apply, same
  weight as any other doctrine edit.
- [ ] **Verify the reset-cleanup admin tool actually ran clean.**
  Shipped 2026-09-13 in response to a live SpaceTraders universe reset
  — see `CLAUDE.md`'s "SpaceTraders universe resets" section for the
  full story and `CHANGELOG.md` for the shipped entry. Typechecked;
  `tests/admin.test.ts` couldn't run against the remote test Postgres
  (`ETIMEDOUT`, same sandbox flakiness, retried once). After using the
  admin page's "After a server reset" button: confirm the cartography
  page starts showing fresh (empty, then slowly repopulating) data
  instead of the old universe's systems; confirm the cleared tenants'
  dashboards come up empty/fresh rather than showing ghosted
  old-universe ships or routes; confirm `docs/TODO.md`'s next galaxy-
  crawl-progress check (`GET /api/admin/galaxy/status`) shows the count
  climbing from 0 again.
- [ ] **Proactive reset detection.** Idea from the same incident, not
  built — see `CLAUDE.md`'s "Open idea, not yet built" section. Right
  now a reset is only noticed reactively (a tenant's own live call
  fails with the dead-token message). Poll the public, unauthenticated
  `GET https://api.spacetraders.io/v2/` on a slow interval, compare its
  `resetDate` against the last one seen, and surface a banner the
  moment it changes — catches it before any tenant's own error wall
  starts, and works even with zero tenants currently booted.
- [ ] **Verify Tower (`/m`) live — all 5 tabs.** Home and Fleet confirmed
  working by the operator 2026-09-13 (the one blank-deck report traced to
  an expected cache-skew window right after a deploy, not a code bug —
  see `CHANGELOG.md`'s Fleet entry). Map, Markets, and More shipped same
  day, not yet seen live. Still worth a pass on: Fleet's individual
  actions (Hold/Release, Repair, Send to waypoint, Assign route,
  Sell/Scrap) actually reflecting on desktop too (same `/api/fleet/*`/
  `/api/dispatch` endpoints — should just work); Map's blips positioned
  sensibly for a real system, tapping one opens the sheet, and Buy from
  the sheet actually purchases; Markets' route-assign picker and Yards Buy
  button; More's contract accept/decline and doctrine toggles actually
  landing (same endpoints desktop already uses). All 5 tabs (Home, Fleet,
  Map, Markets, More) are now built — this is purely a live-verification
  pass, no more screens pending.
- [ ] **Tour more systems to build cross-system pricing data.** Operator
  request 2026-09-12 — more tour coverage across more systems is needed
  before cross-system routes have enough data to evaluate. **In
  progress, 2026-09-13**: operator is manually converting traders to
  explorer for ~2 hours at a time when a system runs out of good routes,
  to force fresh tour coverage rather than waiting on the existing tour
  ships alone. Worth eventually automating (a doctrine rule that
  temporarily reassigns an idle trader to explore when a system's route
  list runs dry?) rather than a standing manual habit — not scoped.
- [ ] **Verify the three new approval gates fire live.** Shipped
  2026-09-13: `buyScout` (`maybeBuyScout()`), `buySiphoner`
  (`maybeBuySiphoner()`), and `installScanner` (`maybeInstallScanner()`)
  now go through `ApprovalGate` the same way `buyShip` already did —
  same 2h auto-approve-on-timeout policy, same "pending request is a
  guard clause, not a new suspension mechanism" shape. Typechecked
  clean; `tests/fleet.test.ts` couldn't run against the remote test
  Postgres (`ETIMEDOUT`, same sandbox flakiness, retried once). Worth
  watching the admin/dashboard approvals list for the first live
  `buyScout`/`buySiphoner`/`installScanner` request to confirm it
  actually shows up and decides correctly, same as the reset-cleanup
  tool's own "shipped, not yet seen fire live" pattern.
  **Investigated and deliberately NOT gated**: ship repairs
  (`maybeRepairFleet()`) — cheap, frequent, and delaying one risks
  losing the ship to a critical failure, the opposite of what a gate is
  for. Ship sell/scrap turned out to already be fully operator-gated —
  `sellShip()` only ever runs from an explicit dashboard/Tower "Sell"
  click (`POST /api/fleet/sell-ship`); the `scrapHere` callback wired
  into every `ShipAgent` role is plumbed but never actually invoked
  autonomously anywhere in the engine today (confirmed by search) — so
  there was no automatic scrap decision to gate.

- [ ] **Supply-chain-aware buy-side price manipulation.** Raised
  2026-09-19, day before a scheduled reset: `GET /market/supply-chain`
  (public, unauthenticated — confirmed live against the real API) returns
  `exportToImportMap`, the game's production graph — e.g. `FAB_MATS`
  needs `IRON`+`QUARTZ_SAND`; `ADVANCED_CIRCUITRY` needs
  `ELECTRONICS`+`MICROPROCESSORS`, which themselves need
  `SILICON_CRYSTALS`+`COPPER`. Selling a good's upstream inputs into a
  market that exports it raises that market's local supply/activity,
  which drives its sell price down over successive trades — not
  instantly, real trade volume over time. This generalizes past gate
  materials to any produced good a trader wants to buy cheap, and is
  strongest at *low*-`tradeVolume` markets (the API's own trade-volume
  field is explicitly "how much a market's price swings per trade" — the
  opposite of where you'd naively look for a big, liquid market to
  manipulate).
  **Explicitly NOT building into the fleet automation before tomorrow's
  reset** — this galaxy's specific markets are about to be wiped, so
  there's no runway for anything built against them tonight to pay off,
  and this is a real new pricing strategy (ties directly into the
  trade-routing/pricing design in `docs/engine-redesign.md` §4.1,
  `RouteCandidate.score`) that deserves a proper design pass once there's
  a fresh galaxy to design against, not a rushed hack under deadline
  pressure.
  **Operator wants to try it manually first, tomorrow, before any of it
  gets built** — pick a market in the new galaxy that exports something
  worth buying in bulk (a gate material or otherwise), identify its
  upstream inputs from the supply-chain graph, sell those inputs into it
  by hand via the dashboard, and see whether the price actually moves the
  way the theory predicts before spending effort automating it.

## UI organization — revisit

- [~] Revisit how the UI is organized. Deck SHIPPED 2026-10-16: seven rail groups with sub-tabs
  (docs/deck-desktop-design.md §16), and a Local / Cross-system filter on Routes. Tower's bottom bar followed on 2026-10-16
  (Overview · Fleet · Trade · Industry · More). Next: a local-only (reach) control in Fleet's ship detail on both, Local
  placement and Dispatch in Tower if wanted, and a way into the Co-pilot screen (it has none).

## Design docs written, no implementation decision made

- [ ] `docs/api-request-priority-plan.md` — thread Scheduler Task
  priority into `RateLimiter.acquire()`. Not urgent; latent until the
  shared limiter is actually contended.
- [ ] `docs/rate-limiter-saturation-plan.md` — queue cap + shedding for
  the shared `RateLimiter`. Same — latent at current tenant count.
- [ ] `docs/ambiguous-mutation-safety-plan.md` — catch the uncaught
  `fetch()` throw in `Client.request()` and add live-state
  reconciliation before retrying a mutation. **Worth doing regardless of
  scale** (real money-loss shape, not a performance/fairness concern) —
  higher priority than the other three in this section.
- [ ] `docs/api-capacity-doctrine-plan.md` — generalize the
  `explorerCreditFloor` pattern to API capacity. Explicitly recommended
  **not** to build yet — revisit only after the saturation plan lands or
  tenant count grows enough to matter.

## Scaling the fleet past ~180 ships (raised 2026-10-15, operator)

Measured 2026-10-15 at 183 ships: CPU busy about 19%, event-loop delay p99 11 ms, so computation isn't the limit. The
game budget is (about 90 calls a minute, pegged), and so is the dashboard payload. Step 1 (lean state, galaxy on its own
version) and step 2 (gzip) shipped 2026-10-15; see CHANGELOG.
- [ ] **3. One combined poll with versions.** Replace the nine requests each screen makes every 15 s with one endpoint that
  only resends slices that changed, cached briefly and shared by every open screen.
- [~] **4. Spend fewer API calls.** First pass SHIPPED 2026-10-15 (see CHANGELOG): sweep off, shipyard snapshots every
  30 min, buy-pass yard scans only where a ship is, unfinished gates rechecked every 20 min. Keeper markets already
  poll by volatility (`keeperCadence.ts`). Second pass SHIPPED 2026-10-15: the ship book in
  shadow (doctrine `shipBook`, off) and the keeper cadence seeded from stored snapshots. **Next:** read a few
  `ship book (shadow)` lines; turn `shipBook` on if the match rate is ~100% and the mismatches are explained, then
  watch `ship <- ShipProxy.refresh` fall in the limiter's top callers. After that, market snapshots (~15 a minute)
  are the largest overhead left.
- [ ] **State backup.** Each state refresh writes the whole snapshot (galaxy included) to the database
  (`saveStateSnapshot`). Write the lean snapshot instead, or less often.
- [ ] **Market book: fold our own trades into stored prices (potential next step, raised 2026-10-16).** Every buy and
  sell response already carries the new price for that good (`transaction.pricePerUnit`, and the market's price after
  our lot). Write it into the registry snapshot and `market_latest` so prices stay fresh with no extra calls. Hold
  until the snapshot reuse (`marketSnapshotReuse`, shipped 2026-10-16) has been measured: if market reads are already
  low, this matters less. Care: a response gives one good's price, not the whole market, so it must update that good
  only and must not reset the market's snapshot age (or the reuse rule would skip a full read the market needs).
- [ ] **5. Split the web server from the engine** into two processes, joined by Postgres notifications.
- [~] **6. Push instead of poll.** First slice SHIPPED 2026-10-15: ships, credits and activity over `GET /api/live`
  (see CHANGELOG); fleet status, dispatch and approvals followed the same day, then Tower's attention list, the programme
  (contracts, missions, feeds, chains) and keepers. Markets stay polled while the Markets tab is open; reports (Metrics, Season, Systems) keep their
  minute refresh until step 7. Replaces step 3 (the combined poll).
- [ ] **7. Precompute the reports** (per-minute and per-hour summary tables) instead of rescanning the ledger per request.
- [ ] **8-10. A new engine alongside the old one:** a central planner that hands out the API budget by value, an event
  log with views built from it, and a migration ship by ship through the existing ownership claims, shadow mode first.

## Experiments — running or recorded

- [ ] **Local-only trader in TS44 (2026-10-15), first trial.** Setup: THEOREM-B0, a light freighter (80 hold), set to
  reach "system". Result: no local work. Evidence: at 14:05 TS44 had 8 same-system routes (best FOOD 81k a trip); by
  15:30 no route bought in TS44 at all. The only routes buying there were two LAB_INSTRUMENTS runs into CH68, which are
  cross-system. B0 was moved to X1-CM13 (10 local routes, best 34k) on a tour order.
  TS44 attributes: two gates from CH68, CM13, JT85, ZN16, QS15 and RM59; three gates from HR84; gate X1-TS44-A20A
  complete, linked to TP16, FP91 and CK71. Its shipyards sell only probes and siphon drones, no trading hull. Holds 14
  keeper ships and no traders.
  Open question for the pattern: do same-system routes in a system come and go with its market prices, and how fast?
  Record local-route count and best profit per system at each check, so the sales pattern can be read later.
- [ ] **Local-only trader for an in-system test (rule for the next trial).** A local ship only gets local work. Before
  moving one, check the board for same-system routes in its destination, and move it only if the count is above zero.

- [ ] **Warp into gate-locked systems, then trade locally.** Idea from 2026-10-15: a system whose gate is not built can
  still be entered by warp (we already warp into FY6 and GX41). A warp-capable ship could set up local trading there
  without any gate spend. Needs a check of which of our known systems have no finished gate and enough local routes.

## Parked ideas — raised, not acted on

- [ ] **Gate payback metric: the latest day a gate is still worth opening (operator, 2026-10-16).** Gates can't be opened
  in the first hours after a reset (cash, materials, and for an unreachable system the relay), so the question per gate is
  how late is too late. Per gate: `cost` (materials at the spread-buying price, see below), `uplift` (extra profit per
  hour once it is open), `payback = cost / uplift`, **open-by = reset - wind-down(1 h) - payback**, and the cost of delay
  is `uplift x 24` a day. Worth it when the earliest feasible opening (start + build time) is before open-by; the slack is
  the difference. Net value of opening at hour h of the week is `uplift x (167 - h) - cost`. Worked for GX41 on 2026-10-16
  (cost about 4.15M, one relay, reset Sun 13:00 UTC): at 150k/h open by about hour 139 (Sat morning), 250k/h by hour 150
  (Sat evening), 400k/h by hour 157; opening on day 3 is worth about +10M at 150k/h and +20M at 250k/h, on day 5 about +3M
  and +8M. Cost model: greedy spread over every producer, each tradeVolume lot raising that market's price about 4.5%
  (3.5-5.6% measured), which came to 4.15M against 4.84M from the single cheapest market. Build it as a pure module with a
  policy (wind-down hours, price impact), tested, shown on the Systems tab next to each gate-locked system, with `uplift`
  taken from the cross-system routes the gate would open (price gaps against connected systems, less jump cost).

- [ ] **Gate staging: build a gate in an unreachable system from a warp-capable relay ship (operator idea, 2026-10-16,
  "for the future").** For a gate whose system can't be entered by jump (GX41-I60 is the case in hand), station a
  warp-capable ship outside the system as a staging point:
  1. **Spread the buying across source systems**, so each producer's price is bumped a little instead of one market
     ratcheting. This also attacks the real limit: FAB_MATS refills only a few units an hour per market (see the 2026-10-05
     notes in CLAUDE.md and docs/reset-opening-playbook.md), so total units an hour grows with the number of producers fed
     in parallel, not just the price.
  2. **Haulers deliver into the staging ship** the way the warehouse did (a designated ship per material with per-good
     targets). The warehouse code is parked, not deleted: `/api/warehouse/*`, the store tables and per-good targets, and
     the dispatcher's warehouse paths are still there, inert behind the retired doctrine rules (CHANGELOG 2026-10-05,
     "Warehousing parked"; restoring is deleting the keys from `RETIRED_POLICIES` and re-adding the panels).
  3. **When it is loaded, the relay warps straight to the gate waypoint, supplies the construction, and warps out.**
     Run it so the next load is already waiting when it returns, or a second relay alternates: no idle time on either side.
  Open questions for whoever builds it: which of our hulls can warp (needs a warp drive; THEOREM-86 does, and the heavy
  freighter THEOREM-55 has a 490 hold and 4,000 fuel); warp fuel in and out per trip (the flight-mode-aware warp math is
  in `fleet.ts`/`warpTour.ts`) and whether the target system sells fuel for the return; hold size against 2,000 units
  (about 5 trips at 400, one at 2,000 isn't possible); whether supplying the gate needs the ship docked or in orbit at
  the gate waypoint; and the timing against the weekly reset (a gate only pays if it opens early enough: see the 2026-10-16
  GX41 analysis).

- [ ] **Operator "don't fly" on a route.** Let the operator mark a route (good + buy market + sell market) as off-limits,
  so the dispatcher and traders skip it until the mark is removed. Motivating case: the 2026-10-15 PLATINUM sell price
  fell 3.5% over six hours; a route that keeps buying into a falling market should be switchable without changing doctrine.
- [ ] **Buy timing per ship.** Let each ship's purchases follow its own pace (lot size and gap between buys), in the same
  way the per-ship lot policy works, rather than one fleet-wide pace.
- [ ] **One tenant session per browser, not per tab.** Surfaced
  2026-09-13 while building "View as" and "+ New agent" on the admin
  page: session auth is a single cookie for the whole browser, so
  switching tenants in one tab (via either of those, or a normal
  re-login) silently flips every other open tab to the new tenant on its
  next request — there's no real per-tab isolation today. Fine for a
  single operator using one tenant at a time, increasingly awkward now
  that flipping between THEO/THEO-1/THEO-2 is an expected workflow (see
  the play-style A/B tracking work). A real fix would need per-tab
  credentials (e.g. the session id carried in the URL/localStorage and
  sent as a header instead of an httpOnly cookie) rather than the
  current cookie-only model — a real architecture change, not scoped.

- [ ] **Push notifications for Tower (`/m`).** Operator request 2026-09-13,
  explicitly future work, not now. Would need: a service worker
  (Tower currently has none — `manifest-tower.webmanifest` alone doesn't
  register one) to receive `push` events and show a notification even
  when the PWA isn't open; a Web Push subscription per installed device,
  stored per-tenant (a device can re-install/re-subscribe, so this is a
  new table, not a single column); VAPID keys generated and held as env
  vars; and a server-side sender triggered off the same conditions that
  already populate Home's triage feed (a new approval, a ship going
  stranded) rather than a new notification concept. Not scoped further.
- [ ] **A log explorer on the admin screen.** Floated 2026-09-12 while
  debugging DRAGOM-C's stuck retry loop — being able to search/filter
  live app logs from inside the admin UI instead of going through
  Render's own log tools would make this kind of live-ops debugging
  faster. Not scoped: would need to decide on retention/volume handling
  and whether it reads from Render's API or the app's own log stream.
- [ ] **Probes deployed from cargo on heavy haulers.** Floated as an
  exploratory idea; probes have effectively zero fuel and can't
  self-navigate, so "camping" a market with a probe today means buying
  one directly at a shipyard on that exact waypoint. Narrower now than
  when raised: 2026-09-12 shipped auto-buying a probe at any shipyard a
  ship visits, which covers every *shipyard* market automatically — this
  idea would only still matter for a market that has a marketplace but
  no shipyard, which a bought-at-a-shipyard probe can never reach either
  way. Still not investigated.
- [ ] **Keep one unit of a great-price good on hand as a souvenir/marker.**
  Random idea, 2026-09-12: if a tour ship, explorer, or trader anywhere
  stumbles on an exceptional price for something (antimatter was the
  example), hold back one unit in the cargo hold instead of selling the
  full stack. Not scoped at all yet — would need a definition of
  "exceptional," a decision on whether it's purely cosmetic/informational
  or feeds something else (a log entry, a per-tenant "best find" record),
  and whether it's worth the held cargo space on a ship that might need
  it.

- **Steady, spread-out input delivery with a large miner pool (operator idea, 2026-10-05).** Last week the fleet ran
  ~30 miners on the iron source. Hypothesis: with a big pool split across a recipe's inputs and their deliveries
  staggered, so inputs arrive at a constant rate instead of in bursts, a producer like F53 might stay out of
  RESTRICTED/WEAK and its export price might actually fall. Context from 2026-10-05 tests: flooding sand took F53
  sand SCARCE -> ABUNDANT in ~1h (needed ~400-500 units; the first 120 did nothing) and moved FAB_MATS from
  RESTRICTED to WEAK, but iron push drained H55's source and lost money per trip. Do not test until the current
  copper/silicon/FAB_MATS tests finish.

- **Backhaul / trade circuits: a loaded return leg (operator idea, 2026-10-05; re-raised 2026-10-08).** Route economics now charge the empty flight back to
  the buy market as a real cost of every repeat (fuel + time), which is correct for today's A->B->A shuttle. Rough
  concept to investigate later: look for "two-way" lanes, where the ship sells good X at B, buys a second good Y there,
  and carries it back to A (or to wherever it wants to buy X's next round), so the return leg earns instead of being
  sunk fuel. Needs a pair-of-legs search over the same price data (X: A->B, Y: B->A, or a triangle A->B->C->A) scored
  on combined net per hour, plus holding the hold-size / cash constraints across both purchases. Not scoped.
  The operator wants this kept on the list for a future pass. The fuller version is a "circuit": a fixed loop of 3+
  markets where every leg carries cargo, assigned to one trader as a standing route. Check first how much the dispatcher
  already gets by picking each ship's next leg from where it is now. On 2026-10-08 THEO-1 sold FABRICS at E48, then ran
  FOOD and FUEL out of E50 without an empty trip home. Measure the dead-leg share in the ledger before building anything.
  2026-10-09 progress: `stcommand_ops_deadhead` measures it (about 27% of time loaded); follow-on lookahead (v1) is on; two-leg
  circuits (v2, `chainCircuitWeight`) are built and off, awaiting a live trial (they survive a restart and check cash at the
  second leg). Route labels show the follow-on / circuit. Still open: 3+ leg and cross-system circuits (v3).

- **Gate-chain follow-ups (2026-10-05).** (a) done in Deck 2026-10-05 (Tower shows tags only; v6 none). (b) done 2026-10-05 as the Ops "Gate supply chain" panel.
  (b-old) A "chain health" Deck panel like the community
  supply-chain graph: each input's supply + import activity at the producer, the producer's export activity, supply and
  trade volume, weakest link coloured. (c) Durable per-market activity/trade-volume history that can be queried without a
  tenant session (the ledger/activity tables are row-locked per tenant, so the read-only SQL login sees none of it).
  (d) Test hypotheses: export activity above WEAK needs ALL inputs' import activity STRONG (the community graph shows
  FAB_MATS STRONG with iron and sand both STRONG); trade volume grows with sustained heavy trading of a good (ELECTRONICS
  at F53 went 20 -> 43 over ~3h of heavy buying) and an import grows when over-delivered.

## Closed / resolved (kept here briefly for context, then delete)

- [x] Yards & outfitting system filter + per-item pricing — confirmed
  working live by the operator, 2026-09-13. See `CHANGELOG.md`.
- [x] Keeper-probe approval fix (both rounds) — operator confirms it
  looks fixed, 2026-09-13. See `CHANGELOG.md`'s two entries.
- [x] `PROXY_URL_<AGENTSYMBOL>` set for each tenant — done, 2026-09-13.
- [x] Persist the system-by-system architecture breakdown — done,
  2026-09-13. See `docs/architecture-overview.md`.
- [x] Public galaxy cartography page — shipped 2026-09-12. See
  `CHANGELOG.md`. `getSystems()` on the SpaceTraders client was removed as
  dead code once `getSystemsPage()` (which also returns the pagination
  total) fully replaced its one caller.

- [x] K8s pod-per-tenant and single-deployment exploration — both
  closed. See `docs/k8s-pod-per-tenant-exploration.md`. Conclusion:
  don't migrate; the shared-IP rate limit isn't solved by either shape,
  and the one real Render-restart benefit is achievable on Render itself
  via the health check shipped below.
- [x] DRAGOM's margin-floor change — confirmed working. Lowered from
  20c to 10c on 2026-09-12; verified via live logs that DRAGOM-1 went
  from flapping/stuck on one route (repeated `margin 19-20c <= floor 20c`
  rejections) to 11 successful route pickups across FUEL/FOOD/MEDICINE
  in the 51 minutes after the change, with zero margin-floor rejections.
  No new failure mode introduced by the looser floor. See `CHANGELOG.md`.
- [x] CARO's insufficient-credits purchase-failure loop — operator is
  deleting the CARO tenant outright (2026-09-12), so no further
  investigation needed.
- [x] Cross-system jump-cost bootstrap gap — fixed 2026-09-12.
  `recordJumpCost()` now also fires from `shipProxy.ts`'s shared
  explore-jump path, so every real jump a tour ship or explorer makes
  feeds `crossSystemLegCost()`'s learned average, not just trader/fleet-
  manager jumps. See `CHANGELOG.md`.
- [x] Render zero-downtime deploys — `GET /healthz` added, mounted
  ahead of every other route in `src/cli/index.ts`. **One manual step
  still needed**: no Render API/MCP tool exposes updating an existing
  service's health-check path, so set it by hand — Render dashboard →
  stcommand → Settings → Health Check Path → `/healthz`. Without that
  one field set, the route exists but Render never calls it.
- [x] Auto-buy a keeper probe at any uncovered shipyard — shipped
  2026-09-12. See `CHANGELOG.md`. **Test-infra note**: 3 of 4 new
  `tests/fleet.test.ts` cases verified passing directly; the 4th
  (`"buys a probe and stations it as keeper..."`) needs a live
  `makeTenant()` round-trip against the remote test Postgres, which hit
  a connection timeout (`ETIMEDOUT`) both times it was attempted in this
  session — a sandbox network-connectivity issue, not a code failure.
  Worth re-running that one case directly next time the test DB is
  reachable, just to see it pass rather than infer it from the guard
  logic and `setShipRole()`'s own separate coverage.

- **Route profit priced per ship, not at the fleet's biggest hold (found 2026-10-08).** `fleet.ts` prices every route
  at `maxTraderCargo` (the largest hold flying), so once 80-unit light haulers joined 40-unit shuttles the Tower route
  list reads ~1.6x what a shuttle earns (E45 -> J62 ASSAULT_RIFLES ~104.7k at 80 units, ~64k at 40; price impact is
  super-linear in units). Shipped 2026-10-08: the Tower route card now shows the figure per hold size (`profitByHold`). Still open: price at the
  cargo of the ship the dispatcher would send (it ranks on the biggest-hold figure and never reads a ship's cargo). Also open: the dispatcher allows one seller per (good, sell market), so two 100k routes into the
  same market get one ship.
