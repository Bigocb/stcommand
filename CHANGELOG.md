# Changelog

Every notable change, newest first. One entry per merged change, written
for someone who wasn't in the room — what changed and why, not just what
the commit touched. Decisions with lasting architectural weight get their
own ADR in `docs/adr/` (see `docs/adr/README.md`) instead of just a line
here; link it from the entry when that happens.

Backfilled from git history starting 2026-09-12 going back far enough to
be useful context; not a complete project history — see `git log` for that.

## 2026-10-29 — A restart no longer drops a keeper delivery's destination
Three probes bought at RY50-Z12X for DJ38 (13:30) lost their destination at the 13:35 redeploy: boot replays a stored hold through `holdShip()`, which always held the ship at its own position (here, RY50's gate), so each cross-system hold was re-pinned to the gate it was flying to. `holdShip()` now takes the stored waypoint (`holdShip(ship, st.holdWaypoint)`) so a replay keeps the original target, and `advanceKeeperDeliveries()` puts a delivery's hold back on its market whenever it names something else, which also repairs the three already affected. Not covered by an engine test (the boot path needs a live fleet); the repair log line is `delivery hold put back on`.

## 2026-10-29 — Remote survey intake: queue systems for keepers without an explorer (clause `remoteSurveyIntake`, off)
The last piece before explorers can be switched off. An explorer's survey did two jobs the remote surveyor did not: it judged whether a system is worth covering and it queued the worth-covering ones behind the fresh-system gate with their markets for keepers. Both now live in `intakeKeeperCandidates()` (`fleet.ts`), called by the explorer path as before and, with the new clause on, by `maybeRemoteSurvey()` after it reads a system (same `judgeSystem()` worth test, same keeper scoring, which needs the remotely read market snapshots, so those are now kept in memory as `surveySystem()` does). A system already queued is left alone. Also always on: markets that are shipyards go first (`yardsFirst()`, `src/engine/keeperOrder.ts`), both in what a queued system lists and in the keeper queue's buying order for a system whose yard stock has not been read, so the first keeper delivered docks at a yard and the rest of the system's keepers can be bought locally. Needs `autoKeeperGoodSystems` on and, for the gate, `freshGate`. Tests in `tests/keeperOrder.test.ts`; the intake itself has no engine test yet and should be watched on its first run.

## 2026-10-29 — A hold more than one jump away no longer stops at the first gate
First live keeper delivery (two probes bought at YF38-D10E for DJ38-AB9B and DJ38-D11F, 26.3k and 26.8k): both jumped YF38 -> ZG14 on their own (5.8k each), then sat at the ZG14 gate. `jumpShip()` re-pins an operator hold to wherever the ship lands (right for a manual jump), and `hopToward()`, which walks a hold's cross-system target one gate per tick, called it, so each hop replaced the hold's final target with the gate just reached. `hopToward()` now passes `keepHold`, which skips the re-pin. Any operator hold on a cross-system waypoint, not just deliveries, had this fault. The two probes were pushed through ZG14 -> DJ38 by hand (5.7k each) and `advanceKeeperDeliveries()` released them on arrival (all in: 37,848c for THEO-F6 and 38,435c for THEO-F7).

## 2026-10-29 — Keepers delivered across gates (clause `keeperDeliveryHops`, off)
A probe can cross a jump gate (THEO-C7: YF38 -> VK87 -> DJ38 for 38.9k all in, now keeping DJ38-EX8Z), so a market whose own system has no yard selling a keeper hull (DJ38's only yard lists an interceptor) can get its keeper from a yard elsewhere. `maybeRequestKeeperProbeForMarket()` now falls back to `pickDeliveryYard()` (`src/engine/keeperDelivery.ts`) when no yard in the system has a stored probe, surveyor or drone: the cheapest hull-plus-jumps among yards within `keeperDeliveryHops` gate jumps (finished gates only) where one of our ships is already docked, since a purchase needs one. It goes through the same approval card as every keeper, with its price shown as hull plus expected jumps, or buys without a card when the auto-approve keeper rule (price cap and cash reserve) allows that total. After the purchase the probe is pinned as the market's keeper and held at the market, which walks it through the gates one hop a tick; `advanceKeeperDeliveries()` releases the hold on arrival. In-flight deliveries are kept in the `keeperDeliveries` fleet flag so a restart does not lose them. Off by default. Tests in `tests/keeperDelivery.test.ts`.

## 2026-10-29 — An approved below-floor sale sells the whole quantity
THEO-A0 bought 72u GRAVITON_EMITTERS at about 35,000c and carried them to X1-KR9-A1, where the price had fallen to about 20,000c (supply ABUNDANT): four lots of 18u sold at a combined loss of about 920k. The operator saw five `sellBelowFloor` cards and approved each, but an approval sold only one lot: right after it the mid-sale loss-floor check re-ran, found the price still below the floor, held the rest, and a new card came about 15 minutes later. Now an approved sale carries on while each lot fetches at least 80% of the price the card quoted (`src/engine/approvedSale.ts`, `trader.ts` `approvedQuote()`, valid 10 minutes after the approval and cleared when the sale ends); a bigger drop stops it and asks again. The blocked-goods list is unchanged: it stops new buys, not the sale of cargo already held. Tests in `tests/approvedSale.test.ts`. Still open: why the destination check before the flight (`sinkPreflight`) did not stop the 2.5M buy.

## 2026-10-29 — Remote surveyor: read systems without a ship (clause `remoteSurveyPerPass`, off)
The galaxy crawler maps systems, waypoint layout and gate state with no token, but not what the markets and yards are. A survey is only API calls, so the server can do it for any system reachable through finished gates, and the game gives anyone a market's goods lists and a shipyard's hull-type list (does it sell probes?) with no ship there. `maybeRemoteSurvey()` (`fleet.ts`, picker in `src/engine/remoteSurvey.ts`) reads `remoteSurveyPerPass` systems every 5 minutes, nearest home first, and saves the goods lists (`market_directory`, 064) and the yard hull types (`shipyard_directory`, migrations/065, also saved by the explorer survey now). It marks nothing surveyed, so explorers still owe those systems their physical visit; a failed or empty read is retried after 2 hours. Ops `market_directory` now lists each system's yards and whether they sell probes. Cost is about one API call per market and yard. Tests in `tests/remoteSurvey.test.ts` and `tests/systemSurveys.test.ts`.

## 2026-10-29 — The survey keeps each market's goods list; explorers can survey without touring markets
Operator plan (after probes were shown to cross gates): an explorer surveys a system and moves on, and keepers are chosen from what the markets trade, then sent by probe. The game gives anyone each market's import, export and exchange lists without a ship there (only prices need one); the survey already read them but kept them in memory only. Now `surveySystem()` saves them (`market_directory`, migrations/064, shared galaxy table wiped at the reset) and the ops tool `market_directory` ranks a system's markets by distinct goods with keeper coverage and a `worthKeeping` count (`src/engine/marketDirectory.ts`). `exploreMaxMarketStops` may now be 0: the explorer still docks at every shipyard (yard stock is only revealed docked) but reads no markets. Tests in `tests/marketDirectory.test.ts` and `tests/systemSurveys.test.ts`.

## 2026-10-29 — HTTP park
`POST /api/fleet/park {shipSymbol}` parks a hull (the MCP tool `stcommand_park_ship`'s twin), alongside the unpark route added earlier, so a parked keeper that was unparked for a test can be put back from the dashboard API.

## 2026-10-29 — A probe can cross a jump gate (tested live)
`docs/opening-tasks-plan.md` said a probe "cannot cross gates" (0 fuel capacity); nothing in the books had ever tried it, and the related note that probes "cannot self-navigate" was already disproven the same evening (THEO-AA flew C41 to A2). Test: THEO-1B, a parked keeper probe (fuel 0/0, engine speed 9) docked at the BT10 gate X1-BT10-I55, was unparked and sent to X1-V90-C20E. The jump went through at 03:12:02 for 5,791 credits (the usual ~5.2k to V90 plus about 10%), with the normal ~5 minute cooldown. So a keeper probe can be bought where a probe is in stock and sent through gates to a system whose own yard sells none (DJ38's only yard stocks interceptors). The doc line is corrected; nothing in the engine uses it yet.

## 2026-10-29 — Keeper queue: markets that can be bought now go first
Operator queued new CK45 keepers and got no cards. Cause: the queue walked its list in score order, and cards raised for PK42-A2 and DQ39-C14B (yards with no ship of ours) were approved, could not run, and held the single request slot while CK45, where THEO-AA sat at the yard, waited. The queue now puts markets in systems where one of our ships is at a keeper-hull yard first (`serviceableFirst()` in `keeperQueueStall.ts`, `keeperServiceableSystems()` in `fleet.ts`); nothing is dropped. And an approved request waiting for a ship is released after 1 minute instead of the full `keeperYardWaitMin` when a buyable market in another system is waiting behind it. Tests in `tests/keeperQueueStall.test.ts`.

## 2026-10-29 — Sending a parked ship now says so; HTTP unpark
`POST /api/fleet/dispatch` answered ok for a parked ship and did nothing (parked hulls have no agent): THEO-AA, a staged keeper at X1-CK45-C41, was "sent" to the CK45 shipyard and never moved. It now answers 409 saying the ship is parked. New `POST /api/fleet/unpark {shipSymbol, role?}` does what the MCP tool `stcommand_unpark_ship` does (resumes the role it had, or the one given), so a parked ship can be unparked from the dashboard API too.

## 2026-10-29 — Keeper queue: a request with no ship at its yard no longer blocks every other market
Operator saw no approval cards for new systems. Cause: an approved purchase for X1-CK45-D44 had to be bought at X1-CK45-A2, none of our ships was there, and the queue (one open request per kind) waited on it for ever, so KX84, SF98 and the rest never got a card. New clause `keeperYardWaitMin` (default 30 min, on; off = the old wait-for-ever): the first time an approved request finds no ship at its yard the wait is timed, and past the grace the row is consumed, logged (`keeper: released the approved keeper request for ...`), and the market is skipped by the queue for 2 hours or until a ship docks at its yard (`src/engine/keeperQueueStall.ts`, wired in `fleet.ts` `resolvePendingKeeperProbeApproval` and `advanceKeeperMarketQueue`). The wait is held in memory, so a restart starts it again. Tests in `tests/keeperQueueStall.test.ts`.

## 2026-10-29 — Compare: weeks lined up on the gate
A week whose gate opened a day later looked 68% behind on the hours-since-first-trade view (this week's gate: 58 h, 10-18's: 34 h). Compare now also lines the weeks up on each one's first gate jump (`gateAligned()` in `src/engine/weekCompare.ts`, `gateAligned` in `/api/compare`): matched profit before the gate, profit in the same number of hours after it (the shorter of the two weeks' time since their gates), profit per hour over those hours, sells, and cumulative profit since the gate at +6/12/24/36/48/72/96 h. The footer says what profit per hour is: matched profit (completed round trips only, before fuel, jump costs and ship purchases) over the hours in the window. Tests in `tests/weekCompare.test.ts`.

## 2026-10-29 — Compare shows every tenant's weeks on a one-owner box
Operator: they are the only user on the box, so reading another tenant's earlier weeks should not need a second setting. With `OPERATOR_AGENTS` unset, Compare now lists every tenant's kept weeks (THEO, THEOREM, ...) to any signed-in agent; set it to a list that leaves an agent out to keep a shared box's tenants apart again. Every other operator-only view still needs the list. Tests in `tests/compareRoute.test.ts`.

## 2026-10-29 — Hull speed counts: per-ship speed in route value, and a yard scan
Operator insight: speed matters as much as hold size (the bulk freighter is speed 60, most hulls are 15), and fewer, bigger, faster ships also mean fewer API calls. Two changes, both advisory-safe:
- **Per-ship speed (`src/engine/shipSpeed.ts`, clause `shipSpeedWeight`, off by default).** Route times are costed at the slowest hull's speed (`fleet.ts routeModelSpeed()`, now one shared helper), so a speed-60 ship was valued like a shuttle. With the clause on, a same-system route is worth more to a faster hull by that share of its real speed ratio (capped at 4x), its flight to the buy market counts for less, and the route matcher (`matching.ts`, `speedGain`/`flightBound`) uses the same gain. Cross-system routes are unchanged (jump cooldowns dominate). Weight 0 / clause off reproduces the old behaviour; tests in `tests/shipSpeed.test.ts`.
- **Yard scan (`src/engine/yardScan.ts`, ops `yard_scan`).** Every hull seen in the yards we have read, at its cheapest yard, scored as hold x speed per 1,000 credits (hold from the cargo modules, since the yard's own figure is often 0), plus a `fastAndAffordable` list (faster than 15, at most 1M by default). Read-only; tests in `tests/yardScan.test.ts`.

## 2026-10-29 — Week over week: Compare tab in Deck and a Compare card in Tower
Operator request: compare this week with a previous week, with a dropdown of earlier weeks and "any tenants from the previous week" (all tenants are the operator's).

- `src/engine/weekCompare.ts` (pure) lines two weeks up by hours since each week's first ledger row (the same axis as the gate milestone) and returns cumulative matched profit,
  wallet (carried over hours with no reading), ships bought and sells per hour, fixed checkpoints (6, 12, 24 ... 167 h) and like-for-like totals cut at the shorter week's last hour,
  so a week in progress is not set against a finished one.
- `Store.weekHours()` sums one tenant's ledger for one named week per hour (row-level policy: that week only); `Store.tenantDirectory()` lists agent symbols. The first gate jump stands in for
  "gate open" for every past week.
- `GET /api/compare/weeks` lists the weeks this tenant kept; for an **operator** (`OPERATOR_AGENTS`, the same env list that gates the agent-watch view) it also lists every other tenant's.
  `GET /api/compare?week=<tenantId>|<universeKey>` returns both series. Another tenant's week is refused unless the caller is an operator: isolation stays the rule, with this one deliberate crossing.
  **Set `OPERATOR_AGENTS=THEO` (comma-separated for more) in the box's environment to see THEOREM's weeks from THEO.**
- `public/shared/compare.js` (shared): dropdown, KPI row, cumulative matched profit and wallet charts with the gate marked, and a checkpoint table. Deck: Insights > Compare. Tower: More > Compare (compact).
- Tests: `tests/weekCompare.test.ts` (alignment, carry-forward, like-for-like), `tests/compareRoute.test.ts` (own weeks, current-week flag, cross-tenant refusal and operator access, bad ids).

## 2026-10-28 — Cargo already bought: the destination is re-checked before it is flown there
Option 1 of the rival-trading discussion (operator, 2026-10-28). The GRAVITON cargo was judged against KR9-A1's bid once, at the buy (58k); a rival then sold 126
units into that market and the bid was 25.7k when the ship arrived, after the jumps and fuel were spent. The loss floor judged it only on arrival.

- `src/engine/sinkPreflight.ts` (pure): with cargo in the hold, take the destination's bid, discount it for the lots the cargo will sell in (the buy guard's per-lot impact,
  `buyGuardImpactPct`), and compare it with the loss floor, cost less `maxLossPct`. Under the floor: don't fly. No reading, impact 0 or no cost basis judges nothing.
- `TraderAgent.deliverHeldCargo()` runs it before navigating to the sell market. The bid is a stored market snapshot no older than 20 minutes (a market far away shows no
  prices to a ship that is not there, so a live read from the buy market is not possible); `freshSnapshots()` now carries each row's timestamp. Under the floor, the ship
  first tries `redirectBelowFloor()` (another market that clears the floor), else holds where it is and logs `holding Nu GOOD at …: not flying to …`. It looks again every
  5 minutes and gives up the hold after 45 (the arrival loss floor then applies), so a cargo is never parked on a stale reading. An operator's manual leg is not judged.
- Not covered: a ship the operator flies by hand, and a collapse after the last check but before arrival. Tests: `tests/sinkPreflight.test.ts` (12; removing the hook fails 3).

## 2026-10-28 — A trade's buying is capped at a share of the spendable cash (doctrine `tradeBuyCashShare`)
THEO-1E bought 40 GRAVITON_EMITTERS at about 33.8k a unit, 1.35M in one trip and about 40% of the wallet, for a route into a market that takes lots of 18.
A rival (VCMININGCORP-339) sold 126 units into that market seven minutes before it arrived; the cargo sold for 765k, a 586k loss. Contract buys already had a
cash-share brake; ordinary trades had none, so one wrong estimate could take whatever the wallet held (operator, 2026-10-28: "like contracts").

- `src/engine/tripBudget.ts` (pure): a trip may spend at most `tradeBuyCashShare` percent (default 25) of the spendable cash it started with, and never less than
  `tradeBuyFreeBelow` (default 300,000c) so a small wallet, such as the 175k opening, is never throttled. 0% / the clause off reproduces today's behaviour.
- The direct-route buy loop in `TraderAgent` (the one that bought the GRAVITON) sizes the budget once before the first lot and stops buying when the trip has used it,
  logging `stopping at Nu GOOD: a trip may use …` and counting a doctrine fire. The trip just carries fewer units.
- Both clauses are on by default and adjustable in Doctrine. Not changed: the warehouse buy and contract buy paths (the latter has its own cap), and the sell side.
- Tests: `tests/tripBudget.test.ts` (the rule, and the real buy loop with the limit on, off and absent; removing the cap fails the first loop test).

## 2026-10-28 — Auto-approved keepers buy through a ship at any yard in the system, not only the cheapest yard
TV37 (22 markets wanted keepers, auto-approve on, 4.4M in the wallet) bought none: the cheapest keeper hull was a probe at C43, no ship of ours was
docked at C43, and the keeper THEO-1F sat at H56, another yard in the same system selling surveyors and mining drones. The log said "none of our ships is
docked at X1-TV37-C43 ... goes ahead when one is there" and no card was raised, so nothing moved. When the cheapest yard has no ship, the auto-approve path now
tries `pickKeeperYardWithShip()` (`keeperYard.ts`): the best yard of the system where one of ours already is, hull preference first (probe, surveyor, drones),
price within a hull, and buys through that ship if the price is within the auto-approve cap and cash reserve. The cheapest yard is still tried first. A keeper
bought this way may be a surveyor rather than a probe. Tests: `tests/keeperYard.test.ts`.

## 2026-10-28 — The route board no longer leads with routes no trader can reach
2026-10-28: another agent of the same operator (THEOREM, paused) had keepers and traders in X1-PK42, whose gate was unfinished. Prices are one
galaxy-wide table, so THEO's Tower led with PK42 JEWELRY at +4.1M/h, with "not flying" blamed on THEO-6's contract duty. The dispatcher never sent a ship
(its per-trader `whyUnreachable` said "no finished gate path"); the board just did not use that answer, because its reachability filter covered only routes
whose buy and sell systems differ.

- `routeUnreachableReason()` (`src/engine/routeReach.ts`, pure): a route is unreachable when no active trader is in its buy system or can fly there
  (`canFlyBetween`, multi-hop included). `/api/markets` marks such routes `unreachable`, gives them the real reason ("no trader can reach X1-PK42: no finished
  gate path from X1-BT10"), keeps them out of the top-25 cuts and lists at most five of them after the rest; the Tower and Deck sort puts them last in either mode.
- Not changed: the dispatcher's own scoring. It already refuses the assignment, and its work list still shows these routes at the top. Tests: `tests/routeReach.test.ts`.

## 2026-10-28 — A finished gate mission opens the gate at once, not after the 45-minute re-read
The gate opened on 2026-10-28 ~03:26 UTC with the mission reporting complete, but the galaxy cache still held "unfinished" (an unfinished gate is
re-read only every 45 minutes, and only when something asks), so the new gate-open milestone, the explorer task and the dispatcher's cross-system
routes would all have waited up to that long. `GalaxyAtlas.noteGateComplete()` records a gate complete without a read; the fleet tick calls it for the
home gate when its construction mission is complete (checked at most every 20 s while the gate looks closed). The cache stays one-way. Test in `tests/galaxy.test.ts`.

## 2026-10-28 — The home gate opening is a week milestone (report, Season screen, goals)
Operator: the gate-open time should be tracked in the weekly report. Last week it took 34 h; this week's result had nowhere to live.

- `maybeRecordGateOpened()` (fleet tick) writes one `milestone` action event (`gate_open`) the first tick it sees the home gate complete: hours into the week
  (from the week's first ledger row, the start of play), wallet and ship count. If the gate was already open on the first look (restart after it
  finished) the event is marked "noticed late", so the time is an upper bound. The week's rows are read before writing, so a restart never adds a second.
- The analysis report has `milestones` and `summary.gateOpenHours`; saved reports and week records keep them across the reset. The Season screen's
  This week row has a "Home gate" tile (hours, or "closed"), and Plan has a new goal measure, "Hours until the home gate opens" (lower is better),
  so next week can carry a goal such as "inside 34 h".
- Tests: `tests/gateMilestone.test.ts` (event, one-per-week listing, goal evaluation); `tests/season.test.ts` measures now include `gateOpenHours`.

## 2026-10-27 — Contract buy over the price ceiling asks the operator
A contract ship that found its good over the buy guard's ceiling (110% of the contract's pay per unit) skipped the buy and toured
markets for a cheaper source, which on a one-source good like IRON looped between two waypoints burning a refuel each pass
(THEO-6, 2026-10-27: 271c against a 196c ceiling, with our own iron feed holding the price up). It now raises a
`contractBuyOverCeiling:<good>` approval stating the price, the ceiling and the loss, and trades while the question is open or
after a denial (re-asks after 2 h; unanswered requests expire as a denial after 1 h). Approving lets that one purchase go
through at the live price. Tests in `tests/contractBuyGuard.test.ts`.

## 2026-10-27 — Gate mission cash floor is a wallet level, not stacked on the fleet floor
The mission's `cashFloor` was compared against spendable cash, which is already the wallet minus the fleet cash floor
(100,000c), so a 750,000c mission floor really needed an 850,000c wallet and the carrier waited with the money there.
`MissionManager` now gets the raw wallet (`getWalletCredits`) and treats the floor as a wallet level it never spends
below; the larger of the mission floor and the fleet floor holds. `tests/missionFloor.test.ts`.

## 2026-10-27 — Gate mission: a max price in credits

The gate's price ceiling was only a percentage over the market's 24-hour low, a baseline the operator never sees. `MissionPacing.maxPrice` is an absolute ceiling in credits per unit: no purchase while the ask is above it (the carrier buys another material meanwhile, or waits and rechecks every 5 minutes), and a lot stops before a chunk that would land above it. When set it replaces the percentage ceiling entirely, and `chain-health` shows it as the ceiling. (The first version took the lower of the two, so a max price of 7,000 was still blocked by the default 40% cap of 1,740; fixed the same day.) Settable from Tower's and Deck's mission card ("max price (c)"), the pacing API and MCP tool, and the `startGateMission` opening step. `tests/missionPacing.test.ts`, `tests/gateOperationSteps.test.ts`.

## 2026-10-27 — Start scout: register several agents and rank their home systems

`npm run scout:starts` (`src/cli/scoutStarts.ts`) registers 1 to 10 agents on the account and scores each home system for the gate, so a better start can be kept. The score (`src/engine/startScore.ts`, pure, policy as data) counts FAB_MATS sources (a second source is worth +150, none -200), a circuitry producer, whether the raw inputs are sold at home, and market and goods counts. The orchestration (`src/engine/startScout.ts`) takes its network calls as ports; nothing registers without `--yes`, a failed registration does not stop the others, and tokens only go to a git-ignored `.local/` file. Motivated by THEO's single-producer system (docs/start-scout.md). `tests/startScout.test.ts`. Not run against the real API yet.

## 2026-10-25 — Gate carrier buys another material while one waits to recover

The gate mission's only carrier sat docked at the FAB_MATS market for most of every cycle: after a 20-unit lot the recovery rule (`recoverPct`) holds the next lot until the ask is back within the band, and the 30-minute `buyGapMin` does the same, but a wait did not count as a block, so the carrier never moved on to ADVANCED_CIRCUITRY even when it was cheap (ABUNDANT at 3,815). `MissionManager.yieldToOtherMaterial()` now hands the carrier to the next free outstanding material for the length of the wait, then it returns. It does not move on while the hold still carries some of the waiting material (that would sell it off as unrelated cargo), when no other material is outstanding, or when the other one is held back itself. Cash floor, lot size and price ceiling are unchanged. `tests/missionYield.test.ts`.

## 2026-10-25 — Tower could not load on a phone after a deploy: stamp every shared module

After the `walletForHolds` change a phone could not load Tower. The HTML already stamped `m.js` with `?v=<hash>`, but the imports inside it (`/shared/domain.js` and the rest) were fetched unstamped, and Cloudflare turns the origin's `no-cache` into a four-hour browser cache for `.js`. A new `m.js` met a cached old `domain.js`, the browser refused to link a missing export, and the app stayed blank. `serveHtml()` now puts an import map ahead of the first module script that maps every `/shared/**.js` URL (relative imports included) to the same `?v=<hash>` URL, so a deploy changes every module's URL at once. `tests/importMapStamp.test.ts`; checked in Chromium that all 19 shared modules load stamped. A phone that already holds a broken copy gets the fixed page on its next load, because the HTML is `no-cache`; if it stays blank, close the tab and reopen.

## 2026-10-25 — Credits + holds no longer double counts a cargo between a sale and the next poll

Deck and Tower's "Credits + holds" (and the net-worth line in the metrics chart) added the wallet from the live feed to hold values that only change on a state poll. The feed moves the wallet the moment a trade lands, so for the seconds until the next poll a sold cargo counted twice: a hauler's 226k load made the total read about 1.5M, then it fell back on refresh. Loads had been small before, so it went unnoticed. The state poll now records `agent.pollCredits` (the wallet from the same response as the hold values), `walletForHolds()` returns it, and the three call sites use it; the plain Credits tile still follows the live feed. `tests/walletForHolds.test.ts`. A server sample of wallet and holds every 10 s over five minutes agreed with the estimates to within a few hundred credits per trade, so the hold estimate itself was fine.

## 2026-10-25 — Gate mission step carries the cash floor

`startGateMission` takes `cashFloor` and `cashResume` (the mission's own pacing: buying holds when the wallet is under the floor and resumes at the resume level; 0 clears it), so a task can keep a working balance while the gate is bought and lower it for the final push. Validated, shown in plain words in the Opening form. `tests/gateOperationSteps.test.ts`.

## 2026-10-25 — `startFeed` can name its crew ship

The engine's own feed-carrier picker takes the biggest empty hold first, which would have pulled a freshly bought hauler off trading onto a feed. A `startFeed` step can now carry `carrier` (a ship symbol); it is assigned straight after the feed starts. `tests/gateOperationSteps.test.ts`.

## 2026-10-25 — Opening task steps for the gate operation: `startGateMission`, `startFeed`

Two new steps so the gate can be run from a task list (and carried in a template). `startGateMission` starts the home gate's construction mission with its pacing in place before any buying (start, pause, set pacing, resume), idempotent; `paused: true` leaves it created but not buying so its materials are protected and the supply chain shows up in the chain panel. A later task with `paused: false` lets it buy, still under the engine's own producer-activity and recovery guards. It does nothing once the gate is open. `startFeed` starts a feeder tier (waypoint, good, mine, crew size, buy source) and its supply stop and loss limit. Both are validated, described in plain words in the Opening form, and passed through the same `OpeningHost` seam. `tests/gateOperationSteps.test.ts`.

## 2026-10-25 — `autoBuyShips`: one switch for the engine's own hull purchases

New doctrine clause `autoBuyShips` (on by default, so nothing changes until it is switched). Off, `maybeBuyShip` (tour shuttle, mining drones, scored picks), `maybeBuySiphoner` and `maybeBuyScout` return before doing anything, so opening tasks and the operator are the only source of hulls and no "priority" `buyShip` cards appear beside the tasks. Keeper probes have their own switch. `tests/autoBuyShips.test.ts`.

## 2026-10-25 — Opening tasks can trigger on the home gate; keeper auto-approve can keep a cash reserve

New trigger `gateProgressAtLeast` (0-100, 100 = the gate is open) so early-game limits can loosen at a milestone: progress is the delivered share of the home gate mission's materials, rounded down so it only reads 100 once the gate itself is complete, and unknown (not 0) when no gate mission has started. The Opening form's custom builder offers it. New doctrine clause `keeperAutoApproveMinCash` (off by default): while on, a keeper probe is auto-approved only if the wallet still holds that much after paying, otherwise it asks as before. `tests/gateTrigger.test.ts`; the keeper seam test's fake doctrine now answers for the new clause.

## 2026-10-25 — Opening buys keep a cash reserve

A task that bought a shuttle at "cash reaches 110,000" would have left about 16,000 to trade with. A `buyShip` step now takes `keepCash`: it waits (with the reason in the task note) unless that much cash is left after paying. The contract, tour, survey and hauler presets set it to 100,000 and start at 200,000 (hauler 450,000); the custom builder has a "Keep at least" field (default 100,000). Tasks queued without it behave as before. `tests/buyKeepCash.test.ts`.

## 2026-10-25 — Stale "needs a role" cards are withdrawn

A ship bought by an opening task (or roled from the Fleet tab, MCP, or a restart) kept its "needs a role" approval card until it timed out, and answering it did nothing (THEO-4 and THEO-5, 2026-10-25). Each tick `FleetManager.withdrawMootRoleApprovals()` now expires any open `assignShipRole:` card whose ship is no longer awaiting a role decision (rule in `mootRoleApprovals`, `src/engine/approvals.ts`). Other kinds of card are untouched. `tests/mootRoleApprovals.test.ts`.

## 2026-10-25 — Opening task: a tour ship that becomes a trader once the markets are priced

New trigger `marketsSurveyed` and new step `waitFor` in the opening-task engine (`src/engine/openingTasks.ts`, `openingRunner.ts`, pure helper `surveyCoverage.ts`). A task can now pause part-way (the ship it bought is only known to that task) until every home-system market with at least `keeperMinGoods` goods has been priced by a visit or a keeper; a market whose goods count is not known yet counts as unpriced rather than being skipped. The new "Tour ship that becomes a trader" preset (Tower and Deck Opening form) buys a light shuttle, sets it to tour, waits for coverage, then sets the same ship to trader. Coverage is only gathered while a task uses it. `tests/marketsSurveyed.test.ts`.

## 2026-10-25 — Tower can register a new agent

Tower's sign-in screen took only a token, so creating a new agent meant going to a desktop. It now has a "Register a new agent" link under Sign in: agent symbol, faction (default COSMIC) and account token, posted to the same `/api/gate/register` desktop uses. A new agent is paused until its standing orders are confirmed, so Tower shows the same standing-orders list (catalog, checkboxes, values) and a "Confirm & launch the fleet" button before the app opens. Signing in with a token and a cold page load now send a tenant that still owes onboarding to that screen too, instead of straight into a paused fleet. Also fixed `.auth-card` ignoring the `hidden` attribute. `tests/towerRegister.test.ts`; checked in Chromium with the gate routes stubbed.

## 2026-10-25 — Tower: a Log out button

Tower had no way to sign out, so after registering a second agent on the same device the first one's session could not be left.

- A "Log out" button in the header beside Guide (`public/m.html`, `m.css`). It asks to confirm, ends the session with the shared `logout()` (`POST /api/gate/logout`), and reloads the page, so none of the last agent's fleet, prices or settings stay in memory when someone signs in as another agent. The reload lands on the sign-in screen because the session is gone.
- Checked in Chromium with stubbed responses (button shown, confirm, logout posted, sign-in screen shown). Tests: `tests/towerLogout.test.ts` reads the page and script: the button exists, uses the shared logout and reloads, and the shared logout calls the server route.

## 2026-10-25 — Contract buy guard: never pay more than the contract is worth, never put most of the cash in one purchase

At 15:19 THEOREM-6, on contract duty, bought 20 FOOD at 4,666c each (93k of a 108k wallet) at A1 for a contract that still owed 179,405c for 64 units
(2,803c a unit): A1 was the only FOOD price known at that moment, and the old check compared the live price only with the dispatcher's own
snapshot of the same price (and refused only a jump of more than 50%). Cash fell to the 20,000c cash floor, so trading stalled (buys of 1-3 units),
and the contract, which pays only on completion, could not be finished (K87 then showed FOOD at 1,275c; the last 44 units needed about 56k).
The EQUIPMENT contract earlier had also lost money (105k cost for 86k income).

- `src/engine/contractBuyGuard.ts` (pure, `contractBuyVerdict`): refuses a unit costing more than `contractBuyPriceGuard` percent (default 110) of the contract's pay per unit still needed (payment owed on completion over units still to deliver; a banked advance does not count), and limits one purchase to `contractBuyCashShare` percent (default 50) of the spendable cash, always allowing one unit when one is affordable.
- `ContractManager.outstandingRewardFor()` gives the units and payment still owed for a good, sharing a multi-line contract's payment by units.
- `runContractBuy()` (trader.ts) applies it after the live price is read: a refusal is logged ("skipping contract buy: FOOD at X: 4,666c a unit is over the ceiling of 3,084c ..."), the route is marked dead for that ship and prices are discovered, so the dispatcher can find the cheaper source.
- Two doctrine clauses, on by default: `contractBuyPriceGuard` (110%) and `contractBuyCashShare` (50%). Either off reproduces the old behaviour; both are switched off by setting the clause off.
- Tests: `tests/contractBuyGuard.test.ts` (the 4,666c case is blocked and 1,275c is allowed, the cash share, the missing-facts and off cases, the reward split by units, and the trader seam; removing the block fails it).

## 2026-10-25 — MCP tools to read and close the season week

Tower has no season controls and the Season screen's Close week is an HTTP call, so the week left open at the reset could not be closed from the
operator's usual tools.

- `stcommand_get_season`: the season, its weeks, goals and saved records, and `staleUniverse` for an open week from an earlier universe. Read-only.
- `stcommand_close_season_week` (optional `label`): the same close as the Season screen. A week from an earlier universe is scored from the saved scoreboard row; the current week is analysed live and its report saved. Recorded as an operator action.
- The close logic moved out of the route into `closeSeasonWeekNow()` (src/http/season.ts), shared by the route and the tool. Tests: two cases in `tests/seasonClose.test.ts`.

## 2026-10-25 — An opening task no longer fails because the ship it just bought is not in the fleet snapshot yet

"Ship for touring" (buy a light shuttle, then make it a tour ship) ran at about 200,000c: it bought THEOREM-7, then step 2 failed for good with
"could not resolve ship ref", although the ship existed. It only ended up on tour because the engine's own "THEOREM-7 needs a role, suggested tour" approval card was approved by hand (the same card for THEOREM-6 was denied and the role set manually); with the step working, no card is needed.
A task that used the ship it bought for a role or contract duty would have lost that step the same way (a contract-duty step in particular).

- `decide()` (openingTasks.ts): when a step refers to "the ship bought in step N", the task's own record says which ship that is (`refs`), but the ship is only in the fleet facts a moment later. That is now a wait, with the reason "waiting for THEOREM-7 (bought by step 1) to appear in the fleet". It still fails when no ship was ever recorded for that step, and for a literal ship symbol that is not in the fleet.
- The old test "ref but ship not in fleet → fail" pinned the bug; it now expects a wait.
- Tests: four cases in `tests/openingTasks.test.ts`. Removing the wait fails the first.

## 2026-10-25 — A season week from an earlier universe closes from the saved results, and the reset closes it for you

The Season screen still showed week 2 (opened 2026-10-18) after the reset, scored against this week's first hours (826/h, 11 trips). Closing a
week ran a live analysis, which sees only the current universe and needs market snapshots the reset wipes, so closing it would have filed
the new week's numbers as last week's.

- `closeWeekFromResults()` (`src/engine/seasonClose.ts`): when the open week's universe is not the current one, `POST /api/season/week/close` scores the goals from the scoreboard row the reset saved for that week (`run_results`, `Store.runResultFor()`), saves no analysis report, and says so. `metricsFromRunResult()` (season.ts) gives profit per hour, net profit and overhead share; positioning costs, trips, estimate accuracy and growth stay unmeasured, so a goal on them is scored missed at close, not guessed.
- The reset does it itself: after saving the scoreboard and before the wipe, `ResetWatcher` calls the new optional port `closeSeasonWeek`, which closes the open week if it belongs to the universe that just ended. A failure is logged and never holds the wipe.
- Last week (2026-10-18), from its saved row: 3.94M/h, net 658.6M, overhead 1.8% of sales.
- Tests: `tests/seasonClose.test.ts` (scoring, no results saved, wrong universe left alone, the reset order, a failing close not holding the wipe). Dropping the universe check fails two.

## 2026-10-25 — Opening tasks now actually run on the live box

Opening automation has never executed a task in production. `FleetManager.runOpeningTasks()` was called only from `tick()`, a single-pass helper that
`run()` does not call: the live process drives `tickCore`, `tickFeeds` and `tickMaintenance` on their own timers. With the clause on and the cash
trigger met (wallet 184,447 against a 130,000 "contract ship" task) the task stayed queued with nothing in the log.

- `runOpeningTasks()` now runs inside `tickMaintenance` (every 5 s, right after `refreshCredits`), and is no longer called from `tick()`, so it cannot run twice. With the clause off it still returns before touching the store.
- The cash trigger reads the wallet (`state.agent.credits`), not the wallet minus the cash floor as docs/opening-tasks-plan.md says. Behaviour is unchanged; the plan doc is wrong on this.
- Test: `tests/openingWiring.test.ts` reads fleet.ts and checks the maintenance loop calls the runner, `run()` reaches the maintenance loop, and `tick()` does not call it again. Removing the call fails it.

## 2026-10-25 — Opening tasks: presets, a plain custom builder, and the automation switch on the screen

The Add task form was three browser pop-ups (task key, name, the command ship's new role) and could build one kind of task, which ran at once.
The engine already supported buying ships, contract duty, doctrine changes and conditions on cash or route profit; nothing on screen offered them.
Opening automation (the doctrine rule that makes the engine run any task) was also off, with no way to see that on the screen.

- `public/shared/openingPresets.js` (pure, shared by Deck and Tower): presets for a contract ship (light shuttle, trader, contract duty), a second ship for touring (waits for the contract ship when that task is queued), a hauler once a route pays, and the command ship's role. Amounts are editable defaults from this week's yard prices. Also `describeTask()`, which writes a task in words, and `buildCustomTask()`.
- `public/shared/opening.js`: tap a preset, edit its numbers, see the sentence it will run, queue it. Custom builder with dropdowns for the condition and up to 8 actions (buy a ship, change a role, contract duty, change a setting), where an action can refer to a ship bought in an earlier one. Each task row shows what it does in words. A Turn on/off button for the automation rule sits in the header. Keys are made up for you.
- Tests: `tests/openingPresets.test.ts` checks every preset and a custom task against the server's own validator. The screen was driven in Chromium with a stubbed API (not committed): it caught the custom form losing typed values on "Add another action" and a redraw that re-read stale inputs, both fixed.

## 2026-10-25 — The starting command ship tours from the first tick

The 2026-10-25 week opened with THEOREM-1 (a frigate with a mining laser and a 40-unit hold) derived as a miner. It mined ore for over an hour,
earning nothing, until the operator set it to tour by hand. The opening playbook has it tour until there are good routes.

- `assignRole()` gives the starting command ship (role COMMAND, symbol ending `-1`: `isStartingCommandShip`) the tour role before the miner rule, and `guessDefaultRole()` agrees.
- Only that ship: a COMMAND hull bought later, and every other mining ship, keep their derived roles. An operator-set role still wins (a persisted override skips `assignRole()`).
- Tests: `tests/commandShipTours.test.ts`; skipping the new branch fails the tour case.

## 2026-10-25 — The reset wind-down no longer scraps ships

Operator decision: hull scrapping is complex for little return (6 of 316 hulls sent in 70 minutes this week, mostly probes that scrap for a
small amount). The wind-down is now only "no new buys, sell what is held". `retireNonTraders()` returns at the top, behind
`FleetManager.WIND_DOWN_SCRAP` (false), after emptying its queue so it cannot grow unread. The retirement code and its tests are kept
(`windDownScrap.ts`) in case it is wanted again.

- Tests: `tests/windDownNoScrap.test.ts` (nothing is sent to a yard with the window open; with the switch on the keeper is sent). Turning the switch on fails the first.

## 2026-10-25 — Wind-down: a loaded trader sells what it holds instead of idling

At 11:00 UTC the wind-down opened (120 minutes) and by 12:10 the ledger showed no sells in the last hour while 14 traders held about 4.4M
of cargo (cost 3.3M) that the reset destroys. `TraderAgent.tick()` returned early while buys were blocked unless the assignment role was
`sell`; almost every trader holds a `direct` (buy at A, sell at B) assignment, so a loaded hull sat in orbit, one of them at the very
market it was sent to sell at. 2026-10-18's fix queued traders for scrapping but did not cover ships idling with cargo.

- A loaded hull with any non-sell assignment now runs `deliverHeldCargo()` (sell on the leg it was bought for) and returns; it never falls through to a buy.
- Tests: two cases in `tests/resetWindDown.test.ts`; removing the fix fails the first.
- Not fixed: the scrap queue drained 6 hulls in 70 minutes with 316 left, so most keepers are still hulls at the reset. Cause not yet found.

## 2026-10-25 — Explorer tasks move to the trader tier in the scheduler

Explorer tasks ran at priority 3, the same tier as about 350 keepers, and behind roughly 100 always-ready traders (priority 2). The
runner takes the lowest number first and re-sorts every few seconds, so a priority-3 task is reached only when no trader is waiting.
Live (03:15-03:19 UTC, after a restart): 338 tasks queued, 309-337 ready, about 15 tasks run per 35 s, tokens full, so a pass over the
ready list takes about 12 minutes. `ops_stuck` showed explorer arrivals 15-50 minutes overdue (THEOREM-59 by 50) against about 2 minutes
for traders, and no new system had been accepted for 7 hours.

- `EXPLORE_PRIORITY` (agent.ts) is 2, so `nextExploreTask()` queues with traders, oldest-due first. Seven explorers, so the extra load is small.
- Tour ships were not changed: a tour with a trip under way already gets priority 2 (`tourPriority.ts`). THEOREM-B5's tour dispatch
  did start, about 25 minutes after it was sent. Scouts stay at 4.
- Not proven: the log buffer reset on the restart, so there is no pre-restart heartbeat to confirm the backlog was the same earlier.
  The cause is read from the ordering code and the overdue arrivals.
- Test: `ShipAgent.nextExploreTask` in `tests/agentNextTask.test.ts` (same tier as trading, ahead of keepers); putting the priority back at 3 fails it.

## 2026-10-25 — An explorer refused at an unfinished gate picks another system at once, and says why when it has nowhere to go

THEOREM-B5 was refused a jump to X1-DF92 (its gate is unbuilt: FAB_MATS 0/1600, ADVANCED_CIRCUITRY 0/400). The refusal came from the
explorer's own live check, so no fuel was spent, and the skip was recorded for three hours. But the error went to the explore task's
catch and the ship sat in orbit at X1-ZR49 for 20 minutes with nothing in its log; new systems stopped arriving while it waited.

- `exploreSystem()` now retries in the same call: a remote gate that turns out to be unfinished is skipped and the next target is
  chosen, up to three targets (`EXPLORE_TARGET_TRIES`). The candidate list is filtered again on each pass so a system skipped a moment
  ago is not picked again. A target the caller asked for is never swapped, and a local-gate refusal still throws (it would fail for every target).
- The no-target wait (5 minutes) was silent. It now logs once per 30 minutes per ship how many systems are connected and which were
  skipped while their gate is built (`logNoExploreTarget`).
- Not found: why B5 stayed silent for 20 minutes. This change covers the refusal path and makes the other path visible; if the next
  stall logs a no-target line, the cause is in the target filter, not the retry.
- Tests: `tests/exploreGateRetry.test.ts` (retry moves on, gives up after three, never swaps an explicit target, no-target log is
  throttled). Removing the retry fails the first test.

## 2026-10-24 — Agent watch: when each agent registered, what its start looked like, how fast start gates get built

Operator idea after the fresh-gate work: players may register several agents and keep the one that starts next to a built gate.
The public API shows no registration time, so the question could not be tested; a scan of all 166 agents of the 2026-10-18 reset
could show only that every start gate began unbuilt (0 of 166 pre-built), that 70 agents (all COSMIC) shared 13 start systems
(gate built in 9 of 13, against 36% of the 86 solo starts), that among agents that played, the solo starts did far better (30%
over 100M credits against 6%), and that sibling names (FIRST/FIRST496, ZIKA-OWL/ZIKA-GROK, SOLO/SOLO_BEN, and dev/test pairs such as
CHAMLIS/CHAMLIS-DEV) were not distinguishable by any static system feature (every start system has 3 shipyards, 25-31 markets and
81-100 waypoints). Gate state at registration time was the missing fact. Full write-up: `docs/agent-watch.md`.

- `src/engine/agentWatcher.ts` (started from `cli/index.ts`, `AGENT_WATCH=off` disables): every 15 minutes reads the public agent
  list and the start-system gates (tokenless, about 10 to 60 requests, retries on 429/5xx, writes nothing unless it read the whole
  list) into three tables kept across resets (migration 063): `agent_sightings` (first seen, bracket, faction, start, who shared
  it), `agent_samples` (credits and ships every 30 minutes) and `gate_progress_samples` (start-gate progress, written on change).
- The first run for a reset copies that reset's hourly `agent_credit_snapshots` (wiped at the weekly reset) into the new tables, so
  this week survives; deploy before the 2026-10-25 13:00 UTC reset to keep it.
- `src/engine/agentWatch.ts` (pure): `planScan` (live versus baseline sightings and the 15-minute bracket), `gatesDue`,
  `gateSampleChanged`, `gateAtOrBefore`, `gateBuildTime`.
- Ops tool `agent_watch` (`stcommand_ops_agent_watch`): filter by agent name part, system, sinceHours, resetDate; each row gives the
  gate at first sight, now and when it finished; the summary gives sightings by source, new agents per hour and gate build hours.
- Tests: `tests/agentWatch.test.ts` (planning), `tests/agentWatcher.test.ts` (a fake public API and the real database: baseline,
  bracket, gate rows only on change, a finished gate never read again, a failed scan writes nothing, snapshot backfill, a new reset,
  and the ops tool). Mutation checks: reporting a baseline as live and re-reading a finished gate both fail their tests.

## 2026-10-24 — A 404 is no longer "built", and a gate is read live before a ship jumps through it

Follow-up to the JM97 entry below. Operator question: why did the crawler not correct a gate recorded complete? The crawler reads only gates
never checked and gates recorded unfinished (re-read hourly, 115 of 160 in the 20:16 pass); a gate recorded complete is never read again, by
design, so a wrong "complete" was permanent. The crawler records only what a 200 says, so the wrong record came from elsewhere. The one
writer that could record "complete" without the game saying so was the fleet's own reader (`GalaxyAtlas.refreshGateConstruction`), which took
an HTTP 404 for "no construction record, so built". Checked against the public endpoint on 2026-10-24: a finished gate answers 200
`isComplete: true`, so does a market waypoint that was never under construction (`X1-HM42-X13F`), and a 404 means "Waypoint X not found" or
"System X not found". JM97's own answer: 200, `isComplete: false`, FAB_MATS 0/1600. The writer of JM97's wrong record is not proven; this rule is
the only one that fits.

- `refreshGateConstruction`: a 404 now leaves the gate unresolved and is not asked about again for 45 minutes (it used to cache complete, forever).
- `GalaxyAtlas.verifyGateBeforeJump(gate)`: one tokenless read of the public `/construction` endpoint (outside the 90 calls a minute limit) just
  before a jump, for both ends. Finished: trusted for 6 hours. Unfinished: the cache is corrected (`recordGateNotComplete`), the jump is refused
  with "... is under construction (checked live before jumping)" and the route to that system is retired, so no jump is paid for or rejected. No
  answer (429, 404, 5xx, network): the jump goes ahead and the game decides, as before. A 429 pauses checking for a minute; ships at the same gate
  at the same moment share one read. In memory only: it is a cache of a cheap read, so a restart just reads again.
- Used by `TraderAgent.jumpToSystem` and `FleetManager.jumpShip` (operator jumps, tours, dispatch, rescue).
- Tests: `tests/verifyGateBeforeJump.test.ts` (the check, the trader and the operator seams), `tests/galaxy.test.ts` (the 404 rule replaces the old
  "404 means built" test). Mutation checks: restoring the 404 rule and reporting an unfinished gate as ok both fail their tests. Full suite: the
  same 62 baseline suites fail, nothing new.
- Not done: re-reading gates recorded complete in the background (the 45 gates the crawler gets HTTP 400 for each pass are still unexplained).

## 2026-10-24 — A rejected jump corrects the gate the game names, not the one the ship stood at (JM97)

Operator question: why did a ship run into a gate that was not open, with the crawler reading gate construction? Found 2026-10-24: THEOREM-1
was routed into X1-JM97 at 20:15 and 20:19 and rejected ("Destination jump gate X1-JM97-I57 is under construction"); THEOREM-94 was routed
through it at 16:17 and a manual jump failed at 16:15. The stored record for `X1-JM97-I57` said complete; a live read said FAB_MATS 0/1600 and
ADVANCED_CIRCUITRY 0/400. The construction cache is one-way (the crawler never asks again about a gate recorded complete), so only a live
rejection can correct a wrong "complete", and the trader's handler (`TraderAgent.jumpToSystem`) recorded the gate the ship stood at (the finished
RB54 hub gate) as not complete instead of the destination the message named. JM97 stayed "complete" and ships kept being routed into it, and each
rejection briefly flagged the finished RB54 gate, which withdraws its proven edges and clears the path cache until it is next re-read (inferred
from the code; the flag was not observed live).

- `src/engine/jumpRejection.ts` (pure): `gateFromJumpRejection(message, {origin, destination})` returns the gate to flag: the gate a message names
  before "under construction", else the destination when it says "destination", else the origin (the old behaviour for "not complete" and
  "not connected"), else nothing for errors that are not about a gate.
- `TraderAgent.jumpToSystem` uses it. `FleetManager.jumpShip` (operator jump, tours, dispatch, rescue) now also corrects the cache on a
  construction rejection, which it never did; it still ignores "not connected" there.
- The crawler reads an unfinished gate again after an hour, so a corrected JM97 stays corrected.
- Tests: `tests/jumpRejection.test.ts` (the helper, the trader handler against the real message, the real atlas cache),
  `tests/jumpRejectionFleet.test.ts` (the operator path). Mutation check: flagging the origin again fails the trader test.

## 2026-10-24 — Fresh systems: a queue behind a release gate, staged keepers, and a release rule the engine can run (doctrine `freshGate`, off)

Operator direction: queue newly found systems so their premium (about 1.7x the mature profit per unit for roughly 8 hours after coverage, see the
freshness entry below) is not spent early, open them on a lead time the operator sets, and eventually let the engine do the opening.
`docs/fresh-system-expansion-plan.md`, "Queued systems and the release gate".

- `src/engine/systemQueue.ts` (pure): scouted -> staged -> live per system, with its best markets and an operator `held` pin. Saved in the
  `systemQueue` fleet flag. `gated()` is every system that is not live.
- `src/engine/systemRelease.ts` (pure): `decideReleases()`, one rule for all three modes. Keep `freshTarget` systems whose premium is alive and
  not within `freshLeadMin` of fading (fade age `freshFadeHours`, or a recent ratio under 1.25x the mature rate with at least 15 sells); release the
  best ready staged system (80% of keepers in place) when short, at least 30 minutes after the last release; release one at once when 3 or more
  traders have been idle for 5 minutes; stage the oldest scouted system ahead of need when budget allows. Held systems are never touched, missing
  information never releases anything, and every decision carries a reason.
- Dispatcher gate: `setGatedSystems()` drops every route that buys or sells in a gated system at recompute. Empty = exactly as before.
- Fleet: with the clause on, an explorer's accepted system is queued (its top `freshKeepersPerSystem` markets by keeper score) instead of going straight
  to the keeper list. Staging adds those markets to the keeper list; a keeper that has arrived at a staged market which has been read once is parked
  (no polling, so waiting costs no API budget; saved in the `freshGate` flag) and unparked at the release. `maybeManageFreshSystems()` runs every 5
  minutes: advisory shows the rule's answer in `system_queue`, auto acts on it. Turning the clause off unparks the staged keepers and opens every
  gate. Keeper triage leaves staged systems alone.
- Tools: ops `system_queue` (queue, readiness, live premiums, what the rule says and why not), MCP `stcommand_stage_system`, `stcommand_release_system`,
  `stcommand_hold_system`. A release is recorded as a `system_release` config change, which the analysis engine now uses to anchor a system's freshness
  curve at the moment traders could first reach it (`livePremium()` in `freshness.ts` gives the rolling 2-hour ratio the rule reads).
- Doctrine: `freshGate` (1 advisory, 2 auto; **off by default**: the explorer path and the keeper list behave exactly as before), `freshTarget` (3),
  `freshLeadMin` (240), `freshFadeHours` (10), `freshKeepersPerSystem` (6).
- Tests: `tests/systemRelease.test.ts` (queue, rule, dispatcher gate), `tests/freshGateFleet.test.ts` (the FleetManager seam: queue, stage, park on
  arrival, release, hold, advisory never acts, clause off), and the release anchor in `tests/freshness.test.ts`.
- Not gated: contracts, feeds and missions do not read the dispatcher's route list, so the gate holds back trader routes only.

## 2026-10-24 — Analysis: the freshness curve, profit per unit by hours since a system gained keeper coverage

Phase 0 of `docs/fresh-system-expansion-plan.md`. The 2026-10-23 finding (the best hours came from big hulls selling into
systems that had just been covered, and the profit per unit fell as we sold into them) was read off two ships by hand; this
makes it a standing measurement. `src/engine/analysis/freshness.ts` (pure) buckets every sell by hours since its system's first
market joined the keeper priority list (0-2, 2-4, 4-8, 8-16, 16+) and compares each bucket with the mature rate (sells in systems
with no recorded coverage change, or covered 16 hours or more). The report gains `freshness` (curve, per-system yield with first and
last bucket, hours to first sell, when the premium fades) and a `freshness` finding when a bucket with at least 15 sells beats the
mature rate by 1.25x. The coverage times come from the whole week's `keeper_markets` config changes (ops/analysis.ts reads them
from the week's start, not just the window). No behaviour change: nothing acts on it. Read it with `stcommand_ops_analysis`; a
saved report (`capture_findings`) carries it across the reset. Tests: `tests/freshness.test.ts`.

## 2026-10-24 — Keeper triage: the engine parks keepers on dead markets and sets itself a reminder to look again (doctrine `keeperTriage`, off)

Operator request: let the engine manage keepers, park the ones on low or crashed markets, and set its own reminder to check
back in an hour or two to see whether the market came back. Part of "always be expanding" (`docs/fresh-system-expansion-plan.md`,
Phase 2): each keeper costs a market read every 5 to 30 minutes against the 90 calls a minute the API allows, so one on a market
nobody trades is a call a keeper on a fresh system could use.

- `src/engine/reminders.ts` (pure): reminders the engine sets for itself, one per kind and subject, saved in the `reminders` fleet
  flag and restored at boot (so they survive a restart; long-overdue ones are dropped). Anything that needs a later second look can use it.
- `src/engine/keeperTriage.ts` (pure): `triageKeepers()` picks the keepers to park: no viable route through the market now, and either
  never a trade of ours there and a score under half the median keeper ("low"), or no trade for 6 hours ("quiet"; "crashed" when every
  route through it is held back as dead). `reviewParked()` answers a due reminder: bring the keeper back (a route is viable again or we
  traded there since), unpark it for one cycle to read the market when there is no read under 90 minutes old to judge by ("probe"),
  look again after 90 minutes then 3 then 6 hours ("extend"), or leave it parked for good after 3 looks ("settle", a candidate to scrap).
- `FleetManager.maybeTriageKeepers()` runs every 10 minutes in the maintenance tick. The reviews run even with the clause off, so
  turning it off never strands a keeper the engine parked. Parking goes through `parkShip()` (reversible, keeps the hull, frees a
  slot under `keeperMaxTotal`, the market stays covered). It never parks more than 15% of the keepers, waits 24 hours into a week, and
  leaves alone a keeper still flying to its market or already under triage. Every park and return is a `config_change` action event
  with its reason, and the engine-parked list is saved in the `keeperTriage` flag.
- `RouteDispatcher.marketRouteUse()` counts the viable and dead routes touching each market; `ledgerTradeByWaypoint` now also
  returns the time of the last trade there.
- Ops tool `keeper_triage` shows what the engine parked, its reminders and the last decisions with reasons.
- Doctrine `keeperTriage` (3 parks a pass), **off by default**: off parks nothing, as before. Tests: `tests/keeperTriage.test.ts`
  (pure decisions, the off policy, reminders round trip, the dispatcher seam).

## 2026-10-24 — Our recent sale and purchase lots survive a restart (fleet flag tradeImpacts)

The sell/buy recovery pricing (`marketCrash.ts`, `marketRecoveryMin`, on live) and the learned price impact
(`lotImpact.ts`) are built from our own recent lots per market, which the dispatcher kept only in memory. Every deploy (ten
of them on 2026-10-24) made it forget the markets it had just dumped into and plan on the stale snapshot price again until a
ship next visited. `RouteDispatcher.impactsSnapshot()` / `restoreImpacts()` write them to the `tradeImpacts` fleet flag (at
most once a minute, only when changed, last 60 lots per market inside the 4-hour keep window) and the fleet loads them at
boot. Not saved, deliberately: the 30-minute recent-volume list behind the older score decay, and the idle-trader clock
(it restarts, which at worst delays an idle alert by five minutes).

## 2026-10-24 — Dead routes are shared between ships (deadRouteShareMin, off by default)

A trader that reaches its buy market and finds the live price no longer pays (the dispatcher planned on a snapshot) put the
route on its own private list in `trader.ts`, and nothing told the dispatcher, so the next ship was handed the same route.
2026-10-24 in the log buffer: 88 such rejections in about 55 minutes across seven ships, the same few markets over and over
(EQUIPMENT at X1-KG7-DD5E, SHIP_PARTS at X1-KG7-AA8B, SHIP_PLATING at X1-KG7-D16E, EQUIPMENT at X1-HA24-XX2B and BE4E);
THEOREM-151 bounced off three of them in a quarter of an hour. `src/engine/routeBlocks.ts` keeps a fleet-wide list: the
two buy-time guards now report what they found (`reportDeadRoute`), the dispatcher holds the route back from every
ship's list for the clause's minutes (a buy market whose price moved blocks every destination from it, a destination that
refused blocks that pair), logs `[dispatcher] N route(s) held back as dead`, and a trader already on its way asks
`deadRouteReason` in its own viability check so it re-plans at once instead of flying there to find out. Clause
`deadRouteShareMin` (30 min, off): off, nothing is recorded or filtered. Saved with the other dispatch state (fleet flag
`deadRoutes`, written only when the list changes, restored at boot with lapsed blocks dropped), so a deploy does not make the
fleet learn the same dead routes again.

## 2026-10-24 — Metrics ranges: 3 hours replaces 3 days

The Metrics screen (Tower and Deck share it) offered 30m, 1h, 6h, 24h and 3d. The 3-day window is gone and a 3-hour one is in
its place (30m, 1h, 3h, 6h, 24h, Since reset), the span that settles a rate after a change. A saved 3-day choice falls back
to 6 hours. The server already accepted any window up to 72 hours.

## 2026-10-24 — Idle traders: a ship in flight is not idle

THEOREM-1B was listed "Idle 8 min" while it was in flight (the dispatcher had no route for it and it was hopping around its
system discovering prices). A trader in transit, or sitting out a jump cooldown, is now busy: it is never counted as idle,
and the idle clock starts when it comes to rest and starts over every time it moves, so a long flight can never trip it.
Tower applies the same test to the ship's own state. A ship that really stops with no route is still listed after five
minutes. Separate from this: 1B's dispatcher log shows only cross-system routes it cannot reach (`canJump=false`).

## 2026-10-24 — Scheduled status report notification

A new alert category, "Status report", off by default, for a device that wants a short report on a schedule instead of only
alarms: `+7.4M/hr (3h avg 7.1M) · 335 ships · 307.6M credits · all clear` (or `N need you`). One event per clock hour
(`src/engine/notify/status.ts`, `slot` = hours since the epoch); a device picks every 1, 3, 6 or 12 hours in the Alerts tab
(UTC-aligned) and takes the hours where `slot % N == 0`. Quiet hours and the hourly cap apply as to every alert. It is
`info`: the service worker shows it with `silent: true` (a platform that honours it will not buzz; iOS decides for itself)
and every report carries the tag `status`, so each replaces the last instead of stacking. It is the one message that carries
credit figures, hence off by default; `docs/notifications.md` is updated to say so.

## 2026-10-24 — Idle traders: listed and alerted only after five minutes without a route

Tower's Needs-a-decision list and the Home "unassigned" count showed every trader the moment it had no route, and a trader
is in that state for a few seconds after each sale, so ships flickered in and out (THEOREM-17A, 2026-10-24). The fleet now
times it (`src/engine/idleTraders.ts`, `FleetManager.refreshIdleTraders()` each maintenance tick, first-seen time kept
while a trader is idle and dropped the moment it has a route, a feed or mission crew, contract duty, cargo, a hold or a
stranding). The time rides on each fleet-status row as `idleSince`; Tower lists a trader only once it is five minutes old
and says how long. A new alert category, "Idle traders" (on by default, once an hour per ship), carries the same
threshold, and the app-icon badge counts those ships. The ship cards on the Fleet tab still show a transient
"unassigned" job label per ship; that is the live state, not an alert.

## 2026-10-24 — Learn each market's price impact per lot, and size trips to it (lotImpactMaxFactor, off by default)

Two losing trips the same evening. THEOREM-38 bought 80 NEURAL_CHIPS in 15-unit lots (ask 21,677c -> 30,228c, about +6.8% a
lot) and sold 75 (bid 31,832c -> 19,464c, about -9.3% a lot): the route showed a 47% margin, the trip cleared about 107k and
left five units to sell at a 50k loss. The route model charged a flat 4.5% a lot, measured once on FAB_MATS, and always took
the full lots allowed. `src/engine/lotImpact.ts` (pure) measures the move a run of our own lots made at a market, averages
the last few runs (never below the 4.5% default, never above default x the clause value), and sizes the trip to the units
where the spread stops paying for the impact (`margin / k`, the peak of the same slippage curve `routeEconomics` charges).
The dispatcher already keeps our lots per market for the recovery pricing (`impactFor()`); the fleet's route builder uses
the learned figures for slippage, profit per hold and trip volume. Clause `lotImpactMaxFactor` (3x, off): off, every figure is
the old flat one. Learned from the last 4 hours of lots held in memory, so it starts empty after a restart.
Not covered: a rival's sales into the same market (VIRAL_AGENTS at X1-PG72-A1 the same evening, VCMININGCORP-213 dumped 90
units two minutes before one of ours bought for that route); the data is in the transactions, the model does not use it yet.

## 2026-10-24 — Tower PWA: the touch icon is embedded in the page

Add to Home Screen from Safari still showed a letter "T" although every icon URL served a valid PNG. Whatever fails in iOS's
separate icon fetch, the icon now travels inside `m.html` as a data URI (a test keeps it identical to the PNG file).

## 2026-10-24 — Tower PWA: the manifest also names the 180px icon

iOS 17+ reads the manifest's icons for "Open as Web App"; its closest size to 180 was the 192px one. The 180x180 icon is now
listed first. Add to Home Screen from a Safari tab, not from inside the installed app: the installed app does not load
the touch icon, which is what produced the letter "T" in the Add sheet.

## 2026-10-24 — Tower PWA: root icon paths answer, 180px size declared

The installed Tower showed a plain letter "T" tile. iOS takes the Home Screen icon once, at install, and keeps it; if that
fetch fails it falls back to the letter. The linked icon URL serves a valid 180x180 PNG now, but `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png` and `/favicon.ico` (the paths iOS and browsers try on their own) were 404s that
Cloudflare cached for four hours. They now serve Tower's icons, and the `<link>` declares `sizes="180x180"`. An already
installed Tower keeps its letter until it is removed from the Home Screen and added again.

## 2026-10-24 — Crawler construction pass: say what each read came to

The 00:02 check found a restarted pass with 26 gates consumed, none recorded and a rate-limit pause, and nothing in the log to say why (a 404, a malformed body and a thrown error were all skipped silently). `GalaxyCrawler` now counts every outcome of the pass (`recorded_complete`, `recorded_unfinished`, `status_<code>`, `malformed`, `error`), shows them in `progress().gateConstruction.outcomes` and in the "pass finished" line. No behaviour change. Sampling the public endpoint by hand returned 200 with `isComplete` for every one of 16 gates tried.

## 2026-10-24 — A new Tower icon: a radar scope

The old icon was two rings and a dot with the rounded corners baked in. The new one is Tower's own signature device, the radar scope: bezel with tick marks, range rings, a sweep with a fading trail, and blips in the map's marker shapes (circle, diamond, triangle), amber on the warm near-black. SVG sources in `public/icons/` (`tower-icon.svg`, `tower-favicon.svg`, `tower-notify-badge.svg`); `scripts/render-tower-icons.mjs` renders the PNGs (192, 512, a separate maskable 512, a 180 apple-touch, a 32 favicon, a 96 flat-white notification badge). Full-bleed and opaque (iOS and Android round it themselves). The manifest now lists `any` and `maskable` entries, the page adds the SVG favicon, and the service worker uses the new badge glyph for notifications. `tests/towerIcons.test.ts` checks every named icon exists and is the size it claims. Deck's icons are unchanged. A phone keeps the old home-screen icon until Tower is removed and added again (iOS); Android refreshes its own.

## 2026-10-24 — Approval wording and an icon badge for notifications

- **Approvals read properly.** The engine asks under kinds like `sellBelowFloor:THEOREM-5:LAB_INSTRUMENTS`, `buyShip`, `buyKeeperProbe`; the alert used to print the raw kind. `describeApproval()` gives each a title (a sell below the loss floor reads "Sell below the loss floor? THEOREM-5 is holding lab instruments · 30 min to decide", the time being how long until the engine denies it by default), unknown kinds are made readable, and no figures are included. They were already alerts and already in "N need you"; this fixes the words.
- **Icon badge.** `badge.ts` `needsYouCount()` (approvals + stranded + critical attention) rides on every push; the service worker sets `navigator.setAppBadge()` (cleared at 0, a platform without it just shows the notification). While Tower is open it sets the badge to the header's own "N need you" figure (`syncAppBadge()` in `m.js`). While it is closed the badge can only change when a push arrives: iOS has no silent pushes.
- Tests: 5 new cases (wording x3, count, worker badge x2, service carries it, payload carries it).

## 2026-10-24 — Push notifications in Tower (needs VAPID keys; off until they are set)

Phone alerts through web push, built as small replaceable pieces so a new alert or a new channel is a short addition. Full design, setup and "how to add one" in `docs/notifications.md`.

- **Core (`src/engine/notify/`, pure):** `categories.ts` (the registry: approvals, stranded, attention, reset, rate), `detectors.ts` (snapshot to events; attention alerts only for critical flags; reset warnings at 2 h and 15 min; rate drop compares the last hour with the 3-hour average and shows no figures), `policy.ts` `decide()` (per-device switches, quiet hours with a timezone offset and a critical override, dedupe with per-category cooldowns, hourly cap with most severe first, digests of three or more, silent seeding), `prefs.ts` (sanitises what a device sends).
- **Delivery:** `transport.ts` (`PushTransport`, web-push with VAPID, 404/410 means the device is gone), `service.ts` (`NotificationService`, a pass every 30 s per tenant: a new device is brought up to date silently, a failed send is un-recorded and retried, a gone device is deleted, nothing is read when no one is subscribed), `live.ts` (the only file that knows `FleetManager`/`Store`).
- **Storage:** migration 062 `push_subscriptions` (row-level security like every tenant table; deliberately not wiped at a reset), `Store` methods.
- **API:** `/api/push/{config,subscription,subscribe,prefs,unsubscribe,test}` (`src/http/push.ts`), tenant from the session.
- **Tower:** More, Alerts tab (`public/shared/pushNotify.js`, shared so Deck can mount it too); `public/sw-tower.js` shows pushes and opens Tower on the right tab (`/m#approvals`, `#fleet`, `#home`, `#metrics`); iPhone needs the Home Screen app and the screen says so. `sw-*.js` is served `no-cache`.
- **Safe without the library:** `web-push` is loaded the first time a message is sent, not at boot, so a server restarted without `npm ci` still starts (a send then fails with "run npm ci" and deletes nobody's subscription).
- **Setup:** `npm run vapid` for a key pair, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in the environment (documented in `.env.example`); without both, push is off and Alerts says so. New dependency `web-push` (and its types, in `dependencies` because the box builds on install).
- **Tests:** `notifyPolicy` (8), `notifyDetectors` (6), `notifyPrefs` (3), `notifyService` (10), `pushClient` (8, includes the service worker run in a stand-in scope), `pushRoutes` (7, against real Postgres with row-level security). The Alerts screen was also driven in headless Chromium with a stubbed API (enable, preferences, save, test, turn off): no script errors. Not done: a real push to a real phone, which needs the keys.

## 2026-10-24 — Dispatcher and crawler lines reach the ops `logs` tool; crawler progress counter

The 23:03 post-deploy check could not see whether the market-recovery pass was adjusting routes or how the crawler was doing: both print through `console.log` / the process-wide `log()`, which the ops log buffer never saw (the existing "route cool-off skips" line was missing too).

- **Dispatcher:** `RouteDispatcher.setLogger()`; the two `[dispatcher] ...` lines (cool-off skips, sell-market recovery adjusts) now go through the fleet's own `log`, so `logs text="sell-market recovery"` finds them. Default is still `console.log`.
- **Crawler:** `cli/index.ts` `logGlobal()` pushes the crawler's lines into the buffer under tenant `?` (every tenant's query includes it) as well as the console.
- **Progress:** `GalaxyCrawler.progress()` (public `/api/cartography/progress`) now carries `gateConstruction: { queueRemaining, readThisPass, pausedForRateLimit, passStartedAt }`.
- Tests added to `marketCrashSeam.test.ts` (1) and `galaxyCrawlerConstruction.test.ts` (1).

## 2026-10-23 — The galaxy crawler reads gate construction; edges no longer need loaded systems

Follows the THEOREM-BE stall (see the next entry). Three pieces:

- **Crawler pass (`galaxyCrawler.ts`, `gateCheckQueue.ts`):** `GalaxyCrawler.tick()` now reads the public, tokenless `GET /systems/{s}/waypoints/{gate}/construction` for every known jump gate (4 calls per 5 s tick, a 429 pauses the pass for a minute) and records `isComplete` in the shared `galaxy_gate_construction` table. Finished gates are never asked again; unfinished ones are re-read hourly. Order in `tick()`: factions, systems, agents, then this, then the connection sweep (which waits until the construction queue is drained). Only a 200's `isComplete` is recorded: a 404 is skipped, not taken for built (the table is one-way). First pass: a few thousand gates in about an hour.
- **Reload (`fleet.ts` `maybeRefreshGateConstruction()`):** every 5 minutes the atlas re-reads that table (`loadGateConstruction()`, which never downgrades a known-complete gate), so what the crawler learns reaches a running process; the hydrated graph is re-read every 30 minutes.
- **Edges without loaded systems (`galaxy.ts`):** `hydrateJumpGraph()` now keeps each gate with the far gate it connects to; `edgeUsable()` and `usableNeighbors()` judge an edge from those two gates' construction status alone. Before, `connectedSystems()` and `edgeUsable()` returned nothing for a system not loaded in this process, which is what read as "no gate" for BE.
- Tests: `gateCheckQueue.test.ts` (3), `hydratedEdges.test.ts` (4), `galaxyCrawlerConstruction.test.ts` (4); mutation-checked. Each tenant's fleet re-reads the graph every 30 minutes (one heavy query each).

## 2026-10-23 — A jump that went through proves the gate is open; warm the path before giving up

THEOREM-BE (80 CLOTHING, about 390k) jumped AR93 -> QK51 -> JM61 -> ZR49 and was then told "no verified gate path (<= 10 hops) from X1-ZR49 to X1-SU37" every 15-30 seconds from 18:30 to 21:19 (about 2h50m idle at about 600k/hr). Open gates do not close; the atlas's `edgeUsable()` wants the far system loaded in this process and its gate confirmed here, and `positioningPath()` is cache-only, so a gap in what the process had loaded read as "no gate" and retired the route.

- **Proven edges (`galaxy.ts`):** every real jump already lands in `recordJumpCost()` and the persisted `galaxy_jump_costs` ledger. Those (from-system, to-system) pairs now count as usable edges, both directions (gate connections are paired), in `canJump()`, `edgeUsable()` and `usableNeighbors()`, rebuilt at boot by `loadJumpCosts()`. No new storage. A live "still under construction" rejection (`recordGateNotComplete()`) withdraws the proven edges of that gate's system. Assumption: connections are symmetric.
- **Warm before giving up (`trader.ts` `navigateTo()`):** when the cache has no path, `warmPositioning()` (load and check the neighbourhood, once per pair per 10 minutes) runs before the route is retired and the error thrown.
- Not changed: a loaded ship with no path still has no automatic walk-back; I walked BE back by hand. Tests: `tests/provenEdges.test.ts` (5), `tests/navigateWarmsPath.test.ts` (2); both mutation-checked.

## 2026-10-23 — Plan on what a market we traded in pays now (clause `marketRecoveryMin`, off by default)

THEOREM-152 sold 360 LAB_INSTRUMENTS at X1-YB39-BD3D (5,836 -> 4,609) and was assigned the same route an hour later at 5,836, bought 180 units for it, was turned back at the market and trekked nine jumps to sell elsewhere (2h14m, about 80k net); THEOREM-173 did the same with ELECTRONICS (2,949 -> 2,210) and carried 40 leftover units eight jumps. Cause: a route's sell price is the last snapshot, a trader snapshots a market when it docks (before it sells), so the pre-sale price stays until another ship visits, and the 30-minute volume discount in `scoreRoute()` had expired long before the market refilled.

- **`src/engine/marketCrash.ts` (pure):** `estimateSellPrice()` takes our recent lots into a (good, market) with the price each fetched, the route's listed price and the snapshot's time, and returns the price to plan on: refilling in a straight line from the last lot's price to the first lot's over `recoveryMin`. Only sales after the snapshot count (a later snapshot already shows the drop). `profitAfterShortfall()` turns the per-unit shortfall into trip profit.
- **Dispatcher:** `recordSale()` now also receives each lot's price (both sell paths in `trader.ts`); `recompute()` adjusts every route's sell price, profit and per-hold profits, and drops a route that no longer pays ("lower the score, or leave it out"). Logs `sell-market recovery adjusts N`.
- **Buy side (same clause):** our own purchases lift the ask the same way (THEOREM-BE, X1-AR93-B15C CLOTHING: 3,342 -> 5,060 over 305 units, and its next route still listed 3,342 for 226k). `recordBuy()` takes each route purchase lot from the trader; `estimateBuyPrice()` plans on the ask falling back from the last lot to the first; sell and buy shortfalls both come off the trip. Contract and warehouse buys are not recorded yet.
- **Doctrine `marketRecoveryMin`** (90 min, 15-240, off). The refill time is a guess: the analysis report has no sell-side recovery measurements yet, so tune it from its `market_recovery` findings once they exist. Off reproduces today's route list (test).
- Tests: `tests/marketCrash.test.ts` (10), `tests/marketCrashSeam.test.ts` (6, mutation-checked on both sides).
- Not changed: `redirectHops` is still off (the nine-jump trek was possible because of it); a keeper-less market with no visit still shows an old snapshot.

## 2026-10-23 — Repairs count as overhead

Operator decision: repairs are a running cost, like fuel, so the overhead % and net now include them; ship purchases
stay capital and scrap stays proceeds. `repairShip` now books a `SHIP` row tagged `REPAIR` with a positive total
(it used to be an untagged negative total). `isRepair()` in `src/engine/metrics.ts` also treats legacy negative
`SHIP` rows as repairs, so earlier rows in the week are counted. `MetricsTotals.repairs` is new; the analysis
engine's `windowMetrics` overhead share and the `analysisLedgerRows` query include repair rows too. Tests in
`tests/metrics.test.ts` and `tests/analysis.test.ts`.

## 2026-10-23 — Ops tool: what charting pays
The API says charting a waypoint pays "a one-time reward of credits based on the rarity of the waypoint's traits" but gives no amount, and our own chart calls (scouts, and new keeper probes at their spawn waypoint) never recorded it. The leaderboard's second list is charts submitted per agent (JANEWAY 24,636), so other agents chart at scale. The operator asked how much it is worth and whether it is worth doing.
- **`stcommand_ops_chart_rewards`** (`chart_rewards`): measures the reward from the books, with no change to the engine. Every ledger row records the balance after it (`wallet_after`), so between two consecutive rows the balance must move by exactly the second row's effect; a chart in that gap explains any leftover. Chart events come from the activity log (kind "chart", already written by the scout and keeper-spawn paths).
- Reports the charts in the window; a **self-check** (gaps with no chart should leave nothing over: `baseline.exactShare` near 1 means the books are tight enough to trust the chart figures); single-chart rewards (median, mean, min, max); the largest rewards with the traits charted; and gaps holding several charts averaged per chart. Ship rows are skipped (a purchase and a scrap share a type, so their sign is unknown).
- Pure `src/engine/chartReward.ts`; `Store.chartActivity()` and `Store.ledgerWalletTrack()`. Tests: `tests/chartReward.test.ts` (6; ignoring the row's own effect fails three).

## 2026-10-23 — Dispatch recompute line says what traders are doing, not "idle"
The dispatcher counted a trader as idle whenever its hold was empty, so a ship flying empty to the market it had just been assigned to buy at counted as idle. On 2026-10-23 the log read "24 traders (16 idle)" while all 24 held an assignment, and that number was used to argue that routes, not ships, were the limit. They weren't: the largest hulls (bulk freighters) earned about 1M an hour each.
- **`src/engine/traderStates.ts` (pure):** `carrying` (cargo aboard), `en route` (empty hold with an assignment: flying to or buying at its next market), `waiting` (empty hold and nothing assigned, the ships that really have no work, named in the line), `manual` (operator override).
- The log line now reads `dispatch recompute: 24 traders (carrying 9, en route 13, waiting 2 [A, B], manual 0) | work: ...`. Nothing else about how routes are assigned changed. Tests: `tests/traderStates.test.ts` (5, including two through the real dispatcher; the mutation that counts en route as waiting fails three).

## 2026-10-22 — Ops tool: rival activity
Every market scan returns the recent fills there, ours and other agents', with the ship, good, side and units; we already store them in `market_transactions`. The operator asked whether we can see how much the other traders buy, and what the leaderboard agents actually trade.
- **`stcommand_ops_rival_activity`** (`rival_activity`): other agents' fills over `sinceHours` (default 24, cap 168), grouped by agent (ship symbol without its last suffix, so `CHAMLIS-DEV-1F` is `CHAMLIS-DEV`): ships, visits, units bought and sold, median and largest load per visit (about their hold), top goods and markets. A visit joins one ship's fills at one market under three minutes apart, so a 225-unit load split into three fills is one visit. Filters `agent` (partial name), `minUnits`, `limit`. A floor, not a census: a scan only shows the recent fills and an agent appears only where we look.
- Pure `src/engine/rivalActivity.ts`; `Store.rivalMarketFills()` (shared table, our own `<agent>-%` ships left out, up to 200,000 rows newest first, reported as `capped` when it hits the limit). Tests: `tests/rivalActivity.test.ts` (5; the visit gap was mutation-checked).

## 2026-10-22 — Ops tool: keepers at markets where we have made no sales
With the keeper limit full (300/300), the operator wanted the keepers standing at markets where none of our ships has sold anything, as the first candidates to scrap. THEOREM-14D (XB31-C45E) and THEOREM-7D (SU37-C48), both scored 0 by the keeper review, were sold the same day to start freeing slots.
- **`stcommand_ops_keeper_sales`** (`keeper_sales`): every stationed keeper with our sells and buys at its market this week (count and credits), lowest first; by default only keepers whose market has had no sale of ours, with `noTrade` counting those with no purchase either. `onlyNoSales=false` lists all of them. Read-only; it says to check buys and the keeper-review score before scrapping, since a market can matter through its prices or purchases without a sale.
- `Store.ledgerTradeByWaypoint()` (one grouped query, scoped to the current week by the ledger's row-level policy) and the pure `src/engine/keeperSales.ts`. Tests: `tests/keeperSales.test.ts` (3).

## 2026-10-22 — Buy market round limit (off by default)
Looking at KP19 CLOTHING lot sizes: THEOREM-BE and C4 took 220-300 units a visit from C13B every one to three hours, and the buy price rose 4-8% a lot (first-lot price 2.6k at best, 3.0-3.5k typically), while the sell side at DX2F recovered on its own (first lot 4.1k to 5.1k over the day). The C13B routes earned 0.83-0.94 of their estimate; the FC8A routes, whose buy market was left alone, 0.97-1.03. The route round limit (`routeRoundsMax`) counts an exact good + buy + sell, so a ship that rotates its sell market never repeats a route and the buy market it is wearing down never rests.
- **`buyMarketRoundsReason()` (`src/engine/routeRounds.ts`, pure):** counts trips that bought a good at a buy market in the last 60 minutes, whatever they sold into, and rests every route out of that market once the limit is reached, until the oldest counted trip leaves the hour.
- **Doctrine clause `buyMarketRoundsMax`** (3 trips, ships off). Wired through the dispatcher's existing cool-off path (`routeCoolOff()`), so traders' own `routeResting` check honours it between trips like the other rest rules. With the clause off nothing changes.
- Tests: three unit cases in `tests/routeRounds.test.ts` and two seam cases in `tests/routeRoundsSeam.test.ts` (trips on three different sell markets rest the shared buy market while a route limit of 2 sees nothing; off at 0). Mutation-checked by counting only one sell market: two tests failed.

## 2026-10-22 — Analysis: does rival trading cost us profit?
Asked whether systems with big traders in them should be treated differently. A first look at 8 markets (route calibration factors against the share of trade value other agents had at their markets) was mixed: the quietest markets (YM69 AMMUNITION 1.26, FOOD 1.14) had the best realized-over-estimated factors and two busy ones were below 1.0 (QB34 FERTILIZERS 0.95, KR33 EQUIPMENT 0.92), but KP19 CLOTHING had almost no rivals and one of the worst factors (0.83), and KR33 HYDROCARBON had heavy rival traffic and 1.15. Too few markets to decide, so this adds the measurement instead of a ranking weight.
- **`src/engine/analysis/competition.ts` (pure):** for every closed trip with an estimate, counts the units of its good that ships not ours traded at the buy market in the hour before the buy and at the sell market in the hour before the sell, plus our own other ships' units in the same windows. Trips fall into none / light / heavy (heavy = 100 rival units or more across the two markets) and each group's realized profit is compared with its estimate (sum ratio and median per-trip ratio), with per-system rival units per trip.
- **In the analysis report** as `competition`, so `stcommand_ops_analysis` and `stcommand_capture_findings` carry it. A finding (`competition:rival-activity`, advisory, no tool call) appears only with 8 or more trips in both the none and heavy groups and a gap of 0.1 or more; it says it is a correlation. Policy values (`competitionWindowMin`, `heavyRivalUnits`, `minCompetitionTrips`, `competitionGap`) live in `AnalysisPolicy`.
- No dispatcher change and no doctrine clause: a competition weight in route ranking waits until this shows a stable gap. Tests: `tests/competition.test.ts` (6; the window bound was mutation-checked).

## 2026-10-22 — Contracts whose delivery point cannot be reached by gate
A PROCUREMENT contract for 132 PRECIOUS_STONES delivering to X1-NH60-ZA5E (owing 17k in all, 6.5k of it an advance already received) was accepted and sourced although NH60 is 21 gate jumps from the home system, past the trader's 10-jump ceiling. THEOREM-21 (a 40-unit hull) bought 40 stones and then hit "no verified gate path (<= 10 hops) from X1-YM69 to X1-NH60" every 12 seconds for more than two hours. There is no shorter path to find, so the trader should not backtrack: the contract should never have been taken or sourced. Three changes:
- **Accept (`ContractManager.acceptBest()`):** a contract with an outstanding delivery to an unreachable waypoint is passed over, once per offer logged ("not accepted: it delivers to X, which has no verified gate path from here"). With no reachability function set (tests, no atlas) it behaves as before.
- **Source (`FleetManager.computeContractBuyTargets()`):** a delivery to an unreachable waypoint is not sourced, so no more cargo is bought for it and its `contractBuy` assignment lapses.
- **Cargo already aboard (`TraderAgent.deliverContractCargo()`, extracted from `tick()`):** when walking to the delivery point fails with a no-gate-path error, the delivery is left alone for 30 minutes (`CONTRACT_DELIVERY_BACKOFF_MS`) and the tick carries on, so the ship sells what it holds like any other leftover; any other error is still thrown.
Reachability (`FleetManager.contractDestinationReachable()`) is from the home system, where contract goods are bought: a verified path within the Positioning jumps limit, else the gates on the way are loaded and checked once (bounded, as for a trader's positioning leg) before it counts as unreachable; answers are kept ten minutes. Pure helpers in `engine/contractReach.ts`; tests in `tests/contractReach.test.ts` fail when any of the three is switched off. No new setting.

The contract already accepted stays accepted (an accepted contract cannot be handed back to the API); it is no longer sourced, and lapses at its deadline (2026-10-28) at the usual reputation cost.

## 2026-10-22 — A trader on a short loop now honours the dispatcher's rest rules
THEOREM-A0 ran CLOTHING X1-KG7-B10C > X1-KG7-ZC9B eleven times in eleven minutes (15:02-15:13) with `routeRoundsMax` at 2 per hour. Its buy price rose from 2,996 to 3,506 in 17 minutes and profit per sale on the sell side fell from about 45k to 9k as the price went 4,545 to 3,664. Cause: the rest rules (`routeCoolOffMin`, `routeRoundsMax`) only filtered the dispatcher's *new* work list. A busy trader's assignment is carried forward unconditionally at every recompute, and a trip of about a minute is as long as the recompute interval, so A0 was almost never idle when the dispatcher looked and was never re-ranked. The trader now asks `Dispatcher.routeCoolOff()` before it buys a new round (`TraderOptions.routeResting`, checked in `viableRoute()` and `whyNotViable()`); a resting route is declined, the dispatcher hands out something else at its next recompute, and a hand-pinned (manual) route is never vetoed. No new setting: it makes the two existing clauses effective for this case, and with both at 0 it does nothing. Tests: `tests/routeRestingSeam.test.ts`.

Not fixed: the rule counts the exact buy-to-sell pair, so a ship can still rotate through several sell markets from one buy market (A0 also used E11D, D16E, ZA1B and CA7E) and keep squeezing the buy price. Counting rounds per buy market is the next step if that shows up again.

## 2026-10-22 — Hauled jumps: a limit on how far cargo is carried (off by default)
Profit per hour fell from about 6M to 1.5M after the 14:25 restart. The two biggest earners, THEOREM-C4 and THEOREM-BE, had each been sent with 225 MACHINERY on a route to a system many gate jumps away (C4: 10 jumps to X1-TK64). At the third hop the trader found "no verified gate path (<= 10 hops) from X1-DG35 to X1-TK64" and redirected the cargo to the best-paying reachable market, X1-NH60, another ten-jump trek at about ten minutes of cooldown per jump. The same thing cost BE 74 minutes after the 12:45 restart (nine jumps back from X1-TA26). A third trader (THEOREM-21) repeated the same "no verified gate path" error about every 12 seconds for ten minutes.

Two new doctrine clauses, both **off** (nothing changes until they are turned on):
- `hauledHops` (default 8 when on): the most gate jumps a route may carry cargo across. `computeDispatchRoutes()` drops a longer cross-system route, with the reason in the route-build drop list. Separate from `positioningHops`, which governs the empty ship's trip to the buy market. Measured over the last 37 hours (6,247 sales, 110M realized): 74% of sales were same-system, 0.6% (38 sales, 12 trips) were on legs of more than 4 jumps and made 2.2% of profit, and several of those (X1-YM69 to X1-SU37, 5 jumps, NEURAL_CHIPS, 213-498k a trip) were good, so a low value would cost real routes; 8 would only have blocked the one 8-jump trek.
- `redirectHops` (default 3 when on): a lot turned back from its destination (`TraderAgent.redirectUnreachable()`) is first offered markets within this many jumps, then any reachable market if none is close (the cargo still has to go somewhere).
Pure functions in `engine/haulLimit.ts`; tests in `tests/haulLimit.test.ts` cover the pure part, the route filter on a `FleetManager`, and the redirect on a `TraderAgent`, and fail when either safeguard is switched off.

What this does not fix: why a path that existed at assignment stopped verifying three hops in. The shared gate cache (`GalaxyAtlas.edgeUsable()`) needs both ends' gates cached complete and both systems loaded; a live "not connected" jump rejection also marks a gate incomplete for every ship (`recordGateNotComplete()`), and I could not tell from the logs which of these happened. Next step would be logging, at the moment a re-plan fails, which edge of the original path is no longer usable.

## 2026-10-22 — Explorers: which found systems became trading
The Explorers report (ops `explorers`, Deck and Tower tab) now answers "of the systems the explorers found and put keepers in, how many do we trade in": each system row has `trading` and `lastTradeAt` (from the ledger's first and last trade in that system this week), and the totals gain `systemsWithKeepers`, `keeperSystemsTrading`, `touredSystemsTrading` and `visitedSystemsTrading`. The tab shows a "Keeper systems we trade in" tile and a Trading column. To tell whether exploring led to trading, each system row also carries `firstTradeAt` and `explorerFirstAt` (the first time an explorer ship jumped in, within the window), and the totals split every system we trade in into `tradedAfterExplorer`, `tradedBeforeExplorer` and `tradedNoExplorerSeen`. A first trade after the first explorer jump is consistent with the explorer having led to it, not proof: traders find systems on their own, and an explorer ship's jumps from before it became an explorer count too. The counts cover every system, not just the newest 60 listed. Tests: `tests/explorerReport.test.ts`. The tab's rendering was checked for syntax only, not in a browser.

## 2026-10-22 — API calls counted by ship role, and an adjustable keeper poll ceiling
**By ship role.** The rate limiter's stats gained `byRole` ("keeper market", "tour market", "trader sell-cargo", ...): each scheduler task runs inside an async-local role tag taken from the ship it belongs to (`FleetManager.apiRoleOf()`: keeper, explorer, tour, trader, miner, scout, other; coordinator loops are "fleet", untagged calls "?"). Visible in `stcommand_ops_instances` and as a third line of the five-minute limiter log. Stats only, no behaviour change. It answers which role the 97 `ShipAgent.recordMarket` calls per five minutes belong to before anything else is parked or slowed.

**Keeper poll ceiling.** New doctrine clause `keeperPollMaxMin` (default 30, so nothing changes until it is raised). A keeper still waits a third of the time its market has sat unchanged, between 5 minutes and this ceiling; 60 would halve the calls for markets that barely move. Why not just raise it: a read counts as fresh for 80% of the wait and prices older than `snapshotMaxAgeMin` (90) are ignored, so 60 is the practical limit. Tests: `tests/apiPriority.test.ts`, `tests/keeperCadence.test.ts`.

**Traders skip re-reading keeper markets (clause `traderSkipKeeperMarkets`, off by default).** The role counts (450 calls in 5 minutes: traders 216, keepers 138, tours 49) showed 28 of them were traders recording a market right after docking. With the clause on, a trader does not make that read when a live keeper stands at the market and its snapshot is younger than the window (10 minutes by default); its own price checks before a buy or sell are untouched. Pure decision in `engine/traderRecord.ts`, wired in `FleetManager.traderRecordMarket()`. A market a trader works used to keep its fast keeper cadence because the trader's snapshot counted as a change; with the read skipped that market can be slightly staler. Tests: `tests/traderRecord.test.ts`, `tests/traderRecordSeam.test.ts`.

**Not built: parking tour ships.** Tour targets already exclude every keeper-covered market and shipyard (`marketTourTargets`, `shipyardTourTargets`), and the first role counts showed tours make 49 calls per 5 minutes, only 2 of them market reads (the rest is movement to markets nobody covers), so parking them would save little and lose coverage work.

## 2026-10-22 — Parked ships, and a blocked-goods list
**Parked ships** (docs/parked-ships-design.md, issue #12 and PR #20's slice 1, cherry-picked with its tests). A parked hull is kept but makes no game-API calls: no agent, no task chain, no polling (a hold polls about 120 times an hour). `FleetManager.parkShip()` releases it from feed and mission crews, clears its hold, mining pin, pending sale and tour destination (a stored hold would be replayed at boot), stops its agent, remembers the role it had and persists `fleet_state.role='parked'`, docking it first if it is in orbit at a market or yard (the only call parking makes). Refused for a live rescue tender. `unparkShip()` resumes the remembered role, an explicit one, or the hull's own; a keeper with no known market falls back with a note. A role change to `parked` is now refused before anything is touched (it used to stop the agent and then throw, orphaning the ship). Exclusions: the reset wind-down never queues a parked hull (so it is lost at the reset unless unparked), attention gives it one info line instead of quiet/low-fuel/overdue, and the stuck classifier skips its tank. A parked keeper still counts as covering its market, so the queue does not buy a second probe for it, and it does not count against `keeperMaxTotal`. Operator surface: MCP `stcommand_park_ship`, `stcommand_unpark_ship`, ops `stcommand_ops_parked`; the keeper review now suggests parking a weak keeper before scrapping it. Not built yet: HTTP routes, Deck buttons, the calls-saved counter and the live one-hour check. Tests: `tests/parkShipEngine.test.ts`, `tests/parkedShips.test.ts` (needs Postgres).

**Blocked goods.** A list of trade goods the fleet will not buy for margin trading, for goods not worth it (first entry: VIRAL_AGENTS, a thin market where every lot sold ratchets the price down and each sale needed a below-floor approval). The dispatcher drops every route in a blocked good ("blocked by the operator" in the route-build drop reasons) and a trader's own choice skips it. It stops new buys only: cargo already aboard is still sold by the normal rules, loss floor and approvals included; a hand-pinned route, contracts and construction missions are unaffected. Stored as the fleet flag `blockedGoods`. MCP `stcommand_block_good`, `stcommand_unblock_good`, ops `stcommand_ops_blocked_goods`, `POST /api/blocked-goods`; a panel in Deck (Settings › Doctrine) and Tower (More › Blocked). Pure list logic in `engine/blockedGoods.ts`. Tests: `tests/blockedGoods.test.ts` cover the list, a trader's route choice and the fleet's persistence; the dispatcher's own filter inside `computeDispatchRoutes()` is not covered at the seam.

## 2026-10-22 — Fewer API calls, a keeper budget, and keepers chosen by what the market trades
The fleet was using all 90 API calls a minute the rate limiter allows (449 calls in 5 minutes, 14 rate-limit hits a minute, low-priority calls waiting up to 21 s), and each automatic keeper adds a market read every 5 to 30 minutes, so the keeper automation would have pushed it over.

**Cheaper background calls.** Unfinished gates are re-read at most every 45 minutes, not 20, and a restart no longer re-reads every one at once: the time each gate was last checked (`galaxy_gate_construction.updated_at`) now seeds the atlas, so only gates not checked recently are read (finished gates were never re-read). The contract list is cached two minutes, not 30 s; it is invalidated by every change made through `ContractManager`, so the cache is only an outer bound.

**Keeper budget.** Doctrine `keeperMaxTotal` (300, on): no automatic keeper purchase once that many keepers are stationed or on the way. A full budget skips the automatic buy without raising an approval card; a purchase by hand or by card is not blocked. Off = no limit.

**Keepers chosen by value.** `engine/keeperValue.ts` scores a market on what it trades: each good weighted by role (export 1, import 0.8, exchange 0.4) times its typical price in thousands (median sell price over the markets we hold, capped at 20k), goods with a profitable route counting 1.5x. The survey already reads each market's import, export and exchange lists without a ship there, so a market is scored before any keeper exists. When a good system's markets are added to the keeper list they are listed best first and their scores remembered (fleet flag `keeperScores`); the keeper queue buys the best-scoring uncovered market first, with operator-listed markets that carry no score ahead of them. Stationed keepers are scored from their stored price rows.

**Keeper review (advisory).** New ops tool `keeper_review` (`stcommand_ops_keeper_review`, `GET /api/ops/keeper_review`): keepers against the limit, the API calls a minute the keepers cost now and at the limit, the weakest stationed keepers, what would be bought next, and swap suggestions where an uncovered market scores at least 1.5x a stationed keeper. Nothing is scrapped or bought by it; to act on a swap, `stcommand_sell_ship` the weak keeper and the queue buys the better market. Automatic scrapping is not built: deciding a keeper is not worth its poll needs the operator's call on the threshold, and scrap refunds only part of the price. Tests: `tests/keeperValue.test.ts`, `tests/keeperAutoApproveSeam.test.ts`, `tests/opsExplorers.test.ts`, `tests/galaxy.test.ts`.

## 2026-10-22 — A system counts as toured only when an explorer's tour finishes
The previous fix (atlas-seeded marks do not count) was too narrow. Any ship that merely passes through a system writes a survey mark (`survey`, `tour`, `explore`, `scout`), and the explorer read every mark as "already done", so good systems could still be skipped without a tour, keeper listing or yard keeper. Now only two marks end the explorer's interest in a system: `toured`, written when its tour runs to the end (`runTourStops()` completing; a cooldown or transit pauses the tour and keeps the remainder to resume), and `rejected`, written when the worth threshold says no. Everything else, including atlas seeds and other ships' visits, leaves the system owed a tour: explorers target it, and on arrival it goes through threshold, keeper list and tour like a new system. A later plain mark from another ship never undoes a finished tour, in memory (`FleetManager.untouredMarks`, `isToured()`) or in the database (`Store.recordSystemSurvey` no longer overwrites `toured` or `rejected` with a plainer source). Scouts and the legacy explore goals still read `surveyedSystems` as before. Expect a one-off wave of tours: every already-known system that passes the threshold and has no finished tour will get one, and the ones that fail it are rejected on arrival; toured marks expire after 14 days like any survey mark, rejected after 60. The Explorers tab now shows `toured`, `not toured yet` (surveyed in passing), `rejected` and `from atlas`. Tests: `tests/explorerTargetIntel.test.ts` (target selection, the marking rules, a finished tour versus a paused one), `tests/explorerReport.test.ts`. `exploreSystem()`'s own use of the check is still only covered by those pieces, not end to end, as it needs a live ship. `stcommand_forget_survey` clears a mark if a system needs touring again.

## 2026-10-22 — Explorers now tour systems that migration 060 only marked from the atlas
Found live on the first accepted system: THEOREM-61 jumped into X1-XN61 (9 markets, 1 shipyard, passes the worth threshold) and logged "already surveyed, skipping market re-tour", so it was neither toured nor listed for keepers. Cause: migration 060 seeded `system_surveys` from the atlas (`source='backfill'`) for every system with a marketplace, and the explorer treats any mark as "visited". Those systems were never visited, so they were never toured. Now a system whose only mark is `backfill` counts as not yet toured (`FleetManager.isToured()`, `atlasOnlySystems`, hydrated from the mark's source): explorers target it, and on arrival it goes through the same path as a new system (threshold, keeper list, tour). Any real mark, including `rejected`, replaces the atlas one; an atlas system that fails the threshold is still not flown to. Not tested at the seam: the `targetWasSurveyed` check inside `exploreSystem()` needs a live ship; target selection is (`tests/explorerTargetIntel.test.ts`). Systems already overwritten with a real mark since the last deploy, XN61 among them, stay un-toured: new MCP tool `stcommand_forget_survey` clears a system's mark (or all) so an explorer tours it again.

## 2026-10-22 — Explorers tab: systems traded in, systems with keepers, and how they grew
Two headline counts at the top of the Explorers tab (Deck and Tower): systems we have traded in this week (with how many in the last 24h) and systems where a keeper is stationed now, plus a cumulative line chart of both. The history needs no new table: a system counts from its first PURCHASE or SELL in the ledger (`Store.systemTradeSpans`, scoped to the current week by the ledger's own row-level security), and a keeper system from the purchase of the earliest keeper now stationed there; a keeper with no purchase row this week counts from the start of the chart, so the last point always equals the current number. Limits: a keeper since scrapped is not counted, and the chart is the current week only. Pure `buildCoverage()` in `engine/explorerReport.ts`; the keeper list and totals still follow the 24h/72h/7d window while the coverage always uses the whole week's purchases. Tests in `tests/explorerReport.test.ts` and `tests/opsExplorers.test.ts`.

## 2026-10-22 — Deck: Fleet › Explorers tab
New read-only tab under Fleet. Per explorer ship: where it is, nav, fuel, what it is doing, any interrupted tour still owed, jumps and jump spend in the window, and the systems it recently visited with their verdict. Below that, the newest survey marks (markets, yards, verdict `surveyed` / `rejected` by the worth threshold / `atlas` for marks seeded from the galaxy atlas, and how many keepers stand there and were bought there), and the keepers bought in the window with where each was stationed, what it cost and where it was bought. Window 24h / 72h / 7d. Tower has the same tab (Fleet › Explorers, a pane of the More screen) with the three lists as stacked cards for a phone, from the same module (`mountExplorers(root, { api, compact: true })`). Data is the new ops tool `explorers` (`stcommand_ops_explorers`, `GET /api/ops/explorers`), built by the pure `engine/explorerReport.ts` from `ship_movements`, `system_surveys` (`Store.recentSystemSurveys`), the ledger's SHIP rows and the keeper stations; screen is `public/shared/explorers.js`. Keepers are attributed by "bought, and now stationed as a keeper", not by which explorer triggered the purchase, which the data does not record. Tests: `tests/explorerReport.test.ts`, `tests/opsExplorers.test.ts`.

## 2026-10-22 — Thin markets are left off the automatic keeper list
When `autoKeeperGoodSystems` adds a worth-touring system's markets to the keeper list, a market that trades fewer than `keeperMinGoods` (default 3, on) distinct goods is now skipped and logged ("skipped N thin market(s)"). The count comes from the survey's own remote market reads, which return each market's import, export and exchange lists without a ship there (only prices need one), so neither a keeper nor the tour is needed to know it. A market the survey has no read for is kept, never dropped on a guess; markets can still be added by hand, and clause off adds everything. `distinctGoods()` and `splitThinMarkets()` in `keeperBuy.ts`; `FleetManager.keeperCandidatesForSystem()` is the seam, tested in `tests/keeperAutoApproveSeam.test.ts`. Not confirmed on a live market yet: the first accepted system's log line will show the counts.

## 2026-10-22 — Good systems get a keeper on every market, and the new keeper and explorer clauses are on
Operator decision, same day: `autoApproveKeeperProbes` (cap 60,000c) now ships **on**, and a new clause `autoKeeperGoodSystems` (on) adds every marketplace of a system that passes the explorer's worth threshold to the keeper priority list when the explorer accepts it, so the whole path from discovery to keeper needs no hand step: survey, accept, list the markets, buy the yard keeper while the explorer is docked, buy the rest through the yard keeper. `FleetManager.addKeeperPriorityMarkets()` appends (setKeeperPriorityMarkets replaces the list); `marketsNeedingKeepers()` in `keeperBuy.ts` picks the markets. If it misbehaves, switch the clause off in Doctrine; nothing else changes. Tests: `tests/keeperBuy.test.ts`, `tests/keeperAutoApproveSeam.test.ts`.

## 2026-10-22 — Keepers bought without a ship waiting, and explorers skip systems not worth a tour
**Keepers.** A market on the keeper priority list could not even raise a purchase request unless the system's shipyard had probe stock stored, and stock is stored only when one of our ships docks at that yard. On 2026-10-22, 26 priority markets (X1-RK67, TP78, UC59, QD80, XM46, RY37) sat uncovered with no approval open, for exactly that reason. New doctrine clause `autoApproveKeeperProbes` (off by default; value is the price cap in credits, default 60,000): when on and the quote is within the cap and affordable, a keeper is bought with no approval card. At a shipyard visit the docked ship buys and moves on, and one visit can cover every uncovered priority market that yard serves. For a market, any ship of ours at the yard stands in as the docked ship (`pickShipAtYard`, a stationed keeper first), so nobody has to happen to dock; a keeper at the yard also re-reads its stock every 30 minutes. A market whose yard has no ship of ours is left for the next pass without raising a card, and an open card for an over-cap quote no longer stalls the markets under the cap. Pure decisions in `src/engine/keeperBuy.ts`; seam test `tests/keeperAutoApproveSeam.test.ts` needs no database. With the clause off, every purchase asks the operator as before.

**Explorer threshold.** After an explorer's survey, a system with fewer than five markets or no shipyard is not toured: it is marked `rejected` in `system_surveys` (durable, shared by every explorer, 60-day lifetime instead of 14) and the ship jumps on. A loaded system whose known waypoints already fail the test is never flown to at all. Doctrine clauses `exploreMinMarkets` (5) and `exploreMinShipyards` (1); switching one off drops that criterion. `exploreMaxMarketStops` (10) replaces the hardcoded cap on markets read per tour; all shipyards are always visited. Pure rule in `src/engine/systemWorth.ts`. Not covered by a test: the verdict-and-mark step inside `exploreSystem()` itself, which needs a live ship; the target-selection half is tested (`tests/explorerTargetIntel.test.ts`).

## 2026-10-22 — ops ledger can read a finished week, oldest rows first
The `ledger` ops tool only ever read the current week, because ledger reads are scoped by row-level security to the fleet's current `universe_key`. Two new options: `resetDate` (e.g. `2026-10-11`) reads that finished week under `<agent>@<resetDate>` over the whole week, and `oldestFirst` returns the earliest rows first, so "the first JUMP of last week" (when the gate opened) is one call. Without them the tool behaves exactly as before. `Store.opsLedger` takes `universe` and `oldestFirst`; `tests/opsLedgerWeek.test.ts` covers both paths at the tool seam.

## 2026-10-18 — Buy-side guards: the destination's live bid decides the buy, between lots too, and a route runs only so many rounds

Every below-floor approval on 2026-10-18 came from the buy side: a ship bought into a price its own earlier lots had pushed up and then met a sink that no longer paid the
plan's margin. THEOREM-5 ran MEDICINE E52 > G58 four times in six minutes, lots of 20 — asks 3409, 3626, 3894, 4223, 4628, 5126 against sink bids 4213, 4062, 4746,
4569, 4549. Rounds one and two made about +24k each; round three bought at 4628 into 4549 and ended holding 20u at a 4877 basis against a 4327 bid, an 11k loss. MEDICINE at
E52 has a measured median recovery of 124 minutes, so nothing was coming back before the next round. Both old checks judged the buy against the route's PLANNED sell price — a
snapshot up to 30 minutes old — and the cool-off did not fire because rounds one and two beat their promise.

Three guards, all shipped **off**, one clause each for the two buy-side ones:

- **Sink check** (`src/engine/buyGuard.ts`, `sinkCheck`): before the first lot, read the destination's live bid and refuse the trip if the margin, after our own expected price
  impact on both ends, is under the margin floor. A destination that cannot be read is not judged (today's behaviour). A refusal blocks the route for five minutes rather than one
  tick, so two market reads and a log line are not repeated every few seconds while the market recovers.
- **Between-lot buy stop** (`nextBuyLotDecision`): after each lot, buy the next only if the destination — after the lots already held are sold into it — still pays more than
  the next ask by the floor. The next ask follows how far the last lot actually moved the price when there is a lot to compare, not the policy percentage. A part-full hold still
  goes to the sink, which is the intended end state.
- **Round limit** (`src/engine/routeRounds.ts`, read by `Dispatcher.routeCoolOff`): no more than N trips on the same good and buy-to-sell route in any 60 minutes, whichever
  ship runs them, so a market recovers instead of being run again straight away. It works with the plain route cool-off off, and when both apply the cool-off is the reason named.

Clauses (`doctrine.ts`, both `enabled: false`, category risk): `buyGuardImpactPct` = expected price impact per lot, **6%** to start (measured impact that day was 4 to 13% a lot),
and `routeRoundsMax` = **2** trips. Both are read live, so turning either on takes effect on the next buy / within a minute. Off means today's behaviour exactly, with tests on
both halves (`tests/buyGuard.test.ts`, `tests/buyGuardSeam.test.ts`, `tests/routeRounds.test.ts`, `tests/routeRoundsSeam.test.ts`). Pinned manual routes keep their existing
negative-margin stop and skip the sink check — a manual route is the operator's explicit choice — but the between-lot stop still applies to them, since it only asks whether the
next lot clears the floor at the destination. Not built (still in `docs/TODO.md`): the shared per-market impact book and the
dispatcher skipping a cooling leg — the plan is `docs/buy-guards-plan.md`.

## 2026-10-18 — A refused lot is retried at the market's cap; a trader no longer loops on "limit of N units per transaction"

"Per hour is down, nobody is selling." THEOREM-1, the fleet's top earner (1.67M of the day's 2.7M), logged `trader error: ... SHIP_PLATING has a limit of 8 units per transaction`
every 11 seconds from at least 20:58 UTC (251 lines in the log buffer, and it was still going 70 minutes after its last sale at 20:36), holding 9u it could not sell. The market's cap
is its live trade volume, which moves with trading (SHIP_PLATING at D44 was 6, then 8, 9, and back to 8), so the 9u lot planned from an earlier read was one unit over. The feeds and
the miners already retried at the size the market names (`feed.ts`, `agent.ts sellCargoInLots`); the trader's two sell loops and its buy loop did not, so the error went up, the tick
ended, and the same lot was tried again. `transactionLimit.ts` reads the cap out of the message; the trader's sell loops (the held-leg sale and the leftover sweep) and its buy loop now
retry at that size, pin the smaller lot on the held route, and let any other error surface as before (`tests/transactionLimit.test.ts`). A refused buy bought nothing, so retrying it is
safe. Also seen while looking, not changed: THEOREM-7 held 20u ADVANCED_CIRCUITRY below its loss floor for 30+ minutes (the floor approval was denied, correctly, and a ship holding cargo
is not given a route, so it sat idle), and THEOREM-6 was on an operator hold.

## 2026-10-18 — Wind-down: keepers can find their yard, and traders are queued before the deadline

Two defects that explain why the 2026-10-18 wind-down left 215 hulls (192 keepers, all 23 traders), found by reading the code against that week's saved timeline:

- **Keepers.** `sellShip()` found a yard only from the galaxy table's SHIPYARD waypoint traits, which are known for far fewer waypoints than the yards the fleet has actually stood at and read.
  A keeper is bought at a yard in its own system and never leaves it, so it always had a yard, but most were refused "no known shipyard". `sellShip()` now falls back to the stored
  `shipyard_inventory` (same system, then one completed gate away: `storedYardFor` in `windDownScrap.ts`). All 26 ships that were scrapped were already standing at a yard waypoint.
- **Traders.** A trader only ever entered the retire queue by selling its hold empty inside the window, so a trader that never sold out (holding below its floor, in flight, cargo left) was never queued, and
  the 15-minute deadline, which exists for exactly such ships, never reached it. Traders are now queued for the whole wind-down window (the `resetWindDown` doctrine value, 120 minutes this week): a loaded one waits for its own sale or the
  deadline (`shouldRetire`), an empty one goes at once.

Tests: `tests/windDownScrap.test.ts`. Not verified live: the next reset is the test, and the wind-down record from the entry below will say whether every ship was sent and where any refusal came from.

## 2026-10-18 — The reset wind-down now keeps its own record

On 2026-10-18 the wind-down opened on time (11:00 UTC) but scrapped only 26 of 239 ships (215 hulls were left at the reset), and nothing survived to say why: its log lines are in memory and the
reset restarts the process. Now, while the window is open, `retireNonTraders` writes to `fleet_events` (which survives the reset; read with the ops timeline and `resetDate`):
`retire_dispatched` for each ship it sends to a yard, `retire_failed` once per ship with the refusal (usually "no known shipyard in <system> or one gate-hop away"), and a
`wind_down_summary` every 10 minutes (hulls left, queued, flying to a yard, sent, refused, top reasons: `windDownSummary` / `retireReasonKey` in `windDownScrap.ts`, tests in
`tests/windDownScrap.test.ts`). No behaviour change to what gets retired: the point is that next week's reset says why. Suspects, not yet shown: keepers (probes) sit in systems where
no yard is known or reachable, or they are sent but never leave their station (all 26 scraps were ships already at a yard waypoint).

## 2026-10-18 — The timeline calls a scrap a scrap

Scrapping a ship writes a SHIP ledger row with a positive total (the credits received), the same shape as a purchase, and the timeline turned every such row into
a `ship_purchased` event: the reset wind-down that scrapped 26 ships on 2026-10-18 (11:03 to 12:59 UTC) read as "bought THEOREM-3E (SCRAP) ... for 16241c" 26 times.
New scraps are now `ship_scrapped` events ("scrapped X at Y for Nc", `shipLedgerEvent` in `src/engine/shipLedgerEvent.ts`, `tests/shipLedgerEvent.test.ts`) and Admin's
Timeline has a "Scrapped" filter. Rows already written keep the old wording (their trade symbol, SCRAP, still tells them apart).

## 2026-10-18 — Deck: Insights > Weeks (the weekly record, no longer admin-only)

The record of each finished week (final cash, wallet change, matched trading net, ships, trades, and on click the roles, top ships and goods, spend and doctrine in force: the
`run_results` rows written just before each reset) was only reachable through Settings > Admin > Scoreboard, which needs the agent to be in `OPERATOR_AGENTS`. Insights now has
a **Weeks** tab (`public/shared/weeks.js`, `GET /api/run-results`): your own agent's weeks, or every agent's for an operator; the table is shared with Admin's Scoreboard
(`scoreboardHtml` in `shared/admin.js`). Separate from the Season screen, which is the plan and its reports. Rendered in a browser against a mock; not against a live server.

## 2026-10-18 — Deck: start a gate mission from the Missions panel

The Deck's Industry > Missions panel only listed running missions, with a red Stop/Remove for each, and "No construction missions." when there were none: a mission could
only be started through the MCP tool. It now ends with a "Start a gate construction mission" row: a list of the home system's known unfinished gates (new
`GET /api/missions/gates`, from the galaxy data) or a typed waypoint, and a "Start mission" button (`POST /api/missions/start`, which already existed), with a
confirm. Checked in a browser against a mock for the control and its gate list; not against a live server.

## 2026-10-18 — Judge each next lot of a sale by the market's price now

THEOREM-64 lost about 523k on one VIRAL_AGENTS trip (X1-KQ90-C16D to X1-QD90-A1): bought 80u at 31,127c, then sold in lots of 18 into a thin market,
27,294c for lot one and 20,428c for lot two, twice in 33 minutes (-192,587c on the second lot each time). The between-lot guard in
`deliverHeldCargo` and `clearLeftoverCargo` compared the price the lot just sold had fetched with the loss floor, but that is the price BEFORE the lot's own
impact; the next lot's price is the market's price after it, which a thin market drops by a quarter in one lot. The guard only ever fired after the damaging
lot had gone.

Now `nextLotBlock` reads the market's sell price between lots and `src/engine/lotGuard.ts` (pure, `tests/lotGuard.test.ts`) stops the pass when the next lot
would fetch less than the floor; if the market cannot be read it assumes the last lot's drop repeats (a quarter when there is no earlier lot). Seam test:
`tests/lotGuardSeam.test.ts` (fails on the old code). Not changed: the 15% `maxLossPct` allowance itself (lot one at 27,294c was within it, a 12% loss), and
route choice: the plan promised 41,081c at the sink and the market paid 27k at arrival.

## 2026-10-18 — A lot held below its loss floor now asks the operator, and stops hammering the market

Found while looking at the VIRAL_AGENTS loss above: `TraderOptions.requestApproval` and `floorSaleApproved()` were written so that a lot held below its floor for five
minutes raises a `sellBelowFloor:<ship>:<good>` approval (the 2026-10-06 THEO-30 incident, 50 minutes with nothing surfacing the decision), but `fleet.ts` never
passed `requestApproval`, so no trader could ever ask. THEOREM-64 held 8u at 11,975c against a cost of 31,127c for 20 minutes and nothing showed in Approvals.
`traderOptions()` now passes `(kind, o) => this.approvals.request(kind, o)` (`tests/floorApprovalWiring.test.ts`). Also: the hold line and the market read ran on every
tick (9 to 34 a minute, 152 lines in 20 minutes); now the hold is logged and the market read once a minute, sooner when the price moves 3% (`FLOOR_HOLD_RECHECK_MS`,
seam tests in `tests/lotGuardSeam.test.ts`). An approved sale still sells at whatever the market pays, by the operator's choice.

## 2026-10-17 — Route cool-off after a disappointing trip, and siphon drones as a last-resort keeper hull

Two things from "more losses in the last hour" and "no approval request in the queue".

**Losses.** The last hour was net positive (matched trading about +2.7M), but the red bar on Tower's per-interval chart was
real: THEOREM-55 ran FABRICS EC8X > FC9E four times in four minutes with ~490-unit holds. Its own buying took the buy price
1878 -> 2319 and its own selling took the sell price 2226 -> 1680; trip 3 lost 161k. The sell-volume discount in
`scoreRoute` only softens ranking, and the 15% loss floor is checked after each lot, so nothing stopped the next trip on
the same route. New pure module `src/engine/routeHeat.ts` plus doctrine clause `routeCoolOffMin` (default 30 min, on): a trip
that made under 40% of its planned profit, or lost money, rests that exact good + buy + sell route until the market has
had time to recover. The trader reports each closed trip (`recordTrip`), the dispatcher drops resting routes before ranking
and logs which and why. Switch the clause off (or 0) for the old behaviour. Tests: `tests/routeHeat.test.ts` and a seam
test in `tests/dispatcher.test.ts`.

**Missing approval.** No keeper request was ever raised for X1-HM60-FC4A: HM60's only yard stocks SHIP_BULK_FREIGHTER and
SHIP_SIPHON_DRONE, and the keeper hull list was probe / surveyor / mining drone only. A siphon drone is now the last
resort in `KEEPER_HULL_PREFERENCE` (still behind the other three), so the request appears in Approvals once `main` is deployed.

## 2026-10-17 — A crashed market price no longer exempts a lot from the loss floor (2.55M lost on VIRAL_AGENTS)

Reported as the last hour's growth reading about -400,000 on THEOREM. The hour's matched trading was +85k against ~477k of
jumps and fuel, and one ship explains the rest of the bleed: THEOREM-BC bought 108u VIRAL_AGENTS at ~35,000c (3.83M),
sold 36u at QD90-A1 for 28-33k, held the other 72u for an hour, then sold them in four 18u lots at **1c each**
(realized -638,625 per lot, -2.55M together). Cause, `trader.ts`: the "dust lot" exemption (units x live price <= 2,000c,
meant for 3u of FUEL) was judged on the market's *current* price, so a market that crashed to 1c made 72 units worth 72c,
"dust", and both the pre-sale floor check and the redirect-to-a-better-market step were skipped. The mid-sale guard did
stop each tick after one lot, but the next tick passed the dust test again. `isDustLot()` now uses the larger of the live
price and the cost basis, so a lot is dust only if it was cheap to begin with. Regression test in `tests/trader.test.ts`
(fails on the old code). Still open: why A1's VIRAL_AGENTS price fell to 1c, and that the 72 units were held an hour
before the dump (see docs/TODO.md).

## 2026-10-17 — Keeper requests say why they were not raised, and a failed yard read no longer blocks the retry

Reported on THEOREM: a tour ship reached the only shipyard in HM60 and no keeper request appeared, and two keeper markets
the operator queued there never turned into requests. The keeper checks returned silently in every case, so the cause
could not be read from the logs. Two changes:

- **Why-not lines.** The checks now log (`keeper: ...`, at most once per key per 30 minutes) when no request is raised
  and why: the yard has no keeper hull in stock (with its stock listed), the stored yard rows for the system hold none,
  the hull is too expensive, every candidate market is already covered, the galaxy cache lists no SHIPYARD trait at the
  waypoint (the read is skipped), or the queue is waiting on one open request. That last case is the likely reason a
  queue never fires: only one request of a kind is open at a time, and an approved purchase has to be made by a ship docked
  at its yard, so an approved request for a yard no ship returns to holds every other market behind it. The line names
  that request and says what it needs.
- **A failed yard read retries.** `recordShipyardSnapshot()` set its 30-minute clock before the read and swallowed any
  error, so one failed read (and the keeper check that follows it) was skipped for half an hour with no trace. A failed
  read now clears the clock and is logged; an error in the keeper check after a good read is logged and keeps the clock.

Not changed: which hulls count (probe, surveyor, mining drone, in that order; an ore hound is deliberately not one).
The root cause of the HM60 case is not established; the new lines should name it the next time it happens.

## 2026-10-16 — A construction mission can be removed, not only paused

A gate mission started by accident (the operator was only checking a gate) stayed on the board for good: the UI could pause
it but nothing could delete it, so X1-FY6-I54 sat at 0 of 1,600 FAB_MATS as clutter. Added `MissionManager.remove()`
(releases the crew exactly as `pause()` does, drops the mission's in-memory state including its pacing timers, then deletes
the stored row with `Store.deleteMission()`, tenant-scoped), `FleetManager.removeMission()`, `POST /api/missions/remove`,
the MCP tool `stcommand_remove_mission`, and a **Remove** button (with a confirm) on the mission cards in Deck and Tower.
The game's own construction site keeps whatever was delivered, so starting the mission again later resumes from its real
progress, and removing a mission that does not exist changes nothing and says so. The older v2-v6 pages were not given the button.
Tests: `tests/mission.test.ts` ("MissionManager.remove", including a persistence test that another tenant's mission at the
same waypoint is untouched and that a restart does not bring it back). One test in that file, "falls back to a different
outstanding material...", already failed before this change and still does.

## 2026-10-16 — A contract delivery in another system is flown, not skipped as "out of range"

`THEOREM-AE` held 80 MACHINERY at X1-CM13-E46 for a contract at X1-KQ90-EA5E and logged "contract delivery ... is out of
range even via known fuel stops; skipping for now" every 30 seconds, so the cargo sat. The delivery branch in
`TraderAgent.tick()` compared the ship's waypoint coordinates with the destination's against the fuel capacity, but a
waypoint's x/y are local to its own system, so across systems that distance means nothing and always failed. A delivery
in another system now goes straight to `navigateTo()`, which already walks the gate path one hop per tick; the in-system
range guard (and its multi-hop fuel stops) applies once the ship is in the destination's system. Topping the tank up by
hand did not help, which is how the cause was found. Test: `tests/trader.test.ts` (fails without the change).

## 2026-10-16 — The Routes board lists the multi-hop routes the fleet actually flies

Reported: on Tower's Routes tab none of the listed routes was being flown, and only 7 were cross-system. The board kept a
cross-system route only when the two systems were one jump apart (`galaxy.canJump`), while the dispatcher assigns
multi-hop routes (a chain of open gates, within the positioning limit) whenever `autoCrossSystemRoutes` is on. So every
route two or three gates away, which is most of what traders were flying (HR84 to KQ90 FABRICS at about 168k a trip, for
one), was hidden, and what was left was mostly same-system routes the dispatcher had already decided against. The board now
uses `FleetManager.canFlyBetween()`: one open jump (both ends built), or with cross-system routes on a path of open jumps,
which is the test the dispatcher is handed. Checked against the dispatcher's own list that day: its top 30 routes were all
unclaimed because every trader was already committed to a trip, which the board now explains per route ("every trader is
occupied").

## 2026-10-16 — Tower no longer rebuilds its buttons under your finger

Reported as Tower feeling slightly slower and the approvals "hanging" after a tap. The server was fine (event-loop delay
about 11 ms, CPU about 16%, memory steady) and nothing in the browser grows (activity is capped at 100, ship rows are
replaced in place). The cause was churn: the live feed pushes ship rows, credits and activity several times a second, and
every push re-rendered Home, replacing the Approve and Deny buttons, so a tap could land on a node that had just been
swapped out, and a decision in flight came back as fresh enabled buttons. Also, a catch-up after the phone woke applied up
to 1,000 events back to back, re-rendering on each. Measured on a simulated minute of live traffic: 150 replacements of
the Approve button and about 190 ms of work, now none and about 3 ms.

- **State and activity updates are coalesced** to one notification per 500 ms (`public/shared/store.js`); approvals,
  doctrine and the rest are still delivered at once. Deck benefits too.
- **An unchanged render is skipped** (`setHtml` in `public/shared/domain.js`) for Home's tiles, triage and activity, the
  approvals lists, the roster, and the tab bars, so buttons and scroll position are left alone.
- **A decision in flight stays disabled** through any re-render until the server answers, then the list refreshes, so a
  second tap can't send it twice.

## 2026-10-16 — Contracts move to Trade; the rest of that tab is Missions

Contracts are now a tab under Trade (second, after Routes) in Deck and Tower, since they are paid hauling work, and
Industry's old "Contracts & missions" tab is now just Missions (Tower's "Construction" heading is renamed to match).
Deck's contracts and missions panels are separate full-width tabs; Tower's contracts list and mission list are separate
sections. A group whose remembered last tab no longer exists opens its first tab. Layout in
docs/deck-desktop-design.md §16 and docs/mobile-app-design.md.

## 2026-10-16 — Keepers stop reading shipyards at waypoints that have none

Keepers call `recordShipyardSnapshot()` for every market they poll, not only the ones with a shipyard, and a read of a
waypoint with no yard is a call that fails. After the 30-minute spacing went in, the limiter still showed 66 of them in
the five minutes after a restart (nothing is stored for a non-yard, so nothing to seed the clock from) and 25 to 48 per
five minutes before that. A yard is now read only at a waypoint that carries the SHIPYARD trait (from the loaded galaxy,
else the registry); one whose traits aren't known yet is skipped and tried again on the next visit. Found while checking the market-snapshot reuse: market reads
that window were 117 per five minutes (127 to 165 before), but it included the boot, so a clean window is still to come.

## 2026-10-16 — Tower navigation regrouped to match Deck

Tower's bottom bar (Home · Fleet · Metrics · Markets · Approvals · More) is now five items: Overview, Fleet, Trade,
Industry, More, with the group's screens as tabs in a scrollable bar under the top bar. Overview holds Home and
Approvals (the pending count shows on the Overview item and the tab); Fleet holds Ships, Mining, Yards and Scrap; Trade
holds Routes, Prices, Keepers and By system; Industry holds Supply chain, Contracts and Feeds; More holds Metrics, Season,
Doctrine, Keys and Admin. Routes gets the same All / Local / Cross-system filter as Deck. Nothing was rewritten: More's
panes were split into wrapped sections and each tab shows its own. Hint lines that sat outside a card, with no style,
are now styled. Map, Local placement and Dispatch aren't in Tower. Layout in docs/mobile-app-design.md.

## 2026-10-16 — Deck navigation regrouped into seven

Deck's rail had thirteen items. It now has seven, each one question, with the screens as tabs under the top bar:
Overview; Fleet (Ships, Mining, Miner preference, Yards); Trade (Routes, Prices, Keepers, Markets by system, Local
placement, Dispatch); Industry (Supply chain, Contracts & missions, Feeds); Map; Insights (Metrics, Season, Notes);
Settings (Doctrine, Automation, Admin, Guide). Ops is gone: its parts moved to Industry, Insights and Settings. Each group
remembers its last tab, and the command palette lists every tab. Routes also gains an All / Local / Cross-system filter,
local meaning both markets in one system (what a local-only ship can fly). Layout and mapping in
docs/deck-desktop-design.md §16. Tower is unchanged for now.

## 2026-10-16 — Miners stop offering goods a market doesn't trade; market snapshots reused while fresh

- **Miner sales.** A miner sold its whole hold item by item at the market it picked, including goods that market
  doesn't trade, and each refusal ("Trade good ICE_WATER is not listed at market X1-CM13-H57") cost an API call:
  THEOREM-7, -8 and -2A did it on every trip. `sellAllCargo()` now skips goods missing from the market's snapshot; they
  stay aboard for a market that buys them, or are dumped once nothing in range does. With no snapshot, every good is
  tried as before.
- **Market snapshots.** Once the ship book freed budget, tour ships and keepers spent it re-reading markets (112 per five
  minutes from `ShipAgent.recordMarket`), and a dock followed by an explicit record read the same market twice within
  seconds. `recordMarketSnapshot()` now reuses a snapshot younger than the market's keeper cadence (5 minutes for one
  whose prices moved recently, up to 30 for one that has sat still; 20% slack so keepers aren't skipped). Traders only
  reuse one from the last minute, since they price their buys from it. Doctrine `marketSnapshotReuse` (on) turns it
  off. Measured earlier (2026-10-08): markets tick about every 30 minutes, a price that moves does so about every 27
  minutes, and only 12% of snapshots taken 5 minutes apart differed.

## 2026-10-16 — Systems tab says what it is for, and scrolls

The Systems tab in Deck is for placing a local-only trader (reach "system"), and it now says so: the title reads
"Systems · local trader placement", a line under it explains the score (same-system routes, gate hops from our ships, a
yard selling a trading hull) and why systems we already trade in stay listed (a local trader can work alongside the
cross-system fleet there), and those systems carry a "we're here" tag. The tab had no scroll and no row styles in Deck;
it now scrolls like Metrics and its rows are laid out.

## 2026-10-15 — Ship book (shadow) and keeper cadence that survives a deploy

The rest of step 4 of the scaling plan, prepared so it can be switched on once it has proved itself:

- **Ship book** (`src/engine/shipBook.ts`). Every ship step starts with `GET /my/ships/:id`, about 15 calls a minute.
  The game only changes a ship when we act on it, and each action's answer carries what it changed, so the book keeps
  each ship's last full read and folds every action response into it (`nav`, `fuel`, `cargo`, `cooldown`). A ship is
  marked unknown while an action is in flight, after one that fails or isn't on the known list (mount installs, scrap,
  repair), and when it is a transfer's receiving ship. Transit arrival and cooldown expiry are applied from their stored
  times. Contract delivery and construction supply, which name the ship in the body, are folded in too.
  It runs in **shadow** from this deploy: each real read is compared with what the book would have served, and every
  five minutes the log carries `ship book (shadow): N reads · M could have been served, K matched (x%) · mismatches …`.
  The `shipBook` doctrine clause (off) lets it serve; its value is the age limit (300 s), so every ship is still read for
  real at least that often.
- **Keeper cadence after a restart.** The cadence (5 to 30 minutes by how long a market has sat still) lived only in
  memory, so after each deploy every keeper polled at the 5-minute floor for up to 90 minutes. It now starts from the
  last three hours of `market_snapshots`: each market's latest signature and when its prices last moved. Market
  signatures no longer depend on the order the goods are listed in.

## 2026-10-15 — About a quarter of the API budget handed back to the ships

At 183 ships the 90-calls-a-minute budget was pegged. The limiter's own five-minute breakdown showed four spenders that
bought little:

- **The ship-list sweep** (12 a minute). It only measured whether one `GET /my/ships` sweep could stand in for the
  single-ship reads. It could (every copy that applied matched), but at 183 ships a sweep is 10 calls and would have
  replaced only 6-26 of about 80 reads per five minutes. It is now off; `SHIP_SWEEP_MS` turns it back on.
- **Shipyard snapshots on dock** (4-8 a minute). Keepers parked at yards re-read them every 5 minutes; now every 30.
  `buyShip()` still reads the yard live before it buys.
- **The buy pass's live yard scans** (4-6 a minute). A yard lists its stock only while one of our ships is there, so
  scanning any other yard returned nothing. It now scans only yards where a ship of ours sits, and ranks on the cached
  credit balance instead of a fresh `GET /my/agent`.
- **Unfinished gate rechecks** (5-6 a minute). An unfinished gate is re-read every 20 minutes instead of every 5.
- **Yard reads after a deploy.** The 30-minute yard clock was in memory, so the first five minutes after a restart
  re-read 57 yards. It now starts from the stored inventory's timestamp.

Expected total: 25-30 calls a minute moved from overhead to ship turns. The limiter's `top callers` log line shows it.

## 2026-10-15 — Live feed: attention, programme and keepers pushed too

The last of the 15-second polls moved to the live feed (`GET /api/live`), built from shared views in
`src/engine/liveViews.ts` so the push and the HTTP routes (`/attention`, `/contracts`, `/keeper/markets`) can't disagree:

- **Attention** (`attention` event): Tower's attention list, checked every 2 s and sent only when it changes (its `asOf`
  stamp is left out of the comparison).
- **Programme** (`programme` event): contracts, missions, feeds, feed chains and chain health, checked every 14 s, one
  check at a time per tenant. A part that fails to build is sent as null and the screen keeps what it had.
- **Keepers** (`keepers` event): the keeper list, checked every 14 s.

All three are in the connect snapshot. While the feed is connected, Deck and Tower read them in full only once a minute
as a safety net; before, each screen fetched them every 15 s, and `loadProgramme` rebuilt the dispatch view each time.

## 2026-10-15 — A system reached by warp is charted

THEOREM-86 warped into X1-GX41 and toured its 26 markets, but GX41 never appeared in Tower's Markets list, best price,
shipyard inventory or the dispatcher's routes. Those views only show systems the tenant has charted. A gate jump marks
its destination charted; a warp didn't, and the every-tick catch-all (`chartOccupiedSystems`) skipped GX41 because the
warp had already loaded it into the atlas (to pick an arrival waypoint) and it treated "loaded" as "charted". Now a
successful warp charts its target, and the catch-all charts any occupied system missing from the charted set. GX41
heals on the first tick after deploy; the price snapshots 86 took are already stored and appear then.

## 2026-10-15 — Live feed: fleet status, dispatch assignments and approvals pushed too

Three more slices moved from the 15-second poll to the live feed (`GET /api/live`):

- **Fleet status** (`fleet` event): each ship's status and "doing" line, as per-ship diffs, plus stranded ships and the
  paused flag when they change. A cooldown's seconds are compared in 15-second steps, so a cooling ship isn't resent on
  every pass.
- **Dispatch** (`dispatch` event): the assignments, contract-duty ships and miner preferences, when they change. The route
  list behind them was rebuilt on every `/api/dispatch` request (every 15 s per screen); now the screen refetches it only
  when the assignments change, at most once a minute.
- **Approvals** (`approvals` event): the server checks open and decided approvals every 6 s while a screen is connected
  (one check per tenant, however many screens are open), and pushes them when they change, so a new approval shows within
  seconds. The view is shared with `GET /api/approvals` (`src/engine/approvalsView.ts`).
- The snapshot a screen gets on connect now carries all six slices. While the stream is up, Deck and Tower re-read the
  bridge, approvals and dispatch once a minute as a safety net. The bridge's hourly aggregates (rate, earnings, triage)
  now refresh once a minute instead of every 15 s.
- `src/engine/liveDiff.ts` is the keyed diff the fleet slice uses.

## 2026-10-15 — A held lot below its floor looks for a market within the jump limit, not just one gate away

THEOREM-D bought 80 DRUGS at X1-KQ90-C27B for 4,355 each (348,400) at 12:22, to sell at X1-HR84-H56. Another agent,
SPECTER, then sold 890 DRUGS there in twelve hours (about 490 in one go at 20:15, walking the price from 4,390 to 1,734),
and D held below its loss floor for nine hours. Deck showed the hold at about -173k. X1-CM13-H57 paid 4,701, above cost,
but it is two gates from HR84 and the below-floor redirect only considered markets one gate away.

- The below-floor redirect, and the unreachable-market redirect added earlier today, now consider any market reachable
  within the positioning-jump limit (`positioningPath`), not only a directly connected system.
- Live action: D was given a manual route to sell its DRUGS at X1-CM13-H57, cleared once the hold is empty.

## 2026-10-15 — No trade legs into a system whose gate is unbuilt; stuck cargo is redirected

After X1-GX41 started being charted (earlier today, the warp-charting fix), the dispatcher gave THEOREM-65 (80 FIREARMS,
about 232k) and THEOREM-25 (80 ALUMINUM) routes that sold in GX41. GX41's gate is still under construction, so neither
could jump in: each sat at its own gate logging "no verified gate path … to X1-GX41" every 30 seconds. Profit per hour
fell to about 614k (after fuel and jumps) over the hour these two were stuck.

- **Cause:** the dispatcher's jump check (`GalaxyAtlas.canJump`) only looks at the gate on our side. GX41 was invisible to
  route planning until it was charted, so the gap never showed before.
- **Fix:** a new `canJumpInto()` also refuses when every gate in the destination is known to be unfinished. A gate whose
  status isn't known yet doesn't block, so routes that worked before still do. The dispatcher's jump check, its path
  shortcut, and the cross-system trip cost and hop count now use it. Explorers keep the near-side check on purpose.
- **Stuck cargo:** when a trader can't reach the market its held cargo was bought for, it now redirects the lot to the
  best reachable market: first one that clears the loss floor, else the best price reachable. Before, it retried the
  same jump forever. A sale below the floor still goes through the usual hold-or-approve rule.
- **Trader too (follow-up):** the trader had its own one-sided check, so THEOREM-25 still tried the jump into GX41 once
  (the game refused: "Destination jump gate X1-GX41-I60 is under construction"). That check also decides which markets
  a redirect may pick. The trader now uses `canJumpInto()` as well, for its jump, its one-hop path and its reachability.
  Live after the fix: THEOREM-65 redirected 80 FIREARMS to X1-HR84-J63 at 3,605c (bought at 2,900c); THEOREM-25
  redirected 80 ALUMINUM back to X1-GJ35-AF1Z at 72c (bought at 141c, about 5.5k lost, so subject to the floor rule).

## 2026-10-15 — Live feed: ships, credits and activity pushed to the screens

Screens pulled the whole state every 15 seconds. Now the server pushes small changes as they happen, over server-sent
events (`GET /api/live`), and Deck and Tower apply them to the same shared store.

- **What's pushed:** ship rows (position, fuel, cargo, cooldown) for the ships that changed, credits, and each new
  activity entry. Ship changes come from comparing the engine's own in-memory ships every two seconds, only while a
  screen is connected. No game API calls.
- **Catch-up:** every event has a number and stays in a buffer of the last 1,000. A screen that reconnects (the browser
  resends the last number on its own) gets only the events it missed; if they've left the buffer, it gets a fresh
  snapshot. Tower on iPhone reopens the connection when it comes back from the background.
- **Polling:** while the stream is connected, Deck and Tower re-read the full state and the activity list every fourth
  tick (once a minute) as a safety net, instead of every 15 s. Everything else still polls as before. Older UI versions
  are unchanged.
- **Trimmed rows (follow-up):** a ship row now carries only what the screens read: route ends as symbol and x/y (the map
  draws a ship between them), departure and arrival, fuel current and capacity, cargo items as symbol and units, and the
  cooldown without its ship symbol. THEOREM-7's row in the live stream went from about 1.6 KB to 630 bytes. The browser
  keeps each cargo item's name and description from the ship it already has.
- **Code:** `src/engine/liveFeed.ts` (hub and buffer), `src/engine/shipRows.ts` (row and diff),
  `src/http/live.ts` (the endpoint), `public/shared/live.js` (the browser side), and new apply functions in
  `public/shared/store.js`.

## 2026-10-15 — Screens: a lean state poll, the galaxy on its own version, and gzip

Measured on the live server at 183 ships: `get_state` was 6.5 MB and took 12 s, and about 2.8 MB of it was the galaxy's
system list. Every open Deck or Tower polled the full snapshot every 15 seconds, along with eight other endpoints, and
nothing was compressed. The CPU was mostly idle (busy about 19%), so the screens were slow because of payload size, not
computation.

- **Lean state.** `GET /api/state?lean=1` leaves out `systems` and `jumpConnections` and sends `galaxyVersion` instead.
  The shared loader (`public/shared/store.js`) fetches `GET /api/galaxy` only when that version changes, and puts the
  galaxy back into the same `state` shape, so screens didn't change. Without `lean=1` the full snapshot is sent, so the
  older UI versions keep working.
- **The galaxy changes during the week, so it's versioned, not cached once.** `galaxyVersion`
  (`src/engine/galaxyVersion.ts`) hashes what the screens draw: systems, waypoints and their traits, and each jump
  connection with whether its gate is finished. A gate finishing, a newly discovered system or a charted waypoint all
  change it. `GET /api/galaxy` sends the version as its ETag and answers 304 when the screen already has it.
- **gzip.** JSON responses under `/api` are gzipped when the browser accepts it (`src/http/gzipJson.ts`, Node's own zlib,
  no new dependency). Bodies under 1 KB are left alone. Compression runs asynchronously.

## 2026-10-15 — Systems tab: candidate systems to move a ship into (advisory)

A new Systems tab in Deck lists the systems worth moving a ship into next, with the reasons for each. It's advisory:
nothing is moved or bought.

- **Criteria** (defaults in `src/engine/systems/candidates.ts`, overridable per request): within 2 gate hops of our ships;
  every gate finished; at least one profitable same-system route; a yard that sells a trading hull is a plus and can be
  required.
- **Unknown is not no:** a system nobody has surveyed is listed under "To survey", since its markets and yards are unknown
  until a ship visits. It's never ranked as a candidate.
- **Each verdict** carries one line per decision. Candidates are ranked by score; exclusions say which rule removed them.
- **Where it reads from:** the galaxy graph, gate status, shipyard listings and the dispatcher's current routes.
- Also available as the ops tool `systems_candidates` (HTTP `/api/ops/systems_candidates`, MCP `stcommand_ops_systems_candidates`).

## 2026-10-15 — Local-only ships (reach "system")

A ship can now be set to local-only (`stcommand_set_ship_reach`, reach "system"). It only takes routes whose buy and
sell markets are both in the system it sits in, so it never flies a gate or pays positioning. Default is "any", so
nothing changes until a ship is set. Behaviour:

- The dispatcher hands cross-system routes out first, then gives local-only ships what is still unclaimed. A local
  assignment never takes a cross-system route away, and local ships are never ranked against cross-system routes.
- The trader refuses a local-only leg in its own route planning too, so a hand-assigned cross-system route is rejected.
- The analysis report splits trips, profit per hour and overhead between local-only and cross-system ships
  (`byReach`), so the two fleets can be compared.
- Each change is logged as a config change (`reach:<ship>`) for the before/after analysis.

Local routes on the board right now: 30 of the 60 (TS44 8, RM59 6, CH68 5, JT85 4, KQ90 2, HR84 2, others 1 each).
Buying local-only ships at each system's own shipyard is a separate step, not in this change; so is any UI for it.

## 2026-10-15 — Two profit-per-hour rates, each with its window

The Metrics page and the season showed different "per hour" figures for the same week, because each used a different
window and start. Both are now shown, each labelled:

- **Since reset:** trips closed since the universe started, less each trip's own refuel, jump and positioning costs,
  per hour of universe time.
- **This season week:** the same definition, counted from when the open week opened. Season profit-per-hour goals are
  scored on this one.

Metrics' own "Per hour" is renamed "Per hour (sales)": it counts sales, not trips, so it still differs. The season's
profit-per-hour tile also shows the since-reset rate. Shared logic is in `src/ops/pace.ts`, and both routes use it.

## 2026-10-15 — Growth rate: a metric, a season goal, and a tile on Metrics

Growth is now measured as the fleet's net worth grows per week, in percent. Net worth is credits, plus holds, plus the
hull capital we've put into ships (purchases, less scrap proceeds). Buying a hull moves cash into capital, so it
doesn't read as a loss; scrapping takes its proceeds back out, so it isn't growth either. The rate is measured over the
span of the wealth samples in the window (first to last), scaled to a week, and needs at least six hours of samples. A
shorter span scaled up exaggerates every swing: a few hours after a season opens read 88% a day, which is why it's weekly.

- `src/engine/growth.ts` (pure): `hullCapitalAt`, `netWorthSeries`, `growthPerWeek`. Tested in `tests/growth.test.ts`.
- Metrics (`GET /api/metrics`): a `growth` block for the window, and `netWorth` per interval. The Metrics screen shows a
  Growth tile with the start and end net worth.
- Analysis report: `summary.growthPerWeek`, so the Season screen's Insights shows it too.
- Season: a new goal measure, "Growth (cash + holds + hulls, per week)", in %/week, higher is better, so a goal such as
  "at least 10%/week" can be set on the Plan tab. Wealth samples before a week opens are not used.

## 2026-10-15 — A change to one ship is judged on that ship's trips

The analysis engine reported "After lot_policy:THEOREM-55 changed (null -> {"maxLots":3}), profit per hour went down
16% (616 trips before, 613 after)". Those were the whole fleet's trips: the comparison mostly measured what the other
18 traders did in those hours, and its "high" confidence came from their trip count. A settings change that applies to
one ship (the event's ship, or the ship in a `lot_policy:<ship>` setting) now compares only that ship's trips, refuels
and jumps, says whose profit per hour it is, and when it fell suggests clearing or restoring that ship's lot policy
(`stcommand_set_ship_lot_policy`). Doctrine and keeper-list changes are still measured on the fleet.

Measured by hand for the record: THEOREM-55 with maxLots 3 (04:04-11:05 UTC) earned 252c a unit against 210c before,
but moved 35% fewer units an hour, so its realized profit fell from 541k/h to 423k/h (500k/h over the last 4.6h).
The cap bit on mid-depth markets (300-unit trips instead of full 480s) and not on the thin ones it was meant for, which
fill a 490 hold in two lots. The cap was cleared at 11:10 UTC.

## 2026-10-15 — Season screen: the multi-week plan and the analysis reports in the UI

The season plan from `docs/multi-week-plan.md` now exists in the app, with the analysis engine beside it. New tables `seasons` and `season_weeks` (migration 054, kept across resets) hold a season, each week's phase, goals and notes, and at the end of a week its record. The rules are pure (`src/engine/season.ts`): a week that ends in Cross-system starts the next at Recover; goals can be measured (profit per hour, net trip profit, overhead share, positioning costs, trips, estimate accuracy; an absolute target or a percent change against last week) or tracked by hand; a missed goal, or a hand-tracked one still open, carries forward. Closing a week saves its analysis report, scores the goals and opens the next week from the record. API under `/api/season` and `POST /api/analysis/capture`; season and goal changes are recorded as `config_change` action events. Deck gets a Season rail item with four tabs: This week, Insights (the full analysis report), Weeks (season history and saved reports) and Plan. Tower's More screen gets a read-only Season card. The analysis report is cached for a minute per window, so repeated page loads don't rebuild it. Also: "Best routes" no longer lists losing routes, overhead is reported to a tenth of a percent, and market impact medians no longer print float noise.

## 2026-10-15 — Action tracking and the analysis engine

The fleet recorded every trade, but not what the bot expected when it chose a route, nor settings changes with their before and after values, so "what worked and why" couldn't be answered. A new `action_events` table (migration 053, kept across resets) now records `trip_planned` (the route's profit estimate, prices, units, lot size and market trade volumes) and `trip_closed` (what the trip made and how long it took) from every trader, sharing a correlation id, plus a `config_change` for every doctrine edit, per-ship lot policy and keeper-list change. A new analysis engine (`src/engine/analysis/`, pure, with tests) joins that with the ledger, market snapshots and other players' trades: it rebuilds every trip with its own costs and the positioning jumps before it, ranks routes by real profit, measures how far our own fills move each market against the model's 4.5% a lot and how long it takes to recover, says who caused each big price move (us, another agent, or nobody seen), compares profit per hour before and after each settings change (labelled as a correlation), and computes calibration factors (realized over estimated profit per route and good, shrunk toward the fleet's), the first step to prediction. Findings carry suggested actions with the exact tool and arguments; nothing is applied. Read it with `stcommand_ops_analysis`; save a week's report with `stcommand_capture_findings` (`analysis_findings`, kept across resets) and read past ones with `stcommand_ops_findings_history`. Design: `docs/analysis-engine.md`.

## 2026-10-15 — Warp fuel is worked out per flight mode, and learned from the game

Every warp THEOREM-86 tried toward X1-FY6 failed for fuel, though the estimate said it fitted. The ship was in BURN, which its own in-system legs leave it in when the tank is full, and BURN doubles warp fuel: two different distances (about 435 and 581 units) cost 868 and 1,160 fuel, exactly 2x. The warp decision (`src/engine/warpTour.ts`) now picks the mode itself: BURN only when it fits with a quarter tank left over, otherwise CRUISE, and the tour and trader set that mode before warping. The fuel margin on an estimate drops from 1.2 to 1.05, since a rejected warp spends no fuel. When the game rejects a warp with "requires N more fuel", or a warp completes, the real CRUISE need is remembered for that pair of systems and used instead of the estimate, so a warp the tank can never make is not retried every tick. The learned needs are kept in memory and relearned after a restart with one rejected call.

## 2026-10-15 — Tour ships with a trip under way get a faster tick

A tour hop (a warp or a gate leg toward a dispatched system) waited behind the whole fleet for the shared API budget, so one hop could take about 15 minutes of queue time. While a tour has a destination or is in flight, its next tick now runs at trade priority instead of survey priority, and a ship in transit wakes at its arrival time instead of polling before it. The pure rules are in `src/engine/tourPriority.ts`. The `tourHopPriority` doctrine clause turns both on or off, and it's on by default. The cost is a few calls per hop, taken from trader and miner tasks only when the budget is full.

## 2026-10-15 — A manual or fleet-driven jump refreshes the ship's cached position

The dashboard's fleet table reads each ship's cached snapshot, and a jump didn't update it. THEOREM-86 was jumped to X1-KK70-XB7D and held there, but the table kept showing X1-HR84-I60 while the ship's popup showed the right system. After any jump through `jumpShip()`, the fleet now re-reads that ship once and pushes it into its cache. A failed re-read is logged and the jump still counts as done.

## 2026-10-14 — Per-ship lot size and lot count cap, with an MCP tool

The only trade-size limit was the fleet-wide `maxLotsPerTrip` doctrine rule, so pacing one hull (a thin market, a long positioning leg) meant changing every ship. A new pure module (`src/engine/shipLotPolicy.ts`) holds two optional per-ship fields: `lotSize` caps units per buy call, and `maxLots` replaces the fleet lot count for that ship. A trip's volume is now min(hold, wallet, lotSize × maxLots), so a smaller lotSize shrinks the whole trip. Overrides persist in the `shipLotPolicies` fleet flag and reload at boot. The new `stcommand_set_ship_lot_policy` tool sets, clears or lists them, so automation can use the same knob. Limits: lotSize 1 to 1000, maxLots 1 to 12, and 0 clears a field. Only trader route planning and buying read the overrides; the dispatcher's route ranking still uses fleet defaults.

## 2026-10-14 — Metrics: a 30-minute live window that refreshes every 15 seconds

The metrics page refreshed every 60 seconds, and its shortest window was one hour. A new 30m window shows the last half hour in two-minute buckets, and refreshes every 15 seconds while it's selected. The other windows still refresh every minute.

## 2026-10-14 — Suspended repair reads the ship from the server before deciding

After the dock-first fix, THEOREM-9 was docked at X1-CM13-A2 but the planner kept logging "docking": a suspended agent's cached copy still said in orbit, and the planner trusted it. The same stale copy is the likely cause of the repair display problem seen earlier. Suspended, damaged ships are now re-read from the server each pass before the planner decides. This costs one ship read per suspended damaged ship per pass.

## 2026-10-14 — Suspended repair docks a ship that has reached its yard in orbit

The first live run flew THEOREM-9 to X1-CM13-A2 correctly, but the planner then saw a ship in orbit at a yard as "not at a yard" and sent it there again every pass. Ships in orbit at a shipyard are now docked first, then repaired on the next pass.

## 2026-10-14 — Suspended miners with a damaged hull are flown to a yard and repaired by the engine; Deck shows condition

A repair was handed to a ship's own agent, and a suspended agent never runs it, so THEOREM-7/-8/-9 sat at condition 0.17 to 0.20 for hours. A new planner (`src/engine/suspendedRepair.ts`, pure, with tests) decides, for each suspended ship below the repair floor, whether to repair it where it docks, fly it to the nearest yard in its system, or wait. FleetManager runs it each maintenance tick, skips operator-held ships, and releases the hull after a successful repair. The floor comes from the doctrine's repair floor. Deck's ship list now shows each ship's condition beside fuel, in red below half.

## 2026-10-14 — Repairs no longer show on the timeline as ship purchases

A repair is written to the ledger as a SHIP row with a negative total, the same type a purchase uses, and the store logged every SHIP row as a purchase. The timeline showed repairs as "bought ... for -12718c". Only positive SHIP rows are now logged as purchases. This fixes the label only; the repair itself was already recorded correctly. Also corrects a test edit from earlier that had commented out a field.

## 2026-10-14 — Dispatcher charges a trader's gate jumps to reach the buy market in full

The dispatcher ranked a cross-system route after charging only a third of the jumps a ship needed to reach its buy market, and a single gate jump was not charged at all. A trader's own positioning jumps are now subtracted in full when it is ranked for a route, and a trip the jumps would make unprofitable is not assigned. The route's shown profitPerTrip does not change, so the dashboard still shows one figure per route. Only the ship-specific ranking does. The sell-side exit is not charged, since the next trip pays its own positioning from wherever the ship ends.

## 2026-10-14 — Deck's ship sheet gets the "Send to nearest shipyard" button

The send-to-nearest-shipyard control shipped on Tower and the older desktop ship card, but not on Deck, which has its own ship sheet. It now sits beside "Send to waypoint" on Deck too.

## 2026-10-14 — Deck metrics: the four charts finally sit on one line

The real cause of the two-across layout: the metrics screen built two separate chart rows, each its own grid holding two charts, so each pair filled only half the width. Both rows now sit in one container, and Deck lays the four charts out as a single row (two across only below 800px). Tower's layout is unchanged.

## 2026-10-14 — Deck metrics: chart row pinned to full width

The four metrics charts on Deck were still wrapping to two across on a wide window, with the row only half the page wide. The chart row now takes the full width of the metrics screen, so the four charts sit on one line.

## 2026-10-14 — Deck metrics: four charts on one row, foldable panels like Tower

The four metrics charts sit on one row on Deck and stay four across down to 800px wide (they were two across under 1100px). Deck's metrics panels now fold like Tower's: tap a panel header to open or close it, remembered per browser. The table styling from the previous change is unchanged.

## 2026-10-14 — "Send to nearest shipyard" on the ship card, and Deck's metrics tables match Tower's

The ship detail card in Tower (the fleet sheet) and on the desktop (the ship detail modal) has a new "Send to nearest shipyard" control. It picks the closest known shipyard in the ship's own system, measured from where the ship is or is heading, and sends it there with the same hold as "Send to waypoint" (it stays until released). Same-system only, like that control; a system with no known yard gets a plain error. The choice is a pure helper (`src/engine/shipyardNearest.ts`) with its own tests. Deck's metrics tables also had no base table styling, so they fell back to browser defaults; they now use Tower's table rules.

## 2026-10-14 — Tour ships hold only on a live keeper decision; decided rows show on the approvals page

A tour ship held at a yard for any unconsumed keeper-probe row there, including a denied one nothing had yet picked up. The hold now applies only to a pending request, or to an approved purchase that has not been bought yet (the row is consumed once the engine acts on it). A denial holds nothing. Approved or denied rows the engine has not picked up yet now appear under "Decided, waiting for the engine" on Tower's approvals page, so they are no longer invisible. The repeated "denied by operator" lines are gone: the engine logs a fresh denial once, and a cooldown once per denial.

## 2026-10-14 — Warp and gate-jump history, with an ops tool to read it

Every warp and gate jump is now written to a durable `ship_movements` table (migrations/052), with the ship, distance, tank before and after, credit cost, and the engine path that made it. The log buffer and activity feed forget on restart, and warps were not in the ledger, so there was no way to answer "how much warping versus gates" after a restart. The new ops tool `stcommand_ops_movements` reads it, filtered by ship and kind over a window, with a summary of counts, warp fuel per unit and gate costs. Moves made before this change are not in the table. The rows are kept across the weekly reset, like the ledger.

## 2026-10-14 — Tour ships stop waiting on a keeper approval after 15 minutes

A tour ship held at a shipyard for any open keeper-probe approval there. An approval that was decided but never bought (the purchase needs a ship docked at the yard to complete) kept the tour ship parked with no end: THEOREM-4 sat at X1-KQ90-ZD8E from 01:51 to 02:16 on 2026-10-14 while the approvals list was empty. The hold now lasts at most 15 minutes per yard (`KEEPER_HOLD_MAX_MS` in `agent.ts`), then the ship tours on and logs that it did. Why the approval was not bought in that window is still open; the hold no longer depends on it.

## 2026-10-14 — Tower: Co-pilot tab removed for now

The Co-pilot item is gone from Tower's tab bar. Its screen is still in the page but unreachable from the bar, so bringing it back is one button.

## 2026-10-14 — A restart no longer re-routes traders that are flying a trip

Each trader's trip and its commitment lived only in memory, so every restart made an empty trader that was still flying to its buy market look idle, and the dispatcher handed it the best route again mid-flight (THEOREM-86 and four others, 2026-10-14, after the 01:15 and 01:20 restarts). Trips and commitments are now saved to a per-tenant flag as circuits already were, and restored at boot. Trips saved before this change are lost once, on the first restart after deploying it. Test: `tests/dispatcherCommitments.test.ts`.

## 2026-10-14 — Traders warp each hop of a multi-jump route, not only the last

A trader on a route several gates away only tried warp for the whole trip, so a leg inside warp range still took a gate. Each hop of a positioning path now warps when the next system is in range, and takes the gate otherwise. The route re-plans from wherever the ship lands. Live test: THEOREM-86 on its 5-jump route to X1-CH68.

## 2026-10-14 — Contracts panel lists only the ship assigned to the contract

A trade hold that happened to carry a good an open contract still wanted was labelled "holding contract cargo" in the Contracts list, as if it were on the contract (THEOREM-66 with ELECTRONICS, 2026-10-14). The label now needs the ship to be the contract's assigned buyer (its contract-buy assignment) or pinned to contract duty. The same fix is in Tower, Deck and the desktop view (v6). The contract itself was never assigned to the trade hold; the label was the only thing wrong.

## 2026-10-14 — Tower: an Approvals tab for every pending decision

Keeper-probe asks used to reach the operator one at a time, at uneven gaps, because the engine keeps one open request per kind and only raises the next once the current one is decided. Tower now has an Approvals tab (count badge when anything is waiting) that lists every open approval with its cost and expiry, with Approve and Deny. Under it, "Coming up" lists the priority markets still waiting for a ship to dock there, so the gap reads as queued rather than missing. `GET /api/approvals` returns that list as `upcoming`, computed from the keeper priority list minus markets that already have an open ask. The engine's one-request-per-kind rule is unchanged, and the Deck rail still shows the same approvals. Not yet checked at phone width on a device.

## 2026-10-13 — Warp travel for traders (execution only)

A trader with a warp drive now warps straight to its route's market in another system, when the target is in range and the tank covers the estimate, instead of taking a gate hop. The same `warpTours` toggle and the same decision as the tour ships (`warpTour.ts`) apply, and the trader still lands on the exact waypoint it was sent to. Traders without a warp drive are unchanged. Route ranking is not touched yet: the planner still prices every cross-system trip with the gate fee and cooldown, so a warp-capable trader finishes its trips faster and cheaper than planned. Pricing warp as cheaper is a separate, later change. No trader has a warp drive yet, so this does nothing until one is bought.

## 2026-10-13 — Warp tours: a tour ship with a warp drive crosses by warp, not gate

A tour dispatched to another system used to walk the jump-gate graph one hop per tick, paying a jump fee each hop and waiting on each gate. A tour ship with a warp drive now warps straight to a waypoint in the target system when it is within warp range and has the fuel for it (estimated at 1.2 fuel per distance unit, unverified until the first live warp, which logs its real fuel cost). It lands on a market or shipyard if there is one, else a jump gate. Anything else keeps using gates as before: no warp drive, target beyond range, short of fuel, distance not yet known, or the warp call fails. The toggle is the doctrine clause `warpTours` (on by default, so it only changes behaviour for ships with a warp drive). Turn it off to send every tour through a gate. The decision is a pure module (`src/engine/warpTour.ts`, tests in `tests/warpTour.test.ts`); `FleetManager.hopToward()` gathers the facts and acts on it. A warp-in-flight ship is no longer treated as arrived by `advanceTourDispatch()`. Dispatch of a single ship by `dispatch_ship` across systems still uses gates; this change covers tours only. Also set the explorer buy cap (`shipCap:FRAME_EXPLORER`) to 0 so the auto-buyer does not buy explorers.

## 2026-10-13 — Tower: every dropdown styled, feeder-tier row wraps

Tower's feeder-tier form (More > Work), the system and price pickers, bulk scrap's role and the add-carrier picker all drew the browser's white pill, and the feeder row ran off the right edge of a phone. One `select` rule in `m.css` now gives every Tower dropdown the dark fill and amber arrow (replacing the narrower metrics-only rule's job there), and `.mission-start-row` wraps so the four controls and the Start button fit. Checked in headless Chromium at phone width.

## 2026-10-13 — Contract buys stay with the ships pinned to contract duty

A ship pinned to contract duty was not the only one allowed to take a contract buy. The first contract slot was open to any ship, and the slot count only counted pinned ships in the idle list. So when the pinned ship was busy, an unpinned ship (a 490-unit freighter, on a small contract) could take the job. Now, once any ship is pinned, unpinned ships are refused contract buys with the reason "contract work is kept for the ships pinned to contract duty", and the job waits for the pinned ship. Test: `tests/contractDuty.test.ts`.

## 2026-10-13 — Metrics filter dropdowns restyled

The By waypoint and Recent trips filters (`select.mx-wp-sys`) had no styling, so phones drew the browser's white pill (and, with no options loaded yet, an empty one). They now match the dark panels: dark fill, hair-line border, amber arrow, capped width so they fit beside the panel title. Same rule in `m.css` (Tower) and `deck.css` (Deck). Checked in headless Chromium at phone width.

## 2026-10-12 — Tower: traders grouped by job, and a Mining segment under More

Tower's Fleet roster now folds traders into Contracts, Routes, Feeds, Mission and Unassigned (the same `jobKind` split Deck uses, each fold collapsible, with its total hold). More has a fourth segment, Mining, which mounts the same sortable mining fields table as Deck (`shared/miningFields.js`) and polls it only while that segment is on screen. Checked the Mining segment in headless Chromium against a stubbed API; the roster grouping was only syntax-checked.

## 2026-10-12 — A manual pin can fly a protected good; protected routes are marked

THEOREM-11 was pinned to ADVANCED_CIRCUITRY D41 -> A4 (~148k a trip) and sat idle: the trader refused it as "protected good", because the gate mission lists circuitry as a material, and the refusal applied to manual pins too. `TraderAgent.refusedGoods()` now drops the one good a manual direct route names from the protected set, so the pin flies, and the ship can deliver and sweep what it bought. Every other protected good, and every auto assignment, is still refused. The cost is on the operator: that circuitry is gate material the mission still needs.

The Routes lists (Deck Markets, Tower) now outline a protected good in amber with a "protected" tag, so the best-looking row that auto trading will never take is visible as such. `/api/markets` routes carry `protectedGood`. Test: `tests/trader.test.ts`.

## 2026-10-12 — Playbook: mine next to where the chain buys its inputs

New section in `docs/reset-opening-playbook.md` from the operator's note: B7 is where the chain buys QUARTZ_SAND and SILICON_CRYSTALS and
has asteroids B11 (24 units) and B8 (49 units) next door, both with mineral deposits, yet all the drones were on EZ5F by H57. Records
the steps (list each input's source market, run `mining_fields` with that market as target, survey the nearest fields with a looping
tour, set up a feed, field and shared collector) and why traits are only a hint. Adds the matching automation item to `docs/TODO.md`.

## 2026-10-12 — Deck Mining screen refreshes itself every 30 seconds while open

The table loaded once when the screen opened, so a survey tour that kept adding surveys (B17, B19 and B23 had 6, 3 and 3 within the
hour) did not show until the screen was reopened. It now reloads quietly every 30 seconds while it is the visible screen and stops when
you leave it. Not run in a browser here.

## 2026-10-12 — Deck: a Mining screen, a sortable table of what the field surveys show

New "Mining" item in Deck's left rail. One row per minable asteroid in the home system (the `mining_fields` ops tool): field,
distance to a waypoint you type (for example the market the ore goes to), surveys taken (with a warning under 10, and a dash for
never surveyed), one column per good seen in any survey showing its share of listed deposits (heat-shaded, so the richest cells
stand out), how many miners and feeds are on the field, and the field's traits. Click any header to sort, again to reverse; never-
surveyed fields sort last on a share column. Sort and the distance target are remembered per browser. The sort/column logic is a
pure file, `public/shared/miningSort.js` (tests: `tests/miningSort.test.ts`); the drawing is `public/shared/miningFields.js`. Only
one field has real survey data until a surveyor tour runs; the screen shows 65 rows with 64 never surveyed. Deck only, not run in a
browser here.

## 2026-10-12 — Deck Fleet: traders are grouped by what they are doing

The Trader group in the Fleet table is split into Contracts, Routes, Feeds, Mission and Unassigned (in that order, empty ones hidden),
each a fold of its own, with the ship count and the total hold of the ships in it. "Contracts" holds contract buys, ships carrying
contract cargo and ships waiting on contract duty; "Feeds" holds feed and chain crews and collector shuttles; "Mission" the gate
carrier and warehouse buy/sell. The grouping reads the job label (`jobKind` in `public/shared/domain.js`, tested in
`tests/jobKind.test.ts`). Deck only; Tower's roster is unchanged. Not run in a browser here.

## 2026-10-12 — Tower (and Deck) can name a feed's carrier, before and after creating it

Tower had no way to choose a feed's carrier: the Start form had no ship field, and a feed card showed the crew as text with no add or
remove, so the automatic pick (biggest empty hold) decided. Tower's Start form now has a carrier picker ("Carrier: auto" by default),
and each feed card lists its crew with a remove button and an "add ship…" picker. Deck's create form gets the same picker (its card
already had add and remove). Each option shows the ship's hold and flags a ship on contract work ("40 hold · on contract"), so the right
size can be matched to the job. `POST /api/feeds/start` takes `shipSymbol`: the feed starts wanting no crew (so its own tick cannot pick
one in between), the named ship is added, and if that fails the feed keeps its normal crew size and the error says so. Tested in
`tests/dashboard.test.ts`; the Tower/Deck controls are not run in a browser here.

## 2026-10-12 — Feeds and missions no longer take a ship that is on contract work

A new copper-ore feed into H57 picked its carrier itself and took THEOREM-A, the pinned 80-hold hauler that held a live contract buy,
instead of the shuttle the operator had freed for it. The automatic carrier pick takes the biggest empty hold among ships the
dispatcher is not using, and neither contract duty nor a contract-buy assignment counted as "using". `pickFeedCarrier` and
`pickMissionCarrier` now skip any ship for which `RouteDispatcher.onContractWork()` is true (pinned to contract duty, or holding a
contract-buy assignment, auto or manual). To choose the carrier yourself, assign it explicitly (Deck's feed card "Add" with a ship
picked, or `assign_feed_carrier`). The pick still prefers the biggest hold, which is the wrong end for a feed into a 60-unit market
(see the playbook); not changed here. Test: `tests/contractDuty.test.ts`.

## 2026-10-12 — Deck/Tower: a drone feed's collector shuttle reads "collector: GOODS → market"

The collector shuttle is not on its feed's crew list, so the Fleet job column and roster showed it as "unassigned". It now reads
`collector: IRON_ORE + COPPER_ORE → X1-CM13-H57` (every good it serves into that market), and drops out of the unassigned counts.
A placeholder label until the collector gets richer status (stuck, loading, carrying). Display only; not run in a browser here.

## 2026-10-12 — Deck/Tower: a trader on contract duty with no contract reads "waiting for contract"

A ship pinned to contract duty with nothing to buy for showed as "unassigned" (and counted in the unassigned badges and the
"need you" tally). It now reads "waiting for contract" in the Fleet job column, Deck's "wants" line and Tower's roster, and is left
out of the unassigned counts. Display only (`contractDutyShips` from `GET /api/dispatch`); not run in a browser here.

## 2026-10-12 — Playbook: put the right size ship on the right job

New section in `docs/reset-opening-playbook.md` (and a one-line pointer in `CLAUDE.md`): this week every 80-unit hauler sat on a feed, the
gate mission or the collector while the shuttles ran the six-figure routes and contracts. It records what decides the match (a market's
per-sale cap limits a feed's useful hold, a mission carrier is limited by price recovery, a collector needs room for the drones'
loads, routes scale with hold until the lot size bites), how to check it in a minute, and how to swap safely.

## 2026-10-12 — Contract duty: several ships can buy one contract good at once

Operator idea: pin more than one ship so contracts finish faster. The dispatcher gave out one contract-buy job per good, so a
second pinned ship just waited. With two or more ships on contract duty it now offers up to one buyer per such ship (max 4,
`MAX_CONTRACT_SLOTS`, work keys `GOOD:contractBuy`, `GOOD:contractBuy#2`, ...). An extra buyer goes only to a ship on contract
duty and only while the units already promised do not cover the need: each ship carried forward with a contract buy counts as
its hold, and each ship assigned this cycle adds its own. The purchase itself is also sized to what is really left: the
trader's `contractNeeded` now subtracts what other ships on a contract buy for that good already carry, which it did not before
(it only subtracted the ship's own cargo, harmless with one buyer, an over-buy with two). The check on the old rule found that
`needed` is units required less units delivered, so cargo in flight was invisible until now. A contract that needs less than one
hold still goes to a single ship. Residual risk: two ships reaching the market in the same instant can both buy before either's
cargo shows; the leftover is small and sells. Tests: `tests/contractDuty.test.ts`.

## 2026-10-12 — Contract duty: pin a trader to contract work in general

Operator request: pin a ship to contract work, not just one contract (the contract crew assignment stays for that). A trader on
contract duty is given contract-buy jobs only, for whichever accepted contract needs a good next (the dispatcher's existing
contract-buy work, richest first), and never an ordinary trading route: the dispatcher skips every other kind of work for it
(logged as "this ship is on contract duty") and `claim()` will not hand it a route of its own. With no contract work it waits.
Pinning drops an ordinary route it held; a ship mid-haul finishes its cargo as before. It is saved across restarts (fleet flag
`contractDuty`) and shown on the `/api/dispatch` payload. Controls: a "Contract duty" / "Release from contract duty" button on
a trader's sheet in Deck and Tower, `POST /api/fleet/contract-duty`, and the `set_contract_duty` tool. One buyer per good per
cycle still applies, so two pinned ships on the same single contract good share it: the second waits for different work. Tests:
`tests/contractDuty.test.ts`, and the endpoint in `tests/dashboard.test.ts`. The buttons are not run in a browser here.

## 2026-10-12 — Deck: start and stop a survey tour from the ship sheet

The looping survey tour had no Deck control (only the `scan_fields` tool). A ship with the surveyor role now has a "Survey tour"
button on its Fleet sheet: a list of the home system's minable fields (nearest this ship first, with surveys taken and the top
deposit share), "10 least surveyed", batches per field, loop laps, nearest first, and Start; while a tour runs it shows laps and
batches and a Stop button. Backed by `GET /api/fleet/survey-tour`, `POST /api/fleet/survey-tour` and `/stop`, which share the
ordering and checks with the MCP tool (`src/engine/surveyTourControl.ts`); the field list comes from the `mining_fields` ops tool.
Not run in a browser here (Deck needs a live session): checked for syntax and the endpoints are tested. A ship needs the surveyor
role first (Change role); a trader cannot start a tour.

## 2026-10-12 — Feeds: a collector with no field was silently ignored by the drones

THEOREM-25 was named collector on the copper and iron ore feeds, but neither feed had a `field`, and the whole collector
path (drone hand-over, the shuttle's wait and carry) is gated on `collector` AND `field`. With no field every drone behaved as
before: THEOREM-7 flew its 12u of copper ore to H57 and sold it itself while the collector sat docked at the asteroid. Deck's
Set collector posts a blank asteroid box as "clear the field", so setting only the shuttle was easy to do and gave no error.
`setCollector` now fills the field in from where the feed's drones all are (and pins them there), or refuses with "name the
asteroid (field) as well" and leaves nothing half set when they are not at one asteroid; a feed that already has a collector and
no field repairs itself the same way, checked at most every 2 minutes (it reads every drone). Tests in
`tests/feedSharedCollector.test.ts`.

## 2026-10-12 — Feeds: a collector shuttle with an operator hold has the hold dropped

THEOREM-25 was parked at the asteroid with `hold_ship` and then made a feed's collector. A hold is re-enforced every tick and
re-navigates the ship back to the hold waypoint (the same trap documented on `withHoldSuspended`, the THEO-5 incident), so the
first time the collector flew its load to the market the hold would have dragged it straight back. A feed now drops the operator
hold on its collector the first time it runs the shuttle (once per process, logged), since the feed owns where the shuttle goes.
Test in `tests/feedSharedCollector.test.ts`.

## 2026-10-12 — Mine feeds: a "hand off at N units" setting

Operator request: drones should give their ore to the collector (or sell it) once they hold 10 of the feed's good, not wait for a
nearly full hold. New per-feed setting `handoffUnits` (migration 051, 1 to 200, blank = the old rule of 80% or full), set from
Deck's feed card ("hand off at" next to the collector controls), `POST /api/feeds/collector` and the `set_feed_collector` tool.
With a collector, the drone hands over at the threshold when the shuttle is there with room; if the shuttle is away and the hold
has room, the drone keeps mining instead of parking. With no collector, the drone flies to the market at the threshold (more,
smaller trips, which is what the setting asks for). Counted in units of the feed's own good, not the whole hold, because drones
jettison the off-target ore. Tests: `tests/feedHandoff.test.ts`.

## 2026-10-12 — Survey tours can loop (a mining tour), nearest field first, and survive a restart

`scan_fields` took one pass over a list of fields and stopped. Now `loop=true` makes it a mining tour: when every field has
its batches the surveyor starts another lap, so the deposit tallies (read by `get_field_composition` and `ops mining_fields`)
keep firming up, until `stop=true`. `nearestFirst` (default on) reorders the fields so the ship always flies to the nearest
unvisited one next from where it is. A looping tour is saved (fleet flag `fieldScans`) and put back on boot for ships that are
still surveyors; a one-pass tour is not. Progress shows laps and batches per field. The order and lap logic is a pure module,
`src/engine/surveyTour.ts` (tests: `tests/surveyTour.test.ts`); the surveyor loop in `agent.ts` calls it. Any ship with the
surveyor role can run a tour; the frigate THEOREM-1 carries a surveyor mount and can be given that role.

## 2026-10-12 — Ops: `mining_fields`, a listing of minable asteroids with their deposit mix

For choosing where to park drones and a collector, and as the data an automatic chooser will read later. One row per
minable waypoint (ASTEROID and ENGINEERED_ASTEROID in the home system; an asteroid base is a market outpost and is left
out): traits, percent of listed deposits by good (largest first) from the field surveys, how many surveys that rests on
(`reliable` at 10 or more), straight-line distance to a named `target` market, and which miners are pinned and which
feeds/collectors use it. `good=` ranks by that deposit's share; `unsurveyed` lists fields with no surveys yet (send a surveyor
with `scan_fields`). Logic is a pure module, `src/engine/miningFields.ts`, tested in `tests/miningFields.test.ts`; the tool only
gathers inputs. Distances are straight-line system units, not flight time; only the home system's waypoints are known to it.

## 2026-10-12 — Feeds: one collector shuttle can serve several mine feeds into the same market

Operator request: a shuttle parked at a field should be able to collect for more than one feed (iron ore and copper ore into
H57, say). `setCollector` used to refuse a shuttle already on another feed. It now allows it when the feeds share the target
market and the field (a shuttle waits at one asteroid and sells at one place); a different market or field is refused with
the reason, and so is a ship that is a drone on another feed. The shuttle's loop (`stepCollector`) runs once per shared group
rather than once per feed: it counts every feed's good in its hold, flies when it is nearly full or a part-load has gone
20 minutes without growing, sells each good under that feed's own sell-gap and force settings, and keeps all the group's goods
(not just the first) when it clears the hold. It is handed back to the dispatcher only when its last feed lets go (remove or
pause). The collector's sale now also uses the chunked sell from the entry below, since an 80u hold into a 60u market would have
failed the same way. Different fields for one shuttle are not supported. Tests: `tests/feedSharedCollector.test.ts`.

## 2026-10-12 — Feeds: sell a hold bigger than the market's per-sale cap in chunks

THEOREM-D carried 80u IRON_ORE to H57, whose market takes 60u per transaction, and the feed tried to sell all 80 in one
call every ~5 seconds for at least four minutes ("sell failed: ... has a limit of 60 units per transaction"). It was not the
sell gap or force: force skipped the gap as designed and the sale itself was refused. The carrier now reads the cap out of
the refusal (the same pattern trader and siphoner already use) and sells the hold in chunks of it, logging each sale;
anything unsold stays aboard for the next pass. Test: `tests/feedSellChunks.test.ts`.

## 2026-10-12 — Deck: a Custom route form (pick the good, the buy market and the sell market)

Deck's ship sheet only had "Assign route", which pins one of the dispatcher's own top routes. The form that lets you name a
good and a buy and a sell market existed on Tower (and the old desktop) only, and I wrongly told the operator Deck had it.
Deck's ship sheet now shows a "Custom route" button for traders: good (with the known goods to pick from), buy from, sell to,
Assign / Auto. It posts the same `POST /api/dispatch` as Tower, so the ship shows "pinned by you" and a release button.
Half-typed values survive the fleet view's re-renders. Not run in a browser here (Deck needs a live session): checked for syntax and
against the code it mirrors.

## 2026-10-12 — Mission: show why a carrier is waiting and when it next looks

A pacing gate (recovery, cash floor, "cannot afford one unit") makes a carrier wait `PACING_RECHECK_MS` (5 minutes) and then
look again; changing the pacing does not cut that wait short, and the "waiting" log line is only written every 30 minutes,
so a mission looked stuck when it was only between looks. `get_missions` (and the dashboard's missions endpoint) now return
`carriers: [{ ship, step, material, waiting, nextCheckAt }]`, where `waiting` says which gate and the numbers (e.g. "FAB_MATS
ask 1267c, waiting for 1320c (recovery +10% over 1200c)"), and the recovery log line names the next check time.
The 5 minutes is the same cooldown the mission uses when it re-shops; no reason for that figure was recorded.

## 2026-10-12 — Fix: Metrics collapsible sections broke the By waypoint panel

The folding code (c475dd9) was inserted into `renderWaypoints` instead of `mountMetrics`, so it referenced `collapsible`
out of scope: sections never folded, and the By waypoint panel threw a ReferenceError on every render (Deck and Tower
both). Moved into `mountMetrics`. Checked in a real browser: 11 panels get a fold header and a tap hides the body.

## 2026-10-12 — Mission: the price ceiling no longer lets one extra chunk through

The mission's ceiling (`maxInflationPct`, % over the market's trailing-24h low) was checked before a lot and then only
against the price just PAID. A lot is bought in trade-volume chunks, so it always bought one chunk past the ceiling:
THEOREM-C on 2026-10-12 had a 20% ceiling on a 1,147c baseline (1,376c), paid 1,363c for the first 20 FAB_MATS and then
1,456c (27% over) for the second. Between chunks the mission now projects the next ask from its own price impact
(`nextChunkWithinCeiling`, `src/engine/mission.ts`) and stops the lot early, with a log line, if that lands above the ceiling.
The gate before a lot was already right. Note the baseline is the 24h LOW, not the first price seen.

## 2026-10-12 — Tower metrics: sections fold when you tap their header

Every Metrics panel on Tower (charts, By waypoint, Pace to reset, Contracts, Recent trips, the By good / ship / system
tables) has a chevron header that folds its body, so the screen can be cut down to the parts you are watching. Which are
folded is remembered per browser. It is an opt-in (`collapsible`) of the shared `mountMetrics`, so Deck is unchanged.
Taps on a header's own filter (system or ship picker) do not fold it. The KPI tiles stay visible.

## 2026-10-11 — Metrics: a Recent trips table, filterable by ship

A new panel on the Metrics screen (Deck and Tower share it) lists the latest sales, newest first: time, ship, good, units,
the route it closed (buy > sell, with where it actually sold when that differed), how it was chosen (auto / manual, circuit
leg) and the realized profit. A ship picker narrows it to one ship and is remembered per browser. It follows the screen's
range (up to 72h). Backed by `GET /api/trips?hours=&ship=&limit=`, which reads the ledger's route tag
(`parseRouteTag` in `src/engine/routeTag.ts`). Sales from before the route tag shipped show a dash for the route.

## 2026-10-11 — Ledger: each trade records the route it belonged to

A PURCHASE or SELL row said where it happened but not which trip it was part of, so "what was this ship flying when it
sold" had to be guessed from neighbouring rows. Trades now carry a `route` tag (`migrations/050_ledger_route.sql`,
`src/engine/routeTag.ts`), e.g. `X1-CM13-B7>X1-CM13-H60 auto circuit1`: buy and sell waypoints, who chose the route
(auto / manual) and the circuit leg. The waypoints come from the route pinned when the cargo was bought, so a mid-trip
reassignment cannot relabel an old trip; the trader stamps the tag in one place, wrapping its `recordLedger`. Read it
through the `ledger` ops tool. Rows written before this deploy have none, and fuel, jumps, mined cargo and contracts stay untagged.

## 2026-10-11 — Circuits: the first leg must be the higher-ranked route of the pair

Operator rule: "the first in the pair needs to have the higher rank". Both live circuits (THEOREM-11 PLASTICS -> EQUIPMENT,
THEOREM-4 DIAMONDS -> MEDICINE) used a near-worthless first leg to reserve a rich second leg, which the ship then never ran.
`bestCircuit` now skips any second leg whose profit per trip is above the first leg's (`outranks()` in `src/engine/circuit.ts`),
and `circuitReport` says how many were skipped ("N outrank this route so cannot be its second leg"). The same pair can still
form the other way round, with the richer route as leg 1. Fixtures in `tests/circuit.test.ts` and `tests/dispatcherCircuit.test.ts`
were adjusted so leg 1 outranks leg 2, with new tests for the rule and the report wording.

## 2026-10-11 — Circuits: never plan a second leg another ship is already buying

The first circuits planned after the new gates (THEOREM-11, THEOREM-4) both failed the same way. Each second leg was a good
another ship was already buying at the same market (EQUIPMENT at K100 for THEOREM-11, while THEOREM-C was buying it there for
D40; MEDICINE at K101 for THEOREM-4, while THEOREM-D was buying it there for J64). THEOREM-11's first leg (PLASTICS, +540c)
sold 368s later, and its second leg was dropped as "no longer on the board": the other buyer had already moved the price.
Its next pick was a contract run, because the route it would have flown, MEDICINE, was by then held for THEOREM-4's circuit.
A second leg is now not offered when any trader (mid-haul, committed, or manual) already buys that good at that market.

## 2026-10-11 — Two-leg circuits: stricter planning, no shared buy market, and a lifecycle log

Reviewing the 34 minutes circuits were on (20:22-20:56 UTC, six planned): none ever ran a second leg. Every one was dropped
first ("no longer available" x2, first leg refused x1, manual route x1, switched off x2), two ships had planned the same
SHIP_PARTS buy market at D40, and the circuits that were planned beat their route alone by a few hundred (rates 1,130-1,735).
Trading itself did not suffer (about 270k/hour while on, 4k in the 24 minutes of market lull before), so this is about
circuits not doing their job, not about harm. Circuits stay off by default; when on they now:

- **Plan only a real gain** (`chainCircuitMinGain`, default 1,500, and a quarter of the route's own score): a circuit that
  barely beats the route alone is no longer planned, so it no longer reserves a second leg and holds a market for nothing.
  Clause off means no minimum.
- **Pick second legs that outlast other traders** (`chainCircuitMinRuns`, default 2): the leg must still be profitable after
  two full runs by others, using the runs-left model (no recovery between runs). Judged only for legs with price data.
- **Never share a buy market:** a second leg whose good and buy market another circuit already holds is not offered.
- **Say why a second leg was dropped.** "No longer available" hid two causes; it is now "no longer on the board" (margin or
  market gone, or taken as another route's sell market) or "still on the board but refused for this ship: <reason>".
- **Log the whole lifecycle** (`dispatch circuit: <ship> ...`): planned, leg 1 sold (and how long after planning), leg 2
  served, leg 2 bought and flying, circuit complete (with the time from planning), dropped (with the reason). Counters and
  the last 120 events are kept in memory and returned by the new ops tool `circuit_log`, which also lists circuits still
  open and how long each has waited. That is the evidence for whether second legs run at all.

## 2026-10-11 — Tower: contract and construction cards fit a phone

The construction buy-pacing form was six inputs and a button in one non-wrapping row, so the last fields ran off the right edge
of the screen (and the inputs were bright white against the dark theme). It is now a two-column grid of labelled fields with a
full-width Save button, and card action rows wrap. The contract crew panel uses the app's own button styles, with plain
wording ("0 units of hold assigned, 2 still needed") instead of capitalised "0U".

## 2026-10-11 — Contracts in the metrics: what they earn, and what is still owed

Contracts were half in the books. Only a completion payout was recorded (no contract id), the advance paid on accept was
never recorded, delivering the goods bought for a contract wrote no row so its cost sat as an unmatched purchase, and
`buildMetrics` ignored CONTRACT rows entirely, so "Net trading" had no contract income while still carrying the fuel spent
on contract runs. Nothing showed the credits accepted contracts still owed. On this server contracts were 70.8k of about
2.75M income over 24h (2.6%), so this is about accuracy, not size.

- **Ledger (migration 049):** `contract_id` on every contract row. New rows: `CONTRACT`/`ADVANCE` on accept,
  `CONTRACT`/`PAYOUT` on completion, and `DELIVERY` (units, cost basis per unit from the ship's own purchases, null when
  mined, total 0 because it is not cash) when goods are handed over. Cash formulas are unchanged. Rows from before this
  carry no id and no advance: their payouts show as "earlier" and the old advances stay missing.
- **Metrics:** `contracts` block (advances, payouts, completed, units and cost delivered, net, share of income, per-contract
  lines) and `netInclContracts` = net trading + contract income - cost of goods delivered. **Net trading is unchanged**, so
  weeks stay comparable; the Metrics screen adds a "Net incl. contracts" tile next to it.
- **Pipeline** (`src/engine/contractPipeline.ts`): for each accepted unfulfilled contract, what it still owes on completion,
  progress, cost so far (ledger), estimated cost to finish (units still to buy at the cheapest known market, less what
  ships already carry), expected net, time left, and warnings (mined-only good, loss, under an hour, abandoned). The owed
  total is shown beside the realized numbers and is never added to credits or net, because it is not cash yet.
- **UI:** a Contracts panel on the Metrics screen in Tower and Deck (realized, owed table, earned per contract). Ops tool
  `contract_money` returns the same for the MCP and HTTP doors.

## 2026-10-11 — Routes board: every "not flying" reason is collapsed, and reads in plain words

The expandable list only appeared when a route had two or more reasons, so the common single-reason case (one free trader)
still showed as a line of text on every row. Every unflown route now shows one "not flying · why?" toggle (with a count when
there are several) that opens a list, in Tower and Deck. The dispatcher's internal work keys are translated:
"outscored by EQUIPMENT:contractBuy" reads "outscored by EQUIPMENT contract delivery", "FERTILIZERS@X1-CM13-K100" reads
"FERTILIZERS into K100". The toggle is a quiet muted chip (amber only while open) so the list is not a wall of amber text.

## 2026-10-11 — Contracts: assign several ships, and send miners (Tower and Deck)

Only the retired v2-v6 desktop pages could put a ship on a contract, one at a time, and nothing could send miners.
`public/shared/contractCrew.js` adds a "Crew" toggle to each delivery line of an accepted contract in Tower (More ->
Contracts) and Deck (Ops -> Contracts): pick any number of traders to haul the good (the panel shows assigned hold against
units still needed), and, when surveys have shown the good as a mined deposit, pick miners and a field (best share first) to
send them to. `POST /api/contracts/assign` now takes `shipSymbols` (a ship that cannot take it is reported, not fatal to the
rest); new `POST /api/contracts/miners` sets each miner's survey preference for the good and pins it to the chosen field, or
clears the preference. A miner holding contract cargo already delivers it before anything else, so no delivery change was
needed. Both are logged as `contract_crew` operator actions. Limits: miners only extract what the field's deposits give
(the preference favours the good in surveys, it does not guarantee yield); several haulers on one good can over-buy, so the
panel warns when assigned hold exceeds what is still needed; a good with no market (mined only) cannot be hauled.

## 2026-10-11 — Routes board: "runs left" hint

Profit per hour assumes a route can be repeated; today's prices showed how long it can't be. THEOREM-A's FOOD run earned
49.2k, 28.1k, then 2.7k as its own buying and selling closed the margin, and prices did not recover between runs (A1's FOOD
price kept falling over a 9-minute rest, DRUGS at H57 over 20). `src/engine/runsLeft.ts` estimates how many back-to-back runs
a route has before the per-unit spread falls to the fuel plus margin floor: the per-lot impact model (4.5% per tradeVolume of
our units, compounding, no recovery) with a 1.25 correction measured from that FOOD data (7.9-9.4% per 80u run observed vs
6.0% modelled). On the day's FOOD prices it says 3 runs, as observed. `/api/markets` returns `runsLeft`, `runsLeftCapped` and
`runsLeftNote`; Tower and Deck show "~3 runs left" (amber at 2 or fewer, tooltip has the working). Display only: it does not
change the dispatcher's ranking, which still rescores every minute from real prices. It assumes one ship on the route, so
several traders on one route burn the runs faster.

## 2026-10-11 — Routes board: "+N more" opens the other traders' reasons

A route turned down by several traders showed the first reason and a plain "(+1 more)". `/api/markets` now returns the rest as
`skipMore`, and in Tower and Deck "+N more" is a button that opens them as a list under the route (and "hide" closes it).

The "every trader is occupied" reason is collapsed the same way: it now reads "every trader is occupied" with a
"ship by ship (3)" button that opens one line per trader, instead of repeating the full list under every route.

## 2026-10-11 — Routes board: "every trader is occupied" says what each trader is doing

The skip reason for an unflown route read "every trader already has work" even when a ship showed `unassigned` in Deck's
Dispatch panel (it was mid-trip with cargo, which counts as busy). It now lists each trader: "THEOREM-A mid-trip with cargo
(FOOD), THEOREM-1 pinned to DRUGS". A mid-trip ship is re-assigned after it sells; a pin stays until released.

## 2026-10-11 — Routes board: sort by profit per hour or per trip, who is flying, and why not

The dispatcher ranks by profit per hour of ship time (profit x 600 / round-trip seconds), but both Routes boards listed by
profit per trip, so a short FOOD run it correctly put first looked buried under longer, bigger-per-trip routes (THEOREM-A,
2026-10-11). `/api/markets` now returns `tripSeconds`, `ratePerHour`, `flownBy` and `skipReason` for each route
(`src/engine/routeStatus.ts`: the ship on it, marked "(pinned)" when hand-assigned, else the sell-market block, the margin
floor, a claim, or the first trader rejection from the dispatcher's last cycle). Tower and Deck get a "Profit / hour |
Profit / trip" toggle (remembered per browser, default per hour), show both figures and the trip time, and Deck now says who
is flying each route or why none is.

## 2026-10-11 — Deck shows a pinned route and can release it

A route the operator assigns by hand (`source: manual`) overrides the dispatcher until cleared, but Deck's ship sheet gave no sign
of it and no way back: only Tower had "Release to auto". Deck's job line now ends "(pinned by you)" for such a route, and the
ship sheet has a "Release to auto" button that posts the same `clear` Tower does.

## 2026-10-11 — Say why a trader is not getting routes

Two traders sat idle next to good routes on the new server and nothing said why: the Routes board only explained blocked
sell markets, and the dispatcher's per-route rejections only cover traders it is offered. A trader that is held, suspended,
claimed by a mission/feed/keeper, the warehouse ship, or marked for scrapping is never offered, so it had no reasons at all.
`src/engine/traderEligibility.ts` now holds that one decision as a sentence (`dispatchExclusion`), and
`FleetManager.dispatcherTraders()` filters through it, so the reason shown cannot disagree with what the dispatcher did.
Shown in `dispatch_explain` (`notConsidered`), `/api/markets` (`traderExclusions`) and a banner at the top of Tower's Routes
list. The "best free hull" hint no longer names an excluded ship.

## 2026-10-11 — A decision model for the co-pilot router and an attention feed (both off, advisory)

Adds TypeSafe's Jev behind a small port, used two ways; both ship switched off and only advise. Jev is a discriminative
model: given a state and typed questions (yes/no, choice, score) it returns probabilities and a confidence, in well under
a second, with no text generation.

- **Co-pilot router** (`jevRouter` clause). Classifies the captain's message into an intent and hands the co-pilot only the
  read tools that kind of question needs. It only narrows, only when sure (default 85%), always keeps the change tool, and
  with the clause off, a low confidence, an "other" verdict or no model the co-pilot gets every tool as before.
  `ChatAgent` takes an optional `toolFilter`; a filter that throws or returns nothing means every tool.
- **Attention feed** (`jevAttention` clause). Ships that need a person's eyes, on Tower's Home and through the new
  `attention` ops tool and `/api/attention`. Plain rules give the clear cases with a checkable reason: stranded, a hold
  replayed from saved state at boot (the exact cause of THEOREM-1's stuck tour ship this week), one log line repeated,
  a long silence, overdue transit, low fuel. With a key, the model is also asked literal yes/no questions about ships
  that look worth a second opinion, and can add its own flags, each labelled with its probability.
- **Every answer is logged** to `judge_decisions` (migration 048, per tenant, kept across weeks, pruned at 14 days) and
  readable through the `judge_decisions` ops tool, so its confidence can be checked against what happened before anything
  acts on it. Nothing is acted on yet: the router changes which tools the co-pilot sees, the feed changes nothing.

Safeguards, from the provider's own limitations page: counts, minutes and percentages are worked out in code, never asked
of the model; the state sent is an explicit allow-list of labelled fields; pasted keys in a captain's message are
redacted; "other"/"nothing" are the first option of each choice because the model leans toward the first; the endpoint is
fixed to `https://api.typesafe.ai/v1/systemone` (a community write-up names a different host, which must not receive fleet
state). Without `TYPESAFE_API_KEY` the router passes every tool and the feed shows the rules alone.

New: `src/engine/{judge,jevClient,judgeLive,copilotRouter,copilotRouterLive,attention,attentionFeed}.ts`,
`migrations/048_judge_decisions.sql`, and tests for each, including one that checks the router's tool table against the
co-pilot's real tool list.

## 2026-10-11 — The ledger is kept week over week, keyed by agent and reset date

The weekly cleanup used to delete the ledger, and the metrics screen read it back with no notion of which week a row
came from. On a server where the cleanup had not run, last week's closing wallet was read as this week's starting
point and the Credits figure showed a loss of about 300,000 that never happened.

Every ledger row now carries `universe_key` (`<agent symbol>@<reset date>`, e.g. `THEOREM@2026-10-11`), the same pairing
`run_results` uses. A restrictive row-level-security policy (`universe_scope`, migration 047) scopes every ledger read to
the tenant's current week, so cost basis, earnings and the ops tools can never see another week's rows, including
readers added later. The weekly cleanup no longer deletes the ledger, `Store.ledgerWeeks()` lists the kept weeks with
their matched profit, and the run-result capture reads the week it describes. The date comes from the game's live status
poll, not from the last reset the watcher handled, so it is right while the watcher is disabled. Unkeyed rows from the
current week are stamped on first boot; older unkeyed rows belong to no week and are skipped. Metrics reads are also
clamped to the current universe (`ledgerReadFrom`), which still applies while the key is unknown.

New: `src/engine/universe.ts` (the key), `migrations/047_ledger_universe_key.sql`, `tests/universe.test.ts`,
`tests/ledgerUniverse.test.ts` (runs as a non-bypass role so the policy is exercised), `tests/metrics.test.ts` additions.

## 2026-10-10 — Dispatcher explain: why a route did or did not get a trader

`stcommand_ops_dispatch_explain` answers "why isn't this route being flown" from the dispatcher's own last cycle
instead of from logs. Each recompute now keeps the ranked work list (with the claimant of each route), the routes
dropped under the margin floor, and, for every idle trader, the reason it was refused each route it was checked
against: already claimed, declined, out of reach, buyer cap, margin gone after impact, net score, or outscored by a
named route. Filter by ship and/or good. Busy traders show their assignment without rejections, and a route that
never reached the work list (no open gate, or its market already being sold into) is not shown. Bookkeeping only;
no change to what the dispatcher assigns.

## 2026-10-10 — Gate status tool for the MCP server and the co-pilot

A read-only `stcommand_get_gate_status` tool lists a system's jump gates, whether each is finished and where it
connects. With `live` it also asks SpaceTraders for each gate's construction, so the answer doesn't depend on our
cached data. The co-pilot gets the same check as `get_gate_status`, so it can answer "is the gate open" from data
instead of guessing.

## 2026-10-10 — Metrics: ranked waypoint table with a system filter

The Metrics tab has a "By waypoint" table: each waypoint's realised profit, sales and sold value, plus cargo bought
and spent there, ranked by profit. A system dropdown filters it. Buys appear beside sales so a market where our own
buying is pushing the price up shows up alongside where we make money.

## 2026-10-10 — Jump planner on Tower and Deck ship sheets

The ship sheet on Tower and Deck now has the v6 jump planner: one row per gate out of the ship's system, with a Jump
button. A gate that isn't finished is greyed out and its Jump is disabled, and so is any ship in transit. Gate
completion comes from the galaxy's construction status, so a gate that is still under construction can't be picked by
mistake.

## 2026-10-10 — Manual send to waypoint refuels on the way

The Tower "Send to waypoint" control no longer refuses a ship that can't make the leg on its own fuel, and it no
longer flies a bare straight-line leg. Ships now go through the same stop-aware planner the missions use: they refuel
at a market or fuel stop when the direct leg is beyond the tank. Idle ships route the same way.

## 2026-10-10 — Metrics: buying pattern charts

Two new charts on the Metrics tab, over the same range as the others. "Buying per interval" shows credits spent on
cargo in each interval (ship purchases are left out, they have their own figure). "Average price paid per unit" is
the price we paid per unit in each interval, with the first and last values in the header. Under steady buying a
rising price line means our own volume is pushing the market up, which is the pattern to watch for.

## 2026-10-10 — Co-pilot can propose fleet changes; you confirm each one

The chat co-pilot could only read the fleet. It can now propose two kinds of change: setting a ship's role (including
keeper, with its market), and holding or releasing a ship. A proposal runs nothing. The co-pilot returns an id, and the
change happens only when you reply `/confirm <id>` in the chat. `/cancel <id>` drops it. Proposals expire after 30
minutes. Confirmation is handled by the server, not the model, so a model cannot confirm its own proposal, and each
executed change is recorded as an operator action with `via: copilot`. Purchases, dispatch, jumps and doctrine are not
offered. The default co-pilot model is now `deepseek-v4.1-flash`; a tenant that already saved a model keeps
it, so change it in Settings to use the new one.

## 2026-10-10 — Metrics: credits plus holds on the Credits chart

The Credits chart shows wallet only, so cargo in transit looked like a drop when a trader bought a load. The engine now records credits plus the estimated value of every hold every five minutes (new table `wealth_samples`, migration 046), and the Metrics view (Deck and Tower) draws it as a dashed second line on the Credits chart, on the same scale, in the same ranges. The series is bucketed by a pure function (`worthByBucket` in engine/metrics.ts, tested). History starts at deploy, so the first day shows a short line.

## 2026-10-10 — Extra-buyer price impact follows the buy market's lot size

When a second or third trader is sent to the same buy market, the dispatcher predicts the ask will have risen by the units already promised there. That rise used a flat 0.2% per unit, measured on a 20-unit-lot market. A 300-unit-lot market moves about 0.015% per unit (the 4.5%-per-lot figure trip slippage already uses), so deep markets were priced as if thin. The per-unit impact is now `PRICE_IMPACT_PER_LOT / buy market lot size` when the route carries it; an explicit tuning value or a route with no known lot size keeps the flat 0.2%. Tested for a thin and a deep market.

## 2026-10-10 — A held lot below its loss floor is redirected to a market that clears it

`deliverHeldCargo` only held when the destination's live price fell below the loss floor. THEO-85 (490-unit freighter) sat at MC94-EB3F with 180u EQUIPMENT (cost 2767c, market 2146c) while other markets paid 3,600c+, so the biggest hull idled and the CLOTHING routes in its system went untaken. It now re-pins the lot to the best reachable market that clears the floor (new pure module `src/engine/floorRedirect.ts`, tested), remembers the markets already tried so it cannot bounce, and falls back to the old hold + operator approval when none clears. Not covered: orphaned cargo with no pinned route (the leftover sweep, own system only).

## 2026-10-10 — Keeper request queue no longer blocks behind one unrequestable market

`advanceKeeperMarketQueue` only ever tried the first uncovered market on the operator's priority list. If that market could not be requested (no keeper hull cached in its system, the shipyard path had already asked for it, or the durable state said covered), nothing behind it was tried, so coverable markets waited for hours (MB58-E47 at the head, MC94 and MB58 markets behind it). It now walks the uncovered markets in priority order, up to 8 per tick, and stops at the first that asks or buys; `maybeRequestKeeperProbeForMarket` reports whether it did.

## Production runs the compiled server, not tsx (2026-10-10)

`npm start` ran `tsx src/cli/index.ts`: four processes (npm, sh, the tsx launcher, the app), and the app itself under tsx's loader
with source maps. On an empty database that is 259 MB against about 100 MB for the compiled server (162 MB with npm in front of
it), on a 512 MB Render box whose memory had been creeping up about 2 MB a minute, mostly outside the JS heap. Now `npm install`
builds `dist/` (a `postinstall` running `tsc -p tsconfig.build.json`, which compiles only `src/` so the output is `dist/cli/...`),
and `npm start` runs `scripts/start.mjs`, which imports the compiled server in its own process. If `dist/` is missing it
falls back to tsx and says so, instead of crash-looping. `@types/express` moved to `dependencies` so the production install can
type-check. `npm run start:tsx` keeps the old behaviour for debugging.

## Cross-system route costing no longer eats the server's CPU (2026-10-10)

Profiled the live server with the new `ops_profile` tool (15 s window, 80% busy, event loop stalling 2.5-6 s at a time): about
60% of all CPU was the jump-path search (`findJumpPath`, `jumpPath`, `gatesTo`, `connectedSystems`, `edgeUsable`), called by
`computeDispatchRoutes` for every cross-system trade leg, several times per leg (once per trader hold size plus the cost and
the trip time), with nothing cached. Those stalls are what made MCP calls time out, UI requests drop ("Load failed" on scrap)
and every ship step take seconds to minutes. `GalaxyAtlas.jumpPath` now caches per system pair and drops the cache whenever a
system, a gate connection or a gate's construction status changes; `FleetManager` memoizes trip cost and hops per system pair
for the length of a route pass. Same answers, far fewer searches (`tests/jumpGraph.test.ts`).

## ops_profile: see where the server's CPU and memory go (2026-10-10)

New read-only ops tool `profile` (MCP `stcommand_ops_profile`, HTTP `/api/ops/profile`) built on the Node inspector, with the
summarizing in `src/ops/profiler.ts` (pure, tested). `status` gives memory, V8 heap and event-loop delay; `cpu` profiles for up
to 30 s and returns self time by function and file; `heap_start` / `heap_report` / `heap_stop` sample allocations and report
which functions' live bytes grew since the start, with the calling stack. Added after the Render service (0.5 vCPU, 512 MB)
went from ~3% to ~47% CPU and from ~180 MB to over 400 MB in a day, with core passes that took seconds taking minutes.

## Tower: Metrics tab replaces Map (2026-10-10)

Tower's bottom bar swaps Map for Metrics, the same screen as Deck's (`public/shared/metrics.js`) with phone styling in
`m.css`. The radar map code was removed from `m.js` and `m.html` at the operator's request (not used). Deck keeps its map.

## Metrics screen in Deck (2026-10-10)

New rail item "Metrics": range buttons (1h, 6h, 24h, 3d), KPI tiles with the change against the window before (net trading,
per hour, credits, sales, profit per sale, overhead, fleet spend), a credits line and a net-trading-per-interval bar chart with
hover values, a pace-to-reset panel (projection at the window's rate against an editable target, and the rate needed), and
tables of profit by good, by ship (with hold size and per-hour) and by sell system, plus traders that sold nothing. Built
from the ledger by `src/engine/metrics.ts` (pure, tested), served by `GET /api/metrics`, rendered by `public/shared/metrics.js`.
See `docs/deck-desktop-design.md` §14.

## Sold ships now actually scrap; sold ships leave the dispatcher's pool (2026-10-09)

The "send to scrap" button only ever flew a ship to the yard. Traders, scouts and keepers were built without the `scrapHere`
handler, and the executor called it as `scrapHere?.()`, so on arrival nothing happened and nothing was logged (siphoners, miners
and the other ShipAgent roles had it). All three are wired now, a missing handler is logged instead of ignored, and
`tests/scrapWiring.test.ts` checks every agent construction in `fleet.ts` has one. Also, a sold ship with an empty hold no longer
counts as a trader in the dispatcher (THEO-27 kept being handed CLOTHING while it waited); a loaded one stays so its trip is
carried to the end.

## Route-first matching, built and switched off (2026-10-09)

New pure module `src/engine/matching.ts` and doctrine clause `routeMatchTopN` ("Best ship for the best routes", disabled by
default). Until now the dispatcher walked idle traders biggest hold first, so a route went to whichever big ship got there
first, however far it stood from the buy market or however little the route paid on its hold. With the clause on, each of
the top N routes (best first) is given to the idle ship that earns most from it at its own hold size (`profitByHold`), less
the time to reach the buy market; those ships are served first, in route order, then everyone else by hold size as before.
It only changes the order ships are served in: scoring, circuits, fuel and market-impact checks are untouched, and the
matched ship still picks by its own scoring. The dispatch log gets one `dispatch match: ROUTE -> SHIP (worth N, next ...)`
line per match. Off (or topN 0) reproduces the old order exactly (tested). The reachability check moved out of the per-ship
loop so it can be asked about any ship. Prompted by RELIC_TECH (about +1.1M a trip) going to a 40-hold ship.

## dispatch_tour no longer refuses the last tour ship in a system (2026-10-09)

Removed the guard in `dispatchTourShip` that threw when the ship was the only tour ship in its system. It dates from before
keepers; keepers now camp the markets that matter, and the guard blocked sending a lone tour ship to map a new system
(it forced hop-by-hop `jump_ship`). Operator's call. The playbook (step 7) now says when a tour ship may move on: once the system's waypoints are mapped and
at least one keeper, including one at a shipyard, is in place.

## Deck yard list shows ship specs; playbook: open systems early (2026-10-09)

Deck's Markets > yards panel now shows the same spec chips Tower's yard cards do (fuel, cargo, speed, crew, slots, mounts;
zero or unknown values left out). `docs/reset-opening-playbook.md` gains "Open more systems from the start": routes shrank
from 100k+ to about 50k a trip as eleven traders worked three systems, so next reset the tour ships go to every large
system as soon as the home gate opens (check `galaxy_gate_construction`, use `dispatch_tour`, keep `explorerTarget` at 0).

## Cross-system circuits, built and switched off (2026-10-09)

Same-system circuit pairs ran dry once every route on the board crossed a gate (all nine traders were on cross-system
routes at 21:44 UTC). A circuit can now be a round trip across a gate: leg 1 buys in A and sells in B, leg 2 buys in B and
sells back in A. The ship jumps there and back either way (a one-way cross-system route ends in an empty jump home); the
circuit fills the way back. New doctrine clause `chainCircuitCrossSystem` (disabled by default) feeds
`CircuitPolicy.crossSystem`; with it off, picks are exactly what they were, and there is a test for that.

Two things the same-system code got away with and this one cannot: a gate trip's `tripSeconds` is already one-way, so it
is not halved like a round trip; and a gate route's ranking score uses its one-way time, which hides the empty jump home.
Compared with that score, a circuit (about 55k a pair in the test) would never win against a 60k route that really earns
30k. The circuit is therefore credited against the route's rate with the return counted (half its score), and the gain
is added to the ranking score. Everything else (second leg kept for the ship, bail-out at half of plan, cash check, 60
minute expiry, restart persistence) is the same code path. Tests: `tests/circuit.test.ts` and `tests/dispatcherCircuit.test.ts`.

## A trader the operator sells now goes to the yard instead of trading on (2026-10-09)

THEO-27 was sold at 20:51 UTC ("flying to X1-AA31-A2 to be scrapped") and was still trading at 21:45: it flew a FIREARMS
leg, then bought 40 EQUIPMENT (about 115k) and started a two-jump trip. `TraderAgent.tick()` handled repair, hold, explore and
tender goals itself but had no case for `scrap`; `drivenByFleet()` is false for scrap, so it did not even log "standing down".
Every other role reaches `runScrapGoal()` through `runFleetDrivenGoal()`. The trader now runs it, but only on an empty hold:
scrapping destroys the cargo, so a loaded trader finishes the trip it is on first. Test in `tests/intentConsumption.test.ts`.

## Fleet row says "holding contract cargo", not "contract: X → Y" (2026-10-09)

The job label for a ship with no assignment was inferred from its hold: any good an open contract still wants printed as
`contract: HYDROCARBON → X1-JX83-G54`, which read as an order. A siphon drone full of HYDROCARBON showed it while sitting
in orbit (siphoners are not wired to deliver to contracts; only traders and miners are). It now reads
`holding contract cargo: HYDROCARBON (for X1-JX83-G54)` in Deck, Tower and v6.

## A refused finished leg no longer cancels the circuit's second leg (2026-10-09)

Seen live: THEO-33 delivered the first leg of a circuit (ASSAULT_RIFLES to J62, 86k) and its planned second leg (DRUGS J62
to H55) vanished with no log line; it was then given an unrelated route. Probable cause, not yet proven from logs: right
after a sale the trader still holds the leg it just finished as its assignment, re-checks it (the sale moved that price),
refuses it, and `decline()` threw away the commitment *and* the circuit, so the "leg 1 sold" signal never fired. `decline()`
now marks leg 1 sold when cargo had been seen aboard, and only drops the plan when the leg was refused before it ran.
Every other way a plan can disappear (release, manual route, expiry, circuits switched off) now logs
`dispatch circuit: <ship> dropped leg 2 <leg> — <why>`, so the next one is no longer silent.

## Who sent a hold, and an honest "why no circuit" line (2026-10-09)

- The dashboard's hold, release and dispatch routes now log the client (address, user agent, referer). THEO-62 was put
  under an operator hold mid-route at 17:43 UTC that the operator did not place; the MCP logs every call and showed none,
  but the dashboard path logged nothing, so the sender could not be told apart.
- The "circuit not better than the route alone" log compared the circuit's raw rate with the route's *discounted* score
  (so 496621 vs 209975 read as a bug). It now puts the circuit on the route's scale (positioning flight, extra-buyer
  penalty) first and prints both numbers.

## Circuit tuning knobs and a "why no circuit" log (2026-10-09)

The follow-on lookahead was switched off (it matched about 1 in 20 of its predictions to the ship's next buy), so circuits
are the only chaining left and the aim is to see them more often. Two doctrine rules, both only used while Two-leg circuits
is on, change what counts as a pair without a deploy: **Circuit reach** (`chainCircuitHorizonMin`, default 10 minutes, how
far apart the legs may be) and **Circuit return leg** (`chainCircuitReturnPct`, default 100): at 100 the second leg must end
near where the first began (a true loop, today's rule); at 0 only two loaded legs back to back are needed and the empty
flight back is not charged, which admits many more pairs. Trips here are short (one to three minutes), so a five-minute empty
hop each way outweighs the second leg unless the legs are almost touching, which is why circuits have been rare. Every route
that gets no circuit now logs why: `dispatch circuit: SHIP KEY - no circuit (N same-system legs, N free, N start within Xm of
the sale, N also end within Xm of the start)` or, when a pair exists but the route alone is better, the best pair's rate
against the route's. Defaults reproduce the previous behaviour.

## A cross-system route is only handed to a ship that can reach the gate (2026-10-09)

The dispatcher checked that a jump between two systems was possible, but not that the ship could fly to the gate in its own
system. THEO-27 (300 tank) was handed a JX83 route while standing in GY77 and 399 from the gate: it could not cruise that far,
found no fuel stop to relay it, and drifted for 2h09m. The same fuel-range test a same-system leg already gets (gate beyond
the tank and no fuel stop that relays it means unreachable) now applies to the flight to the first gate; the new
`crossSystem.gateFor` callback names that gate (`Galaxy.gatesTo`). With no gate known it behaves as before.

## Jumps cost time in the lookahead and circuit credits (2026-10-09)

A gate jump leaves the ship on a cooldown of about 10 minutes (every trader that had just jumped showed ~599s), but the
follow-on lookahead and the circuit credit priced it in credits only (a third of the jump). Cross-system follow-ons and
first legs were over-credited, and the six smaller traders spent most of the afternoon empty (THEO-51 empty for 176 of
180 minutes). `bestFollowOn` now charges each hop `jumpSeconds` (default 600, `JUMP_COOLDOWN_SECONDS` in chain.ts) as
empty time, scaled the same way as a same-system flight, and drops a path longer than the horizon (15 minutes, so one
hop); the circuit credit charges the same wait for a first leg in another system. Cross-system credits are not banned: a
pair that still earns enough after the wait is credited, which is the behaviour to keep as cross-system trading opens up.
The plain route score now counts it too. A cross-system route had no trip time (`tripSeconds` is only set for
same-system round trips), so it was ranked on raw profit per trip against same-system routes ranked per 10 minutes: a
cross-system trip beat them however long the jumps kept the ship busy, which is why the six small traders spent the
afternoon hopping systems and sitting empty. `computeDispatchRoutes` now gives a cross-system route a one-way trip time
(jump cooldowns for each hop plus `CROSS_SYSTEM_FLIGHT_SECONDS`, a 240s placeholder), and the dispatcher charges the wait
for getting to a buy market in another system against the score. A cross-system trip that earns enough per unit of time
still wins (THEO-62's FOOD haul is ~700k per ten minutes after the wait). Rankings shown as per hour on Deck and Tower
change for cross-system routes too.

## The server no longer exits when the database drops a connection in use (2026-10-09)

From 2026-10-08 17:02 the server process exited and restarted about every 15 minutes (21 times between 11:20 and 17:16 on
2026-10-09 alone), each time pausing every trader until the dispatcher re-assigned them. The log was always
`uncaughtException ... Connection terminated unexpectedly`, thrown from pg's client, right after several
`[db] idle connection lost` lines. The pool already had an `error` listener, but that only covers idle clients: a client
that is checked out (inside `withTenant`/`withPool`) had none, so when Postgres dropped every connection at once the error
became an uncaught exception. `createPool` now also puts an `error` listener on every new pooled client (logged as
`[db] connection lost while in use`); the query that was running still fails to its caller and the pool opens a fresh
connection on the next one. Why the connections drop: Render's `promptoria-db` is a 256 MB Postgres plan whose memory
swings between ~136 MB and ~257 MB of a 268 MB limit and falls back at each drop (connections 20 -> 7-8 at 15:15 and
16:55), with the app holding 20 pooled connections, so the database is being restarted for lack of memory. That is a
plan-size decision, not changed here.

## Two-leg circuits, off by default (2026-10-09)

Second step of `docs/backhaul-plan.md` (v2). Lookahead only nudges which route an idle trader picks; it cannot stop a
second trader taking the return leg, and it never required that leg to end where the first began. A circuit is a pair:
buy A and sell B, then buy near B and sell near A. Nothing changes until the new doctrine clause **Two-leg circuits**
(`chainCircuitWeight`, 50%, clause disabled by default) is switched on; with the clause off the dispatcher is exactly as
before (covered by a test), and turning it off again releases every held leg.

- `src/engine/circuit.ts` (pure, tested): `bestCircuit()` finds the best second leg for a route (starts within 10 minutes
  of the sale, ends within 10 minutes of the first buy, a different good, same system), scores the pair over the whole
  cycle including both empty hops, and `circuitScore()` credits the weighted gain over the route's own score. `judgeLeg2()`
  is the bail-out: the second leg is dropped if it is gone, unprofitable or has fallen under half its planned score.
- The dispatcher keeps the second leg for that ship (`RouteDispatcher.circuits`): other traders are not handed or credited
  it, and once the first leg's cargo has been sold the ship is given it ahead of the normal pick. Plans expire after an
  hour, and `release`, `decline` and a manual assignment drop them. For a route that has a circuit the circuit replaces
  the follow-on credit; routes without one still get the follow-on credit. Assignments carry an informational `circuit`
  field and the log has `dispatch circuit: ...` lines.
- Visibility: a trader's route label on Tower, Deck and the desktop Fleet tab now carries a short note after the good,
  `chainNote()` in `public/shared/domain.js`: " · then ALUMINUM JX83-H55 → JX83-D44" for the follow-on the dispatcher has
  lined up, or " · circuit 1/2, back via CLOTHING" / " · circuit 2/2" for a circuit. Read-only; nothing shows with the
  clauses off.
- A first leg in another system is credited for what it earns AFTER the jump cooldown, not only its credits. Live
  (2026-10-09) THEO-51 and THEO-27 were planned GY77 pairs while standing in JX83 and sat empty, because the score
  charged a jump as credits and no time. See "Jumps cost time" below.
- The trader is unchanged. It still flies one assignment at a time and keeps its own wallet and viability checks, so a
  second leg it refuses is simply dropped.
- Cash: when the second leg comes up the dispatcher checks the spendable cash (wallet less the cash floor, after the first
  leg's proceeds) against the planned load, and drops the leg if it would buy under half of it (`minCashShare`).
- Restarts: pending circuits are saved to the tenant's `fleet_flags` (key `dispatchCircuits`, written only when they
  change, cleared by a server reset like the rest of the game state) and restored at start-up, so a deploy between the
  two legs does not lose the return leg. A restored plan whose first leg was never seen to sell in this process is
  dropped rather than assumed; the trader's held-route pin still carries the cargo either way.

## Holds and credits move together on the dashboard (2026-10-09)

Credits update the instant a trade response arrives, but hold values came from the agents' own cached ships (a tick
behind) and were cached for 15 seconds, so Credits + holds swung by about a cargo's worth right after a trade. The
dashboard now prices the hold from the same live per-ship cargo it shows beside the credits (`FleetManager.cargoValues`
takes it), and the cache is dropped as soon as any hold changes (`cargoSignature`). The MCP `get_cargo_value` tool is
unchanged.

## Follow-on lookahead and the deadhead measure, off by default (2026-10-09)

First step of `docs/backhaul-plan.md`: traders spend a lot of time flying empty after a sale, and the dispatcher scored
each route only from where the ship stands. Two additions, neither changes behaviour until switched on:

- `src/engine/chain.ts` (pure, tested): `bestFollowOn()` finds the best route that can start where a route sells, and
  `chainScore()` adds a weighted share of it to the route's score. The dispatcher calls it per idle trader when the new
  doctrine clause **Follow-on lookahead** (`chainFollowOnWeight`, 50%, clause disabled by default) is on; the chosen
  follow-on is recorded on the assignment (`followOn`) and logged as `dispatch chain: ...`. The trader is unchanged.
  With the clause off, `followOnWeight` is 0 and the dispatcher is exactly as before (covered by a test).
- New ops tool `stcommand_ops_deadhead` (`src/engine/deadhead.ts`): per ship and fleet, the share of time loaded vs
  empty and realized profit per loaded hour, from the ledger. The baseline to judge the lookahead against.

## Rate is now net trading pace over the last hour (2026-10-09)

The Rate on Deck's top bar and Tower Home was a 3-hour lagged average of wallet movement, so open cargo and ship
purchases read as losses (-74,822/hr while traders were mid-trip, the day keepers were bought). It now shows net
trading pace: realized profit on sales minus fuel and jump costs over the last 60 minutes, per hour, with an arrow
against the 3-hour average and (Tower) a sparkline of the trailing-hour pace over 5 hours. Cargo and ship purchases
don't count, so it equals the change in wallet + holds at cost, ships excluded. `/api/bridge` gains `pace`
(`src/engine/pace.ts`, `Store.tradingPaceBuckets`); the old `rate` field is unchanged for the v2-v6 pages.

## Tower Home drops the Best route tile (2026-10-09)

Removed at the operator's request. The tile showed the single best assignment's profit per trip, which is
still on the Deck routes list; Home keeps Credits, Credits + holds, Rate and Fleet.

## Hold values fall back to stored prices after a restart (2026-10-09)

After a deploy the in-memory market registry is empty until ships and keepers
re-read their markets, so a full hold (THEO-31's 80 ADVANCED_CIRCUITRY, ~441k
paid) showed as unpriced and "Credits + holds" read ~500k short for several
minutes. `FleetManager.cargoValues()` now falls back to the stored
`market_latest` snapshots for any market the registry has not got; the live
registry still wins when it has one.

## Credits + holds at the top of Deck and Tower (2026-10-09)

A second number beside Credits: the wallet plus the estimated proceeds of every
hold (`walletPlusHolds` in `public/shared/domain.js`, fed by `cargoValues` from
`/api/state`). Deck: "+ Holds" in the top bar; Tower: a "Credits + holds" tile
on Home. A trailing "+" means some cargo has no known price, so the figure is a
floor. Prompted by three traders buying at once and taking the wallet to 13k:
the wallet alone looked like a collapse while the money was sitting in cargo.

## Deck fleet table shows potential profit per hold (2026-10-09)

A Profit column on the Fleet tab next to Value: the hold's estimated proceeds
minus what we paid (cost basis from `ship_manifest`), green when positive and
red when negative. It shows "?" when there is no cost basis on file or part of
the hold is unpriced, since the difference would be wrong in both cases. Helper
`cargoProfit` in `public/shared/domain.js`.

## Keeper probes are bought at the cheapest yard (2026-10-09)

A market-triggered keeper request (`maybeRequestKeeperProbeForMarket`) chose
the keeper hull first and then the yard *nearest the target*, ignoring price.
At X1-MG54 that meant a probe at A2 for 124,017c while C38 sold the same probe
for 55,589c. It now takes the highest-preference hull any yard in the system
stocks (probe, then surveyor, then drone) and buys it at the cheapest yard,
using only prices seen in the last 10 minutes; if no yard has a fresh price it
falls back to the stored ones rather than propose nothing. Ties go to the
nearer yard. Logic is `src/engine/keeperYard.ts`. The shipyard-triggered path
is unchanged: it only ever sees the yard a ship is standing at.

## Deck lists the top 20 routes, like Tower (2026-10-09)

Deck's Markets > Routes list showed only the top 5 routes while Tower shows 20, so the operator could not see how far the
profitable routes ran down. Deck now lists the top 20 (the panel already scrolls) and its header count says so.

## Feed carriers back off when the margin gate blocks them (2026-10-09)

A feed whose buy fails its margin gate (the source's ask above what the target pays, plus `maxLossPerUnit`) retried every
15 seconds, and each retry re-reads the ship and its hold first (2 API calls) before it re-checks the price. On
THEOREM_DEV_2 three stuck feeds (iron, copper, aluminum, gaps of 19-37c against an allowance of 15) were measured at about
105 calls per 5 minutes, a fifth of the shared budget, for nothing. A blocked carrier now waits 30s, then doubling up to
5 minutes (`marginWaitMs`), and any clear pass resets it. Separately the allowance on those three feeds was raised
(set_feed_limits maxLossPerUnit 15 -> 50): our own buying moves the source's ask up by more than 15, and leaving the
feeds blocked starved the producers (F51 went back to RESTRICTED).

## Deck's Markets tab gets Tower's Systems segment (2026-10-09)

Tower's Markets tab has a Systems segment: pick a system, see every market ever priced in it (any age, from
`GET /api/markets/known`, since a stale market is exactly the one that needs a keeper), each with the keeper badge to add
or remove it from the keeper list. Deck had only the per-good Prices list and the raw Keeper textarea, so that workflow
was phone-only. Deck's Markets panel now has the same Systems segment (a system picker and the badge list, with the
age and goods count per market), sharing the existing `keeperBadge()` and `toggleKeeperPriority()`.

## Value of what a ship is carrying, on Deck and Tower (2026-10-08)

Operator wanted to see how much capital sits in holds (with five haulers loaded the wallet reads far lower than the
fleet is worth, and the wallet-contention question depends on it). `cargoValue()` (`src/engine/cargoValue.ts`) prices
each good a ship carries at its own route's sell market (live snapshot, falling back to the route's quoted price),
otherwise at the best price any market in its system pays, then takes off our own per-lot price impact (the dispatcher's
`slippageCredits`), so the figure reads as roughly what the hold would fetch rather than the list price. Goods with no
known price are counted separately and shown as `+` (partly priced) or `?`. `FleetManager.cargoValues()` caches it for
15s, adds the per-unit cost basis from the cargo manifest, and `GET /api/state` returns it as `cargoValues` keyed by
ship. Deck gets a Value column in the fleet table plus the figure in the hold heading, per-good lines and map detail;
Tower gets it on the hull card's Hold gauge, the roster row and the hold heading. The tooltip shows each good's price,
which market it is priced at, and the cost basis on file (the manifest keeps the last purchase price, so it overstates
the average paid for a multi-lot buy). `stcommand_get_cargo_value` returns the same per ship plus the fleet total and the
wallet, for status reports.

## Keepers poll quiet markets less often (2026-10-08)

Keepers were about 36% of the API budget (a ship read, a market read and a shipyard check every 5 minutes each), and the
limiter was at 90 of 90 a minute. Prices over the last 6 hours on JX83/AA31/GY77 (372 series): when a price moves it
moves about every 27 minutes (IQR 18-33), 41% never moved, and only 12% of 5-minute-apart readings differed, so most
polls re-read an unchanged market. A keeper now waits a third of the time its market has sat unchanged, between 5 and 30
minutes (`keeperPollDelayMs`, `FleetManager.keeperPollMs`); any ship's snapshot counts as a change, so a market a trader
works keeps the 5-minute cadence, and 30 minutes is well inside the 90-minute intel window. A keeper already docked at its
market also skips its own ship read (nothing but this fleet moves it, and the 30s sweep keeps a copy). Expect roughly 70%
fewer keeper calls; to be confirmed against the limiter's per-caller counts.

## Dashboard credits move at the trade (2026-10-08)

Deck and Tower showed the balance from a 20s agent read (`GET /my/agent`, routine priority) polled by the browser every
15s, so a sale could take 35s or more to show, longer when the shared limiter was full and the read waited in the queue
(operator watched two sales and saw no change). Every trade and purchase response already carries the wallet, so the
client now hands it to `FleetState.setCredits()` straight away; the 20s read stays as the correction.

That left the balance ahead of the hold (operator saw 300k leave with no cargo change: a 290k ANTIMATTER buy whose cargo showed on the next 20s read), so the same response's `cargo` now also goes to `FleetState.setShipCargo()` (`Client.onCargo`) and the two move together.

## MCP tool to start the gate mission (2026-10-08)

There was no MCP way to start a construction mission (only the dashboard's start control), so a session driving a
tenant over MCP could not run the opening playbook's step 5. `stcommand_start_mission` starts the mission for a gate
under construction and, when pacing fields are passed, applies them before any buying: it starts, pauses, sets the
pacing, then resumes, so a new mission never sources at the default 40% ceiling.

## Max lots per trip is a doctrine rule (2026-10-08)

A trip's volume has been `min(hold, what the wallet allows, lot size x MAX_LOTS_PER_TRIP)` with the constant fixed at 3
(`dispatcher.ts`). With 80-unit light haulers that caps a good that trades in lots of 18 at 54 units and one in lots of 20
at 60, however big the hold: ledger `wallet_after` showed those part-filled buys leaving 600-900k in the wallet, so the
cap, not cash, was the limit. It is now the doctrine rule `maxLotsPerTrip` (default 3, range 1-12, adopted by default so
nothing changes until it is edited), visible and editable on the dashboard's Doctrine tab and through
`stcommand_set_doctrine`. `computeDispatchRoutes()` (route profit figures) and every trader read it live, so a change
applies from the next route plan. Each extra lot still moves the price ~4.5% against us; the route profit model charges
for that, so a higher cap trades per-unit margin for fuller holds.

## The ledger records the wallet balance at each trade (2026-10-08)

Many traders buy from one wallet, so how full a hold gets depends on what the previous trader left. Cash read every 20-30
minutes cannot show that (it can swing by hundreds of thousands inside a minute), and rebuilding it from transactions
needs anchors and drifts by the untracked ship and jump costs. `ledger` now has a `wallet_after` column
(`migrations/045_ledger_wallet_after.sql`): every row is stamped with the balance from the game's own response to the
trade. `SpaceTradersAPI` keeps the latest `agent.credits` seen on a sell, purchase or ship purchase
(`lastKnownCredits`), and the tenant's ledger writer adds it to each entry. With several ships trading at once the value
can already include a neighbour's transaction that landed a moment later, so read it as "the wallet at about this
trade". Rows from before the deploy stay NULL. Dashboard and MCP reads are unchanged.

## The last-tour-ship guard now covers every system, not just home (2026-10-08)

`dispatchTourShip` refused to send away the only tour ship in the HOME system, but checked nothing elsewhere. THEO-1
was AA31's only tour ship and was sent on to GY77 without a word, leaving AA31's unkept markets with no price updates
(the operator: it could not leave without another tour ship in the system last week). The check now counts tour ships
standing in whichever system the ship is in, and the refusal names that system. No test covers it: it needs a full
`FleetManager`; verified by typecheck and reading the diff.

## Route cards show the profit per hold size (2026-10-08)

The route list priced every route at the fleet's biggest hold, so once 80-unit light haulers joined the 40-unit
shuttles the per-trip figure read ~1.6x what a shuttle earns. `computeDispatchRoutes()` now also returns
`profitByHold` (net per trip for each distinct trader hold size), `/api/market/routes` passes it through, and the Tower
route card adds a `40u +64,240 · 80u +104,680` line when the holds differ. The headline `/trip` figure is unchanged
(still the biggest hold's), and the dispatcher still ranks on it, which is open in `docs/TODO.md`.

## Drone hulls no longer set the route-costing speed (2026-10-08)

The route list costs every trip at the slowest flying hull's speed (`fleet.ts`, `fleetSpeed`). When THEO-17, a
mining drone (engine speed 9), was made the home tour ship, it became that slowest hull and every modelled trip
stretched ~1.7x against the 15-speed shuttles, lowering every dispatcher ranking score. A drone never takes a
trade route, so `FRAME_DRONE` hulls are now left out of that speed. Related, not changed: the displayed
profit-per-trip is priced at the fleet's biggest hold, so after the 80-unit light haulers arrived it reads about
1.6x what a 40-unit shuttle earns (E45 -> J62 ASSAULT_RIFLES: ~104.7k at 80 units, ~64k at 40). Per-ship pricing
is open in `docs/TODO.md`.

## Feed routes answer a refusal as JSON, not a bare 500 (2026-10-08)

Removing COPPER_ORE from the dashboard threw a 500 (three tries, 11:20 UTC). COPPER_ORE → H55 had both a buying and a
mining feed, and the request did not say which (`mine` omitted), so `FeedManager.resolve()` refused with "say which with
mine=true or mine=false". The feed routes have no try/catch, and Express 5 answers an uncaught async throw with an HTML
500 that hides the message, so the page showed nothing useful. The other feeds had a single mode each, which is why they
removed fine. Removing each with `mine` set worked straight away (buying feed, then mining feed).

The dashboards in this repo (Tower `m.js`, Deck `deck.js`, `v6.js`) already send `mine` on remove, so the request most
likely came from a tab loaded before 2026-10-07 01:28 UTC (commit 0d2dcdf) that never reloaded. Not confirmed.

- The ambiguity refusal now carries status 409.
- The dashboard router ends with a `jsonErrors` handler (`src/http/jsonErrors.ts`): an error thrown out of any route
  without its own catch answers JSON `{ error }` with its status (500 if it has none), so the toast shows the reason.
  Test: `tests/jsonErrors.test.ts`.

## The gate mission no longer spends below its cash floor (2026-10-08)

`cashFloor` only decided whether the mission bought at all. The lot itself was sized from the whole balance, so once
cash was above the resume level, one stop could spend nearly all of it. Live: THEO at ~260k bought 25
ADVANCED_CIRCUITRY for 184,475 at 02:47 with a 200k floor and fell to ~25k, which left its traders short of cash
for their own cargo. The 2026-10-07 multi-transaction change made this worse, because a lot could now be bigger than
one 20-unit transaction. The lot is now sized from `credits - cashFloor`, and the mission waits when less than one
unit fits. Tests in `tests/missionPacing.test.ts`.

## Contracts past the 20th are seen again, and negotiating docks first (2026-10-08)

Two bugs kept agents off contracts, which pay 120-230k each for manufactured goods.

- `getContracts()` read only page 1 of `/my/contracts` (20 per page, oldest first). The one open contract is always the
  newest, so once an agent had done 20, the engine never saw another one. THEOREM_DEV_2's 21st offer (MEDICINE, 16 to
  A1, 154,416) sat unaccepted for about 3.5 hours while the fleet kept trying to negotiate a new one. It now follows
  `meta.total` to the last page and remembers it, so a refresh is still usually one call. Test:
  `tests/contractPaging.test.ts`. (Live, I accepted that MEDICINE contract by hand and flew it with 2-3: +70,848.)
- `maybeNegotiateContract()` picked any ship not in transit, usually an orbiting drone, and every try failed with
  "Ship is not currently docked" (THEO, about once a minute after its ALUMINUM_ORE contract finished). It now prefers a
  docked ship and docks the fallback first.

## Mission and feed ships no longer freeze on the dashboard (2026-10-07)

While a construction mission or feed flies a ship, the ship's agent is suspended, and the agent was the only thing that
refreshed the cached snapshot the dashboard and fleet status read. The managers read the ship through the raw
`api.getShip`, so the UI froze on the last pre-suspension state: THEO-1 showed "IN_TRANSIT -> I59 with 20u" for over an
hour (operator watched it the whole drive home) while it had delivered and sat DOCKED empty at D44, and earlier "in
orbit at I59" while docked at F53. `MissionManager` and `FeedManager` now get the ship through `FleetManager.liveShip()`,
which writes every live read back via the existing `noteShipState()`. Closes the high-priority TODO item.

## A mission lot larger than the market's trade volume is bought in several transactions (2026-10-07)

The construction mission made one `purchaseCargo` per stop, capped at the market's per-transaction trade volume, so
`buyLotUnits` above that volume did nothing. Live: D44 sells ADVANCED_CIRCUITRY 20u/tx, the operator set lot 40, and
THEO-1 kept buying 20 and flying its ~40 minute D44 -> I59 round trip half empty. `MissionManager.stepCarrier` now
buys the lot in trade-volume chunks in the same stop, stopping early at the price ceiling, at the cash floor, or on a
failed later transaction (the first chunk failing keeps the old block-and-retry path). Without pacing this also fills
the hold instead of buying one trade volume. Tests: `tests/missionPacing.test.ts`.

## A trader that refuses its assigned route gets a new one instead of idling for hours (2026-10-07)

When a trader declined the dispatcher's auto leg (margin under its floor, a protected good, a dead route), it fell
through to "discovering prices" while the dispatcher kept it *committed* to that leg: an empty trader's commitment only
lapsed after `COMMIT_GRACE_MS` (3h) or when it stood at the buy market with the route gone from the list. Confirmed
live 13:04-13:40: THEOREM_DEV_2-1 held FOOD K92 -> A1 (margin 195-261c, floor 300c) and ping-ponged K92 <-> A1 with an
empty hold, refuelling 25 times; THEOREM_DEV_2-3 held POLYNUCLEOTIDES E49 -> F53 (protected for a contract). Both
traders were idle for 35+ minutes with CLOTHING worth 35,519c a trip unassigned.

The trader now calls `RouteDispatcher.decline()` when it rejects an auto leg for any reason other than missing prices
(which discovery fixes). That drops the assignment and its commitment and keeps the leg out of that trader's picks for
15 minutes (`DECLINE_MS`); the trader's next tick claims the best leg it can fly. Manual pins are never declined.
A protected-good refusal blocks every leg of that good for the trader, since it is refused at any market.

Follow-up the same afternoon: with declines working, the dispatcher still handed out one sub-floor leg after another
(13:45-14:11: FOOD +208, COPPER +61, FABRICS +167/+179, AMMUNITION +179, FERTILIZERS +100 against a 300c floor), each
costing a recompute and a discovery hop. It now drops direct legs at or under `effectiveMarginFloor(marginFloor,
buyPrice)` (the trader's own check, same doctrine value) before assigning. Tests: `tests/dispatcherDecline.test.ts`.

## The chain guard lets traders deliver protected goods to the chain's own producers (2026-10-07)

Operator: "we're leaving money on the table." `protectChainGoods` drops every route for a good in an open gate's
supply chain so traders don't drain a producer's inputs, but it also dropped the routes that feed the chain. On THEO,
MICROPROCESSORS A3 -> D44 (+1,487/unit, ~59k a load) and ELECTRONICS F53 -> D44 (+1,383) were hidden while D44 is the
ADVANCED_CIRCUITRY producer, and the dispatcher had all six traders on legs worth +40 to +2,700 a trip; two pins were
the stopgap. `chainSinks()` (supplyChain.ts) now maps each chain good to the markets that EXPORT a chain link made from
it (a gate material or another chain good), and `computeDispatchRoutes()` keeps a protected leg when its sell side is
one of those markets. Selling a chain good anywhere else is still blocked; the 'protected' log line now names the
allowed sinks (`tests/supplyChain.test.ts`).

## A tour ship in a corner hops toward stale markets instead of ping-ponging (2026-10-07)

THEOREM_DEV_2-5, made a tour ship at 04:02 because 13 of X1-XJ90's 24 markets had gone 8-10 hours unseen, flew
I59 <-> J61 every seven minutes for 40 minutes. Fuel was fine (it refuels to 300 at every stop); the target pick was
the problem. From the I59 gate corner every stale market is 340-600 units away, beyond one 300-fuel leg, so the
stale-first, nearest-next sort only ever offered the two fresh corner markets, each the other's nearest. When no stale
market is in range, `steppingStone()` (agent.ts) now picks the reachable market that gets closest to one, as long as
that is closer than where the ship stands; each hop strictly shortens the distance, so it cannot cycle
(`tests/tourSteppingStone.test.ts`). Likely the same cause as the J61 <-> J62 bounce of 2026-10-06.

## Fleets wait for the old instance to stop; mining drones dump junk in one call (2026-10-07)

Two follow-ups to the trader-starvation incident below, shipped together so they cost one restart.

**Boot gate.** A Render deploy starts the new instance, passes its health check, moves traffic, and only then sends the
old instance SIGTERM, so both used to fly the same ships for that gap. `src/core/instanceGate.ts`'s
`waitForPredecessor()` now holds every tenant boot (`TenantRegistry.setBootGate()`, eager and request-triggered alike)
until no instance that started earlier has written a heartbeat in the last 15 s (heartbeats are every 10 s), capped at
90 s, and proceeds at once if the heartbeat table can't be read. The web server still starts immediately, since the
old instance is only stopped once the new one is healthy.

**Drone junk.** A mine feed drone cleared each off-target ore through `sellCargo`: a ship read, a dock, a sale the
field's market refused, then the jettison, plus an orbit before the next extraction, then a fresh ship and cargo read
on the following pass before mining. With 10 drones on CE5D jettisoning ice, copper, aluminum and silicon nearly every
cycle, that was about two thirds of the shared budget. The mine branch now dumps junk worth under 2,000c with one
`jettison` call (`FleetManager.dumpJunk()`, same value guard as before) and mines in the same step; anything it refuses
still goes through the full clear (`tests/feedJunkDump.test.ts`, `tests/instanceGate.test.ts`).

## Slow keeper tasks no longer hold traders for half an hour (2026-10-07)

Operator check on THEO-C and THEO-30 "not going the right way": every route assignment was correct, but traders were
acting about once every 30 minutes. `Scheduler.runOnce()` ran one pass over a ready list fixed at the start, strictly
in order. With the limiter busy (10 feed-driven mining drones at mission priority), each of THEO's ~26 keeper tasks
waited ~35 s for its DEFERRABLE market call, so one pass took 30+ minutes; THEO logged no scheduler heartbeat from
02:12 to 03:15, and a trader that came due a second after its own turn waited for the rest of the pass. A pass now ends
once it has run something and spent `PASS_MAX_MS` (5 s), so the next pass re-sorts and a trader waits at most one slow
task. Tasks not reached stay queued and lead the next pass at their own priority (`tests/schedulerPassCap.test.ts`).

Same incident: two pushes 50 s apart (03:06:54, 03:07:44) meant two instances drove THEO at once for ~30 s and then
~60 s (three in total), which showed up as doubled refuels, a FABRICS sell for 30 units on a ship holding 20, and "ship
is in transit" errors. Fixed by the boot gate below; still batch documentation pushes, each restarts both fleets.

## A buying feed and a mining feed can supply the same market (2026-10-07)

Operator request: feed QUARTZ_SAND into F53 by buying it at B7 *and* by mining it at CE5D at the same time. Feeds were
keyed by (target market, good), so a second feed for the same good replaced the first. The source mode is now part of
a feed's identity: `FeedManager.key()` gives a mining feed its own key (a buying feed keeps the old one, so existing
feeds are untouched), `migrations/044_feed_source_key.sql` widens the unique constraint to
`(tenant_id, target_waypoint, good, mine)`, and every per-feed operation (limits, pause/resume, carriers, crew size,
sell gap, remove) takes an optional `mine`. Omitted, it acts as before when the good has one feed and refuses to guess
when it has both. Assigning a carrier without `mine` puts a miner on the mining feed and a trader on the buying one;
the collector settings always mean the mining feed. The chain-health view adds both crews up into one input. MCP tools
`stcommand_remove_feed`, `stcommand_set_feed_limits`, `stcommand_assign_feed_carrier` and
`stcommand_remove_feed_carrier` and the dashboard feed routes accept `mine` (MCP also takes the strings "true"/"false", for
clients holding a tool list from before the change). Deck, Tower and v6 feed rows carry `data-mine` and send it with
every per-feed action, so their buttons act on the right feed when a good has two. Tests: `tests/feedSourceKey.test.ts`.

## Pinned routes plan against the live balance and wait at their buy market (2026-10-06)

Right after a big sale the fleet's cached balance trails the wallet by minutes. A pinned trader sized its load against
that cached figure, so on THEOREM_DEV_2 ships docked at their buy market were rejected with `volume=0 ... credits=242`
while the wallet held 130k, and the fallback sent them off empty to "discover prices" — four times in one evening, each
costing a 20-30 minute empty round trip. `TraderAgent.runArbitrage()` now reads the live balance (`spendableNow()`) before
planning a pinned route and route planning prefers it while it is under a minute old (`creditsForPlanning()`), and a
pinned ship that still can't fly its route goes to (or stays at) its buy market and retries next tick instead of
wandering. Tests: `tests/pinnedRouteSafety.test.ts` ("pinned route affordability").

## Pinned routes stop themselves at a negative margin or after two losing trips (2026-10-06)

A route pinned with "Assign route" / `stcommand_assign_route` is an operator override: the trader skipped the live
margin floor before buying (comparing against the sell price typed when it was pinned) and the loss floor when selling.
On THEOREM_DEV_2 a pinned ALUMINUM H55 -> D47 route made ~3.9k a trip for 16 minutes, then kept going while its own
trades ran H55's buy price from 167 to 552 and pushed D47's sell price from 266 to 127, losing ~50k in 18 minutes.
`TraderAgent` now still skips the margin *floor* for a pinned route, but refuses to buy when the live buy price is at or
above the destination's latest recorded sell price, and counts losing trips on the pinned good: two in a row, or the
negative-margin check, unpins the route (`stopManualRoute` -> `FleetManager.setManualDispatch(ship, undefined)`), logs
`pinned route stopped: <reason>` and returns the ship to the dispatcher. Tests: `tests/pinnedRouteSafety.test.ts`.

## Ship-sweep measurement dated by request, with status transitions (2026-10-06)

The first Phase 1 summary read 80% matched, but the sweep copy was dated by when the paged list came back. A ship that
docked, orbited or navigated while that request was in flight could be in the copy or not, and either way it scored as a
mismatch instead of "acted since". `FleetManager.sweepShips` now dates the copy by the send time, so those reads are
excluded the way Phase 2 would exclude them. Status mismatches are also broken down by transition (e.g.
`DOCKED->IN_ORBIT 3`) in the five-minute `ship sweep:` line, to tell a race from a copy that is really stale.

## A dropped database connection no longer crashes the process (2026-10-06)

At 16:56 both running instances exited at the same moment with `uncaughtException — exiting: Error: Connection terminated
unexpectedly`: the shared Postgres dropped idle connections, `pg` reports that as an `'error'` event on the pool, nothing
listened for it, and the process-level handler added earlier the same day exits on any uncaught exception. It also
failed the deploy in flight (Render marked `1ec04c8` `update_failed` and kept the previous build), and the restarts
overlapped long enough to cause a short burst of 429s. `createPool()` now handles the pool's `'error'` event with a log
line; the pool already discards the broken client and reconnects on the next query.

## Shipyard reads cached; batched ship reads, phase 1 (measure only) (2026-10-06)

**Shipyards.** The ship, scout and siphoner purchase checks re-read every shipyard on every maintenance pass
(`shipyard <- FleetManager.maybeBuyShip`, 17-19 per five minutes) only to decide whether to *ask* for an approval, and every
dock at a shipyard took a fresh snapshot (15-20). Both now trust a listing for five minutes (`cachedShipyard`,
`recordShipyardSnapshot`), and a dock snapshot also feeds the purchase cache. The purchase itself (`buyShip()`) still
reads the yard live.

**Batched ship reads, phase 1.** The biggest remaining use of the budget is the `GET /my/ships/:id` each agent step
starts with, and it grows with the fleet. `GET /my/ships` returns twenty complete ships per call, so a periodic sweep
could replace most of those reads — if its copies are good enough. This phase only measures: a sweep every 30s
(`FleetManager.sweepShips`, a fourth coordinator loop, routine priority, about 4 calls a minute) feeds a
`ShipSnapshotBoard`, the API client reports every single-ship read and ship action to it (`Client.setShipObserver`,
observation only), and each read is scored against the latest sweep copy the way Phase 2 would have used it. A
`ship sweep: …` line every five minutes gives the match rate and which fields disagree. No agent reads the copies yet.
The plan for phases 2 and 3 is in `docs/TODO.md` ("Batch ship reads").

## Dashboard refresh no longer stacks up; unfinished gates are re-read every 5 minutes (2026-10-06)

**Refresh pile-up.** The two-cadence dashboard refresh (earlier today) recorded `lastFullAt` only after its reads came
back, and its full read runs at background priority, where a call can wait most of a minute. The timer fires every 20s,
so each tick launched another full refresh behind the one still queued: the limiter counted 24 ship-list calls
(`ships <- refreshState`) in five minutes where a full read every two minutes should make about five. The timer now runs
one refresh at a time and claims the full read when it starts.

**Gate construction.** `GalaxyAtlas.refreshGateConstruction` re-read any gate still known to be unfinished on every ask,
and the scout's reachability check (`scoutCanReachUncharted`, every maintenance pass) asks about each gate — 12-16 calls
per five minutes. An unfinished gate is now trusted for five minutes; one never read is read at once, and a completed gate
stays cached forever as before. The test that pinned "re-fetch a gate still cached incomplete" now checks it after the
recheck interval.

## Contracts the operator has stood down are no longer polled every 30 seconds (2026-10-06)

`ContractManager.fetchContracts` (called through `listActive` by three coordinator steps) re-read `GET /my/contracts` every
30 seconds for as long as a contract existed, about 4 calls a minute, plus a second read of the same list in the dashboard
refresh. Also in the Ops contracts panel (`v6.js`): an accepted contract no longer shows a red "accept by expired" label — that deadline only applies to an offer. When every open contract is something the operator told the fleet not to work — an accepted contract that was
abandoned, an offer that was declined — nothing delivers against it, so nothing changes the list from our side; only a
deadline passing does. The cache now lives an hour in that state, as a safety net only: a deadline passing needs no
polling to notice (an expired contract stops counting as open, which ends the stood-down state, so the next read goes
out at the normal cadence), and every operator decision (`decline`, `undecline`,
`abandon`, `resume`) invalidates it so picking a contract back up is immediate. A list with no open contract is not
"stood down": the fleet wants to negotiate a new one, so it keeps the 30s cadence. The dashboard refresh now reads the
contracts through the same cache instead of making its own call.

## Orbit and dock take the new nav from the response (2026-10-06)

`ShipProxy.refresh` (a `GET /my/ships/:id`) was the largest single source of game-API calls, 70-83 per five minutes. A
big share came from `ensureInOrbit()` and `ensureDocked()`, which called the orbit or dock endpoint and then read the
whole ship back — though both endpoints return the ship's complete `nav`. They now apply the nav from the response
(`applyNavOrRefresh`), falling back to the read when a response has none. That removes roughly the 30 read-backs a
five-minute window held (about 6 calls a minute). The remaining refreshes are the per-task read at the start of each
agent step, which is the agents' ground truth and left alone.

The limiter's caller attribution now names two frames (`ShipProxy.refresh < ShipAgent.tick`) so the remaining refreshes
can be traced to the step that makes them; the log lists the top twelve.

## Dashboard snapshot built from the engine's own ships; a shutting-down instance stops calling the API (2026-10-06)

**Snapshot.** The dashboard's live state (credits, every ship, contracts) came from one refresh that listed every ship
through the game API (two pages at 40 ships), and an earlier change this day put it on a 45s timer at the lowest
priority, so credits and ships could be a minute and a half old. It now has two cadences. Every 20s at routine priority:
the live agent (one call) plus the ships as the engine already holds them (`FleetManager.currentShips()`, no API
calls). Every 2 minutes at background priority: the game API's own ship list and the contracts; any ship it lists that
the fleet doesn't drive yet is merged in. Credits and ship positions are fresher than before and the refresh costs about
a third of the calls. A ship the fleet has just sold can linger in the list for up to two minutes, until the next full
read.

**Deploy 429s.** Every deploy produced a minute of "rate limited, backing off" lines: Render keeps the old instance
running until it is told to stop, both share one IP's 1.5 req/s, and the old one kept working through its queue and any
in-flight pass (a feed step can run for a minute) after SIGTERM, because `stopAll()` only stopped *new* passes. SIGTERM now
also drains the shared `RateLimiter` (`drain()`: every waiting request is rejected, every later one fails at once) and
forces exit after five seconds if an open connection keeps `server.close()` waiting. The overlap that remains is the new
instance's own boot.

## Crew ships in flight are no longer polled (2026-10-06)

With the calls named, the biggest remaining source was the feed and mission loops: on every pass they read each crew ship
and returned early if it was still flying, so a carrier on a ten-minute leg, or a collector on a long haul, was re-read
every few seconds the whole way. `FeedManager.getShip` (53 per 5 minutes) and `MissionManager.getShip` (41) were about 20%
of all game-API calls between them. Neither loop can do anything with a ship until it lands, so they now sleep it until its
arrival time (`transitResumeAt()`, capped at 30 minutes, and falling back to the old every-pass read when a ship carries
no usable arrival). Carriers use their existing `retryAt` backoff; collectors a per-feed wake time. A backoff already
longer than the flight is left alone. The per-pass `getShipCargo` stays: the comment in `stepCarrier` records a live case
where `ship.cargo` and `getShipCargo` disagreed.

## Trimmed the calls nothing was waiting on (2026-10-06)

The first per-call breakdown of the 90-calls-a-minute budget showed where it went, and three sources were doing work no
decision needed:

- **Gate construction polling (~10/min).** An active mission re-read its construction site on every ~2s coordinator
  pass, including while cash-floor or recovery pacing held every purchase. It now re-reads every 30s, and straight after
  a delivery (the only thing that moves the counts). A paused mission already used a 60s cadence.
- **Dashboard state refresh (~12/min).** Every 20s the registry fetched the agent, every ship (two pages at 40 ships)
  and the contracts for the dashboard's snapshot. It now runs every 45s, and at background urgency: outside any scoped
  context a call defaults to *critical*, so this was queuing ahead of deferrable work and level with ships' real actions.
- **Credit checks in purchase gates (~5/min).** `maybeBuyShip`, `maybeBuyScout` and `maybeBuySiphoner` ran a fresh
  `GET /my/agent` on every maintenance pass to learn whether buying was even plausible. They now read the 30s-cached
  balance (`cachedCredits`); `buyShip()` and the approval-gated purchases still read live.

The limiter also records who asked: a second log line, `limiter 5m top callers: ship <- ShipProxy.refresh 90, ...`,
names the code behind each call kind (`callerOf()`, first stack frame outside `client.ts`). The 28 `GET /my/ships/:id`
calls a minute are the biggest single item and are not trimmed yet; this is how to find out which code makes them.

## API calls carry an urgency; critical calls go first, the rest wait their turn (2026-10-06)

The one 1.5 req/s bucket was running at 89 of 90 calls a minute, so what drains first decides what the fleet feels.
Every call now has a tier (`API_PRIORITY` in `client.ts`): **boot/rescue 0**, **critical 1** (ships in motion and money
changing hands: trades, navigation, extraction, mission and feed crews), **routine 2** (the control loop's own reads),
**deferrable 3** (keeper market snapshots, shipyard and gate refreshes, purchase checks, credit refresh — can wait a
couple of seconds), **background 4**. A call that keeps waiting is promoted one tier per 20 seconds (never past boot), so a
steady critical stream delays the rest but cannot starve it.

The tier travels with the work, on AsyncLocalStorage (`runWithApiPriority`), not on the Client's shared `priority`
field: the scheduler runs each task at `taskToApiPriority(task.priority)` (mission/trade/mine critical, keeper/survey/
explore deferrable), and each coordinator loop runs at its own (feeds critical, core routine, maintenance deferrable).
Before, the scheduler flipped that one shared field around every task, which would hand one loop's urgency to another
now that they run at the same time. Boot still wins everywhere (`setPriority(0)`).

The limiter also labels each call (`callKind`: extract, market, navigate, sell-cargo, ...) and the five-minute log line
now reads `limiter 5m: N/min of 90 · queue Q · wait avg/max · p1 … · p3 … · by tenant … · by call …` — wait per tier is
the check that critical calls stay short while deferrable ones absorb the backlog. Same numbers in `GET /api/rate-limit`
and the `instances` ops tool. Known edge: work launched without awaiting inside a loop (a detached repair trip started by
a maintenance pass) inherits that loop's tier until aging promotes it.

## Coordinator split into core / feeds / maintenance loops (2026-10-06)

`FleetManager.run()` awaited one serial `tick()`: dispatch, every purchase check, feeds and missions, then the syncs.
When the game API backed up, `feeds.tick` alone took up to 25 minutes (it grew over the process's uptime and reset on a
restart), and since trader route assignment lives in that same pass, a trader that sold its cargo waited for the next
pass before it got another route. Measured: 15-minute windows with 2-6 sales while the pass was slow, 35-43 sales right
after a restart.

`run()` now drives three loops that only ever wait on themselves. **core** (~2s) computes dispatch routes, recomputes
assignments, commits intents and syncs state, and makes no game-API calls; **feeds** (~2s) runs missions and feeds;
**maintenance** (~5s) does credits, gate and contract refreshes and every purchase/keeper/repair/explore controller.
Controllers still only propose on the `IntentBoard` and core commits, so an operator hold now wins a priority tie
explicitly (proposals no longer arrive in a fixed order). Slow-pass logs and `slow_ticks` rows are tagged with the loop
(`tick: SLOW pass [feeds]`, step names `feeds:feeds.tick`). `tick()` runs the three once in order. One risk traded
away: a maintenance controller and a feed can now pick the same idle ship at the same moment (before, they were
serialized); both check availability and the feed suspends the ship straight after picking it, so the window is narrow.

## Rate limiter reports demand and wait per tenant (2026-10-06)

All tenants share one 1.5 req/s token bucket, and nothing said how much of it each used or how long callers waited. The
limiter now keeps a five-minute window of granted calls (tenant, priority, time spent queued). The server logs
`limiter 5m: N/min of 90 · queue Q (oldest Ns) · wait avg/max · THEO … | OTHER …` every five minutes, and
`GET /api/rate-limit` and the `instances` ops tool include the same figures. A queue that keeps growing means demand is
above the bucket; the per-tenant split answers whether a second tenant is the cause.

## Ship, siphoner, keeper-probe and scanner purchases no longer auto-approve (2026-10-06)

The `buyShip`, `buySiphoner`, `buyKeeperProbe` (both paths) and `installScanner` approvals now deny on timeout, like
`buyScout` below. Only free decisions (`assignShipRole`, `autoExploreBorrow`) still approve themselves.

## Scout purchase no longer auto-approves (2026-10-06)

`maybeBuyScout` asked for a `buyScout` approval with `onTimeout: "approve"`, so a silent operator meant the money was
spent after the timeout. That is how THEOREM_DEV bought a SHIP_SURVEYOR (~43k of a ~63k balance) nobody asked for.
It now denies on timeout; the purchase happens only when the operator approves it.

## Trader: a failed sale no longer jettisons a valuable lot (2026-10-06)

THEOREM_DEV-1 bought 6 EQUIPMENT (19,212c) at K81 and lost all of it. The leftover sweep picked the best market
galaxy-wide (`bestSell`), which was X1-JX83-E50 in another system, so it did not navigate, tried to sell at the jump
gate it stood at ("EQUIPMENT is not listed at market X1-MG54-I51"), and the catch block jettisoned the whole hold
("no buyer"). Fixes: the sweep only considers markets in the ship's own system (`bestSell(good, system)`), and a lot
worth at least 1,000c is held with a log line instead of jettisoned after a failed sale. Cheap lots are still dumped.

## Feed miners are no longer ejected when a junk-cargo clear races (2026-10-06)

`clearUnrelatedCargo()` set `cleared = false` when neither sale nor jettison could find an item ("jettison: THEO-29 has
no QUARTZ_SAND in cargo"), although its own comment says an item neither call can find is already cleared. Every caller
then called `releaseFailedCarrier()`, so an iron-ore miner at B14 (THEO-29, 02:35) and copper-feed miners THEO-14 / 17
were dropped from their feed, picked their own field and went off drifting to deliver. Now an item that is gone on a
fresh cargo read counts as cleared, and a mining carrier whose clear still fails retries in 30 s instead of being
released.

## Survey tour: `stcommand_scan_fields` (2026-10-06)

`pickSurveyTarget()` returns the field a surveyor is already at, so the "surveyor scout flies between fields" role
never actually left its rock (THEO-18 has sat at CE5D all week). New operator-ordered tour: `ShipAgent.startFieldScan`
/ `FleetManager.startFieldScan` / MCP `stcommand_scan_fields {shipSymbol, fields[], batchesPerField}` visits each field
in order, drifts legs it can't cruise, takes N batches (recorded to the field tally) and reports completion. Progress
is read by calling the tool without `fields`.

## Field composition: every survey batch is recorded per asteroid (2026-10-06)

Waypoint traits say only "common metal deposits"; B14 carries that trait and its surveys are mostly copper, silicon
and ice (3 iron deposits in 38 listed). `SurveyPool.record` now persists every batch to `field_surveys` (migration
043, shared galaxy table, wiped on reset) so composition is a tally instead of a log search. Read it with
`GET /api/field-composition` or MCP `stcommand_get_field_composition { good: "IRON_ORE" }`, which ranks fields by
that deposit's share of listed deposits. The existing surveyor-scout role already flies between fields taking one
batch per visit, so a surveyor on tour fills the table.

## Miner: a preferred good is never traded for a locked-in wrong survey (2026-10-06)

THEO-1 (iron-ore preference, Surveyor II) mined silicon, copper and ice at B14 for an hour. When none of a survey
batch contained the preferred good, `createAndPickSurvey()` fell back to the best *other* refinable survey and cached
it until it expired (~55 min), so every extraction drew from junk. Now: with a preference set it picks the survey
with the highest share of the preferred deposit; if none offers it, it re-surveys on the next tick (4 tries), then
falls back to plain uncached extraction. Without a preference nothing changes.
The shared survey pool had the same hole (`SurveyPool.pick` returned a random survey when none held the preferred
good, including THEO-1's own junk ones): it now takes a `strict` flag, set whenever the operator preference is set,
that returns nothing instead and prefers the survey with the highest share of the good.
Both also require the survey to be at least 30% the preferred good (`MIN_PREFERRED_SHARE`): THEO-1's first post-fix
survey was 1 iron in 7 deposits.

## Mission cash floor (2026-10-06)

`MissionPacing.cashFloor` / `cashResume`: the mission holds purchases while the agent's credits are under the floor
and resumes only once they are back above the resume level (default floor + 25%), so the gate mission plus
subsidised feeds can't spend the account to zero while trading income rebuilds (THEO: 220k -> 155k in the hour to
01:29). Dashboard pacing route, MCP `stcommand_set_mission_pacing`, Deck and Tower pacing forms all carry the two
fields. Operator request.

## Trader: selling below the loss floor becomes an approval (2026-10-06)

A trader released from a subsidised feed holds its cargo forever once the live price is under its cost basis (THEO-30
sat 50 minutes at F52 with 40 IRON bought at 222c; THEOREM_DEV-3 the same at F45). After 5 minutes held, the trader
now raises a `sellBelowFloor:<ship>:<good>` approval with the price, cost basis and loss; approve sells on the spot,
deny or a 30-minute timeout keeps holding (deny cooldown 30 min before it asks again). Operator request.

## Deck: trades strip, two-row Ops page, per-material hold; Tower: per-material hold (2026-10-06)

Operator asks: (1) expose `market_transactions` — new `GET /api/market-transactions?good&waypoint&since&limit`
(`Store.marketTransactions`), MCP `stcommand_get_market_transactions`, and a Trades table beside "Selling here" on
Deck's Prices tab (ours highlighted, other agents dimmed) so a price move can be matched to who traded. (2) Deck is
a fixed-height dashboard and a third row is unreachable: Ops is now two rows — a segmented top panel (Supply chain /
Automation / Notes) over Contracts + Missions. (3) The mission `onlyMaterials` pacing field is now a buy/hold toggle
on each outstanding material in Deck's and Tower's mission cards; holding every material is refused (use Stop).
(4) Follow-up the same hour: Markets row 2 is a Dispatch / Miner preference tab panel — each list gets the
whole row instead of a strip with its own scrollbar — and the Markets grid is two fixed rows that never scroll as a
page (panels scroll inside themselves; Feeds keeps its single row).

## Mission `onlyMaterials`: stop the fallback buy of an expensive secondary material (2026-10-06)

Live: the FAB_MATS inflation guard paused that material twice (21:30, 23:34) and each time the mission fell through to
the next outstanding material and bought 20 ADVANCED_CIRCUITRY at ~4,000c/unit (80k and 82k) — 162k nobody meant to
spend, and it would have repeated every 30 minutes while FAB_MATS stayed over the guard. `MissionPacing.onlyMaterials`
restricts sourcing to a list (dashboard `/missions/pacing`, MCP `stcommand_set_mission_pacing`); when everything
outstanding is excluded the carrier waits a minute instead of spinning. Clear it (null) to let the mission buy the rest.

## MCP: `stcommand_remove_feed_carrier` (2026-10-05)

The dashboard could release one ship from a feed crew; MCP could only add. Needed to pull a third iron carrier back
into dispatcher trading when cash got tight without removing the whole feed.

## Feed collector carries FUEL cargo for long field round trips (2026-10-05)

Live finding: every unstripped metal field in X1-JX83 is 276+ units from the H55 refinery, so a 300-tank shuttle
collecting ore at B14 arrived with 24 fuel and the only way home was a 77-minute drift (~30 ore/h for a seven-ship
crew). The collector now buys FUEL cargo units at the target before heading out (`collectorFuelUnits()`: enough to
cover both legs with 10% margin, max 5 slots) and refuels from cargo at the field before the return leg
(`refuelFromCargo`, the API's `fromCargo` refuel, which works away from any market). FUEL is kept out of the
collector's junk-cargo clear. Failures are logged and the trip falls back to the old drift.

Also noted: removing a feed releases its ships to the dispatcher immediately — re-pin a ship *before* removing the
feed it is on, or the dispatcher will claim it (THEO-27 left B36 on a 265-unit drift 28 s after the sand feed was
removed).

## MCP: `stcommand_set_mission_crew` (2026-10-05)

Mission crew changes (the dashboard's assign / remove-carrier) had no MCP equivalent, so a connected agent could not
swap the command ship off the gate mission to use it as a miner. One tool with `action: add | remove`.

## Selling a keeper drops its market from the priority list; keeper-market MCP tools (2026-10-05)

Operator report: six keeper probes were scrapped but their six markets stayed on the keeper priority list, so the
fleet would convert an idle miner or request a new probe to re-cover the very markets the operator had just given up
on. `Fleet.sellShip()` now removes a sold keeper's station from the list before the hull leaves. Two MCP tools expose
the list so an agent can read and prune it without the dashboard: `stcommand_get_keeper_markets` and
`stcommand_set_keeper_markets` (replace the full list; new entries get the usual immediate coverage check).

## Reset opening playbook (2026-10-05)

Review item 8: `docs/reset-opening-playbook.md` writes down the order of operations for the first hours of a reset,
from this week's evidence (feed the chains first, shuttles before probes, mission buys only when the producer is
GROWING/STRONG and the recovery gate allows). CLAUDE.md's weekly-layout section now points at it.

## Drone-plus-collector mining: feed `field` + `collector` (2026-10-05)

Review item 6, the pattern other players use for far or crowded asteroids. A mine feed can now pin its drones to one
asteroid (`field`) and name a shuttle (`collector`) that waits in orbit there. A drone that is full hands its hold to
the collector through `POST /my/ships/{s}/transfer` (both in orbit) and goes straight back to mining; the collector
flies to the target market when nearly full (or after a 20-minute part-load), sells under the feed's sell-gap rule,
clears junk, and returns. Drones never make the 15-unit round trip, and an asteroid beyond a drone's tank becomes
workable. Set with `POST /api/feeds/collector`, `stcommand_set_feed_collector`, or the Feeder-tier card in Deck
(which also gained the loss-limit / stop-level controls from migration 040). The collector is suspended from the
dispatcher while assigned and released on pause/remove. Migration 042. Not yet exercised live.

## MCP: stcommand_sell_ship (2026-10-05)

Exposes `FleetManager.sellShip()` (fly to the nearest yard and scrap) over MCP with a required `confirm=true`, so an
operator working through the MCP can retire hulls. First use: six keeper probes parked at fuel-only stations and the
gate itself (B6, C42, CE5D, I59, I60, J61), from the project review's probe audit.

## Gate supply-chain panel in Deck and Tower, `GET /api/chain-health`, MCP `stcommand_get_chain_health` (2026-10-05)

Review item 9. `FleetManager.chainHealth()` walks every material an unfinished mission still needs: each in-system
producer (export ask, supply, activity = production strength, trade volume, the mission's 24h low and price ceiling),
and under it each input the producer imports (supply, activity = consumption strength, price and volume, the cheapest
in-system source, the feed serving it), with the weakest input flagged; inputs made in-system nest one level (iron
<- H55 <- iron ore). Deck shows it at the top of Ops, Tower under More -> Construction, both from one shared renderer
(`shared/domain.js` chainHealthHtml). Loaded with the programme poll. This is the view other players use to spot the
bottleneck at a glance (community supply-chain graph).

## market_latest read memo (2026-10-05)

Review item 7. `Store.latestMarketSnapshots()` ran a full `SELECT * FROM market_latest` from 16 call sites, including
the feeds' price/supply lookups once per carrier per 2-second tick. It now memoises the result for 5 seconds and drops
the memo on every market write and on reset cleanup, so a fresh read is visible on the next call. No behaviour change.

## Mission recovery gate, market transactions kept, block-aware refuelling (2026-10-05)

From the project review (doc "stcommand Project Review"), items 2-4. (2) Mission pacing gains `recoverPct`: the
next lot is bought only once the ask is back within that percent of what it was before the previous lot, so buying
follows the market's own refill (a sawtooth) instead of ratcheting the price up every 30 minutes; in memory, so a
restart allows one lot. Settable in Deck/Tower mission cards, `POST /api/missions/pacing`, and the MCP tool. (3) Every
market read now keeps the market's `transactions` (all agents' recent trades there, with ship symbol and executed
price) in the new shared table `market_transactions` (migration 041), via one observer on `SpaceTradersAPI.getMarket()`
rather than the dozen call sites. (4) Traders refuel only when at least a whole 100-unit FUEL block is missing or the
tank is below half (`refuelWorthwhile()`); tanks under 100 keep topping up as before, since any refuel costs one block
anyway. Observed before: 216c refuels for 188 burned, roughly a third of fuel spend lost to block rounding.

## Gate supply-chain guard, and feeds that accept a loss and stop themselves (2026-10-05)

Two changes from the FAB_MATS price investigation. (1) New doctrine rule `protectChainGoods` (on by default): while any
construction mission is unfinished (paused ones count), every good that goes into its materials, transitively down to
the raw ores (FAB_MATS <- IRON, QUARTZ_SAND; the circuitry chain <- ELECTRONICS, MICROPROCESSORS <- SILICON_CRYSTALS,
COPPER, ...), is dropped from the dispatcher's route list so ordinary traders no longer resell it for margin and drain
a producer's inputs (seen 2026-10-05: iron bought at H55 resold to F52 while F53's own iron was short). Feeds and manual
routes are unaffected; the chain comes from `transitiveInputs()` over the live `/market/supply-chain` (keyed by the EXPORTED good, values are what
its market imports; EXPLOSIVES is skipped because every raw-ore market imports it). (2) Feeds gain `maxLossPerUnit` (credits per unit above the target's pay the feed will
accept, replacing the default 10% margin gate) and `stopAtSupply` (MODERATE/HIGH/ABUNDANT: stop sourcing once the
target's supply reaches it; loaded carriers still deliver). Stored in migration 040, set with
`POST /api/feeds/limits` or the `stcommand_set_feed_limits` MCP tool. Aim for HIGH, not ABUNDANT: other players report
that over-feeding an import makes its market "evolve" (trade volume 60 -> 165, consumption grows) and it then goes
SCARCE when the feed can't keep up. Deck Feeder-tier cards gained the controls on 2026-10-05 (see the collector entry).

## Route profit now counts the whole round trip, price impact, and ranks by time (2026-10-05)

A deep dive on `computeDispatchRoutes()`/`TraderAgent.routeProfit()` found the profit it showed for a route was
`(sell - buy) x units - one-way fuel` at flat snapshot prices, and live tests proved it wrong on thin margins: a sand
route listed +92/trip actually lost 130-170, iron 124->129 lost 350-1,270. Fixes, all in the new pure
`src/engine/routeEconomics.ts` shared by the route list and the trader: (1) fuel is now the **round trip** (the ship
flies back empty), BURN-aware (BURN burns 2x fuel for half the time, as the trader actually flies it) and priced per
100-fuel block; (2) our own **price impact** is charged on both sides (~4.5% per tradeVolume lot, linear, average is
half the move; per-side trade volumes now come from `tradeLegs()`); (3) the route list and the dispatcher rank by
**profit per time** (scaled to a 10-minute reference trip, and the flight to the buy market is charged against it)
instead of per trip, so a short repeating route beats a long one earning the same; (4) the margin floor is now
`max(flat doctrine floor, 2% of buy price)`, so a 3,000c good needs more spread than a 22c one; (5) a same-system leg
with unknown coordinates is no longer priced at zero fuel, it is dropped. Manual routes still bypass the profit and
margin checks. Cross-system legs keep the jump-cost model (plus slippage). Not done: cash already committed to other
assignments is still not subtracted when sizing each route. Backhaul idea parked in `docs/TODO.md`.

## Deck: ship buying in Yards, editable doctrine values, Keeper tab layout (2026-10-05)

Three Deck gaps reported by the operator. Markets → Yards listed ship prices with no way to act on them; each type now
has a Buy button for its cheapest yard (plus buttons for other yards), confirming first and posting to
`/api/fleet/buy` like Tower and v6. Doctrine standing orders showed their value as plain text; numeric rules now have
an inline number input (min/max/step from the rule) that saves via `POST /api/doctrine { key, value }` on change.
The Keeper tab was squished because its flex children shrank inside the fixed-height panel (textarea collapsed to
one line); children no longer shrink and the textarea has a minimum height.

## Restart no longer flips loaded traders into miners; Deck/Tower show a DRIFT tag (2026-10-05)

THEO-1 (frigate, 40 JEWELRY aboard) was found crawling B7→A1 in DRIFT with 19/400 fuel. At each deploy, `init()` ran
`assignRole()` (hull classification) on every ship *before* re-applying persisted manual roles, so a trader was briefly
started as a miner agent, flown to the nearest market with a full hold and drained of fuel before `restored role trader`
landed. `init()` now skips hull classification for ships with a persisted manual role, restores those, then falls back
to `assignRole()` only for ships still idle. Deck's fleet table/detail and Tower's roster also show a `drift`/`burn` tag
next to the ETA (from `nav.flightMode`, only while in transit), as v6 already did.

## Deck and Tower: feed carriers and loaded traders no longer count as "unassigned" (2026-10-05)

Follow-up, same day: that was not enough on its own. Deck never loaded feeds/missions/contracts at boot or on its 15 s
poll (only when Ops, Feeds or Map was opened), so a feed carrier still read "unassigned" until one of those screens had
been visited this session; Tower had the same gap for Home (it loaded them only on Fleet and More). Both now load
them at boot and on every poll, and Deck re-renders Overview and Fleet when they arrive.

The Overview/Home "Unassigned" count was every trader with no dispatcher assignment, which also caught ships working a
feed (an iron or silicon carrier) or a mission, and any trader mid-trade with cargo aboard. THEO showed three unassigned
traders that were in fact the iron and silicon feed carriers. Deck now uses `jobFor()` (feed, mission, contract and loaded
hold claims resolved first) and Tower uses `claimFor()` plus a cargo check, so only a genuinely idle, empty, unclaimed
trader counts.

## Route list no longer reads empty just because the fleet has no trader yet (2026-10-05)

`computeDispatchRoutes()` sizes each trip to the largest cargo hold among *traders*, with a floor of 15 units. A fresh
agent starts with its command ship on the tour role (the intended layout: map the system first, then convert it), so it
has no trader, every leg was priced at a 15-unit hold, and the one-way fuel charge (distance x fuel price) pushed the long
ones below zero. THEOREM showed zero routes with all 27 markets priced although the best legs paid 75-85%. The hold size
now also counts tour and explorer hulls, the ones that become traders. A 40-unit command ship turns five of the six best
THEOREM legs profitable (DRUGS J56>H49 about +48k a trip, LAB_INSTRUMENTS C38>A4 about +16k, CLOTHING K79>A1 about +10k).

## Setting a new ship's role clears its pending "needs a role" prompt (2026-10-05)

A just-bought ship waits in `pendingRoleShips` for an operator decision. Assigning its role manually (Fleet tab or
`stcommand_set_ship_role`) did not remove that entry, so minutes later the app raised a fresh "needs a role, suggested
tour" approval for a ship that already had one (seen with THEO-2B, which was then correctly working as an iron-feed
carrier). The stale prompt was harmless once answered (a manually-roled ship ignores it) but looked like the ship had no
role. `setShipRole()` now drops the pending entry. Separately and by design: a ship that is a feed carrier or on a
mission has a suspended agent, and `setShipRole()` refuses to change its role ("suspended") until it is removed from the
feed or mission first.

## Market snapshots now record the game's `activity` level (2026-10-05)

Every market good the API returns carries `activity` (WEAK / GROWING / STRONG / RESTRICTED): for an export, how close
production is to its maximum; for an import, how close consumption is. We had been discarding it. Price-impact
experiments this session showed price is a function of stock (path-independent, reversible, ~4-5% per tradeVolume
of units bought) and that FAB_MATS stock regenerates at only ~1% price per hour, far too slowly for the gate, so what
sets the production rate is the open question and `activity` is the first candidate. Migration 038 adds nullable
`activity` columns to `market_snapshots` and `market_latest`; `recordMarkets` writes it from every call site that
builds a row from API trade goods. Older rows stay NULL.

## MCP: stcommand_trade_cargo for price-impact experiments (2026-10-05)

There was no way to buy or sell goods through the MCP server, only the dashboard's session-auth route, which made
market-impact experiments (does a 1-unit buy move the price as much as a 20-unit one? does splitting a purchase into
small lots help?) impossible to script. `stcommand_trade_cargo` wraps `Fleet.buyCargo`/`sellCargo` and returns the
transaction price plus the market listing before and after, so impact is read directly instead of waiting for the next
keeper snapshot. `buyCargo`/`sellCargo` now return a `TradeResult` (optional re-read of the market after the trade);
existing callers ignore it.

## Construction missions: per-mission buy pacing and MCP tools (2026-10-05)

Measured this week: a market's price depends on the total units taken from it (about +0.22% a unit), not on how a
purchase is split, and FAB_MATS stock refills at only a few units an hour. A mission buying a 20-unit lot every cycle
outruns that and runs into its price gates. `MissionPacing` (migration 039, a jsonb `pacing` column on `missions`) adds
three optional per-mission knobs: `buyLotUnits` (units per purchase, still capped by the market lot), `buyGapMin`
(minimum minutes between purchases of a material, shared by all carriers) and `maxInflationPct` (the existing cumulative
ceiling over the market's trailing-24h low, previously a hard-coded 40%; the separate per-visit 25% gate is unchanged).
Unset means the old behaviour. New `POST /api/missions/pacing` and MCP tools `stcommand_get_missions`,
`stcommand_set_mission_pacing`, `stcommand_pause_mission`, `stcommand_resume_mission` (the MCP server had no mission
tools). The gap is held in memory, so a restart allows one immediate purchase. Tests: `tests/missionPacing.test.ts`
(no database). UI: Deck Ops → Missions and Tower More → construction mission cards now have the three fields, Save pacing, and (Deck) Stop/Resume; Deck no longer rebuilds the cards while a field is focused.

## Fix: route fuel cost was 100x too high, hiding almost every route (2026-10-05)

`computeDispatchRoutes()`, `TraderAgent.tripCost()` and the miner's opportunistic arbitrage all charged a leg
`distance x FUEL price`. FUEL is sold in blocks of 100 tank-fuel (the ledger shows a 300-fuel top-up as two units at 72c),
and a CRUISE leg burns about 1 tank-fuel per distance unit, so the real cost is `distance x price / 100`: a 100-unit hop
is about 72c, not 7,200c. Every spread worth under a few thousand credits a trip was therefore priced as a loss, the route
list went empty ("4 traders (4 idle) | work: (none)") once the big early gaps were arbitraged away, and income fell from
about 60k to about 13k an hour overnight. Remaining same-system spreads at the time (PLASTICS G54>K87 +4.2k a trip,
ALUMINUM H55>K87 +3.8k, AMMUNITION F52>E45 +6.4k, COPPER H55>F53 +2.6k) all read as losses of 1.3-6.8k and are now
profitable. Added `FUEL_UNIT_SIZE` (100) in `fleet.ts`. Jump costs for cross-system legs are credits and were not affected.

## Warehousing parked: UI removed from Deck, v6 and Tower, doctrine locked off (2026-10-05)

Operator decision: the warehouse was an early idea and is not helping the gate chase, so it is out of the way until
after the gate opens (it may be worth bringing back for the longer game). The Warehouse panel is gone from Deck's Markets
screen (Dispatch now spans the width), v6's Trade Ops screen and its mobile Ops page, and Tower's More tab, along with
their loaders and handlers. The three warehouse doctrine rules (`warehouseTarget`, `warehouseMax`, `warehouseMinMargin`)
are in `RETIRED_POLICIES` in `src/engine/doctrine.ts`: never adopted or enabled whatever is stored, so the dispatcher
only assigns direct round trips; hidden from `list()`/`catalog()`; and `set()`/`setAdopted()` refuse them (so the Doctrine
screens and `stcommand_set_doctrine` cannot turn them on). To restore: delete those keys from `RETIRED_POLICIES` and
re-add the panels (git history has them). Not removed: the `/api/warehouse/*` routes, the store tables and per-good
targets, and the dispatcher's warehouse code paths, which are inert while the master switch is off. Unit-tested in
`tests/doctrineRetired.test.ts` (no database needed).

## Deck: Map screen is now v6's 3D map (2026-10-05)

Deck's Map screen was a flat 2D scatter of blips. It now runs v6's actual map engine: the orbit/pan/zoom
Three.js scene (right-drag orbits, drag pans, wheel/+/- zooms, Fit), procedural planets, ship hulls with
live motion trails, jump-gate pulses, the Galaxy toggle with its route planner, and hover/click waypoint tips
(with "ships here"). The engine was extracted from `v6.js` into `public/deck-map.js` rather than imported,
because it is woven into v6's own globals; the few v6-only dependencies (replay scrubber, mobile layout,
ship-details modal, system strip) are replaced by small hooks, each marked `DECK:`. Deck's own parts stay:
the system chip row, the market detail / leaderboard / factions / system-agents side panel, and a new ship
card there (click a hull on the map; "Open in Fleet" jumps to its Fleet row). The render loop idles while
another screen is showing. three.js and its bloom add-ons load as classic scripts in `deck.html`, same set as
v6. Overview's "Home system" panel now hosts the same 3D map (always the home system): there is one shared
WebGL scene and the two screens take turns hosting it (`mountDeckMap()` moves it between them), so nothing
is duplicated. Not ported: v6's replay scrubber, trade panel and ship-details modal.

## Deck: fleet table grouped by role (2026-10-04)

Deck's Fleet screen was a flat 40-row table, with the 26 keepers burying everything else. It now groups
rows by role exactly like Tower and V6 already did (`shared/cooldown.js` supplies the collapse state,
role order and cooldown bar): a header row per role with the count, click to collapse, keepers collapsed
by default. A collapsed group still shows an amber "N unassigned" or red "N stranded" badge so it can't
hide trouble, and the Job column carries the live cooldown bar. Collapse state is shared with Tower/V6
through the same localStorage key. Selection, system chips and the detail panel are unchanged.

## Three miner/feed bugs found in live ops (2026-10-04)

1. **Field spread sent drones to unreachable asteroids.** In X1-JX83 the only field
   within fuel range of a market is CE5D. `maxCrewPerField` (5) made the picker skip it
   once full, and the +50k "needs drift" penalty then lost to *any* field under the cap,
   so the sixth drone was pinned 250+ units away (B14/B12/B15) where it produced nothing.
   Extracted `selectField()` (unit-tested): reachable fields are preferred outright; when
   all reachable ones are full the ship stays on the least-crowded reachable field.
2. **Miner fuel-stop ping-pong.** `ShipAgent.nextHopToward()` picked the reachable fuel
   stop nearest the destination without checking it was closer than the current position,
   so with two such stops (D43/D44) a ship refueled back and forth every minute, forever.
   A stepping stone must now be strictly closer; otherwise the leg falls back to one DRIFT
   (verified live: a drone drifting to B7 shows ETA ~2h36m at 79/80 fuel). `TraderAgent`'s
   version already did a proper chain search and is unchanged.
3. **Feed carriers could jettison valuable cargo.** The unrelated-cargo clear sold, then
   jettisoned on failure. Jettison from a feed now refuses anything worth over ~2,000c at
   the best known price, and a carrier that can't clear its hold is released from the feed
   (`clearUnrelatedCargo` returns whether the hold was cleared).

Not changed: a miner can still make an opportunistic arbitrage buy right before an
operator hold lands (the 44k of SHIP_PLATING on THEO-14) — that was a race caused by
unpinning and re-holding it in quick succession, not a standing bug.

## Feeds no longer claim a trader that is holding cargo

Live near-miss 2026-10-04: a newly created `IRON → F53` feed claimed THEO-1 thirty
seconds after it bought 18 SHIP_PLATING (~90k) for a C41 delivery. The feed carrier
skipped the sale at C41, refueled, and flew toward H55 (which does not buy plating),
where its unrelated-cargo clear would have tried to sell and then jettisoned the
load. The operator-visible fix was removing the feed before the carrier acted; the
cause was the carrier picker (`pickFeedCarrier`) offering a loaded trader — the
registry's "trading" claim, which should outrank a feed, lags a tick or two behind
a purchase. The picker now skips traders with anything in the hold, so a feed waits
for a genuinely free one. (A manual `assign_feed_carrier` is unchanged; the
jettison fallback in `clearUnrelatedCargo` is untouched and worth revisiting.)

## MCP: `stcommand_mine_at` and `stcommand_set_doctrine`

Found 2026-10-04: with `fieldSpreadEnabled` on, new miners are spread to whichever
asteroid has the fewest ships. In X1-JX83 the only common-metal field near the refinery
(H55) is CE5D (17 units); every other is 276-370 away, so two drones sent to B14/B12
spent their time commuting and delivered almost nothing. `stcommand_mine_at` pins a
miner/surveyor to a field (the ship keeps working; `release=true` undoes it) and
`stcommand_set_doctrine` edits a doctrine rule (value/enabled) so rules like
`autoKeeperProbes` can be changed without the dashboard.

## MCP: feeder-tier tools (`get_feeds`, `start_feed`, `assign_feed_carrier`, `remove_feed`)

Starting a feed was dashboard-only. Reported 2026-10-04: new miners got pulled onto a
procurement contract instead of mining for the ore feed. A feed claims its crew
(`shipRegistry` owner "feed"), which is what keeps contracts/missions off them, so the
fix for that is to run the ore as a feed — now possible over MCP.

## MCP: `stcommand_set_miner_preference`

Set (or clear, or list) which good a miner's or surveyor's surveys favor, from the
MCP tools — previously only the dashboard form and Tower's per-ship "Mining
preference" button could. Logged as an operator action like the dashboard route.

## Duplicate keeper requests: the two request paths now see each other

Operator report (2026-10-04): each uncovered market produced two approval cards at
once — one `buyKeeperProbeForMarket` and one `buyKeeperProbe` (often the same
surveyor hull, bought when no satellite is stocked). Cause: the shipyard-visit
path (`maybeRequestKeeperProbe`) and the market path
(`maybeRequestKeeperProbeForMarket`) each dedup only against their own approval
kind, so both could ask for the same target market. Each path now checks the
*other* kind's open request (pending or decided-but-unconsumed) for the same
target, packed as `shipyard|target|hull`, and stays quiet if there is one
(`otherKeeperKindTargets` / `keeperRequestTargets`). The earlier purchase-time
coverage re-check still guards against a double purchase.

Second cause found the same day (E45, which is a plain market, not a shipyard):
during a deploy two instances run for about a minute, and the booting one's
in-memory `keeperMarkets` can be seconds stale — a probe bought for X1-JX83-E45
at 14:45:07 was followed by a fresh request for E45 from the new instance at
14:45:17. Both request paths and the purchase-time check now also consult the
durable `fleet_state` (`keeperTargetCovered`), not just memory.

## Tower Admin: the same operator screens on mobile (shared module)

The Admin tabs now live in `public/shared/admin.js` + `shared/admin.css` and are
mounted by both Deck (`#rail-admin`) and Tower (an **Admin** tab-bar button, shown
only for operators — `OPERATOR_AGENTS`). Same five tabs (Reset, Scoreboard,
Timeline, Health, Tenants); on a phone the tab row scrolls, tables scroll
sideways, cards stack to one column and the timeline renders as stacked event
cards. `deck-admin.js` was folded into the shared module.

## Deck Admin: operator-only screens on the normal session (replaces /admin's key login)

Deck gets an **Admin** rail item, shown only when `/api/gate/session` (and the
login response) say `operator: true` — i.e. the signed-in agent is listed in the
`OPERATOR_AGENTS` env var (comma-separated; unset = nobody, fails closed). One
page, one tab at a time: **Reset** (watcher state, countdown to the next reset,
account-token/auto-recovery flags, per-agent progress), **Scoreboard**
(`run_results`, click a week for roles/top ships/goods/spend/doctrine),
**Timeline** (filterable fleet events + the 15-minute cash curve), **Health**
(stuck ships, instances/rate limit, keeper coverage), **Tenants** (view as,
play profile, delete, manual post-reset cleanup). Backend: the old admin
handlers moved into `createAdminRoutes()` and are mounted twice — behind
`x-admin-key` at `/api/admin` (unchanged, still works) and behind session +
`requireOperator` at `/api/operator` (new, resolved ahead of the engine-boot
middleware so it works when a tenant's engine is down). New read-only routes on
both: `/reset-watch`, `/run-results`, `/timeline`. `public/admin.html` stays
until the new screens are confirmed in use; then it and the key can go.

## Durable fleet timeline: `fleet_events` + `run_timeline`, and an ops `timeline` tool

Until now a week's story was mostly lost: the ledger/activity feed are wiped at
each reset, `fleet_state` keeps only a ship's *current* role, approvals are
wiped, and role changes the engine made itself (e.g. THEO-1 → tour at boot)
were never recorded anywhere. Migration 037 adds two tables that, like
`run_results`, are not tenant-scoped and outlive the wipe:
- `fleet_events` — append-only: `role_change` (from → to, from `setFleetState`),
  `ship_purchased` (type, yard, price — from every `SHIP` ledger row, whoever
  initiated it), `approval_requested` / `approval_decided` (incl. timeout
  auto-decisions). Written from the three Store chokepoints inside the same
  transaction behind a savepoint, so history can never fail the action it records.
- `run_timeline` — credits, ship count, role mix and running buy/sell totals every
  15 minutes per agent, for a cash/fleet curve.
Each row carries the game universe (`reset_date`) so weeks can be separated;
`core/universe.ts` holds the current one, set by the reset watcher (and flipped
right after the post-reset wipe, before the new agent boots). The ops tool
`timeline` merges `fleet_events` with `operator_actions` in time order
(filters: sinceHours, ship, kinds, resetDate; `samples=true` adds the curve).

## Stopping a tenant now also stops its state-refresh timer

Found during the first live auto-recovery (2026-10-04): `stopOne()` stopped a
worker's fleet and scheduler but left its 20s `refreshState` interval running, so
the replaced worker kept polling with its dead token and logging "state refresh
error: agent token is from a previous server reset" forever. `TenantWorker` now
exposes `stopRefresh()`, called by `stopOne()` and `stopAll()`.

## Automatic recovery after the weekly server reset (register + boot)

`ResetWatcher` (started from the server, polls the unauthenticated game status
endpoint every minute) notices a changed `resetDate`, then per tenant: saves the
week's `run_results` row, stops the worker, wipes that tenant's stale game data
and the shared galaxy tables, registers a fresh agent with the same symbol using
`ST_ACCOUNT_TOKEN` (same tenant row, so the MCP key and doctrine survive), and
boots the engine. Level-triggered: each tick re-derives what is left, so a
failed step (API still warming up, registration or boot error) is retried and a
second agent is never registered. First run records the current resetDate as a
baseline and changes nothing; nothing is wiped unless the token is confirmed
dead by a 401. Without `ST_ACCOUNT_TOKEN` (or with `AUTO_RESET_RECOVERY=off`) it
only detects and reports. `RESET_FACTION` overrides the default `COSMIC`.
Phase 2 (a defined starting layout) is not built: the new game just boots with
the engine's defaults. Status: ops tool `reset_watch`.

## Weekly scoreboard: `run_results` table, saved just before a reset wipes the data

One row per agent per server-reset period (migration 036): cash in hand at the
end, wallet delta (final − the 175,000 registration grant), peak credits, ship
count by app role and by game class, matched trading net and trade count, fuel /
jump / ship-purchase spend, top 5 ships and goods by realized P&L, contracts by
status, the doctrine in force and the number of operator interventions. It is
not tenant-scoped and not part of the game-data wipe, so it survives both the
weekly reset and tenant deletion. `Store.captureRunResult` reads only Postgres
(last state snapshot, ledger, fleet roles), so it works after the game token has
died; `ResetWatcher` calls it for each dead tenant *before* the wipe and holds
the wipe for up to three ticks if the capture fails. Reset captures are
write-once per (agent, universe). The ops tool `run_results` lists rows;
`captureNow=true` records a refreshable mid-week 'manual' row to preview the
numbers. The watcher itself is still not started by the server (separate step).

## Dispatcher: buy-impact set to 0.20% per unit (0.002) — corrects the 0.2 mix-up

The operator meant 0.20% per unit, i.e. `BUY_IMPACT_PER_UNIT = 0.002`; the
previous entry's 0.2 was 20% per unit (percent vs fraction), which allowed one
trader per good per buy market. At 0.002 a second/third buyer is sent only
while the predicted ask still leaves margin, capped by
`MAX_TRADERS_PER_BUY_MARKET`. Tests updated.

## Dispatcher: buy-impact set to 0.2 per unit (operator decision) — effectively one buyer per market

The 0.12% recalibration (earlier today) measured the price rise *within* one visit
and ignored how slowly a market recovers. Live proof the same afternoon: a pinned
ADVANCED_CIRCUITRY run repeated by one freighter, with three other hulls on the
same good, drove TU85-E11E's ask from 4,178 to 7,992 in two hours — trips went
+450k, +134k, −69k, −105k. First reverted to 0.25%, then — on the operator's explicit
instruction ("20% = 0.2") — set to 0.2. At 0.2 per unit, (1.2)^units makes a second
buyer's predicted ask astronomically high, so the dispatcher sends ONE trader at a
time per good per buy market (the three-buyer cap never binds). Deliberately blunt;
lower it (0.0025 was the old value) to allow sharing again. Dispatcher tests pin
0.0025 where they test sharing and one new test covers the default.

## Scripts and styles revalidate on every load instead of caching for 5 minutes

JS/CSS (each UI version's, Tower's, Deck's, and `shared/*`) were served with
`max-age=300`. After a deploy a phone kept the old `m.js` for up to five minutes
(the new Yards cards "didn't change"), and, worse, an entry point and a shared
module can expire independently, so a new `m.js` can import a name an older
cached `shared/domain.js` lacks and blank the app. They now use `no-cache`: a
conditional request that returns a tiny 304 when nothing changed and the new file
the moment it does. HTML was already `no-cache`; fonts stay immutable. A `?v=`
stamp on the entry file alone would not have fixed the shared-module case.
`tests/uiVersions.test.ts` updated.

## Tower Yards tab: readable ship cards

Each shipyard listing is now a card: ship name and price on one line with the Buy
button, the cheapest yard under it with a small "+N more yards" toggle (the old
"also X, Y (choose)" underlined run of text), and a row of labelled stat chips
(FUEL, CARGO, SPEED, CREW, SLOTS, MOUNTS) instead of one long wrapping
"fuel 0 · cargo 0 · speed 9 · crew 0/0 …" line. Zero and unknown stats are left
out, so a probe shows just its speed rather than five zeros.

## An operator redirect now re-pins cargo the ship is already carrying

`deliverHeldCargo()` always finished the leg a cargo was bought for (the held-route
pin), so re-pointing a ship's manual route at a different sell market had no
effect on cargo already aboard — live, 80u of ADVANCED_CIRCUITRY bought at 7,992
stayed pinned to a ~6,200 market while a ~6,900 one sat in the same system. A
*manual* route for the same good with a different `sellAt` now updates the pin
(persisted, logged "operator redirected delivery"); auto assignments never
override a pin. Tests in `tests/trader.test.ts`. (A guard against manual routes
buying at a negative margin was considered and deliberately not added: the
2026-09-22 operator request lets a pinned route run regardless of margin.)

## Fix: a few-credit leftover froze a trader for hours (THEO-80)

A ship holding cargo counts as busy, so the dispatcher assigns it nothing, and
the leftover sweep reported "did work" every tick while refusing to sell a lot
below the loss floor. THEO-80 kept 3u of FUEL (~200c; bought at 85c, market 68c,
under the 15% floor) from 20:35 to 22:03 — about 1.5 hours "unassigned", logging
"holding 3u FUEL: … below loss floor" every ~6 minutes. Lots worth ≤ 2,000
credits (`TraderAgent.DUST_LOT_CREDITS`) now bypass the loss floor in both sweep
paths and are sold at whatever the market pays: the loss is trivial, an idle
hull is not. Valuable lots keep the floor. Tests in `tests/agentStep.test.ts`.

## Dispatcher: buy-impact assumption lowered from 0.25% to 0.12% per unit

`BUY_IMPACT_PER_UNIT` (how much each unit already promised at a buy market is
assumed to raise the ask for the next trader) was 0.25%, measured at one market.
The ledger over the prior 24h (87 multi-lot buys) shows a median of 0.13% per unit
(mean 0.17%, p90 0.42%), and a 225-unit buy at TU85-E11E actually rose ~16% in
total. At 0.25% the dispatcher charged ~284k against a 347k ADVANCED_CIRCUITRY
route and chose a ~313k URANITE run for a new freighter; the manual override
netted ~450k. Now 0.12%; the three-buyers-per-market cap is unchanged as the
backstop. Watch whether more traders now share one good's buy market and whether
realised margins hold.

## Fix: a trader/miner/siphoner drafted as a fuel tender never ran the tender

A rescue `suspend()`s the tender hull, and `TraderAgent.nextTask()` (and the
identical chains in `ShipAgent.nextTask()` and `SiphonerAgent.nextTask()`)
returned early on `suspended` — before `tick()` could reach `runTenderGoal()`.
Since tender execution moved into the ship itself, that left the tender idle
forever: THEO-82, the 2,300-fuel freighter, sat in orbit for 17 minutes with a
tender intent while THEO-80 waited at 0 fuel. (Explorer/scout/tour tenders were
unaffected, which is why the cross-system rescue earlier today worked.) The gate
now lets a suspended agent through when its intent is a tender
(`isTenderGoal()` in `intent.ts`); everything else suspended still no-ops.
Deliberately tender-only — a critical repair also suspends the agent but is flown
directly by the fleet. Tests in `tests/traderNextTask.test.ts`. (Note: one older
test in that file, "ETA-scheduled resume … a resumed tick()", fails with and
without this change.)

## Ops layer: a read-only monitoring & investigation suite (phase 1)

A set of named, read-only tools for the questions live-ops keeps asking, exposed
two ways from one catalog (`src/ops/catalog.ts`): MCP tools `stcommand_ops_*`
for a connected agent and `GET /api/ops[/<name>]` behind the dashboard session.
Phase 1: `logs` (in-memory ring buffer with the ~100-ship `fleet:` snapshot noise
hidden by default), `ship_live` (live game state vs the agent's cached view, plus
intent/pins/assignment/own log lines), `stuck`, `pnl` (matched trading net vs
cash flow incl. jumps), `ledger`, `keepers` (covered/en-route/pending +
duplicates), `instances` (deploy overlap + 429 rate), `survey_candidates`,
`market_freshness`, `assignments`. Pure logic is in `src/ops/classify.ts`
(tests: `tests/opsClassify.test.ts`); SQL is `Store.ops*`. Design, principles and
the phase-2 plan (`dispatch_explain`, `route_board`, `trace_ship`, `deploy_check`,
`fuel_plan`, `db_read`) are in `docs/ops-layer-design.md`. Not yet exercised
against a live deploy.

## MCP: stcommand_assign_route / stcommand_clear_route

A connected agent could dispatch, hold, tour and re-role ships but had no way to
pin a trader to a specific route — that lived only in the dashboard's "Assign
route". Both tools now call the same `FleetManager.setManualDispatch()` the
dashboard does (manual route overrides the dispatcher, persisted in the
`dispatchManual` fleet flag, logged as an operator action). Added because the
dispatcher's buyer-crowding discount (0.25%/unit at a shared buy market, cap 3)
can leave a very profitable route to a lone hull — a new 150-unit freighter was
sent to URANITE instead of 347k-a-trip ADVANCED_CIRCUITRY — and the operator
wanted to override it and measure what really happens.

## Keeper badge stays "pending" until the keeper actually arrives

The market badge (Tower, V6, Deck) said "● covered" the moment a keeper was
*pinned* to a market — which for a freshly bought probe is the instant it is
purchased, while it still sits at the shipyard waiting for its first tick and
then drifts slowly. It now stays "◐ pending" (amber) until a pinned keeper is
physically at the market and not mid-flight, and only then turns "● covered".
Shared logic: `keeperCoverage()` in `public/shared/domain.js` (covered / enroute
/ pending / none). The en-route variant isn't tap-to-remove, since removing the
market from the priority list wouldn't recall the ship.

## Fix: duplicate keeper probes bought for a market that already had one

Keeper-probe purchases run from a stored operator approval whose target market
was picked when the approval was *requested*; two request paths
(`buyKeeperProbe`, shipyard-triggered, and `buyKeeperProbeForMarket`) run side
by side, so two approvals could name the same uncovered market and the second
bought a redundant probe. Live at X1-TU85 on 2026-10-03: THEO-84/85 both pinned
to A15C and THEO-88/8A both to D18C, bought five seconds apart (~57k credits).
`purchaseKeeperProbe()` now re-checks `keeperMarkets` at the moment of purchase
and skips (with a log line) if the target is already covered; the request-time
check alone could not see a probe still pending purchase. Test in
`tests/fleet.test.ts` (needs the Postgres test schema to run).
Separately, a new keeper waits for its first ~10-minute keeper tick before it
starts flying to its pinned market — that part is by design, not stuck.

## Ledger: jump costs are their own type, and trader jumps are finally recorded

Jumps cost ≈5–8k credits each, and the books were wrong in two ways. A
scout/tour/manual jump (`FleetManager.jumpShip()`) was written as
`type='REFUEL', units=0` — indistinguishable from fuel except by that hack, so
the fuel line in every summary quietly included gate tolls (about 0.60M of a
0.96M "refuel" total over 24h). And a *trader's* jump
(`TraderAgent.jumpToSystem()`) was not recorded at all, which matters more as
cross-system routes multiply. Both now write `type='JUMP'`;
`Store.ledgerSummary()` returns a separate `jump` figure, subtracts it from
`net`, and the 15-minute earnings log line shows `jumps -N`. Migration 035
relabels the old zero-unit REFUEL rows as JUMP, per tenant (the ledger is
FORCE ROW LEVEL SECURITY, so a plain UPDATE would touch nothing). Trader jumps
before this change stay unrecorded — there is nothing to rebuild them from.
Test: `tests/trader.test.ts`.

## Fix: ships showed a finished construction mission as their current job

The Fleet list/ship sheet (Tower, V6, Deck) labels a ship `mission: … @ <gate>`
if any mission lists it in `assignedShips`, without looking at the mission's
status. A completed SUPPLY_CONSTRUCTION mission keeps its crew list in the
database (the engine releases the ship, but the row still names it), so THEO-1
— a carrier on the finished home-gate mission — kept reading "supplying
X1-SJ91-I67" long after it had been repurposed to tour. Completed missions are
now ignored by that lookup. Display-only: the engine never treated the ship as
on that mission.

## Tower fleet list: cargo dot on every row

Each ship row in Tower's list carries a small dot before the fuel bar: glowing
amber when the hold has any cargo, a dim hollow ring when empty; hover shows
`units/capacity`. Zero-hold ships (keepers) leave the slot blank so the
columns stay aligned. (A first version drew a fill-level box; replaced by the
simpler on/off dot.) The `F<n>`/`H<n>` text stats are gone from the row: fuel
is now a small dot (green ≥50%, amber 25–50%, red + glow under 25%; hover for
exact values) and hull condition is dropped from the list (still in the ship
sheet and Deck card). The row's small label under the ship name is now the
system the ship is in (e.g. `Y84`; hover for the full waypoint) instead of its
role — the role is already the group header, so it was repeated on every row.

## Fleet list: collapsible role groups and a cooldown bar (Tower + V6)

The Fleet list is now grouped by role (traders, miners, …, keepers) with a
header per group you can tap to collapse; the choice is remembered per browser
and keepers start collapsed. A collapsed group still shows a red "N stranded"
or amber "N unassigned" badge so collapsing can't hide trouble. Ships on a
cooldown get a thin bar that drains from amber to green with a `m:ss`
countdown beside it. It's computed from the cooldown's absolute `expiration`
and updated in place once a second (no re-render, no extra polling), so it
stays correct between the 15s state polls. Shared code:
`public/shared/cooldown.js`. Also shown in Tower's ship detail sheet and Deck card view.

## Rate-limit indicator in Tower and Deck, with deploy-overlap hint

A small pulsing amber dot (next to the clock in Tower, next to the connection
pill in Deck and V6) appears while SpaceTraders is answering 429s, with a toast when
it starts; tapping the dot re-shows it. The toast also says when another server
instance is alive at the same moment — the usual cause of a storm (a deploy's
old instance still ticking ships). Mechanics: `RateLimitMonitor`
(`src/core/rateLimitMonitor.ts`) counts 429s over a rolling minute via the
client's `onRateLimited` hook; each instance heartbeats into the new
`instance_heartbeats` table (migration 034) every 10s; `GET /api/rate-limit`
returns the count plus any other instance seen in the last 40s; the UI is
`public/shared/rateLimit.js`. Silent when nothing is limited.

## Fix: a tender never reached its fuel market after a cross-system jump

`ShipProxy.runTenderGoalStep()` never refreshed the ship, so a tender that
had just jumped into the stranded ship's system kept its pre-jump snapshot,
re-issued the same (now no-op) hop every tick and never headed for the fuel
market. Confirmed live with THEO-6B: it sat in X1-Y84 while the fleet log
still said X1-KN46-B22C. The step now refreshes and waits out cooldown first,
like the repair/scrap/hold goals. Test added in `tests/shipProxy.test.ts`.

## Fix: every fuel-tender rescue was cancelled the moment it was planned
`tenderRescueStep()` created a plan (proposing the tender's intent, which is only committed later in the same tick) and then immediately checked the committed board for that intent. It was never there, so the same call deleted the plan, forgot the stranded ship's hold and released the tender ("dispatching fuel tender" followed one second later by "released to rescue"). No tender rescue could ever run, which is why THEO-1 stayed stranded. The creation pass now returns after storing the plan; the next pass finds the committed intent and leaves it alone.

## Fuel rescue can send a tender from another system
`makeRescuePlan()` only considered ships in the stranded ship's own system, so THEO-1 (0/400 at Y84-C30X) sat unrescued for days while an 800-fuel explorer was two jumps away (the planner even tried it and failed on an "Infinity fuel" cross-system distance). New `pickCrossSystemTender()` is a fallback used only when no same-system tender qualifies: an idle hull, explorer, scout or tour ship (never a trader or miner) with an empty hold, not in transit, a tank that covers the market -> stranded leg and is at least 40% full, and a known gate path of at most 5 jumps; fewest hops, then biggest tank. The tender goal's BUY phase now walks the gate chain first (`jumpTo`, one hop per tick) before navigating to the fuel market in the stranded ship's system.

## A ship sent to a market/shipyard now docks there and records it
A ship dispatched to a waypoint is held there, but `runHoldGoal()` only navigated: it arrived in orbit and never docked, so nothing was snapshotted (a shipyard's stock was never scanned). Once parked at a MARKETPLACE or SHIPYARD waypoint it now docks once (throttled to every 15 min per waypoint), which records the market and, for a yard, its ships. Tour and keeper ships also now get `recordShipyard` on their shared proxy, so any dock at a yard records it.

## Tower "send to waypoint" handles a target in another system
Typing a waypoint from a different system into the Fleet sheet's send box failed with "needs Infinity fuel to reach …": the fuel pre-check measured a cross-system distance (always Infinity). `POST /api/fleet/dispatch` now rejects a cross-system target with a plain message, and Tower checks first and offers to send the ship by the gate path through tour dispatch instead (the role becomes tour; change it back on arrival).

## Tower Systems list shows every market ever priced, with its age
The Systems segment was built from the freshness-filtered snapshot cache (`snapshotMaxAgeMin`, 90 min), so a market whose price had aged out vanished from the list, which is exactly the one that wants a keeper (NM66: 8 of 17 markets hidden, including DA6E, the buy side of the EQUIPMENT route). New `GET /api/markets/known` returns every priced market in the tenant's charted systems with its goods count and newest snapshot time, no cutoff; Systems uses it and shows age in minutes/hours/days. Trading and the routes list keep the freshness cutoff.

## Fix: loaded traders were invisible to the dispatcher (shown "unassigned")
A trader holding cargo is claimed "trading" in the ship registry, which outranks "auto", so `dispatcherTraders()` (which filtered on `availableFor("auto")`) dropped every loaded ship from the dispatcher's list. The "busy" carry-forward never saw them, their assignment was discarded each cycle, and the fleet page listed them as unassigned (THEO-28, 2E, 45, 46); it also meant their trips never counted toward the per-market buyer cap. `dispatcherTraders()` now also includes traders claimed "trading", so loaded ships keep (or get rebuilt from their held-route pin) an assignment that stays until delivery.

## Loaded traders no longer show "unassigned" after a restart
The dispatcher's assignments live in memory, so after every deploy a trader mid-haul had none on record and the fleet page listed it as unassigned (THEO-28 carrying lab instruments, THEO-2E carrying drugs), even though the ship kept flying the trip from its own held-route pin. `recompute()` now rebuilds a loaded trader's assignment from that pin (the `inFlight` list), so it shows its route, is committed until delivery, and reserves its sell market.

## A trader's trip stays assigned until the delivery is done
The dispatcher only carried an assignment forward while the ship's hold was loaded, so an empty trader already heading to (or jumping toward) its buy market was re-ranked every minute and turned around mid-route (2E: TN82 -> VU66 -> back out through KN46, ~5k per wasted jump). An auto "direct" trip is now committed to its trader from assignment until the hold has been seen loaded and then emptied. It lapses if no cargo has been bought within `COMMIT_GRACE_MS` (3 h, covers positioning + buying), or if the ship is standing at the buy waypoint with an empty hold and the route has left the ranked list — never mid-flight to the buy waypoint. A manual override clears the commitment. Committed legs also count toward the per-market buyer cap and reserve their sell market.

## Scouts now snapshot shipyards
A scout docking at a SHIPYARD waypoint recorded the market but never the yard's stock (only tour/keeper ships did), so a scouted system showed no shipyard inventory (NM66: three yards, none scanned). `ShipProxy` takes an optional `recordShipyard` and calls it on docking at a shipyard; the scout wiring passes `recordShipyardSnapshot`.

## Fix: traders leaving markets half-empty and drifting
`TraderAgent.navigateTo()` now tops the tank up to ~95% at the start of every call when the ship is at a market, before the cross-system branch. Previously a cross-system departure skipped the in-system top-off, and a stepping-stone fuel stop missing from the price table was never refuelled at, so ships left D54 at 66/600 and VU66-I56 at ~120/300 and fell back to DRIFT legs.

## Fix: loaded traders bouncing between two fuel stops
When no chain of fuel stops reached a far destination, `nextHopToward()` fell back to "the closest reachable stop" without checking it was closer than the ship's current position. Two stops that were each other's best answer sent loaded traders (2E, 2F, 9, 8 in VU66, E46 <-> E42) back and forth indefinitely. The fallback now only returns a stop strictly nearer the destination; otherwise it returns undefined and the ship uses the ordinary single-leg/drift navigation.

## Per-market buyer cap now counts traders already in flight
Six traders ended up hauling CLOTHING from the same VU66 market. The cap of 3 buyers (and the sell-market de-dup) only saw traders assigned in the current pass; a ship committed to a run drops out of the dispatcher's trader list, and after a restart the in-memory assignments are empty, so ships already holding the good were invisible. `recompute()` now takes an `inFlight` list built from every trader's held-route pins (`TraderAgent.inFlightLegs()`): those legs reserve their sell market and count toward the per-market buyer cap and price-impact estimate.

## Trader fuel stepping stones use every known fuel market, chained
Traders' multi-hop legs only considered fuel markets in their own price table and picked one greedy stop, so a gate 470+ units from the destination (VU66-I55 on a 300 tank) fell back to a multi-hour drift, and arriving at an unpriced fuel stop skipped the refuel. `nextHopToward()` now unions registry-snapshotted fuel markets with the price table and searches the shortest chain of fuel stops that reaches the destination; the pre-leg top-off also recognises registry-known fuel markets.

## Unreleased

- **Tour ships drift to a market when nothing is within cruise range.** The
  tour target filter requires the round trip to fit the tank, which exists to
  stop a ship being marooned between markets; but DRIFT costs ~1 fuel per leg
  whatever the distance, so a ship standing on a market with a usable tank
  (>= 10 fuel and >= 10% of capacity) can always drift to the next one and
  refuel there. THEO-A (80-fuel tank) sat "no reachable target" in X1-FC23 and
  X1-YM56, whose markets are 150-450 units apart. The tour now drifts to the
  nearest (stale-first) in-system market within `TOUR_DRIFT_MAX_UNITS` (500),
  logging "drifting to <market>". Slow (hours per leg) but it gets the
  snapshots. A ~900-unit hop is still treated as out of range.

- **Fix: a multi-hop trader no longer jumps out of home on a nearly empty
  tank.** `jumpToSystem()` flew to the departure gate with `navigateTo()`, which
  returns immediately when the ship is already there and so skips its own
  top-off. X1-SJ91-I67 is both the home gate and a fuel market, so THEO-2E
  jumped with 80/300 fuel and, after two jumps, needed 467 at cruise to reach
  VU66-A4 and drifted for ~2 hours (live 2026-10-02). The trader now tops up
  (`topOffHere()`, market-only, never detours) at the departure gate before
  jumping and at each arrival gate after landing — the gap I had flagged as
  "no fuel check before the first leg".

- **Dispatcher: impact-aware assignment when several traders want the same
  buy market.** The route list prices each route at the ask RIGHT NOW, and the
  dispatcher only de-duplicated sell markets, so three traders were sent to
  buy ADVANCED_CIRCUITRY at X1-SJ91-D54 in one recompute, each scored as the
  only buyer (live 2026-10-02: ask 3,469 -> 3,783 -> 4,259 -> 4,656 across
  batches of 40/40/28, ~0.25% per unit, recovering ~1-2% in 10 min). Now, within
  a recompute, each extra buyer at the same (buy market, good) is scored net of
  the ask rise its predecessors cause (`BUY_IMPACT_PER_UNIT = 0.0025`), is
  refused if that predicted ask leaves less than the doctrine `marginFloor` per
  unit (or the score goes non-positive), and no more than
  `MAX_TRADERS_PER_BUY_MARKET = 3` buyers go to one market whatever the margin
  says. The number of traders therefore follows the margin; traders that don't
  fit take the next-best route. Single buyers are unaffected. Impact is a fixed
  placeholder, to be learned per market from snapshots later; sell-side impact
  (~0.04%/unit) is not modelled.

- **Scouts can be dispatched to a system (they keep the scout role).**
  `dispatchTourShip()` used to flip any ship to the tour role, and
  `ScoutAgent` never read a pinned destination, so "send this scout to X"
  either converted it or did nothing. `ScoutAgent.tick()` now takes the
  dispatched hop first (`advanceTourDestination`, same primitive tour ships
  use); `dispatchTourShip()` leaves a scout's role alone. Tower's ship sheet
  shows "Send to system" on scouts (and "Tour another system" on tours).

- **Tower: "Tour another system" on a tour ship's sheet.** Opens a picker of
  charted systems (from `/api/galaxy/overview`, labeled with yard/markets),
  and Send posts the same `/api/fleet/tour-dispatch` desktop uses — the ship
  walks the gate graph one hop per tick, then tours the destination.

- **Fix: turning on "Auto cross-system routes" stalled the fleet loop.** The
  gate-cache warm-up for the home/trader neighborhoods was awaited inside
  `tick()`; it is dozens of rate-limited API calls per system, so with the
  switch on no dispatch recompute ran for 12+ minutes (every trader idled).
  It now runs in the background (`maybeWarmJumpNeighborhoods()` is fire-and-
  forget with an in-flight guard) and tick() never waits on it.

- **Cross-system trading, phase 2: the dispatcher can assign multi-hop routes
  (doctrine switch "Auto cross-system routes", OFF by default).** With the
  switch on, `RouteDispatcher.recompute()` accepts (a) a route whose buy and
  sell systems are up to 3 verified gate hops apart and (b) hands an idle trader
  a route that starts up to 3 hops away. Guards: the trader's hold is empty
  (busy traders never reach this code), the FIRST trip must out-earn the
  positioning cost, one trader always stays in the home system, and candidates
  are ranked net of a third of the positioning cost. Per-hop cost is the learned
  per-gate average else the flat 5,000c estimate; `computeDispatchRoutes()` now
  prices a multi-hop buy->sell leg per hop. While the switch is on the fleet
  warms the gate caches around the home system and each trader's system every
  20 min (`GalaxyAtlas.warmNeighborhood()`, bounded). With the switch off, the
  dispatcher behaves exactly as before (tested). "Cross-system intel freshness"
  now defaults to 120 min (was 360).

- **Tower: "Cancel sale" button for a ship with a pending scrap order.** The
  ship sheet's Release button only appears for a HELD ship, so a ship flying
  off to be scrapped (THEO-A) had no Release to tap, despite my earlier
  instruction. A ship whose status `wants` begins "scrap" now shows an amber
  "Cancel sale" button that calls `/api/fleet/release`, which cancels the sale
  order (see `releaseShip()`).

- **Cross-system trading: the buy->sell leg can now span up to 3 gate hops.**
  `viableRoute()`/`whyNotViable()` accepted a route only when its buy and sell
  systems were ONE jump apart, so a good bought at home and sold two systems
  away (confirmed 2026-10-02: ADVANCED_CIRCUITRY, D54 3,522 -> VU66-A4 7,259)
  was rejected even when assigned by hand. They now ask `positioningPath()` for
  a verified path of at most `MAX_POSITIONING_HOPS` (3), `tripCost()` charges
  every hop (learned per-gate average, else the flat estimate), and a manual
  route also warms the gate caches buy-side -> sell-side. The executor already
  steps one hop per `navigateTo()` call, carrying the cargo. The dispatcher's
  AUTOMATIC assignment is still single-hop for buy->sell (phase 2, gated on the
  doctrine switch); this makes a hand-assigned multi-hop trade work. A directly
  connected pair keeps the old one-hop rule.
- **Tower: bulk scrap.** More tab -> "Bulk scrap": pick a role, tick ships (All /
  None), Scrap selected. Posts the same `/api/fleet/sell-ship` the per-ship Sell
  button uses, one ship at a time, with one confirmation listing every hull.

- **A pending sale no longer survives a role change or Release.** A scrap order
  (`shipManualState.scrapAt` -> `scrapTargets` -> a priority-0 "scrap" intent)
  outranks every role, and nothing cleared it when the operator re-roled the
  ship, so THEO-A ("sold by the operator, flying to X1-SJ91-A2 to be
  scrapped") kept jumping system to system toward the yard for ~1.5h after
  being switched to scout and then tour — ~43k of jumps in 2h, ignoring the
  credit-floor doctrine (which only gates explorers and chart scouts, not an
  operator-ordered trip). `setShipRole()` now clears `scrapAt` alongside the
  hold, `releaseShip()` cancels a pending sale, and clearing `scrapAt` forgets
  the stale committed scrap intent.

- **Shipyard listings now keep (and Tower shows) each ship's real stats.**
  The Yards view showed only name and price; the scan threw away engine speed,
  reactor power, crew and the modules/mounts a ship is sold with, and the
  frame's `cargoCapacity` is always 0 (cargo comes from cargo-hold modules).
  Migration 033 adds the columns; `recordShipyardInventory()` saves them and
  `shipyardInventory()` returns them; Tower's Markets -> Yards shows a stats
  line (fuel, cargo from modules, speed, crew, slots, mounts) under each ship.
  Existing rows show "—" for the new fields until a ship of ours docks at that
  yard again (the listing only carries stock while one is there).

- **Releasing an operator hold (or changing the ship's role) now clears its
  committed "hold" intent.** `IntentBoard.commit()` only revisits ships that
  have a proposal in the current pass, so after `holdWaypoint` was cleared and
  `proposeOperatorHolds()` stopped proposing, the old hold intent stayed
  committed and the agent kept standing down on it until a restart. Confirmed
  live 2026-10-02: THEO-2F, set to trader after being sent to X1-VU66-H52,
  sat docked with `want: hold X1-VU66-H52` and never traded.

- **Stop re-scanning unrecorded shipyards on every tick.** `scanLoadouts()`
  (called by `maybeBuyShip()` each pass) live-fetched every shipyard with no
  recorded inventory, every time. `getShipyard()` only lists stock while one
  of our ships is docked there and an empty answer is never recorded, so those
  yards stayed "unrecorded" and cost an API call per tick: confirmed live
  2026-10-02, `maybeBuyShip` took ~88s of each ~92s fleet tick, starving
  every step after it (keeper-purchase resolution among them — an approved
  surveyor purchase sat unconsumed with a ship docked at the yard). Each such
  yard is now tried at most once per 30 min, and at most 3 per pass.

- **Dispatcher can assign far same-system routes (multi-stop fuel chains).**
  `reachable()`'s fuel-stop check allowed ONE relay stop, capping a reachable
  leg at 2x the tank, while the trader's own executor (`nextHopToward()`)
  flies longer legs in several hops. So any route touching X1-SJ91-J70 (~660
  units from the rest of home, 300-unit tanks) was never assigned: confirmed
  live 2026-10-02, DRUGS 35k / ASSAULT_RIFLES 23k / FIREARMS 13k sat on the
  work list with idle traders while MICROPROCESSORS 10k and FERTILIZERS 2k
  were handed out. `fuelChainReaches()` (fleet.ts) now BFS-es over the
  system's fuel stops, each hop within one tank. Time cost is real (several
  legs), which the route's profit estimate already prices via fuel/trip cost.

- **Cross-system trading, phase 1: a trader can now fly a route that starts up
  to 3 gate hops away.** Previously `viableRoute()` and `navigateTo()` assumed
  the route's start system was at most ONE jump from the ship, so a manual
  assignment two systems out (confirmed live 2026-10-02: THEO-2E, SHIP_PARTS
  VU66-D39 -> VU66-H52) was rejected and the ship silently fell back to a poor
  local lane. New `src/engine/jumpGraph.ts` holds the pure BFS and the
  `MAX_POSITIONING_HOPS = 3` cap (a code constant, deliberately not a
  setting). `GalaxyAtlas` gains `jumpPath()` (cache-only; an edge needs the
  gate cached complete at BOTH ends), `warmJumpPath()` (bounded scan that
  loads/checks the gates in between) and `usableNeighbors()`. The trader
  re-plans from its live position and takes one hop per `navigateTo()` call,
  stopping on each intermediate system's gate; a live "under construction"
  jump rejection now closes the gate in the atlas and retires the route. Only
  hand-assigned (manual) routes trigger the warm-up; the buy->sell leg stays
  single-hop. Dispatcher auto-assignment of cross-system routes (phase 2,
  default off, freshness window as a doctrine setting) is not built yet. See
  the "Cross-System Trading: PRD and Design" doc.

- **Tower: Markets → Systems view.** Pick a system, see every market with
  a snapshot in it (goods count, age) and tap its keeper badge to add or
  remove it from the keeper list — the phone equivalent of desktop's
  Prices & snapshots list. Before this Tower could only reach a market's
  badge by picking a specific good first.

- **Releasing a manual route actually releases it.** `RouteDispatcher.recompute()`
  copies a manual override into its `assignments` map, so after the operator
  cleared one (Tower's new "Release to auto", desktop's Auto) the stale copy
  stayed there and the busy-trader carry-forward kept handing it back until
  the ship went idle — confirmed live 2026-10-02 on THEO-8, whose stored
  flag was gone but whose old route kept being logged as assigned.
  `setManual(undefined)` now drops the copy, and carry-forward skips any
  `source: "manual"` assignment with no live override behind it.

- **Tower: "Release to auto" button for a hand-assigned route.** A trader
  pinned by Assign route / Custom route now shows a prominent button on its
  ship sheet naming the route; tapping it clears the manual assignment
  (same `POST /api/dispatch {clear:true}` the old Auto button used, which
  was only visible inside the Custom route form) and hands the ship back
  to the dispatcher.

- **Tower (`/m`) can edit the keeper priority list.** The More tab has a
  new "Keeper stations" section: the full-list textarea, Save, Default,
  the cover-whole-list switch and the current stations — the same
  `/api/keeper/markets` calls the desktop Book uses. Before this Tower
  could only toggle one market at a time from a price-list badge.

- **Keeper purchases fall back to a surveyor, then a mining drone, when a
  yard sells no probe.** Keeper requests (both the shipyard-triggered and
  market-triggered paths in `fleet.ts`) only ever considered `SHIP_PROBE`,
  so a system whose yards don't stock probes (confirmed live 2026-10-02,
  X1-VU66: yards sell explorer/ore hound/surveyor/mining drone, no probe)
  never produced a keeper request at all. `pickKeeperHull()` now picks the
  best hull a yard has (probe > surveyor > mining drone); the approval
  detail names the hull and the third `|` field of the approval's packed
  `shipSymbol` carries it (older rows without it still mean a probe). The
  market path's keeper-priority-list gate is unchanged.

- **A scout now re-fetches a newly entered system's waypoint traits and tops
  off on any market it's standing on.** Confirmed live 2026-10-02: THEO-1
  (scout) jumped into X1-Y84 with 9/400 fuel, stood on two FUEL_STATIONs
  (F39A at 5 fuel, EZ7D at 4) logging "cannot refuel ... no reachable
  market", and drifted on (1 fuel a leg) until it hit 0/400 at C30X.
  The atlas had cached X1-Y84 trait-less, so neither station read as a
  market — the gap `GalaxyAtlas.refreshWaypointTraits()` documents; tour
  agents already call it on arrival, scouts never had it wired. `ScoutAgent`
  takes a `refreshSystemMarkets` option (once per system per lifetime,
  failures logged and ignored), wired in `registerScout()`, and a scout on a
  market with under half a tank refuels immediately instead of only when
  budgeting a specific leg. Does NOT rescue THEO-1: the fuel tender is
  same-system only (`makeRescuePlan()`), nothing else is in Y84, and at 0
  fuel not even drift can move a ship. A cross-system tender is a separate
  feature. Tests in scoutTraitRefresh.test.ts.

- **A tour ship low on fuel away from a market no longer holds forever; it
  heads for the nearest market (drifting if it has to).** Confirmed live
  2026-10-02: THEO-2F sat at X1-VU66-B30 (an asteroid, no fuel) with
  34/300 for ~25 minutes, logging "holding ... not enough fuel for
  X1-VU66-B7 and nowhere to refuel" every few minutes. Three things lined
  up. (1) `tourScout()` treated *any* refuel failure as "stand down",
  though `navigateTo()` can fall back to DRIFT for far less fuel —
  `scout.ts` already had that fix (its THEO-A incident) and the tour path
  never got it; it now only holds at 0 fuel. (2) The reachable-target
  filter budgeted against the full tank even away from a market, where
  it can't be topped off, so the ship kept picking legs away from the only
  fuel; away from a market it now budgets against the fuel it has. (3) The
  fuel-tender rescue only flags a ship at <=10% fuel, and 34/300 is 11%, so
  nothing came for it. With nothing reachable and fuel between 10% and 50%,
  both the tour and scout now navigate to the nearest market (drift
  fallback) and refuel there; at <=10% they still mark themselves stranded
  for a tender. Deliberately NOT changed for the scout: its chart-target
  filter still budgets against capacity, because scoutSelfTarget.test.ts
  encodes the opposite design — a scout with fuel left attempts the leg and
  lets DRIFT cover it, rather than holding (THEO-A, 6 hours). Tests added to
  tourScout.test.ts; the existing "stands down" test now accepts "no
  reachable target", since an empty tank away from a market falls out of the
  budget before reaching the hold message.

- **Server-reset cleanup now wipes `feed_missions`, and the mission price
  baseline is a trailing 24h low instead of the all-time minimum.**
  (1) `feed_missions` wasn't in `Store.TENANT_GAME_TABLES`, so a reset left
  feeds pointing at dead-universe waypoints with `assigned_ships` symbols
  (`THEO-N`) that get reused every reset — a surviving feed would have
  claimed new-universe ships it was never configured for. Nothing stale
  existed for the 2026-09-27 reset (all feeds were created after it), so
  this closes the gap before the next one. Same RLS policy as `missions`;
  the reset endpoint stops the in-memory worker before wiping, so feeds
  can't write themselves back. (2) The cumulative price gate seeded from
  `MIN(purchase_price)` over all of `market_snapshots`, but a fresh post-
  reset market opens at its cheapest: FAB_MATS' baseline was 1020c against
  a 1020-4555c weekly range, so the 40% ceiling (~1428c) sat permanently
  below anything the market would offer and the mission refused it.
  `cheapestKnownPrice()` now takes a `sinceMs` window (and ignores
  non-positive prices), `MissionMaterial.firstSeenPrices` became
  `priceBaselines` (`{ price, seededAt }` per market), and a baseline
  re-seeds once it's older than 24h — still long enough to reach back
  before a same-day runaway like the 1618c -> 2675c climb. The old
  persisted `firstSeenPrice(s)` keys are ignored, so the live FAB_MATS and
  ADVANCED_CIRCUITRY baselines re-seed on their next buy with no operator
  reset. Typechecked clean; not run against a live fleet (mission tests
  need a local Postgres).

- **Mission price baselines are now per source market, and a missing live
  price no longer lets a mission buy blind.** Two gaps in the cumulative
  price gate, found re-reading it on 2026-10-01. (1) `MissionMaterial.
  firstSeenPrice` was one number per material, seeded from whichever
  market was picked first — if the carrier later re-shopped to a different
  market for the same material, that market's price was judged against the
  first market's historical low, wrongly blocking a fair price or wrongly
  allowing a high one. Now `firstSeenPrices` is keyed by market waypoint,
  each seeded from that market's own `cheapestKnownPrice()` the first time
  the mission shops there. Existing persisted `firstSeenPrice` values are
  ignored and re-seeded per market from the same history on the next buy
  (no migration needed — same JSONB column). (2) If `listBuyers()` had no
  row for the chosen market, `price` was 0, which skipped both inflation
  gates and sized the purchase as if the good were free. A missing or
  non-positive quote now triggers a re-shop instead of a buy. Typechecked
  clean; not run against a live fleet.

- **A trader mid-arbitrage now has a real claim on itself, closing the gap
  that let a mission/feed auto-pick grab it out from under an in-progress
  trade.** Confirmed live 2026-09-29: right after resuming the FAB_MATS
  mission, its carrier auto-pick grabbed THEO-1 mid-route — 40u
  ASSAULT_RIFLES just bought at E55 (~134,160c) for resale at J70 (the
  only other market in-system that trades them, at 4419c/u; the mission's
  own market doesn't trade them at all). `availableFor("mission")` only
  answers "who's claimed" — a plain trader running its own ordinary
  buy-fly-sell loop was never claimed by anything, the same "auto" bucket
  as a genuinely idle, empty ship, so it looked identical to one. First
  pass patched `pickMissionCarrier()`/`pickFeedCarrier()` directly with a
  same-hold-must-be-empty check; reverted in favor of the real fix once
  it was clear every other owner (rescue/repair/mission/feed/keeper)
  already has its own claim and this was the one role that didn't — a
  per-picker cargo check would leave the identical gap in every other
  `availableFor()` caller (`auto`-promotion included) and in any future
  one. Added a new `"trading"` claim owner (`src/engine/shipRegistry.ts`),
  ranked above mission/feed/warehouse/keeper (an operator's committed
  trade capital shouldn't be interruptible by a fleet subsystem's own
  pick) but below rescue/repair (a stranded or critically damaged ship is
  still more urgent). `FleetManager.syncShipClaims()` now derives it for
  any `role === "trader"` ship currently holding cargo — deliberately
  `trader`-only, not miners, since ore in a miner's hold is its ordinary
  working state and exactly the pool a "mine" feed drafts carriers from;
  claiming that too would starve mine-feed crew picking. Unlike
  mission/feed/rescue/repair, a "trading" claim does NOT suspend the
  ship's own agent — it's still running its normal tick(), not being
  driven by a subsystem via raw API calls, so nothing about its own
  autonomous operation changes; the claim only makes it invisible to
  every *other* subsystem's carrier picker until its hold empties out
  again. **Not yet verified against a live fleet or the test suite** —
  typechecked clean, remote test Postgres unreachable again this session.
- **The mission price baseline (below) now persists on the mission's own
  record, not in memory, and backfills from real market history instead
  of the live price at the moment it's first set.** Operator-requested
  follow-up to the same-day price-gate fix: the first version stored
  `firstSeenPrice` on the in-memory `TaskState`, which a redeploy wipes —
  this app redeploys often, so the very next restart would have silently
  re-baselined to whatever the live (possibly still-inflated) price
  happened to be at that moment, quietly weakening the gate it was built
  to strengthen. Moved it onto `MissionMaterial.firstSeenPrice`
  (`src/engine/mission.ts`), persisted via the same `materials` JSONB
  column the mission already round-trips through `Store.recordMission()`/
  `latestMissions()` — no schema change needed. It's also no longer seeded
  from the live price at all: added `Store.cheapestKnownPrice()`
  (`src/db/store.ts`), a plain `MIN(purchase_price)` over the append-only
  `market_snapshots` history, and the baseline now prefers that real
  historical low, falling back to the live price only if this good/
  waypoint pair has no recorded history at all.

  The FAB_MATS baseline already set by the first version's brief window
  live (from ~2868c, not the true ~1051-1084c historical low visible in
  `market_snapshots`) needs an explicit one-time reset to pick up the
  corrected value — added `MissionManager.resetMaterialBaseline()` /
  `FleetManager.resetMissionMaterialBaseline()` and a new
  `POST /missions/reset-material-baseline` dashboard endpoint for it, same
  pattern as the existing pause/resume/carrier-target mission controls.
  **Not yet fired against the live tenant** — this session has no write
  path to the production database (the query tool available is read-only
  by design, deliberately not bypassed) and the stcommand MCP server
  (which would call this through a proper authenticated tool) has been
  disconnected all session; call it once either is available, or trigger
  it from the dashboard directly.
- **Mission material buying now catches a runaway price building up in
  small steps, not just a single big jump.** Confirmed live 2026-09-29:
  after the operator resumed the FAB_MATS→I67 SUPPLY_CONSTRUCTION mission,
  THEO-1's buy price climbed 1618c → 1609c → 1747c → 1736c → 1902c →
  2054c → 2231c → 2436c → 2675c — a 65% cumulative rise over 7 cycles,
  ~591,000c spent with zero revenue (SUPPLY_CONSTRUCTION has no cash
  payout at all; that's how the mechanic works). The existing
  `MAX_MISSION_BUY_INFLATION` gate (`src/engine/mission.ts`, added
  2026-09-11 after an almost identical incident cost 3.7M credits) only
  compares against the price at the *previous* re-shop, so it never
  caught this: every individual hike was 6-10%, well under its 25%
  threshold, even though they compounded to 65%. Added
  `TaskState.firstSeenPrice` — recorded once per material, the first time
  this mission ever buys it, and deliberately never reset by
  `blockMaterial()`'s re-shop (unlike `t.basePrice`, which resets every
  cycle) — and a new `MAX_MISSION_BUY_INFLATION_CUMULATIVE` (40%) check
  against it, with a 30-minute cooldown rather than the usual 5-minute
  re-shop retry, since a cumulative breach means the material itself has
  run away, not just this one market visit. **Not yet verified against a
  live fleet or the test suite** — typechecked clean, remote test
  Postgres still unreachable this session.
- **Fixed the second CRUISE-only reachability bug that kept feed carriers
  stranded with a full hold, indefinitely — `dispatchShipHop()` had its
  own separate, unfixed copy of the same wrong fuel model
  `canReachTarget()`'s fix (below) already addressed.** Even after that
  fix let the IRON_ORE feed's crew climb back to 20/24, checking actual
  throughput found the same underlying bug one layer deeper: 15 of the 20
  crew ships had gone completely silent for 2-7+ hours each, despite
  hundreds of extractions fleet-wide. Root cause: `dispatchShipHop()`
  (`src/engine/fleet.ts`, used by both feed and mission dispatch) is a
  *separate* function from `canReachTarget()` — it decides how to actually
  move a ship once eligibility already passed, and it still searched only
  for a CRUISE-reachable stepping-stone fuel market, giving up and
  retrying every ~3 minutes forever when none existed within the tank's
  CRUISE budget. Confirmed live: THEO-2D logged "cannot hop toward
  X1-SJ91-H63 from X1-SJ91-B26 (no reachable fuel stop)" roughly every 3
  minutes for hours, cargo full, never moving an inch, since DRIFT was
  never attempted. Fixed the same way as `canReachTarget()`: when no
  CRUISE stepping stone exists, switch to DRIFT and navigate directly to
  the real destination instead of giving up. **Not yet verified against a
  live fleet** — typechecked clean, remote test Postgres still
  unreachable; watch for the stalled ships' IRON_ORE deliveries resuming
  and the "cannot hop toward" log line stopping for good.
- **Fixed the real cause of miners getting silently kicked from their
  feed's crew after field-spreading moved them — `canReachTarget()`'s
  fuel model was simply wrong.** Confirmed live 2026-09-29: over a dozen
  ships (THEO-3, 7, 12, C, 27, 28, 29, 32, 34, 35, 39, 2A, 2C, ...) got
  released from the IRON_ORE→H63 feed the moment they arrived at their new
  field, each logged by `feed.ts`'s `stepCarrier()` as "cannot reach
  target (no viable route); releasing". `canReachTarget()`
  (`src/engine/fleet.ts`) treated a leg needing more fuel than the tank
  holds *at CRUISE* as unreachable — wrong, because DRIFT doesn't scale
  fuel with distance the way CRUISE does. Verified directly against
  production: THEO-31 departed at 80/80 fuel, needed 334 at CRUISE for a
  same-system leg, flew it on DRIFT, and landed at 79/80 — one fuel unit
  for the whole leg. A same-system destination is essentially always
  reachable this way; the old distance-based BFS was rejecting legs that
  the ship could fly for pocket change in fuel, just slowly.
  `canReachTarget()` now simply checks same-system-ness (plus a non-zero
  tank) instead of doing fuel-budget arithmetic that assumed CRUISE-only
  travel.

  This shipped after two earlier attempts in the same session that treated
  the symptom instead of the cause and are now reverted: a
  `pickFieldAssignment()` penalty for a field that couldn't reach the
  feed's target "without drift," and a `reconcileStrandedFeedFields()` pass
  that re-picked a field every tick for any ship still failing that check.
  Since DRIFT is actually cheap, *no* field within a realistic distance of
  H63 passed that check, so `reconcileStrandedFeedFields()` unpinned and
  reassigned the same ~18 ships every tick forever — a live infinite loop,
  caught and reverted within minutes of deploying by watching the app
  logs repeat identical unpin messages every ~20 seconds. Removed both;
  the actual fix needed to live in `canReachTarget()`, not in avoiding
  distance. **Not yet verified against a live fleet or the test suite**
  (remote test Postgres still unreachable this session) beyond the fact
  that the reverted infinite loop has stopped — watch for the affected
  ships rejoining the feed crew and the "cannot reach target" log line
  disappearing entirely.
- **Field-spreading now avoids assigning a miner/surveyor a field it can
  only reach via DRIFT, when a comparably-good field it can reach on
  ordinary CRUISE hops exists.** Confirmed live 2026-09-29 right after the
  multi-hop routing fix (below) shipped: it cut DRIFT incidents on the
  initial field-relocation from "every ship" (22/22) to 2 stragglers, but
  every one of those 22 ships still had to fly its *original* DRIFT leg to
  completion — SpaceTraders has no "cancel this transit" call, so a fix
  landing mid-flight can't shorten a leg a ship already committed to.
  Several 80-fuel-capacity mining drones sat in 1.5-2 hour single-leg
  DRIFTs as a result, which is what the multi-hop fix alone couldn't
  prevent — it only helps dispatches issued *after* it ships. Added
  `FleetManager.reachableWithoutDrift()`, a BFS over known fuel-selling
  markets (mirrors `ShipAgent.nextHopToward()`'s own stepping-stone
  search, since a raw distance cutoff would incorrectly penalize a field
  that's actually fine via a couple of CRUISE hops — of the 22 fields
  assigned beyond direct range, only 2 genuinely had no viable multi-hop
  path at all). `pickFieldAssignment()` now heavily deprioritizes (not
  bans) a field this specific ship can't reach without DRIFT, same
  pattern as the existing STRIPPED deprioritization. New doctrine control:
  `avoidDriftFields` (on by default). **Not yet verified against a live
  fleet** — typechecked clean, remote test Postgres unreachable again this
  session; the effect (no new drone gets a multi-hour single-DRIFT
  relocation going forward) is only visible the next time an unpinned
  miner/surveyor needs an initial field assignment.
- **Miners and surveyors now route through intermediate fuel stops for a
  multi-hop leg, instead of one long DRIFT covering the whole distance.**
  `ShipAgent.navigateTo()` (`src/engine/agent.ts`, shared by both roles)
  handed every destination straight to `ShipProxy.navigateTo()`, whose own
  `findFuelStop()` only accepts a stop that reaches the *final* destination
  in one more hop — a leg needing three or more hops has no such stop and
  falls all the way back to a single DRIFT. `trader.ts` hit this exact gap
  and got its own `nextHopToward()` stepping-stone redirect on 2026-09-27;
  `agent.ts` never got the equivalent. Confirmed live 2026-09-29: right
  after field-spreading (below) started sending miners/surveyors to
  asteroids well outside the old crowded-near-the-shipyard range, every one
  of them dropped into hours-long DRIFT for legs a couple of ordinary
  CRUISE hops would have covered — field-spreading didn't cause this bug,
  it just made every ship hit it at once instead of it lurking unnoticed.
  Fixed with `ShipAgent.nextHopToward()`, mirroring trader.ts's version
  against the shared `Registry` (`marketEndpoints()`/`fuelFor()`) instead
  of trader's own `priceTable`: `navigateTo()` now redirects through the
  nearest known fuel-selling market that makes progress toward the real
  destination whenever the direct leg exceeds the tank. **Not yet verified
  against a live fleet or the test suite** — typechecked clean, but the
  remote test Postgres has been unreachable all session (see the
  field-spreading entry below for the same, still-open gap); watch live
  miner/surveyor ETAs after this deploys to confirm CRUISE hops replace the
  DRIFT legs.
- **Miners and surveyors now spread across the system's known asteroid
  fields instead of all converging on whichever is nearest.** Confirmed
  live 2026-09-29: `pickMiningTarget()`/`pickSurveyTarget()`
  (`src/engine/agent.ts`) both did pure nearest-distance selection among
  every `ASTEROID`/`ASTEROID_FIELD`/`ENGINEERED_ASTEROID` waypoint, with
  no idea any other ship existed — every miner and surveyor bought over
  weeks ended up on the single field nearest the shipyards (`X1-SJ91-
  EB5B`), which is now `STRIPPED` from the crowding, while 37 other
  iron-bearing asteroids in the same system sat untouched. Also found:
  `pickSurveyTarget()` never even read the existing `pinnedMiningTarget`
  an operator's `mineAt()` sets — miners and surveyors share the same
  `ShipAgent` class and pin field, but only the miner picker honored it.
  Fixed with a new `FleetManager.pickFieldAssignment()` scorer (crowding
  first, `STRIPPED` heavily deprioritized — not banned — distance a
  tiebreak) and `maybeAssignFields()`, which runs every tick and pins any
  miner/surveyor that doesn't already have one via the existing `mineAt()`
  — including, as a one-time side effect, every ship bought before this
  shipped, since none of them had a pin yet either. An operator's own
  `mineAt()` pin is never touched. Three new doctrine controls: `maxCrewPerField`
  (default 5), `avoidStrippedFields` (on), `fieldSpreadEnabled` (on) — all
  render automatically in the existing Doctrine tab on every UI version,
  no frontend changes needed. **Verified live 2026-09-29, ~1hr post-deploy**,
  directly against production Postgres: 25 distinct miners/surveyors, 25
  distinct asteroid pins, zero collisions. (`fleet_state` only shows 12 of
  those 25 — it's a sparse table of manual role overrides, not a full
  roster, so most auto-classified miners never get a row there; the other
  13 were cross-checked via `ship_state`'s live position/target instead.
  Not a bug — `fleet_state` working as designed just briefly looked like
  one from a raw SQL query that assumed it was authoritative.) The
  remaining new unit tests (`describe("FleetManager field spreading...")`
  in `tests/fleet.test.ts`) still haven't run — remote test Postgres was
  unreachable (connection timeout) every attempt this session — but live
  production behavior is now confirmed independently of them.
- **A newly-bought ship whose hull is role-ambiguous now waits for the
  operator instead of auto-launching into a guessed role.** Confirmed
  live 2026-09-27: buying a shuttle auto-classified it as "tour" and
  launched it immediately; by the time the operator noticed and switched
  it to trader, the ship was already several minutes into an unrelated,
  hours-long DRIFT leg with no way to recall it (SpaceTraders has no
  "cancel this navigate" call — a role switch only redirects the *next*
  leg). `FleetManager.buyShip()` (the manual dashboard purchase) and
  `maybeBuyShip()`'s generic scored-pick fallback (no specific
  `attempt.wantRole`) now call a new `registerNewShip()` instead of
  hull-classifying immediately via `assignRole()`: the ship sits genuinely
  idle — no role agent, nothing dispatches it — while a new
  `assignShipRole:<ship>` entry appears in the existing Approvals panel
  (every UI version already renders any approval kind generically, so no
  frontend changes were needed) naming the suggested role. Approve to
  accept the suggestion, deny to leave it idle and assign a role yourself
  from the Fleet tab, or ignore it — auto-approves after 10 minutes, the
  same "don't strand a fleet nobody's watching" default every other
  `ApprovalGate` consumer uses. Purchases with an unambiguous hull
  (`buyScout`'s SHIP_SURVEYOR, `buySiphoner`'s SHIP_SIPHON_DRONE, and
  `maybeBuyShip()` calls with an explicit `attempt.wantRole`) are
  unaffected — there's no real ambiguity to defer for those. Restart-time
  role restoration (`assignRole()` in `init()`) is also unaffected — this
  only changes what happens the moment a *new* hull is purchased.
- **Fixed a same-day regression in the above: a manual role assignment
  from the Fleet tab could get silently undone seconds later.** Confirmed
  live: an operator manually set a pending ship's role from the Fleet tab
  while its `assignShipRole` approval was still sitting unanswered; when
  that now-moot approval was later denied, `maybeResolveNewShipRoles()`
  didn't know the ship already had a real role and shoved it back into
  idle, undoing the manual assignment. It now checks `manualRoleShips`
  before acting on a late-arriving decision — the approval row still
  resolves normally (so it clears out of the Approvals panel), but once a
  ship has a real manual role, the decision is a no-op either way.
- **Traders now actually fly multi-hop fuel-stop routes instead of a
  single hours-long DRIFT leg.** `viableRoute()` (`src/engine/trader.ts`)
  has accepted a route whose distance exceeds the ship's tank as long as
  `nextHopToward()` — a stepping-stone search proven out for contract and
  mission cargo delivery — found *some* multi-hop path, since 2026-09-21.
  But the leg was then actually flown through the trader's own
  `navigateTo()` wrapper straight to `ShipProxy.navigateTo()`, whose
  `findFuelStop()` only accepts a single intermediate stop that reaches
  the *final* destination in one more hop — exactly two legs, no more.
  A route needing three or more hops has no such stop, so the executor
  fell all the way back to one continuous DRIFT leg covering the whole
  distance, the opposite of what "viable via a multi-hop path" was
  supposed to mean. Confirmed live 2026-09-27: several 300-capacity
  traders sent toward `X1-SJ91-J70` (a ~750-800 unit haul, reachable via
  a chain of closer stepping-stone markets each well under 300) sat in
  hour-plus DRIFT instead of the ordinary CRUISE hops `nextHopToward()`
  already knew existed. Fixed by having the trader's `navigateTo()`
  itself redirect through `nextHopToward()` whenever the direct distance
  exceeds the tank, before ever handing the leg to `ShipProxy` — the same
  redirect contract delivery already does, now applied to ordinary
  buy/sell/haul legs too (every trader role routes through this one
  wrapper). No changes to `ShipProxy`/`FleetManager.findFuelStop()`
  itself, and no changes to non-trader roles (miners/siphoners/tour
  ships), which don't run cross-market arbitrage legs long enough for
  this gap to matter the same way.
- **Feed/Feeder-chain forms: market and good pickers are dropdowns, not free text (v6, Deck, Tower).**
  Confirmed live 2026-09-27, twice in one session: a typo'd target
  waypoint (a wrong system symbol, then a same-system near-miss —
  `X1-SJ91-F63` for the intended `X1-SJ91-H63`) left a feed with a full
  crew target and zero reachable ships, since the typo'd waypoint either
  didn't exist in the charted galaxy or didn't trade the feed's own good.
  The "Start feed" good/waypoint inputs and the Feeder-chain tier
  good/market inputs are now `<select>`s sourced from the same
  server-authoritative `priceGoods`/`priceWaypointsByGood` the price
  chart's own pickers use (`GET /api/goods`): picking a good filters the
  market list to only markets that actually trade it, so this typo class
  is no longer possible to enter. No backend changes.
- **Deck: fixed the Keeper tab bleeding through under every other Markets
  tab.** An inline `style="display:flex"` on the Keeper panel's own
  hidden `<div>` outranked the browser's default `[hidden]{display:none}`
  (inline author styles win regardless of the `hidden` attribute), so the
  panel never actually hid — its Cover-full-list toggle and station list
  showed underneath Routes/Yards/Prices too, stacked below whatever the
  selected tab's own content was. Moved the flex layout into a
  `.mk-keeper-body` class with an explicit higher-specificity
  `[hidden]` override, the same pattern `.content[hidden]` already uses
  elsewhere in this file.
- **Removed "Manipulation Routes" (buy-side price-manipulation finder) everywhere — superseded by Feeder tiers/chains.**
  Feeder tiers/chains now do the same job — build a counter-pressure crew
  against a buyer driving a market's price up — as a live, running system
  instead of a one-shot suggestion list, making Manipulation Routes
  redundant. Removed in full: `FleetManager.findManipulationRoutes()`/
  `getManipulationHistory()` and their supporting `DEPOSIT_TRAIT_HINTS`/
  `needsRefining()`/`fleetCanRefine()` helpers (`src/engine/fleet.ts`),
  the `GET /api/manipulation-routes` and `GET /api/manipulation-routes/
  history` routes (`src/http/dashboard.ts`), the `manipulationRoutes`
  store state and `loadManipulationRoutes()` (`public/shared/store.js`),
  and every UI copy of the panel — v6's Ops pane (desktop + mobile),
  Tower's More tab, and Deck's Ops screen — plus their now-orphaned
  `tests/fleet.test.ts` cases. No replacement endpoint; use a Feeds
  screen chain instead.
- **Deck Markets screen reorganized from three stacked rows to two** —
  folded the always-visible Keeper stations panel into the Routes/Yards/
  Prices segmented control as a fourth "Keeper" tab (same ids, so
  `renderKeepers()` needed no changes) instead of it sitting below as its
  own full-width row. Row 1 is now the segmented panel (Routes/Yards/
  Prices/Keeper), row 2 is Warehouse next to Dispatch+Miner preference.
- **Deck feature-parity pass: closed the gap from a week of v6-only
  features — Feeder tiers/chains, Automation panel, Notes, Fleet ETA
  column, per-ship miner preference, the "Matched" P&L tile, and a
  per-good price chart.** Deck (`/deck`) had fallen behind v6 across
  everything shipped since Feeder tiers first landed: the whole feed-
  management system was entirely absent, along with the Automation panel
  (per-ship live decision feed), the just-added operator Notes log, the
  Fleet table's ETA column, the per-ship miner-preference control, the
  realized-P&L "Matched" KPI tile, and v6's per-good price chart with
  marketplace/timeframe pickers and the keeper-priority badge. All ported
  this pass, reorganized rather than just squeezed into the existing
  layout:
  - New **Feeds** nav item (own screen, not folded into Ops) — Feeder
    chains (build/toggle a connected tier chain) and Feeder tiers (crew
    management: assign/remove carriers, set crew size, sell gap, force,
    on/off) side by side, ported from v6.js's `renderChains()`/
    `renderFeeds()`/`onFeedClick()` verbatim.
  - Ops screen gained an Automation panel (every ship's current wants/
    doing, from `fleetStatusSummary()`) and a Notes panel (the operator's
    own persisted scratchpad, same `/api/notes` endpoint Tower and v6
    just got) alongside the existing Contracts/Missions.
  - Markets' Routes and Yards panels became a segmented Routes/Yards/
    Prices control (matching Tower's own Markets tab shape) — Prices adds
    the good/marketplace pickers, timeframe buttons, an SVG price line
    (buy dashed green, sell solid amber), and the per-market list with
    the tap-to-toggle keeper-priority badge. The Dispatch panel also
    gained the miner-preference mini-form (bias a miner's surveys toward
    a specific good) it was missing.
  - Fleet's ship table gained an ETA column (`nav.route.arrival`,
    teal/live only while actually IN_TRANSIT) and its `jobFor()` was
    upgraded to the same feed/chain/mission-claim-aware version v6 has
    (was trader-only before — a real, separate gap this pass also
    closed, since the new Automation panel depends on it for a
    non-trader ship's job to read correctly).
  - Overview's KPI row gained a 6th tile, "Matched": realized P&L from
    completed round trips only (from `bridge.matchedNet`/
    `matchedTrades`), reading "—" rather than 0 when nothing's closed in
    the window rather than looking like a zero-profit fleet.
  - No backend changes — every one of these reads state the shared
    `store.js` already fetches (or, for Matched/ETA, fields the API
    responses already carried); this was purely catching Deck's own
    HTML/CSS/JS up to what v6 and Tower already have.

- **Fix: a "mine" feed's crew was never told which good to actually mine —
  extraction defaulted to "whatever refines to a metal," with no bias
  toward the feed's own target.** `ShipAgent.surveyPredicate()` only
  favors a specific deposit when that ship has an operator-set miner
  preference (`FleetManager.setMinerPreference()`); nothing in
  `FeedManager` ever set it for a feed's own crew. Confirmed live: three
  of the H56 IRON_ORE feed's six miners had it set (by hand, the day
  before, for the original 3-ship crew) and reliably drew IRON_ORE; the
  three added later never got it and mostly extracted ALUMINUM_ORE/
  QUARTZ_SAND/ICE_WATER/SILICON_CRYSTALS/COPPER_ORE instead, over 40
  minutes of live extraction logs. `FeedManager` now sets a carrier's
  miner preference to `feed.good` on every join (auto-picked, manually
  assigned, or restored at boot) and clears it on every leave (removed,
  released by a lowered crew target, or the feed paused) — so a "mine"
  feed's crew is always biased toward its own good without operator
  action, and an existing crew missing it (like the three above) picks
  it up automatically the next time the process restarts and restores
  feeds from the DB.

- **Fix: a "mine" feed only cleared off-target cargo once the hold was
  completely full, so junk ore sat taking up room for most of a mining
  cycle instead of getting sold out of the way immediately.**
  `stepCarrier()`'s mine branch called `clearUnrelatedCargo()` only when
  `cargoFree() <= 0`; now it clears as soon as any unit of a good other
  than `feed.good` is in the hold, freeing room for the feed's actual
  target right away instead of waiting for a full hold that, with an
  unbiased survey, could take many cycles to reach.

- **Fix (follow-up to the above, deployed minutes later): the proactive
  junk-clearing check used the wrong cargo snapshot, and got stuck
  retrying a sell that could never succeed.** `stepCarrier()` fetches
  cargo two different ways — `ship` (from `getShip()`, at the top of the
  call) and a separately-fetched, fresher `cargo` (from
  `getShipCargo()`), and `held` is deliberately computed from the
  fresher one. The new junk check read `ship.cargo.inventory` instead.
  Confirmed live within minutes of deploying: THEO-27 extracted 4u
  ICE_WATER, and every following pass logged `THEO-27 step error: THEO-27
  has no ICE_WATER in cargo` — `clearUnrelatedCargo()`'s own `sellCargo()`
  does its own fresh `getShip()` fetch and found none, while this check
  kept reading the stale snapshot and retrying the same doomed sell
  forever, never reaching `mineOnce()` again. Now reads `cargo.inventory`
  (the same fetch `held` already trusts) for both the check and the
  clear call.

- **Fix (second follow-up, same session): that snapshot fix didn't fully
  hold — a different ship hit the identical symptom minutes later with a
  different good.** THEO-2D got stuck exactly like THEO-27 had, this
  time on ALUMINUM_ORE, even after the previous fix made both the junk
  check and the clear call read the same `cargo` snapshot. Confirmed
  `Client.get()` has no caching layer at all — both `getShip()` and
  `getShipCargo()` are genuinely uncached live fetches every time — so
  `sellCargo()`'s own internal fresh fetch (inside `ensureShipAtMarket()`)
  can still disagree with a `cargo` snapshot taken moments earlier,
  likely from real queuing delay under the shared rate limiter between
  the two calls, not any bug in which variable is read. Rather than chase
  that further, made `clearUnrelatedCargo()` resilient to it directly:
  if a good neither sells nor jettisons (both live-checked against
  fresher state than this loop's own snapshot), that's functionally
  already-cleared from this loop's perspective — log and move to the
  next item instead of throwing out of the whole call, which is what
  was silently preventing every following pass from ever reaching
  `mineOnce()` again for that ship.

- **Fix: a feed carrier holding refined FUEL as cargo (bought via its own
  arbitrage trade) could never be cleared to make room for the feed's own
  good, permanently blocking it from ever doing feed work.** Found live
  while growing the H56 IRON_ORE crew from 3 to 6 miners: THEO-2E ran an
  arbitrage FUEL buy right before being claimed as carrier #5/6, filling
  its 15-unit hold with FUEL cargo. Every following `stepCarrier()` call
  saw `held(IRON_ORE)=0`, `freeSpace<=0`, and called `clearUnrelatedCargo()`
  to free the hold — which unconditionally skipped any item named "FUEL",
  on the apparent assumption that might be the ship's fuel *tank*. It
  never is: `cargo.inventory` (what this method clears) and
  `ship.fuel.current` (the tank) are separate fields; "FUEL" showing up
  in cargo is refined fuel bought as tradeable cargo, sold like any other
  good (see trader.ts's own arbitrage routes). THEO-2E sat fully loaded
  at H56, doing nothing, for 11+ minutes with zero feed log output,
  while its five crewmates cycled normally. `clearUnrelatedCargo()` no
  longer special-cases "FUEL" — it clears (sells, or jettisons on sale
  failure) anything that isn't the feed's own good.

- **Fix: a feeder tier's mining crew ran a full mine-to-cargo-full cycle
  synchronously inside a single `feeds.tick()` call, blocking the whole
  fleet coordinator (not just that feed) for as long as one ship's cycle
  took.** Found live, hours after the galaxy-crawl rate-limit fix below —
  same symptom (`FleetManager.tick()`'s per-step timing instrumentation
  flagging `feeds.tick()` at 400s+ in one pass) recurring on a feed that
  had nothing to do with the crawler. Root cause: `FeedManager.stepCarrier()`'s
  mine branch calls `ShipAgent.mineOnce()`, which calls `mineStep()` →
  `extractUntilFull()` — a `while (cargoFree() > 0)` loop that extracts,
  then `await`s the real ~69s extraction cooldown, then extracts again,
  until the hold is completely full. `mineOnce()` never set
  `schedulerDriven`, so `waitCooldown()`'s scheduler-aware branch (throw
  `CooldownPending` instead of sleeping — the same mechanism every other
  scheduler-driven agent loop already relies on, see
  `agentStep.ts`'s `CooldownPending` doc comment) never engaged; each
  `mineOnce()` call genuinely slept out every cooldown in place, one ship
  at a time, inside the one shared `feeds.tick()` await chain that
  `FleetManager.tick()` itself waits on. Confirmed live: one
  `feeds.tick()` pass took 405786ms (6.8 minutes) driving exactly this,
  during which nothing else in the fleet's coordinator pass could
  advance. Fix: `mineOnce()` now sets `schedulerDriven = true` around its
  call into `mineStep()` (mirroring `nextTask()`'s own pattern), and
  `FeedManager.stepCarrier()`'s mine branch catches `Pending` and
  reschedules that ship at `err.resumeAt` instead of letting the
  exception either block or fall through as log-spammy noise — so a feed
  now drives one extraction per `mineOnce()` call and yields, instead of
  running its crew's entire mining cycle inline.

- **Fix (follow-up to the above, same day): the `mineOnce()` fix alone
  didn't hold — a second race on the same shared `schedulerDriven` flag
  defeated it.** Verified the deploy live and still saw
  `waitCooldown()`'s real 69s sleep (its "cooldown Ns" log, which only
  fires on the non-scheduler-driven branch) instead of `CooldownPending`
  being thrown. Root cause: a suspended ship's own `nextTask()`-family
  scheduled chain (e.g. `THEO-27-mine`) keeps re-firing every ~30s the
  whole time a feed/mission/rescue owns it directly — `suspend()` never
  removes the scheduled task, it only makes `tick()` a same-tick no-op.
  But every `nextTask()`-family `run()` set `schedulerDriven = true`
  *before* that no-op check, and cleared it in its own `finally`
  regardless. `FleetManager.tick()`'s serial loop doesn't prevent the
  *Scheduler*'s independent task loop from running concurrently with it —
  so this no-op chain's `schedulerDriven = true` → (near-instant no-op) →
  `schedulerDriven = false` could interleave with a concurrent
  `FeedManager.stepCarrier()` → `mineOnce()` call still mid-extraction on
  the exact same `ShipAgent`/`ShipProxy` instance, clobbering the flag
  back to `false` out from under it right as it reached its own
  `waitCooldown()`. Fixed by checking `this.suspended` in each
  `nextTask()`-family `run()` *before* touching `schedulerDriven` at all,
  in `ShipAgent.nextTask()` (agent.ts, miners — where this was actually
  observed live), `TraderAgent.nextTask()` (trader.ts) and
  `SiphonerAgent.nextTask()` (siphoner.ts) — the three classes a
  feed/mission/rescue can suspend today. A no-op that's about to return
  immediately now never touches the shared flag.

- **Fix: galaxy crawl's agent-directory pass hammered SpaceTraders' real
  rate limit on every single attempt, continuously, for at least two
  days.** Found chasing an unrelated mystery — the new per-feed
  heartbeat (previous entries) itself went silent for 5-10 minutes at a
  time, and `FleetManager.tick()`'s new per-step timing instrumentation
  pinned it to `feeds.tick()` taking 400s+ in one pass. Neither was the
  real cause: `GalaxyCrawler.crawlAgents()` fetched every page of the
  galaxy-wide agent directory in a single unthrottled `for(;;)` loop,
  zero delay between requests — fine "on a fresh reset" when the
  directory was a page or two, but once it grows past a couple of pages
  (organic growth over the days since the last reset, no code involved)
  that burst alone blows straight through SpaceTraders' real per-IP
  ceiling (2 req/s) within its own loop. Worse: since a failed pass never
  set `agentsCrawlDone`, the hourly re-run gate never applied — it retried
  the *entire* unthrottled burst again on literally the next 5s tick,
  forever, with zero backoff and no way to recover on its own. Checked
  Render logs back to 2026-09-24: this had been failing continuously for
  at least two days, single-instance, unrelated to any redeploy or code
  change — just the agent count crossing whatever page count first
  exceeded the burst tolerance.
  Fix: `crawlAgentsPage()` replaces the loop with the same one-page-per-
  tick, resumable pattern `crawlSystemsPage()` already used safely at
  full galaxy scale (this crawler ticks every 5s — see `cli/index.ts` —
  so one page per tick is ~0.2 req/s regardless of how large the
  directory grows). A failed page just retries the same page next tick;
  already-accumulated pages aren't discarded.
- **Tower: set a feed's sell-gap ("spread") from the mobile UI, not just
  desktop.** Tower's feed panel (`more-feeds`) already had start/pause/
  resume/remove/crew-size, unlike `force` which stayed desktop-only —
  extended the same pattern to `sellGapMs`: a `gap Xm`/`gap default` tag
  on each feed card, a minutes input + "Set spread" button per card
  (`POST /api/feeds/sell-gap`, same endpoint desktop uses), and an
  optional gap field on the start-feed form so a fresh feed can set its
  spread at creation instead of reverting to the 5-minute default and
  needing a second call to fix it — exactly the gap in the workflow that
  came up live recreating the H56 feed earlier this session.
- **Full per-step timing instrumentation for the coordinator's tick() pass,
  after the feed heartbeat itself proved the stall wasn't feed-side.**
  The previous entry's heartbeat (logs at most once a minute,
  unconditionally, at the top of `FeedManager.step()`) went quiet for
  5-10 minutes at a time on its own — proving the problem isn't inside
  `feed.ts` at all, since that log sits upstream of every feed-specific
  code path. `feeds.tick()` is one call in a long serial chain inside
  `FleetManager.tick()` (`refreshCredits → ... → missions.tick() →
  feeds.tick() → ...`), so something *earlier* in that same chain
  occasionally blocking for minutes would stall everything after it in
  that pass — invisible everywhere else, since the ship-level Scheduler
  that drives mining/trading/etc. is a separate loop and stayed healthy
  throughout.
  Every step of `tick()` (both the paused/halted early-return and the
  full pass — every `await`, plus the synchronous calls like
  `dispatcher.recompute()`/`proposeOperatorHolds()`) is now wrapped in a
  new `timed()`/`timedSync()` helper that measures its own duration: any
  single step ≥1s (`STEP_WARN_MS`) logs immediately by name; if the whole
  pass totals ≥3s (`TICK_WARN_MS`), the full per-step breakdown — every
  step's name and ms, not just the slow one — is persisted to a new
  `tick_step_timings` table (migration 031) via `Store.recordSlowTick()`.
  Only slow passes are recorded (a tick fires every ~2s; logging all of
  them would be ~30 rows/minute/tenant of noise while healthy) — read
  back via `Store.recentSlowTicks()` or the new diagnostic
  `GET /api/tick-timings`. Root cause of the original stall still
  unconfirmed — this is what makes the next occurrence provable instead
  of inferred.
- **Feeder tiers: heartbeat + arrival logging, after an unexplained silent
  gap.** Live incident: a freshly-recreated H56 IRON_ORE feed sat at 0/3
  crew for ~9 minutes with zero log output — not even
  `pickFeedCarrier()`'s own throttled "no carrier" diagnostic, which
  should fire at least every 15s on a genuine failed pick. `feeds.tick()`
  runs every 2s from the coordinator loop, so a real failure-to-pick
  should have logged dozens of times; it logged none, and the scheduler's
  own heartbeat showed the fleet healthy (not starved) throughout, ruling
  out that as the cause. Root cause not yet identified — this ships two
  new log lines so it's provable next time instead of inferred from
  absence: a once-a-minute unconditional heartbeat at the top of
  `step()` (crew count, mine/force/gap settings) proving whether a feed
  is even being reached, and a `"... arrived with Nu, gap clear — selling
  now"` line symmetric with the existing `"... holding ... waiting"` log,
  so every arrival is visible whether the sell-gap held it or not — two
  ships arriving and each immediately selling within seconds of each
  other now shows up directly instead of only being inferable from
  suspiciously-close sell timestamps.
- **Feeder tiers: per-feed sell-pacing (spread sells out, not just cap
  volume) plus a one-time crew-join stagger.** Built from a live
  operator observation: H56's IRON_ORE price held up better across a
  quiet multi-hour gap in the ledger than the raw sold-volume for that
  window would predict, suggesting SpaceTraders' market price may
  recover between sells, not just react to cumulative recent volume
  regardless of timing (unverified against SpaceTraders' own docs — that
  text isn't published — so this ships as a testable bet, not an assumed
  fact). Two mechanisms, both in `FeedManager`:
  - **Sell-pacing gate** (the main mechanism): a feed now tracks the
    last successful sell into its `targetWaypoint`, shared across its
    whole crew. A carrier arriving with cargo, inside the gap since that
    last sell, just waits in place (already docked, cargo intact)
    instead of selling immediately — `DEFAULT_SELL_GAP_MS` (5 min)
    unless the feed sets its own `sellGapMs` (new, persisted, migration
    030). Per-feed rather than a global constant since the right gap is
    a live A/B question per route, same as `force`/`mine` already are.
    Skipped entirely when `feed.force` is set.
  - **Crew-join stagger**: a ship joining a feed's crew (auto-picked or
    operator-assigned) gets its first cycle offset by its join order
    (`STAGGER_STEP_MS` × slot, capped at `STAGGER_MAX_SLOTS`) instead of
    starting immediately — a one-time phase nudge so a batch of ships
    added together don't start their mine/buy→sell cycle in lockstep.
  UI: a `gap` tag on each feed row (desktop Ops → Feeder tiers), a
  minutes input + "Set sell gap" button per row, and an optional gap
  field on the start-feed form; `POST /api/feeds/sell-gap` under the
  hood. Tower's feed panel stays read-only, same as `force` before it.
- **Feeder tiers: margin-gated buying, replacing the drift check that
  never actually worked.** The old guard (`MAX_FEED_BUY_INFLATION`)
  compared each cycle's buy price against a "base price" that got reset
  to the current price every single cycle — it could never see
  cumulative drift, which is exactly how THEO-6's H56→F50 IRON feed
  climbed 90c→240c+ over nine buys without ever tripping it (see the
  two urgent fixes below, found investigating the same incident). Every
  buy now checks live profitability instead: the source price against
  the destination's current sell price (`FleetManager.sellPriceAt()`,
  new), gated by `MIN_FEED_MARGIN_PCT` (10%). No margin → the feed waits
  and rechecks every 15s rather than buying regardless, and — since it
  doesn't reset `t.market` the way the old guard did — it keeps
  watching the *same* market for recovery instead of pointlessly
  re-shopping to one that's already known to be worse.
  New per-feed `force` flag (persisted, migration 029) skips the gate
  entirely for an operator who wants a route run through regardless —
  a contract deadline, or just wanting the good moving now. Toggle from
  the Ops Feeder-tiers panel (`Force`/`Unforce` button on each feed
  row) or at creation (`force (ignore margin)` checkbox); `POST
  /api/feeds/force` under the hood. Tower's feed panel stays read-only
  for now — deliberately out of scope this pass, desktop covers it.
- **Fix (live incident): a mine-feed's hold could clog with the
  asteroid's other deposits and never clear.** `held` (stepCarrier()'s
  "am I already carrying the target good" check) only counts units of
  `feed.good` — a hold that's completely full of the asteroid's *other*
  ore types reads as "empty-handed" and falls into the mine branch, but
  `mineOnce()` has no free cargo slots to extract into and silently
  no-ops every call while still reporting success. Confirmed live:
  THEO-27/THEO-29/THEO-2C (the H56 IRON_ORE feed's crew) sat full of
  COPPER_ORE/ALUMINUM_ORE/SILICON_CRYSTALS — zero IRON_ORE — for 48+
  minutes, re-logging "mining at .../using survey at ..." every cycle
  with nothing ever extracted or delivered. This is *why* H56's price
  never moved during the whole earlier "do we need more miners or a
  refinery" discussion — not a market-mechanics answer, a feed that had
  silently stopped delivering entirely. The mine branch now clears a
  full-but-wrong-good hold before mining, same as the buy branch already
  does before buying.
- **Fix (urgent, live incident): a feed could buy from its own sell
  target, looping in place and burning cash every cycle.** THEO-6's IRON
  feed (H56 → F50, no `buyAt` pin) drove F50's own buy price down through
  its own selling until F50 became the system's cheapest known IRON
  market — at which point the next cycle's "buy cheapest known market"
  auto-pick selected F50 itself. The ship never traveled: buy 60u at F50
  for 13,560c, immediately sell the same 60u back into F50 for 6,780c,
  repeat — a straight -6,780c every ~90 seconds, dozens of consecutive
  cycles, confirmed live in the ledger. The cheapest-known-market pick
  now excludes the feed's own `targetWaypoint`. This doesn't fix the
  separate, already-known issue of H56 itself inflating from repeated
  buying (still being designed — see the operator/engineering
  conversation this session) but it stops the much faster in-place loop.
- **Tower: moved the Activity feed from the bottom of the More tab to
  Home.** Operator report: "the other UIs have an activity feed where I
  can see buys and sells as they go by" — Tower already had one, but it
  was the last of ten sections on a long More-tab scroll, easy to miss
  entirely, and the operator explicitly didn't want it added back there
  ("there's too much stuff already"). Home already polls continuously (the
  one screen that's always live), so Activity now lives there instead,
  right under the triage list — `loadActivity()` moved off the
  More-tab-only loaders to fire on every boot/poll tick, same as bridge/
  approvals/dispatch.
- **Fix: Tower's Fleet screen never actually loaded the data its own new
  feed/mission/contract claim display needs.** `claimFor()`/`fleetRows()`
  (added same day, see the entry below) read `feeds`/`missions`/`contracts`
  from the shared store, but `loadProgramme()` — the only thing that
  populates them — was wired to fire on the More tab only, never on Fleet
  and never at boot. Confirmed live: THEO-6's card showed no feed claim at
  all on a fresh Fleet-tab visit, because the arrays were still empty.
  `setTab("fleet")` and the 15s poll now both call `loadProgramme()` too.
- **Fleet tab/Tower now show a feed/chain, mission, or contract claim for
  any ship, not just traders.** `jobFor()` (v6.js) and `claimFor()`/
  `jobLabel()` (m.js) previously only ever computed a "signed to" label
  for `role === "trader"` — every other role's Job column read "—" even
  when a mission or feed had actually claimed it, which was exactly the
  live confusion behind today's stuck-miners investigation (a miner
  holding contract-protected IRON_ORE with nothing on screen explaining
  why). Now checks, in order: a feed/chain claim (`feeds`'s own
  `assignedShips`, showing the chain name when one applies), a mission
  claim (`missions`'s `assignedShips`, naming the outstanding material),
  the existing trader-only dispatch assignment, and — lowest priority,
  informational — cargo the ship happens to be holding that an active,
  non-abandoned contract still wants. The Automation feed's
  `describeAutomation()` picks up the same claim ahead of its old
  role-specific fallback text ("autonomous — picks its own field each
  cycle" no longer says that about a ship a feed has actually pinned).
- **Add: `POST /api/miner-preference` now logs to `operator_actions`** (kind
  `miner_preference`), same as `/fleet/role` already does for role changes.
  Found as a dead end while investigating the IRON_ORE-stuck-miners
  incident below: the operator's account of having set a mining preference
  on specific ships days earlier had nothing to check it against —
  `setMinerPreference()` persists to a single `fleet_flags` JSON blob that
  gets deleted outright once the last preference is cleared, and neither
  it nor its HTTP route ever wrote an audit row. Now every set/clear is a
  permanent, queryable row, regardless of what the current live state is.
- **Fix: an operator-abandoned contract's goods stayed protected forever,
  with no way to ever clear a hold that picked them up.** THEO-27/THEO-29
  (plain auto-miners, no custom route or mission involved) sat with full
  holds of IRON_ORE indefinitely, silently re-picking a survey and doing
  nothing every tick. Root cause, confirmed via a persisted
  `contractOperatorState` fleet flag: an IRON_ORE procurement contract had
  been abandoned by the operator on 2026-09-20 ("stop sourcing this," per
  `ContractManager.abandon()`'s own doc comment), but
  `ContractManager.protectedGoods()` never checked the `abandoned` set the
  way `outstandingDeliveries()`/`deliverVia()` already did — so IRON_ORE
  stayed in `allProtectedGoods()` forever (no sell, no jettison) while
  `deliverVia()` correctly refused to route it anywhere (no active
  delivery to route to). Two checks that individually made sense
  disagreed about one contract, and any ship that incidentally mined the
  now-undeliverable-but-still-protected good got stuck with no exit.
  `protectedGoods()` now skips abandoned contracts too, same as
  `outstandingDeliveries()` — the stuck miners' next sell-cargo step
  should reclaim the ore automatically, no manual jettison needed.
- **Fix: `MissionManager`/`FeedManager` buy and sell never reached the
  ledger.** Both called `this.api.purchaseCargo()`/`sellCargo()` directly on
  the raw SpaceTraders client, bypassing `recordLedger` (and, for buys, the
  activity feed) entirely — a whole category of real spend was invisible to
  ledger-based reconciliation, discoverable only via ephemeral Render logs.
  Found while tracing a ~330,000c balance drop for the operator: a mission's
  material purchases and a feed's buy/sell legs left no ledger trail at all.
  Both managers now take a `recordLedger` option (same shape as
  trader.ts/siphoner.ts/scout.ts/agent.ts already use), wired from
  `FleetManager`'s own `this.recordLedger`; feed/mission buys also now fire
  `onActivity("buy", ...)` for parity with every other buy path in the fleet.
- **Confirmed, separately: a feed reassignment jettisoning a ship's existing
  cargo is a real, verified loss, not a bug in the reassignment logic
  itself.** THEO-6 bought 60u EQUIPMENT (192,140c) at 01:51, was reassigned
  to a feed at 01:55, and `clearUnrelatedCargo()` tried to sell the
  EQUIPMENT at the feed's location before jettisoning it — the sell failed
  (no market there buys EQUIPMENT) and it fell back to jettison at 02:07,
  logged (`THEO-6 jettisoned 60u EQUIPMENT`) but with zero credits
  recovered. `clearUnrelatedCargo()`'s sell-then-jettison fallback (already
  fixed for both managers back on 2026-09-10, commit b064034) is working as
  designed; the loss here is the ordinary risk of reassigning a ship whose
  hold isn't sellable at its current location, not a new defect.
- **Fix: `FleetManager.sellCargo()` recorded a real sale to the ledger and
  activity feed but never printed a log line — the only sell path in the
  codebase with that gap.** Confirmed live 2026-09-25 answering an
  operator's "where did my money go": THEO-6 bought 60u EQUIPMENT
  (~192,140c) on a normal trade route, then got commandeered as a feeder
  carrier before selling it — `clearUnrelatedCargo()` (shared by
  FeedManager/MissionManager, used to free a newly-commandeered ship's
  hold) called this method to sell the EQUIPMENT off, which genuinely
  worked and genuinely recovered credits, but produced zero trace in the
  Render log stream. Every other sell path (trader.ts's own sells,
  feed.ts/mission.ts's direct `api.sellCargo()` calls) already logs
  itself; an operator grepping logs for "sold" to reconcile a large
  balance drop found every sale except this one. Added the missing log
  line, same format as the others.

- **Fix: starting a feeder chain from tiers that were already running as
  standalone feeds silently did nothing to those tiers, while still
  reporting success.** Confirmed live 2026-09-25: operator started three
  standalone feeds (IRON_ORE→H56, IRON→F50, ELECTRONICS→D40), then built a
  chain from those same three tiers — `startChain()`'s own "chain started"
  log fired, but `FeedManager.start()` had an unconditional
  `if (this.active.has(key)) return;` for a feed already running under that
  (market, good) key, so none of the three tiers actually received the new
  `chainId`/`buyAt`. The chain didn't show up in the UI because, in the
  data, it didn't actually exist — no tier carried its id. Fixed by having
  `start()` **adopt** an already-running feed into the chain (apply the new
  `chainId`/`chainName`/`chainOrder`/`buyAt`/`mine` and force its carrier(s)
  to re-pick their source next tick) instead of no-op'ing, whenever the
  call is specifically a chain start (`opts.chainId` set); an ordinary
  repeated `startFeed()` call on an already-running feed is still the
  harmless no-op it always was.

- **Add: feeder chains — connected feeder tiers where each one buys where
  the previous one sold, instead of each independently re-deriving
  "cheapest known market" and possibly drifting to an unconnected one.**
  Operator feedback on the standalone feeder-tier feature: "when we make a
  chain like this, they shouldn't be separate, I want the next step to buy
  where the previous step sold." A chain (e.g. ore→H56→F50→D40) is several
  `Feed`s sharing a `chainId` (`FeedManager.startChain()`), with every tier
  after the first getting its new `buyAt` pin (see below) set automatically
  to the previous tier's own `targetWaypoint` — no separate persisted
  entity, just grouping metadata (`chain_id`/`chain_name`/`chain_order`,
  migration `028`) on the same `feed_missions` rows. Several chains can run
  at once, each toggled independently (`pauseChain`/`resumeChain` pause/
  resume every member tier as one unit; `removeChain` stops and forgets the
  whole thing). New routes: `GET /api/feed-chains`, `POST /api/feed-chains/
  {start,pause,resume,remove}`. New "Feeder chains" panel in desktop
  (`v6.js`/`v6.html`, Ops tab) with a dynamic tier-row builder (add/remove
  tiers, each with its own good/market/mine); Tower (`m.js`/`m.html`) gets
  a read-only view + on/off toggle for now — building a new chain stays a
  desktop action, noted on the Tower panel itself. A chain's tiers are
  still plain `Feed`s underneath, so they also show up in the existing
  "Feeder tiers" panel (now showing a "chain: `<name>`" badge) with full
  per-tier crew controls — the chain panel is only for building/toggling
  the chain as a whole.
  Also added the underlying **`Feed.buyAt` pin**: a feed's source market
  can now be fixed explicitly instead of always auto-picking the system's
  cheapest known seller — the piece a chain tier actually relies on, also
  usable standalone via `startFeed`'s new `buyAt` param.

- **Fix: feeder tiers could only ever source by buying at a market — a
  feed for a mined good (raw ore, the actual bottom tier of the
  ore→refinery chain the feature was built for) would sit stuck logging
  "no source found" forever, since nothing sells raw ore.** Added an
  explicit "mine instead of buy" checkbox per feed (`Feed.mine`, new
  `feed_missions.mine` column, migration `027`) — deliberately a manual
  operator choice, not auto-detected from "has no market seller", since
  that heuristic is unreliable and the operator already knows which is
  which. When set, sourcing skips the market lookup entirely and calls a
  new `ShipAgent.mineOnce()` (`src/engine/agent.ts`, factored out of
  `tick()`'s own step-4 mining logic so it's reusable outside the normal
  survival loop) — the crew must be drawn from the miners pool specifically
  (`pickCarrier`'s new `requireMiner` flag), since a trader has no mining
  mount and would just spin. Also fixed the auto-crew gate, which checked
  for a known market buyer before ever assigning a carrier — always false
  for a mine feed, so it would never staff up at all without this.

- **Add: feeder tiers — a dedicated crew that continuously buys a good
  cheap and sells it into one specific upstream market, to keep that
  market's price from spiking under a buyer's own repeated purchasing
  pressure.** New, deliberately separate `FeedManager`
  (`src/engine/feed.ts`) and `feed_missions` table (migration `026`) — not
  a `Mission` kind, kept apart per operator request: a feed has no
  construction site or required/fulfilled materials to track and never
  "completes" the way a mission does, it just runs until the operator
  turns it off. Same crew shape as the multi-carrier mission work below
  (`assignedShips`/`carrierTarget`, one independent buy→sell `TaskState`
  per crew ship, throttled auto-ramp toward the crew target) and its own
  `ship_claims` owner (`"feed"`, ranked with `mission`/`rescue`/`repair` —
  see `shipRegistry.ts`'s own comment on why it isn't just reused
  `"mission"`). New routes: `GET /api/feeds`, `POST /api/feeds/start`,
  `/pause`, `/resume` (the ON/OFF toggle), `/remove` (stop and forget, vs.
  pause's "keep to resume later"), `/assign`, `/remove-carrier`,
  `/carrier-target`. New "Feeder tiers" panel in desktop (`v6.js`/
  `v6.html`, in Ops next to Construction missions) and Tower (`m.js`/
  `m.html`, in More) — start form, crew list with per-ship remove, crew-
  size input, and the on/off toggle. This is the first concrete piece of
  the operator's "protocol" ask (see `docs/TODO.md`): manually starting a
  feed for each tier of a chain (e.g. X1-SN30's H56→F50→D40 ahead of the
  ADVANCED_CIRCUITRY bottleneck at I60) is possible today; auto-deriving
  the whole chain from one construction site is the remaining piece,
  tracked in `docs/TODO.md`.

- **Add: multi-carrier construction missions — a site can now be staffed by
  more than one ship at once.** `Mission.assignedShip` (a single string)
  was the hard architectural limit blocking parallel buyers on a
  bottleneck material (e.g. ADVANCED_CIRCUITRY at a jump gate, where one
  carrier alone can't hit a same-day build). Replaced with
  `assignedShips: string[]` + `carrierTarget: number`; `MissionManager`
  now runs each crew member's own independent source→buy→supply
  `TaskState` per tick, auto-ramps the crew toward `carrierTarget` one
  ship per tick (same throttled pattern the old single-carrier auto-pick
  used), and exposes `removeCarrier()`/`setCarrierTarget()` alongside the
  existing `assignCarrier()` (which now *adds* to the crew instead of
  replacing it). `store.ts`/migration `025_mission_multi_carrier.sql`
  persists the new `assigned_ships`/`carrier_target` columns (dropped the
  old singular `assigned_ship` column). New routes
  `POST /api/missions/remove-carrier` and `POST /api/missions/carrier-target`.
  Desktop (`v6.js`) and Tower (`m.js`)'s Construction missions panels
  updated to show the crew and a crew-size control.
  **Known gap**: `v2.js`–`v5.js` and `deck.js` still read the old
  `m.assignedShip` field in their own mission panels, which is now always
  `undefined` — those panels will show "no carrier yet" even when a crew
  is assigned, until they're ported to `assignedShips` too (see
  `docs/TODO.md`). Assigning still works from any of them (the API
  route is unchanged), only the carrier display regresses.
  This is groundwork for the "protocol" work described in
  `CLAUDE.md`/`docs/TODO.md` — an auto-derived, toggleable feeder chain
  (ore → refinery → intermediate → construction site) for speed-running a
  future gate build; the chain-proposer and the ON/OFF UI are not built
  yet, this lands the engine layer they depend on.

- **Fix: Deck (`/deck`) Overview's "Home system" mini-map rendered every
  marker at zero size, so the panel looked blank.** `renderMinimap()`
  emitted a nested `<span class="mk planet">` marker inside each `.blip`,
  but `deck.css` (copied verbatim from the design spec's own stylesheet)
  only defines `.blip.planet`/`.blip.market`/`.blip.gate`/`.blip.ship…` —
  there is no `.mk` rule anywhere in Deck's CSS. Every waypoint and ship
  therefore drew a 0×0 element and the chart appeared empty even though
  `state.systems` was populated and the "N waypoints" count was correct.
  A pre-existing bug from the original Overview pass, not from the Pass
  A–D work. Fixed by putting the marker classes directly on the `.blip`
  div — the same shape `renderMap()` already uses and the same rules
  `deck.css` already has. Live verification pending.

- **Add: Deck (`/deck`) Doctrine enable/disable toggles — Pass D of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Doctrine
  screen rendered Standing Orders read-only, so an operator could see which
  rules were on but couldn't flip one without leaving Deck. Ported Tower's
  toggle control and handler (`m.js`'s `renderMoreDoctrine()` + its click
  listener): each rule row gets a `.sw` switch whose `aria-pressed`
  reflects `rule.enabled`, and clicking it calls
  `POST /api/doctrine { key, enabled: !currentlyEnabled }` then re-fetches
  via `loadDoctrine()`. Deck's existing list rendering is kept — only the
  toggle was added, per the plan. Also added a `"doctrine"` subscription
  (there was none) so the store's own `notify("doctrine")` re-renders the
  screen, matching how every other slice is wired. No backend change.
  Live verification pending (no DB/token in the build environment).

- **Add: Deck (`/deck`) Map galaxy data — Pass C of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Map
  screen had only a top-3 leaderboard snippet; this adds the two panels
  the plan called for, without adding a seventh rail item (the design call
  already made for this repo is to extend Map's right-hand panel rather
  than add a Galaxy tab). Ported `v6.js`'s `renderFactions()` and
  `renderSystemAgents()` directly. The System Agents panel preserves the
  running-tally logic exactly: history is grouped by `agentSymbol`, and a
  signed delta is shown only when there are **2+** points (a single point
  is not a trend), colored green/red/dim, with the tenant's own agent
  marked `· you`. **No backend work** — `GET /api/agents-in-system/history`
  and the durable `agent_credit_snapshots` series were already built this
  session; `loadGalaxy()` already fetched all four endpoints in one call,
  so Deck just had to import `factions`/`systemAgents`/`systemAgentsHistory`
  from the existing store import and render them. Live verification
  pending (no DB/token in the build environment).

- **Add: Deck (`/deck`) Markets write toolbars — Pass B of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Markets
  screen already *showed* warehouse and dispatch data read-only; this makes
  those panels write. Ported the exact working implementation from
  `public/v6.js` (`dispatchAssign`/`dispatchClear`/`warehouseDesignate`/
  `warehouseRelease`) — same endpoints, same body shapes. Dispatch toolbar:
  a trader ship picker, a good picker (distinct `dispatchRoutes[].good`),
  an **Assign** button (`POST /api/dispatch` with the route's buy/sell
  fields) and an **Auto** button (`{ shipSymbol, clear: true }`). Warehouse
  toolbar: a ship picker (holds ≥20), a waypoint input, **Designate**
  (`POST /api/warehouse/designate`) and **Release**
  (`POST /api/warehouse/release`). Reused the `.field-select`/`.field-input`
  classes Pass A added. The selects repopulate on every poll but preserve
  the operator's current choice, the same discipline `v6.js`'s
  `renderDispatch()`/`renderWarehouse()` already follow — a 15s refresh
  must not yank a selection back to the first option mid-interaction.
  No backend change. The plan's lower-priority items within this pass were
  also built in the same commit: warehouse manual **Adjust**
  (`POST /api/warehouse/adjust`), curated **sell-targets** add/remove
  (`POST /api/warehouse/targets` + `/targets/remove`, each removable
  inline from the warehouse panel), and a **Keeper stations** panel
  (`POST /api/keeper/markets` — save the line list, the cover-full-list
  toggle, and reset-to-defaults). The keeper textarea is only re-seeded
  from the store when it isn't focused, so a 15s poll can't wipe a
  half-typed list. Live verification pending (no DB/token in the build
  environment).

- **Add: Deck (`/deck`) Fleet ship-action sheet — Pass A of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** The single
  largest functional gap in Deck was that an operator could *see* every
  ship on the Fleet screen but not act on one. Ported the shape of Tower's
  already-working action sheet (`public/m.js`'s `renderSheet()` and its
  `#sheet-actions` handler) rather than redesigning it: send-to-waypoint,
  Hold/Release, Dock/Undock (disabled mid-transit, matching the route's own
  guard), Assign route (top-4 by `profitPerTrip`), Repair, Sell/Scrap
  (confirm-gated), Change role (with the `roleMismatchReason()` mismatch
  warning and the keeper-market input shown only for `keeper`), and Full
  details (per-item Jettison, module/mount Remove, install-from-cargo).
  **No new backend route and no new `Store`/`FleetManager` method** — every
  action already had a working endpoint in `src/http/dashboard.ts`; that
  file was not touched. Added two reusable form classes (`.field-select`,
  `.field-input`) to `deck.css` so later passes don't re-invent the same
  inline style a third time. One deliberate deviation from the plan's §1c
  ("wire a listener on `#fleet-detail-actions`"): the buttons are created
  inside `renderFleet()`'s `innerHTML` assignment, so a statically-declared
  container in `deck.html` would be wiped on every render; the two
  delegated listeners instead bind to the stable `#fleet-detail-body`
  parent, which is the same one-handler-keyed-off-`data-act` pattern.
  Live verification pending (no DB/token in the build environment) — the
  operator will confirm the buttons work end-to-end after deploy.

- **Add: Deck (`/deck`), the desktop redesign — Overview pass built
  2026-09-19.** `docs/deck-desktop-design.md` was written as a mechanical,
  step-by-step build spec (full CSS and HTML copied verbatim, exact data
  bindings checked against real code) specifically to be built without
  needing design judgment calls. First pass: `/deck` route + shell + Overview
  screen only (KPI row, Wants-vs-Doing triage table, live Approvals/Activity
  signal rail), reusing `public/shared/*.js` patterns verbatim — no new
  backend routes, no new `Store`/`FleetManager` methods, same
  `loadState`/`loadBridge`/`loadApprovals`/`loadDispatch`/`loadActivity`
  polling as Tower. Fleet/Markets/Map/Ops/Doctrine and the ⌘K command
  palette are later passes, not this one. The ⌘K hint renders inert. Shell
  nav items for future screens show "coming soon" placeholders. Live
  verification pending — the operator will confirm Overview works end-to-end
  after deployment, same pattern Tower's own first pass followed.

- **Fix: a hold targeting a waypoint 2+ hops away retried an impossible
  direct jump forever.** `ShipProxy.runHoldGoal()`'s cross-system branch
  (`jumpTo`, wired to `FleetManager.jumpShip()`) passed the hold's *final*
  target waypoint straight to a single-direct-gate-only jump primitive —
  correct for an adjacent system, permanently broken for anything farther,
  since `jumpShip()` throws "not connected" and there was no multi-hop
  fallback. Confirmed live via the new MCP tools: an agent held THEO-13 at
  a waypoint 2 hops away and it retried the identical doomed jump every
  tick forever ("Failed to execute jump ... is not connected to the
  current location") — the exact failure class `advanceTourDispatch()`
  (a tour ship's own multi-hop dispatch) already existed to prevent, for
  a caller that never got the fix. Factored `advanceTourDispatch()`'s
  hop-by-hop walk into a shared `hopToward()`, and added `jumpToward()` —
  now every `jumpTo` wiring (13 sites, every scheduler-driven role) takes
  one hop at a time toward the target and lets the next tick take the
  next, instead of one all-or-nothing direct jump. This bug predates the
  MCP server (`sendShipTo()`'s own cross-system dispatch had the same
  gap) — the MCP tools just made it easy to hit by dispatching a ship
  somewhere a human operator would normally reach via tour-dispatch
  instead.

- **Add: trading/pricing intel tools to `/mcp`** — `stcommand_get_goods`
  (every observed TradeSymbol, for resolving a plain-language good name),
  `stcommand_get_best_price` (cheapest-to-buy and best-to-sell locations
  for a good, scoped to this tenant's own charted systems and the same
  freshness window the dashboard's Markets tab uses — never another
  tenant's unexplored markets, even though `market_latest` is shared
  server-wide), `stcommand_get_price_trend` (per-minute avg/min/max sell
  price over a time window, via the existing `goodPriceHistory()`), and
  `stcommand_get_shipyard_inventory` (every observed ship type/price per
  shipyard, filterable by system or ship type). All four reuse the exact
  Store/FleetManager methods `dashboard.ts`'s own `/markets`/`/prices`/
  `/goods` routes already call — no separate query logic. 20 tools total
  now (10 read-only, 10 write).

- **Fix: `/mcp` rejected a bare API key, requiring the literal `Bearer `
  prefix — confirmed live, broke a real setup.** A `.mcp.json` committed
  to the repo by another session interpolates
  `Authorization:${STCOMMAND_MCP_TOKEN}` from an env var holding just the
  raw `sctk_...` key, no `"Bearer "` anywhere — a natural, easy-to-hit
  config shape, not a malformed request. `createMcpAuth` now accepts
  either `Bearer <key>` or the bare key directly; `sctk_`-prefixed keys
  are never ambiguous with another auth scheme, so nothing is lost by
  also accepting them unprefixed.

- **Add: a hosted MCP server (`/mcp`), first pass — an agent can now take
  real fleet actions instead of an operator relaying them by hand.**
  Per `docs/mcp-server-plan.md`: per-tenant Bearer-key auth (new
  `tenant_mcp_keys` table + `hashApiKey()` in `src/auth/crypto.ts`,
  minted/revoked from the dashboard's Book-mode settings panel via
  `GET/POST /api/mcp-keys`, `POST /api/mcp-keys/:id/revoke` — the raw key
  is shown exactly once, at mint time, same as a GitHub PAT), mounted at
  `/mcp` ahead of the cookie-based `resolveTenant` (same position
  `/api/admin` occupies). Stateless Streamable HTTP
  (`@modelcontextprotocol/sdk`) — a fresh `McpServer` per request, nothing
  held across restarts.
  16 tools: 6 read-only (`stcommand_get_state`, `_fleet_status`,
  `_approvals`, `_doctrine`, `_activity`, `_ship_state`) and 10 write
  (`stcommand_dispatch_ship`, `_hold_ship`, `_release_ship`, `_jump_ship`,
  `_dispatch_tour`, `_set_ship_role`, `_dock_toggle`, `_refuel_ship`,
  `_buy_ship`, `_decide_approval`) — covering everything this session's
  own live-ops work on THEO-1C actually needed. Every write tool calls
  the *exact* `FleetManager` method the matching dashboard route already
  calls (`sendShipTo`/`manualJumpShip`/`dispatchTourShip`/etc.) — the
  design doc's own load-bearing constraint, given today's earlier fixes
  were all bugs from exactly that kind of divergence between manual-
  action paths. Every write tool call is also logged to the existing
  `operator_actions` table with a `mcp_`-prefixed kind and
  `meta.source: "mcp"`, so a later investigation can tell an agent's
  action from a dashboard click.
  Not yet built (tracked in `src/mcp/tools.ts`'s own trailing comment and
  `docs/TODO.md`): `stcommand_get_bridge`/`_markets`/`_galaxy_overview`
  (each composes several store calls the way their dashboard handlers do
  — worth factoring that composition out of `dashboard.ts` first), the
  missions/contracts/warehouse/doctrine write tools, and the
  confirm-flag requirement on destructive actions
  (scrap/sell-ship/abandon-contract/pause-fleet) once those are added.

- **Fix: `autoExplore()`'s idle check didn't know about a `dispatchTourShip()`
  destination, so a ship on a real, operator-directed multi-system tour
  trip kept getting offered up for the `autoExploreBorrow` approval gate
  (see below) at every docked stop along the way.** `dispatchTourShip()` —
  the Fleet tab's "send this tour ship to system X" control — only ever
  sets `tourDestination`; unlike `sendShipTo()`/`manualJumpShip()` it never
  calls into `isHeld()`/`operatorHolds`, so a ship mid-dispatch read as
  "idle" (not held, cargo empty, not mid-transit) every time it paused
  between hops. Confirmed live: an operator dispatched THEO-1C on a real
  7-hop trip toward X1-TX45 and had to deny an `autoExploreBorrow` request
  roughly once per stop, ~every 15-25 minutes, for a ship that was
  actively mid-mission the whole time. `autoExplore()`'s eligibility
  filter now also excludes any ship with a live `tourDestination`.

- **Fix: the Navigate tab's manual "jump" control never registered as an
  operator action at all.** Turned out to be the real culprit behind the
  `tourDestination` bug below, not the plain dispatch control: `/fleet/jump`
  called `FleetManager.jumpShip()` — a bare navigation primitive — directly.
  Confirmed live: an operator jumped THEO-1C to X1-TX45 from its Navigate
  tab; the jump itself succeeded, but nothing claimed ownership, set a
  hold, or cleared its stale `tourDestination`, so the very next
  `tourScout()` tick picked the old automatic destination back up as if
  the manual action had never happened — the ship landed in the operator's
  chosen system for one tick, then kept walking on its own schedule.
  `jumpShip()` itself has to stay a bare primitive (it's also how
  `advanceTourDestination()` performs each hop of an automatic multi-hop
  tour trip — giving it hold/ownership side effects would make that walk
  self-cancel after one hop). Added `manualJumpShip()`, a thin wrapper used
  only by the dashboard's `/fleet/jump` route, that claims operator
  ownership and clears `tourDestination` after the jump — same pattern
  `sendShipTo()` already uses for the plain dispatch control.

- **Fix: `sendShipTo()`/`holdShip()` (the manual dispatch/hold controls)
  never cleared a leftover `dispatchTourShip()` destination.** Confirmed
  live, same THEO-1C: a deploy restart restored a stale `tourDestination`
  (X1-YG81) from an unrelated earlier trip; the operator then dispatched
  THEO-1C to X1-TX45 via the dashboard's plain dispatch control, which
  correctly held it at the target waypoint — but `tourDestination` was a
  separate persisted field the hold never touched, so `tourScout()`'s
  `advanceTourDestination()` picked the stale goal back up on its very
  next tick and walked the ship straight through the operator's hold
  toward X1-YG81. `sendShipTo()`/`holdShip()` now clear `tourDestination`
  in the same `updateShipManualState()` call that sets the hold, so a
  manual dispatch always wins over a standing automatic tour plan instead
  of just outrunning it for one tick.

- **`autoExplore()`'s opportunistic borrow of an idle tour/scout ship now
  requires operator approval, same gate as a ship purchase.** This path
  (`FleetManager.autoExplore()`) pulls any idle tour or chart-scout ship —
  cargo empty, not held, not mid-transit — onto a multi-minute jump trip to
  an unsurveyed connected system, entirely separately from the dedicated
  `explorer` role. Confirmed live: an operator-dispatched tour ship
  (THEO-1C, sent to look around COSMIC's home system, X1-TX45) got
  borrowed into an explore trip to X1-QB86 within a minute of finishing
  its survey pass and going idle — invisible from outside since the
  ship's role never changed from `tour`, so there was no way to tell it
  was about to leave. Now gated behind `ApprovalGate.request("autoExploreBorrow", ...)`,
  same one-request-at-a-time-fleet-wide pattern as `buyScout`/
  `buyKeeperProbe` (2h timeout, auto-approves if nobody's watching —
  preserves today's fully-automatic behavior for an unattended fleet,
  while giving an operator who's actually looking a chance to say no).

- **Galaxy map: hover tooltip for system glyphs, and a declutter pass for
  crowded local clusters.** The galaxy-mode overview (`renderGalaxy3D()`,
  `v6.js`) previously gave a system glyph no feedback at all until you
  clicked it (which immediately drops you into that system) — there was
  no way to check a system's stats without navigating away first. Hovering
  a glyph now shows the same `#map-tip` panel the per-system waypoint view
  already uses, with type, home/marketplace/shipyard/jump-gate tags, and
  ship count. Separately, real galaxy coordinates cluster tightly in
  places (confirmed live — dense charted neighborhoods drew as an
  unreadable knot of overlapping rings); added `declutterGlyphPositions()`,
  a light pairwise-repulsion pass that nudges only still-overlapping glyph
  pairs apart after scaling, leaving isolated systems untouched.

- **Fix: the role-change warning claimed a non-probe keeper "won't be able
  to do this role's job" — it will, just less efficiently than a probe.**
  `roleMismatchReason()`'s keeper case only flags a hull mismatch because
  `FleetManager.setShipRole()` places no actual restriction on it — any
  ship reassigned to keeper flies itself to its assigned market and docks
  there via the same `navigateTo()` every other role uses
  (`keeperPoll()`, `agent.ts`). Only a probe/satellite is special-cased
  elsewhere (bought directly at the target waypoint, since it has no fuel
  and can never move itself there) — a mobile hull works fine as a
  keeper, it just spends fuel a probe wouldn't. The warning now says so
  instead of implying the assignment won't work: rewrote it as a
  self-contained per-role message (desktop and Tower both stop appending
  a generic "won't be able to do this role's job" suffix that was simply
  wrong for this one case).

- **Fix (best-diagnosis, unconfirmed on-device): Tower's per-location
  shipyard/route picker rows didn't respond to a tap at all on iPhone,
  even after the poll-rebuild fix above.** Live report: the picker opens
  fine (its toggle button works reliably) but tapping a row inside it did
  nothing — confirmed working from a desktop browser via the equivalent
  `.buy-ship-alt` buttons, so this is mobile-Safari-specific, not a
  server or logic bug. The one concrete difference found between the
  toggle button (works) and the picker's row buttons (don't) in the same
  delegated-click container: the toggle has `cursor: pointer` set inline,
  the row buttons had no `cursor` at all — a known class of iOS Safari
  issue where a delegated `click` (handled by an ancestor's listener
  rather than the element's own) doesn't fire reliably on an element with
  no `cursor: pointer`/interactive CSS signal. `.ship-pick button` now
  sets `cursor: pointer`, `touch-action: manipulation`, and an explicit
  tap-highlight color. This is a plausible fix based on the available
  evidence, not one confirmed against a real device in this sandbox —
  flagged honestly, needs the operator to confirm it actually resolves
  the tap.

- **Fix: Tower's new per-location shipyard/route pickers could buy at (or
  assign) the wrong location — tapping a specific "also" shipyard bought
  at the cheapest one instead.** Same root cause as the ship-detail-panel
  fix earlier this session, one tab over: Tower's Markets tab polls every
  15s (`loadMarkets()` → the `subscribe("markets", ...)` path), and
  `renderMarkets()` unconditionally rebuilds both the routes list and the
  yards list on every poll — including whichever picker the operator just
  opened. A tap that straddles that rebuild can land on whatever element
  ends up at the same screen position afterward, not the one that was
  there when the tap started; live report matched exactly ("clicked the
  row I wanted, but nothing happened" / bought at the home system
  instead). `renderMarkets()` now skips rebuilding a list while its
  picker is open (`openRouteGood`/`openYardGroup`); each toggle handler
  still calls its own render function directly, so opening/closing a
  picker is unaffected — only the periodic path is guarded.

- **Add: a tour ship that finds an uncovered shipyard now holds there,
  docked, until its own keeper-probe approval is decided.** Operator
  requirement, prompted directly by the two live keeper-probe-approval
  races fixed earlier this session: touring on before the operator (or
  the timeout policy) decides just reopens the same "is a ship really
  still there" gap those fixes closed reactively. `tourScout()` now
  checks a new `hasPendingKeeperApproval` callback right after recording
  a shipyard's stock — if a `buyKeeperProbe` request for exactly this
  waypoint is still open (raised just now, or found already open on a
  revisit), it holds instead of picking its next stop. Closes on its
  own once the request is decided (approved, denied, or auto-decided by
  the timeout) — never an indefinite hold. Two new tests in
  `tests/tourScout.test.ts`.

- **Add: manual Dock/Undock to Tower's ship-action sheet.** Desktop has
  had this for a while (`.dock-toggle`, hitting the existing
  `/api/fleet/dock` toggle endpoint), but Tower's sheet never got a
  button wired to it. Same endpoint, same label logic (reads current
  `nav.status`, disabled with an explanatory title while in transit
  rather than hidden).

- **Fix: approving a "buy keeper probe" request could still fail even
  when the confirming ship was genuinely, currently at the yard — just
  in orbit rather than docked.** Follow-up to this session's earlier
  keeper-probe-approval fix (which closed the *stale-cache* version of
  this failure) — a second, separate live report showed the same
  underlying requirement biting a different way: `purchaseShip()` only
  grants access to a docked ship (orbit is navigate/extract only), and
  `resolvePendingKeeperProbeApproval()`'s live presence check confirmed
  the ship was at the right waypoint but never checked docked status.
  It now docks the candidate itself when it's in orbit there, the same
  idempotent dock-if-orbiting step every other purchase call site in
  this file already takes — rather than consuming the approval and
  gambling on catching the ship already docked. `purchaseKeeperProbe()`
  also gets the same clearer "orbiting isn't enough" error wording
  `buyShip()` got, since it calls `purchaseShip()` directly and doesn't
  inherit that translation.

- **Fix: shipyard/module intel listings (desktop and Tower) only let you
  buy at the cheapest location for a ship type or component — every other
  location the "also: X, Y" line named was inert text, with no way to buy
  there instead.** Live report: an operator with a ship already at one of
  the "also" waypoints had no way to buy there at all, only at the
  (possibly distant) cheapest listing. Each "also" location is now its
  own real, clickable buy target — small inline buttons on desktop
  (`.buy-ship-alt`/`.buy-mod` in `renderShipyardIntel()`), an expandable
  per-location picker on Tower (`renderMarketYards()`, same toggle pattern
  the route-assignment picker already used).

- **Fix/clarify: buying a ship failed with a raw "must have at least one
  ship available at the purchase location" even when a ship was right
  there — in orbit.** That's the live API's actual requirement, not a
  bug: per SpaceTraders' own docs, only a *docked* ship can access a
  shipyard — orbit only grants navigate/extract. `FleetManager.buyShip()`
  now catches that specific failure and rethrows with the real
  requirement spelled out ("no ship of yours is docked at ... orbiting
  isn't enough") instead of the generic API wording, on both the desktop
  and Tower buy flows (they share this one code path).

- **Fix: dispatching a tour ship to a system (or any `<select>`-driven
  action in a ship's detail panel) was unusable — the panel reset out from
  under the operator on every attempt, before a choice could be made.**
  Live report: "EVERY time I try and use this so send a tour somewhere it
  refreshes before I can choose." Both places a ship's detail panel
  renders (`openShipDetails()`, shared by the Bridge triage rail's
  `#manifest` and the Fleet tab's own tabbed `#fleet-detail` pane) rebuild
  from scratch on every 5-second fleet-data poll while open — a fix
  earlier in this file's history ("typing resets after a few seconds")
  already preserves a plain text input's value/caret across that rebuild,
  but a `<select>` has no equivalent: choosing an option opens the
  browser's own native picker UI entirely outside the page's DOM, and the
  element stays focused with its value unchanged for however long that
  picker is open — long enough, routinely, to lose the race against a 5s
  poll. The rebuild then replaces the `<select>` out from under the still-
  open picker, so no selection was ever possible to begin with; the
  Fleet-page pane didn't even have the text-input fix. Both refresh
  functions (`refreshOpenShipDetails()`, `refreshFleetShipDetail()`) now
  skip the rebuild entirely for a poll cycle whenever focus is already
  inside the panel, rather than trying to preserve a picker they can't see
  into — the next quiet poll (once the operator is done) picks up
  whatever changed instead.

- **Fix: approving a "buy keeper probe" request on the dashboard could
  silently fail and quietly re-ask later, with no visible error.** Live
  incident: X1-MV41-XZ3Z asked for approval twice, both approved, both
  purchases failed with "must have at least one ship available at the
  purchase location" — each failure burned the approval, so the next time
  any ship happened to redock at that shipyard, `maybeRequestKeeperProbe()`
  asked fresh, with no memory of the earlier approve. Root cause:
  `resolvePendingKeeperProbeApproval()` (`src/engine/fleet.ts`) already
  guarded against firing the purchase with nothing there, but the guard
  trusted `fleetStatusSummary()`'s cached ship positions — each ship's own
  agent's last-known nav, current only as of that ship's own last tick.
  This method runs every fleet tick regardless of whether the candidate
  ship's own tick has run recently, so a tour ship that had already moved
  on since its last tick still read as "at" the yard, passed the guard,
  and the real purchase then failed against SpaceTraders' live state. Now
  confirms the candidate is genuinely still there with one live
  `getShip()` call before ever consuming the approval — the same
  live-over-cached pattern already used everywhere else in this file.

- **Fix: a stalled HTTP call could silently kill a ship's scheduler task
  forever, with no error and no reschedule.** Live incident: two different
  traders (THEO-1, THEO-11) each went dark for 30-50+ minutes, both
  immediately after logging the DRIFT-leg fuel diagnostic (`DRIFT leg to
  X: needs N at cruise, have M/C`) and just before the actual navigate
  call — no error logged, no further scheduler activity for either ship at
  all, until the whole process restarted. `Client.request()`
  (`src/core/client.ts`) called `fetch()`/`undiciFetch()` with no timeout
  or `AbortController` at all; if that one call stalls (dropped
  connection, server accepts but never replies), the promise never
  settles, and since `trader.ts`'s scheduler wrapper only reschedules from
  a call that actually resolves or rejects, the ship's whole task chain
  hangs permanently and invisibly. Two independent ships hitting the exact
  same hang point is what made this a systemic gap rather than a fluke.
  Every request now races a 20s `AbortController` timeout; a stalled call
  retries like a 5xx (bounded by the existing `maxRetries`) and then
  throws a real, catchable `APIError` instead of hanging, so the ship's
  usual error-backoff-and-retry path takes over.

- **Fix: a surveyor parked in its own asteroid field logged a false
  "cannot refuel and no reachable market" warning on every single tick,
  indefinitely, despite surveying successfully every time.**
  `pickSurveyTarget()` (`src/engine/agent.ts`) deliberately prefers
  staying put once a surveyor is already sitting in an asteroid field —
  re-surveying the same field keeps the pool fresh without burning fuel.
  But `surveyScout()` still called `refuelIfNeeded(5, target.symbol)`
  unconditionally, even when `target` was exactly where the ship already
  stood. `refuelIfNeeded()`'s round-trip budget prices a full "get there,
  then get back out to the nearest market" trip regardless of distance —
  for a 0-distance target that's still whatever it costs to reach the
  nearest real market from an asteroid field that isn't one itself, which
  can be large or entirely unreachable. Same root cause `scout.ts`'s
  `pickChartTarget()` call site hit earlier this session (the THEO-A
  6-hour-hold incident) — now fixed the same way there: the refuel gate is
  skipped entirely when the ship is already standing on its own target,
  since no travel is about to happen and there's nothing to budget fuel
  for.

- **Fix: a trader restarting mid-haul could lose track of cargo it had
  already bought, get reassigned an unexecutable good, and sit stuck full
  forever.** Live incident: THEO-1 bought 40u MEDICINE in two 20u lots five
  seconds apart; a Render restart (triggered by an unrelated deploy) landed
  right after the second lot but before `persistHeldRoute()` ran — that
  write only happened once, after the *entire* multi-lot buy loop
  completed, not after each lot. On reboot the app had no durable memory of
  the trip, so `deliverHeldCargo()` had nothing to resume, and
  `RouteDispatcher.recompute()`'s busy-carry-forward logic (which only
  protects a trader when its own in-memory `this.assignments` map — wiped
  on every restart — already has a record for it) handed the now-full,
  cargo-stuck ship a fresh, unexecutable good on every recompute since.
  Two independent fixes: `trader.ts` now sets `heldRoute`/`heldCost` and
  calls `persistHeldRoute()` after *every* lot of a multi-lot buy, not once
  at the end, so even a restart between the first lot and the second finds
  a durable pin for what's already in the hold; `dispatcher.ts`'s
  `recompute()` now also skips any trader reporting `busy: true` (real
  cargo in the hold, per `dispatcherTraders()`) even when it has no
  carried-forward assignment record, leaving genuinely busy ships alone
  rather than assigning them fresh work — `TraderAgent`'s own held-route
  recovery is the one place with enough detail to resume correctly.

- **Fix: the dedicated explorer role re-toured a system's markets on every
  single revisit, forever, instead of just the first.** Live incident:
  THEO-C (role `explorer`) ping-ponged between X1-FF6 and X1-NR97 — the
  only two systems its home gate connects to, both fully surveyed within
  the first couple of trips — for over a day straight, re-running the exact
  same multi-stop market tour (including a 574-fuel DRIFT leg to
  X1-FF6-F25B) on every visit for zero new data.
  `FleetManager.exploreSystem()`'s candidate selection already tries to
  prefer an unsurveyed system (`candidates.find(c =>
  !surveyedSystems.has(c))`), but once every reachable system is surveyed
  it has nothing left to return and falls back to `candidates[0]` — the
  system it just came from — and the function then unconditionally re-ran
  the whole market survey regardless of whether `target` was already
  marked surveyed. It now skips straight to the jump-through once a target
  is already in `surveyedSystems`. Separately: `ShipProxy.runExploreGoal()`
  (the path `autoExplore()`'s occasional repurposing of an idle tour/scout
  ship uses) never marked a system surveyed at all — a real, independent
  gap from the same root cause, now fixed with a new `onSystemSurveyed`
  callback wired from `FleetManager` into every tour/scout/explorer
  `ShipAgent`/`ScoutAgent` construction site. Two new tests in
  `tests/fleet.test.ts` covering `exploreSystem()`'s skip; the existing
  `tests/shipProxy.test.ts` suite (unchanged) confirms `runExploreGoal()`
  itself still behaves correctly with the new callback wired in.

- **The dedicated explorer now backtracks through known space once its
  immediate neighbors are exhausted, instead of just bouncing between
  them.** Follow-up to the fix above: skipping the re-tour stopped the
  wasted fuel, but THEO-C still had no way to reach anything past X1-FF6
  or X1-NR97 — `exploreSystem()`'s candidate selection only ever looked at
  systems *directly* connected to wherever the ship currently stood, so
  with both immediate neighbors surveyed it was permanently capped at
  those two, forever. New `FleetManager.nextHopToUnsurveyed()` runs the
  same multi-hop BFS `advanceTourDispatch()` already uses for a tour
  ship's cross-system trip, but across *every* system this tenant knows
  of, and returns just the next hop toward the nearest one still
  unsurveyed — so the explorer now hops back through an already-known
  system when that's genuinely the only way onward, rather than treating
  "nothing new next door" as "nothing new anywhere." Two new tests in
  `tests/fleet.test.ts`.

- **Fix: a scout refusing to even attempt a leg it couldn't afford at
  CRUISE, when DRIFT could likely have covered it.** Live incident,
  immediately downstream of the fix below: once THEO-A got past
  X1-MV41-B11A, its next target sat far enough away that a full CRUISE
  round trip to the system's only known market (~104 fuel) exceeded its
  92/300 tank — and it held indefinitely, `not enough fuel for
  X1-MV41-EX9X and no reachable market`, the same as before. But
  `navigateTo()` already has an automatic DRIFT fallback for exactly this
  case (`chooseFlightMode()` in `flightMode.ts`, whose own design note
  says "any successful navigation beats none" — DRIFT costs meaningfully
  less fuel than CRUISE for the same distance, in exchange for a much
  slower transit), and the real navigate API is the final authority
  either way. The scout's pre-flight `refuelIfNeeded()` gate never gave it
  the chance: a refusal was treated as "cannot proceed at all" and held
  before `navigateTo()` ever ran. It now only holds when genuinely out of
  fuel (0, matching `navigateTo()`'s own `StrandedError` threshold) —
  otherwise it hands off to `navigateTo()` and lets DRIFT (or the live
  API's own rejection, worst case) decide. Tests updated/added in
  `tests/cooldownPending.test.ts` and `tests/scoutSelfTarget.test.ts`.

- **Fix: a scout standing exactly on its own next chart target held for
  fuel it didn't need, for over 6 hours straight.** Live incident: THEO-A
  jumped into X1-MV41 (the earlier fix below working as intended), toured a
  few waypoints, then arrived at X1-MV41-B11A — an uncharted asteroid with
  no market of its own — with 92/300 fuel, and got stuck holding there
  forever: `holding at X1-MV41-B11A: not enough fuel for X1-MV41-B11A and
  no reachable market`. `pickChartTarget()` correctly picks the nearest
  uncharted waypoint, which can be the ship's own current position (distance
  0) once everything else nearby is charted — but `tick()` still ran the
  full `refuelIfNeeded()` round-trip budget before attempting to chart it,
  which prices in a return trip to the *nearest market*, regardless of
  whether the ship is actually about to travel anywhere. From B11A that
  return trip was 100+ fuel to the system's one distant fuel station — a
  cost with nothing to do with charting a waypoint already underneath the
  ship. `tick()` now skips the refuel gate entirely when the ship is already
  standing on `target`, since `navigateTo()` no-ops in that case anyway and
  no fuel is at risk. Two new tests in `tests/scoutSelfTarget.test.ts`; also
  fixed a latent gap in an existing `cooldownPending.test.ts` fixture that
  had the same self-target ambiguity (its "must not fly with no fuel" test
  happened to still pass before only because the refuel gate never checked
  which target it was for).

- **Fix: a tour ship dispatched across multiple jump-gate hops got stuck
  mid-route, mis-reading its own in-flight transit as a failed jump.** Live
  incident: THEO-14 was bought and dispatched to tour X1-B48 (2 known hops
  away), but sat touring X1-XB94 indefinitely, logging `tour dispatch hop
  to X1-B48 failed, touring X1-XB94 while waiting: [object Object]` on
  every retry. `advanceTourDispatch()`'s `jumpShip()` call reaches the gate
  via `dispatchShip()`/`agent.dispatchTo()`, which for a tour ship
  (`ShipAgent`) really flies there and throws `NavigationPending` as real
  control flow while `schedulerDriven` is true — not a failure. The old
  catch treated any thrown value as a genuine jump failure, permanently
  (mis-)recording a perfectly good gate as under construction via
  `recordGateNotComplete()` and falling back to local touring — the exact
  same misdiagnosis on every subsequent retry, since a multi-hop dispatch
  always needs at least one real transit. (The `[object Object]` was
  `String()`-ing a `Pending`, which isn't an `Error`.) `advanceTourDispatch()`
  now re-throws `Pending` so it propagates to `nextTourTask()`'s own catch,
  which already reschedules correctly at `err.resumeAt` — a genuine jump
  rejection still records the gate as blocked, unchanged. Two new tests in
  `tests/fleet.test.ts`.

- **Fix: `ScoutAgent.dispatchTo()` never actually flew the ship, breaking
  every jump through it.** Live incident, caught within an hour of shipping
  the scout-jump feature below: THEO-A sat at X1-B48-F25A while the fleet
  logged `THEO-A jumping X1-B48-B13A -> X1-VJ42-X19E` followed immediately
  by `Failed to execute jump. Waypoint X1-B48-F25A is not a jump gate.` on
  a ~90s retry loop for 15+ minutes straight. Root cause: unlike every other
  role's `dispatchTo()` (`ShipAgent`, `TraderAgent`, `SiphonerAgent` all
  actually fly there and block until arrival, propagating `Pending`
  correctly inside a scheduled tick), `ScoutAgent.dispatchTo()` just set a
  `manualGoal` flag and returned immediately, leaving the actual flight for
  some future tick to notice. `jumpShip()`/`dispatchShip()` assume the
  standard contract — they call `dispatchTo()` to reach the gate, then
  immediately attempt the live jump expecting the ship to already be there
  — so for a scout the ship never moved and every jump attempt failed
  against wherever it actually was standing. `ScoutAgent.dispatchTo()` now
  matches the other roles: navigates and orbits for real (still recording
  `manualGoal` so a later tick charts the destination), letting
  `schedulerDriven` propagate `Pending` exactly like `ShipAgent.dispatchTo()`
  already does. Three new tests in `tests/scoutDispatchTo.test.ts`.

- **Chart scouts jump to a new system once their current one is fully
  charted, instead of idling forever.** Live incident: THEO-A was
  converted to `scout` and assigned X1-B48, but a live public-API check
  confirmed all 30 of B48's waypoints already had a `chart` (almost
  certainly charted first by the 32-ship rival fleet HYDRA) — it kept
  cycling every waypoint logging `already charted, skipping`, burning fuel
  for zero value with no way out. `ScoutAgent` gained a
  `jumpToUnchartedSystem` hook, called when `pickChartTarget()` comes up
  empty and there's nothing left to sensor-scan either; `FleetManager`'s
  new `scoutJumpToUnchartedSystem()` picks a connected system (preferring
  one already known to have an uncharted waypoint, then an unchecked one,
  before retrying anything already confirmed empty — tracked in a new
  `scoutExhaustedSystems` set so it can't ping-pong between two exhausted
  neighbors), jumps via the existing `jumpShip()`, and force-refreshes the
  destination's waypoint traits (`refreshWaypointTraits()`, same fix as the
  B48 stale-cache bug below) so the very next tick sees accurate chart
  status. Gated by a new `scoutCreditFloor` doctrine value plus the shared
  `exploringEnabled` switch — same budget-limit shape as explorers'
  `explorerCreditFloor`, sized separately since a scout's jump is a much
  cheaper, single-hop spend. Four new tests in `tests/scoutJump.test.ts`.

- **Traders top off at a fuel market before departing, not just when low.**
  Live incident: THEO-B (600-unit tank) departed a fuel-selling market at
  392/600 (65%) — above the old `<50%` refuel trigger, so `navigateTo()`
  skipped it entirely — then needed 453 fuel for the very next leg at
  CRUISE and had to fall back to DRIFT, several times slower, for a trip a
  topped-off tank would have flown normally. Tour ships already got this
  exact fix (`ShipAgent.tourScout()`'s "top off at every market, not just
  when running low"); traders never did. `TraderAgent.navigateTo()` now
  tops off whenever docked at a real FUEL-selling market and not already
  ~95% full — a same-system round trip's fuel math doesn't know what leg
  comes next, and checking a market that already sells fuel costs nothing
  extra. The other refuel path — burning FUEL out of the cargo hold when
  there's no market here — is a real tradeoff (hold space, not a free
  top-off) and stays gated to genuinely low, unchanged. Four new tests in
  `tests/trader.test.ts`.

- **RouteDispatcher: check the sell leg's fuel distance too, not just the
  buy leg.** Live incident: THEO-11 (80-unit tank) was assigned
  `ADVANCED_CIRCUITRY X1-XB94-D43 -> X1-XB94-A4`, rejected a cycle later
  inside `TraderAgent.findRoute()` (`buyAt->sellAt distance 91 exceeds fuel
  capacity 80`), then handed a different unreachable/unprofitable route
  twice more over the next 15 minutes — never completing a trip — while 14
  other same-system routes it could actually fly sat unused in the same
  ranked work list. `RouteDispatcher.recompute()`'s `reachable()` check
  (added for a prior DRAGOM-3 fuel-distance case) already verified the ship
  could reach *buyAt* from its current position, but never checked that the
  *whole round trip* (buyAt→sellAt) fit the tank —
  a same-system route could pass the first check and still be physically
  unreachable for a small hull. It now also checks `distance(buyAt,
  sellAt) <= fuelCapacity` for a same-system `direct` item (the one role
  that needs the full round trip, unlike buy/sell/haul); a cross-system
  sell leg is untouched, since that's a jump, not a fuel-distance flight,
  and `canJump()` already covers whether it's possible at all. Three new
  tests in `tests/dispatcher.test.ts`.

- **Fix a tour ship never seeing a system's own markets when it was cached
  before they were charted.** Live incident: THEO-A, dispatched to X1-B48,
  arrived and sat reporting `no reachable target` forever instead of
  touring, even though the diagnostic breakdown added earlier the same day
  confirmed the ship genuinely had zero in-system targets (`0 in X1-B48,
  atMarketHere=false`) — not a fuel-range problem. Root cause: SpaceTraders
  only reveals a waypoint's `traits` once *someone* (any agent, not
  necessarily this tenant) has actually charted it. X1-B48 was scanned and
  cached weeks before this session's tour-dispatch feature existed; at that
  moment its two FUEL_STATIONs and two PLANETs apparently hadn't been
  charted yet, so they cached with empty trait arrays — no MARKETPLACE,
  permanently, since `GalaxyAtlas.loadSystem()` trusts any non-empty cached
  waypoint list forever and never re-fetches it. The live API shows all
  four carrying MARKETPLACE today (confirmed by hand against the public
  endpoint), but this tenant's cache never learned that.
  `GalaxyAtlas.refreshWaypointTraits()` is the one deliberate exception to
  that trust rule — a live re-fetch that overwrites the cached waypoint
  list while preserving already-resolved jump gates. `tourScout()` now
  calls it (via a new `refreshSystemMarkets` agent option, wired for tour
  agents only) exactly once per system when it finds zero in-system targets
  despite knowing the system exists, so a genuinely marketless system still
  only pays for one live call rather than one every tick forever. Five new
  tests across `tests/galaxy.test.ts` and `tests/tourScout.test.ts`.

- **Tour dispatch now routes around a specific gate under construction,
  instead of only ever considering the shortest hop count.** Follow-up to
  the fix below: `findSystemPath()`'s BFS picked the fewest-systems route
  regardless of whether any gate along it was known to be blocked — for
  THEO-10's case, X1-XB94's genuine direct gate to X1-MJ67, which returned
  that path forever even once `advanceTourDispatch()` had recorded
  X1-MJ67-I55 as incomplete, since nothing about the pathfinding itself
  cared. It now excludes any connection through a gate the construction
  cache already knows is incomplete before running BFS, so a longer but
  actually-jumpable route (through a different gate into the same
  destination system, where one exists) wins instead. A gate with unknown
  status is still included — this doesn't require every gate on a route to
  already be verified before a first attempt. When a destination's only
  known gate is the blocked one, this correctly falls back to "no known
  path yet" rather than fabricating a route that can't exist — reaching
  X1-MJ67 specifically still has to wait on that gate's own construction,
  same as before, since it has only the one gate. Three new tests in
  `tests/fleet.test.ts`.

- **Fix a tour ship retrying a doomed jump forever instead of touring while it
  waits.** Confirmed live: THEO-10, dispatched to tour a remote system,
  spent over an hour "sitting at the gate" — every tick it tried to jump to
  X1-MJ67-I55, got rejected ("Destination jump gate ... is under
  construction"), logged "will retry next tick", and unconditionally
  reported back to `tourScout()` that it had done work, which skipped the
  ship's normal same-system touring target selection every single time. The
  explore path already has the right pattern for this
  (`ShipProxy`'s JUMP phase calls `GalaxyAtlas.recordGateNotComplete()` on a
  live rejection so `canJump()`/`gateComplete()` stop lying), but
  `advanceTourDispatch()` never used it — it just retried the identical
  jump blind, every tick, forever. It now checks `gateComplete()` before
  attempting (skipping the attempt once the cache already knows the gate is
  incomplete) and calls `recordGateNotComplete()` on a live rejection,
  falling through to normal touring of the ship's current system in both
  cases instead of reporting "did work". `FleetManager.tick()`'s existing
  periodic `refreshGateConstruction()` sweep is what notices the gate
  actually finishing and lets the tour resume on its own.

- **Fix a released ship standing down forever against its own stale hold.**
  Confirmed live: THEO-10 (a tour ship) was released from the dashboard —
  the "Hold" button correctly reappeared, `operatorHolds` and the persisted
  `shipManualState` were both correctly cleared — but the fleet-status log
  kept reporting `want:hold <waypoint>` for it indefinitely, and the ship
  just sat at the gate instead of touring. `IntentBoard.commit()` only ever
  resolves *this tick's* proposals (confirmed intentional — see
  `intent.test.ts`'s "leaves the standing intent in place"); a ship nothing
  proposes anything for keeps whatever was last committed forever, it's
  never implicitly retracted. Every other fleet-driven goal (repair, tender,
  explore, scrap) already calls `forgetIntent()` itself when it finishes;
  `hold` has no natural finish, so `releaseTo()` — the one path every
  release goes through — had to do it instead, and didn't. A tour ship is
  the case that surfaced this: nothing else ever proposes anything for it,
  so once its one active proposal (the operator hold) stopped, the stale
  committed intent from before the release just sat there, and `tourScout()`
  kept standing down against it via `standDownReason()`. `releaseTo()` now
  calls `forgetIntent()` too. Also gives `releaseTo()` a log line
  (`<ship>: released to <owner>`) — it never had one, unlike `holdShip()`/
  `sendShipTo()`, which made this harder to confirm from the logs alone.
  New regression test in `tests/fleet.test.ts`.

- **Show other agents sharing a system, both on the public map and in the
  game UI.** Prompted by a live incident: a competing fleet (HYDRA, 32
  ships) sharing THEO's home system turned out to explain both a mystery
  gate contributor and a market staying crushed longer than THEO's own
  volume alone would predict — the operator asked for this to be visible
  going forward instead of hand-checked. `GalaxyCrawler` gains a periodic
  (hourly) pass over the public `GET /agents` directory, grouped by
  headquarters system and kept in memory alongside its existing
  factions/systems crawl — same "no tenant client, no rate-limit cost"
  design as those two, since credits/ship counts genuinely change over
  time unlike static faction/system data. `/cartography`'s click-a-system
  panel now lists agents headquartered there (symbol, ship count,
  credits), sorted by fleet size. The v6 dashboard's Galaxy tab gains a
  matching "Agents in system" pane, scoped to the signed-in tenant's own
  home system (`GET /api/agents-in-system`), next to the existing
  Leaderboard/Factions panes. Verified end-to-end with real data through
  both surfaces (mock server + Playwright): correct sort order, "· you"
  marking on the v6 pane, counts and credits formatted correctly.
- **Fix `/cartography`'s click-a-system panel never opening.** Confirmed
  live: clicking a dot did nothing, no matter which one. Root cause was
  in the drag-to-pan handler added alongside the panel itself
  (`setupMapControls()`'s `pointerdown` listener): it called
  `svg.setPointerCapture()` unconditionally, even when the press landed
  on a dot. Once the SVG has pointer capture, the browser routes the
  resulting synthetic `click` event to the capturing element instead of
  the dot underneath the pointer, so the dot's own click listener
  (`openSystemPanel`) never ran — reproduced with a real simulated
  click (fails) versus a directly-dispatched click event on the same
  node (works, since it bypasses native pointer-capture routing).
  Fixed by skipping the drag-start (and the capture) when the press
  target is a `circle.dot` — a press starting on a dot is a click, not
  a pan. Drag-to-pan on empty map background still works, verified.
- Replace the flat 10-minute sale cooldown with graduated, volume-based
  route scoring. Confirmed live: THEO's fleet ran up 3.6M credits in
  ~30 minutes system-wide, then every route in the system went to zero
  profit at once — a per-route cooldown only reacts *after* a specific
  route is sold into, so a burst spread thin across many routes never
  individually triggers it, even though the fleet's own volume is what
  crashed the whole market. `RouteDispatcher.recordSale(good, sellAt,
  units)` now tracks recent sold volume per market (30-minute rolling
  window) and `scoreRoute()` discounts a route's ranking — not its real,
  displayed profitPerTrip — proportionally to how much of a full trip's
  worth of volume the fleet has already dumped there recently. Selling
  roughly one trip's worth halves a route's score, two trips' worth
  thirds it, and so on, so the dispatcher naturally spreads trades
  across markets *before* a price actually collapses, and a market's
  fatigue fades smoothly as the window ages sales out rather than
  snapping back all at once at a fixed cooldown expiry. A heavily-sold
  route still wins if it's the only one for its good. Also closes a gap
  the first pass of this change introduced: the existing "second
  trader, different market" fallback pushed its own work item at the
  route's raw, undiscounted profit, which could out-rank the
  now-deprioritized primary pick in the final cross-good sort and
  silently undo the whole adjustment for a single-trader case — both
  direct-route ranking figures are now decayed consistently. Four new
  tests in `tests/dispatcher.test.ts` cover the decay, its recovery
  over time, and the single-route-survives-fatigue case.
- Fix two idle traders getting assigned the identical route while one was
  already flying it. Confirmed live: THEO-B was mid-haul on CLOTHING
  X1-XB94-K87 -> X1-XB94-A1 (bought, in flight, not yet sold) when the very
  next `dispatch recompute` handed THEO-A the identical CLOTHING/A1 leg
  fresh — the same-route collision the 10-minute sale cooldown (below,
  2026-09-14 earlier) does not cover, since no sale had happened yet to
  start that cooldown. Root cause: `RouteDispatcher`'s busy-carry-forward
  reserves a busy direct trader's leg under the qualified `good@sellAt`
  key, but the new "best route for this good" work item generated each
  cycle was keyed on the bare good with no market qualifier — the two keys
  never collided, so nothing stopped a second, idle trader from being
  freshly assigned the exact leg the first was already flying. Fixed by
  tracking busy direct traders' claimed (good, sellAt) pairs and checking
  them at both places new route work gets generated; a second trader can
  still take the same good into a genuinely different market, which is
  the feature this collision was hiding inside of. Two new regression
  tests in `tests/dispatcher.test.ts` (verified to fail without the fix).
- **Cartography: click-a-system side panel.** Clicking a dot on the
  public `/cartography` galaxy map now opens a slide-in panel with that
  system's sector/type, waypoint count and type breakdown, and any known
  jump-gate connections (each clickable to re-center the map on the
  destination system). New `GET /api/cartography/systems/:symbol`
  (`Store.getGalaxySystemDetail()`) reads tenant-scanned `waypoints` when
  available, falling back to the background crawler's `crawledWaypoints`
  only when a system hasn't been visited by any tenant yet — the two are
  never merged. This was scoped in `docs/TODO.md` on 2026-09-14 and
  shipped the same day (`b72fec4`); logging it here since it went
  straight into a commit without a changelog entry at the time. Map dots
  themselves stay system-granularity — no per-waypoint markers yet.
- Fix a paused construction mission silently un-pausing itself across a
  restart. `MissionManager.persist()` wrote the DB row's `paused` column
  from a flag passed in at each call site, defaulting to `false` when
  omitted — but `tick()`'s periodic `reconcile()` (which keeps a paused
  mission's material counts fresh even while paused, on its own slow
  cadence) called `persist(mission)` without ever passing that flag, so
  every reconcile of a paused mission quietly wrote the DB row back to
  unpaused while it stayed correctly paused in memory. The next restart
  read that stale row and resumed the mission on its own — no operator
  action, no log line admitting it. Confirmed live: tenant `bfc926dc`'s
  `X1-XB94-I55` mission (paused 2026-09-14 03:32, released THEO-B) came
  back resumed and buying FAB_MATS again at 11:49, the first restart
  whose only intervening `persist()` call was `reconcile()`'s. Fixed by
  having `persist()` always derive `paused` from the live `this.paused`
  Set instead of trusting a per-call flag, so every persist reflects
  the true in-memory state.
- Tower's More tab gains an Activity section — sells, buys, repairs,
  scraps, jumps, mission/contract events, warehouse moves, and the
  like, reusing the same `activity` store slice and `/api/activity`
  endpoint desktop's own activity feed already reads (no new backend).
  Mining extraction, surveying, siphoning, and market/shipyard scan
  snapshots are filtered out client-side (`ACTIVITY_HIDDEN_KINDS` in
  m.js) — those fire on essentially every tick and would drown out
  everything else in a feed meant to answer "what's going on," not
  replay the tick log. Desktop's own activity feed is untouched.
- Fix (correction to the same-day StrandedError fix below): watched
  THEO-9 live after deploying StrandedError and it kept looping anyway
  — turned out it was sitting at 0 fuel *right on top of* a market that
  sells fuel (X1-XB94-E44), so `navigateTo()`'s "not at a market" check
  correctly did not treat it as stranded, but `runRepairGoal()`/
  `runScrapGoal()` never called `refuelIfNeeded()` before navigating in
  the first place — unlike `runHoldGoal()`, which already did. The ship
  just kept computing a route through a *different*, equally-unreachable
  fuel stop instead of buying fuel where it already stood. Both now call
  `refuelIfNeeded({ reserve, target })` before `navigateTo()`, same as
  `runHoldGoal()` already does.
- `RouteDispatcher` now deprioritizes a `(good, sellAt)` leg for
  `SALE_COOLDOWN_MS` (10 min) right after a trader actually sells there —
  new `recordSale()`, called from both of `TraderAgent`'s sell sites
  (the direct-route leg and the warehouse `sell` role). Confirmed live:
  the existing "two traders may share a good only when selling into
  different markets" protection only reserves a leg while the ship
  flying it is *busy* — the moment it finishes and goes idle, the
  reservation releases, and since ranking is pure last-known profit, the
  very next idle trader was handed the identical "best" route before the
  price its predecessor's own sale had just crashed got any chance to
  recover: THEO-1 sold 40u ELECTRONICS at X1-XB94-D43 for 35,900c;
  THEO-A sold the same 40u at the same waypoint 8 minutes later for
  20,800c. The cooldown is a deprioritization, not a hard block — a
  cooling leg still gets picked if it's the only route for its good, so
  a trader is never left idle over it, but loses to any real alternative
  first.
- Fix: a fleet-driven goal (repair/scrap/hold/explore/tender) whose ship
  ran out of fuel mid-route retried the identical doomed navigate call
  forever — every ~13s, no back-off, no recovery. Reported live: THEO-4
  and THEO-9 (mid-scrap) retried "requires 1 more fuel for navigation"
  for hours, contributing to multi-hour stretches overnight where the
  earnings tracker showed zero sales fleet-wide. Root cause:
  `navigateTo()`'s "route via a fuel stop" logic could pick a stop
  computed from the ship's own 0 current fuel — which is, by definition,
  exactly as unreachable as the original destination — and just let the
  live API call fail every time. `navigateTo()` now throws a new
  `StrandedError` immediately when the ship has 0 fuel and isn't at a
  market, before ever attempting that doomed call;
  `ShipProxy.runFleetDrivenGoal()` catches it centrally (covering all
  five fleet-driven goals in one place) and backs off cleanly instead of
  logging a fresh "agent error" every cycle. `getStrandedShips()` still
  derives stranded status independently from live ship state, so this
  doesn't change whether a fuel-tender rescue gets attempted — only stops
  wasting API calls and log volume on a call already known to fail. *Why
  no rescue tender ever reached these two ships in the first place is a
  separate, still-open question — not fixed here.*
- Fix: a scout/tour ship's opportunistic jump (`autoExplore()`) could
  retry an identical doomed jump forever once committed — confirmed
  live, THEO-C retried a jump through X1-XB94-I55 every ~11s for hours,
  always failing "Jump gate X1-XB94-I55 is under construction" even
  though `canJump()`'s own pre-check is supposed to filter out exactly
  this. Root cause, two parts: (1) `GalaxyAtlas.refreshGateConstruction()`
  treated *any* error from the construction-status check — not just a
  404 (genuinely no construction record, i.e. pre-built) — as "gate is
  complete," permanently poisoning the one-way cache on what could've
  been a transient failure; now only a real 404 is treated that way, any
  other error leaves the gate unresolved for the next sweep to retry.
  (2) Once a ship's committed intent already had a bad gate baked in
  (from before the cache was poisoned), nothing ever re-validated it —
  `runExploreGoal()`'s JUMP phase just retried the same `jumpShip()` call
  forever. It now catches a jump rejection, calls the new
  `GalaxyAtlas.recordGateNotComplete()` (the one deliberate exception to
  the cache's one-way design — a live rejection is stronger evidence
  than any cached guess) to correct the cache immediately, and abandons
  the goal so the fleet re-decides next pass. Also fixed a related bug
  found while tracing this: `exploringShips` only ever gained entries —
  nothing removed a ship from it once its trip ended (success *or*
  failure), so any ship that had ever auto-explored once was
  permanently benched from being picked again for the rest of the
  process's life. `autoExplore()` now reconciles it against each ship's
  actual current intent on every pass.
- `sellShip()` now re-fetches the ship live instead of trusting its agent's
  cached snapshot before picking a scrap yard — that cache only refreshes
  on the agent's own tick cadence, so a ship whose agent hadn't ticked
  recently could have its *previous* system searched for a yard instead
  of its real current one, reporting "no known shipyard" even when the
  true current system has one. The error message on a genuine miss is
  also far more specific now (distinguishes "this system was never
  scanned" from "it was scanned, but nothing there has a SHIPYARD trait")
  — reported live: an operator scrapping a miner from Tower saw it fail
  even in a system they could confirm had shipyards, and the prior plain
  "no known shipyard in <system>" message gave no way to tell which of
  these it actually was.
- Fix: selling/scrapping a ship stationed in a system with no shipyard of
  its own (the common case for a miner parked in an asteroid field) threw
  "no known shipyard in &lt;system&gt;" and did nothing. `sellShip()` now
  calls a new `nearestShipyardForSale()`, which looks one gate-hop past
  the ship's own system when nothing scrappable is known locally, and
  `runScrapGoal()` (`src/engine/shipProxy.ts`) jumps there first via the
  same `jumpTo` primitive `runHoldGoal()` already uses for a cross-system
  target. Deliberately not shared with repair's own yard lookup — a
  critically damaged ship should not be routed further afield on top of
  its existing damage, and `runRepairGoal()` has no jump handling of its
  own — so repair stays same-system-only. Reported live: scrapping a
  miner did nothing, even after the keeper fix below.
- Fix: `FleetManager.controlledAgent()` was missing `keepers` from the role
  maps it checks, so Hold, Sell/Scrap, Send-to-waypoint, role-change, and
  designate-warehouse-ship all threw "not under fleet control" for any
  ship currently in the keeper role — on both the desktop dashboard and
  Tower — even though `shipFor()`/`stepFor()`/`noteShipState()` already
  worked around the same gap for reads. `keepers` is the same `ShipAgent`
  class as every other role map, so it now belongs in `controlledAgent()`
  directly; the three read-path fallbacks that special-cased it are
  simplified now that they're redundant. Reported live: scrapping THEO-3
  from Tower did nothing.
- Fix: holding or releasing a ship (Fleet tab, either the triage-row
  buttons or the ship-detail modal) now also refreshes the Dispatch/Trade
  Ops assignment list, not just Bridge. `holdShip()`/`releaseShip()`
  free or reclaim that ship's dispatcher assignment immediately
  server-side, but the Dispatch list only re-polls every 20s — in that
  window a just-held ship's stale pre-hold route stayed on screen
  alongside whichever other trader the dispatcher handed the now-freed
  route to, looking like two ships sharing one route. They were never
  both actually running it; it was a display lag, not a duplicate
  assignment.
- Galaxy crawler Phase B + C: `GalaxyCrawler` no longer needs any tenant's
  authenticated `SpaceTraders` client to make progress — every endpoint it
  calls (`/systems`, `/factions`, `.../jump-gate`) is public, so it now
  runs on plain tokenless `fetch()` and no longer competes with any
  tenant's rate limiter (`TenantRegistry.anyBootedApi()`, which existed
  only for this, was removed). Once the systems/factions crawl finishes,
  it now also runs an ongoing opportunistic sweep of every known-but-
  unresolved jump gate, checking the public (no-token, chart-gated)
  `.../jump-gate` endpoint on the chance some other player has charted it
  since — most checks still fail (still uncharted by anyone), but hits are
  free connection data merged into `galaxy_systems.jump_gates` via a new
  `Store.mergeGateConnections()` (read-modify-write scoped to just that
  column, leaving `waypoints`/`crawled_waypoints` untouched). A drained
  queue rebuilds and re-sweeps every 24h. New `Store.listSystemsForGateCrawl()`
  feeds the queue build. See `docs/TODO.md`'s cartography items for what's
  still not wired up on the rendering side, including a spec'd (not yet
  built) click-a-system side panel for the public cartography page.

## 2026-09-13 (Galaxy crawler: stop discarding free per-system waypoint data)

Verified live against the real SpaceTraders API (no token): `GET
/systems` — which `GalaxyCrawler` already calls once per page for
system-level metadata — embeds every system's full waypoint list
(symbol/type/x/y/orbitals) in the same response. The crawler was
discarding that array entirely and only persisting sector/type/x/y.

- `migrations/020_galaxy_crawled_waypoints.sql` — new `crawled_waypoints`
  column on `galaxy_systems`, deliberately **separate** from the existing
  `waypoints` column. `GalaxyAtlas.loadSystem()` (the per-tenant boot
  path) treats any non-empty `waypoints` row as a fully-scanned system
  and casts it straight to the live API's `Waypoint` type (`.traits`
  included) with zero live fetch — writing this public, trait-less data
  there would have handed a tenant's very first visit to that system
  waypoints missing `.traits` entirely, and every trait check downstream
  (shipyard/marketplace detection, mount checks) would throw. Caught
  before shipping, not after.
- `src/db/store.ts` — `mergeSystemWaypoints()` (writes only
  `crawled_waypoints`, leaves `waypoints`/`jump_gates` untouched);
  `listGalaxySystems()` now also returns `crawledWaypoints`.
- `src/engine/galaxyCrawler.ts` — `crawlSystemsPage()` now persists
  `sys.waypoints` via the new method alongside the existing meta write.

**Honest scope note**: this only captures the data — nothing renders it
yet. The public cartography page draws one dot per *system*, never
per-waypoint; Tower/desktop's galaxy views read a tenant's own in-memory
`GalaxyAtlas`, not this shared column. Wiring an actual view is a
separate follow-up (`docs/TODO.md`). The larger design (decoupling the
crawler from any tenant's authenticated client, and opportunistic
jump-gate connection discovery via the same public, chart-gated
`.../jump-gate` endpoint) is also not built yet — this is Phase A of
three only.

Typechecked clean. Full test suite couldn't run against the remote test
Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this session,
retried twice).

## 2026-09-13 (System classifier + starter doctrine templates)

Operator idea, following straight from the checkpoint's new system-
attribute capture: classify a system by those attributes and suggest the
right doctrine template for that type, rather than every tenant running
identical settings regardless of what its home system actually looks
like.

- `src/engine/systemClassifier.ts` (new) — `classifySystem()`, a plain
  rule-based classifier (deliberately not learned — this matches the
  doctrine system's own explicit-rules philosophy) over market/shipyard/
  jump-gate/connectivity counts, sorting a system into `isolated`,
  `market_desert`, `shipyard_poor`, `hub`, or `standard`. `DOCTRINE_TEMPLATES`
  pairs each archetype with a small set of starter doctrine deltas (e.g.
  `isolated` zeroes `explorerTarget` — there's no gate to jump through;
  `hub` turns on `warehouseTarget` and raises `keeperCount` — enough
  markets and liquidity to be worth it). Explicitly a first-pass
  starting point, not a tuned result — every value is normal editable
  doctrine afterward.
- `src/http/admin.ts` — the checkpoint's captured system snapshot now
  includes its `archetype`. Two new endpoints: `GET
  /tenants/:id/system-template` (read-only preview: classify the
  tenant's *current* home system, return the matching template) and
  `POST /tenants/:id/apply-template` (re-classifies fresh server-side
  rather than trusting a client-sent archetype, then applies each
  delta via `Doctrine.setAdopted()` + `.set()` — the same public API
  the dashboard's own Doctrine tab uses). Nothing runs on its own; this
  only ever executes on an explicit operator click.
- `public/admin.html`/`admin.js` — the Play style panel now shows the
  detected archetype and template preview (when the tenant is booted in
  this process) with an "Apply template" button, confirmed before it
  fires since it changes live doctrine settings.

Typechecked clean. `tests/admin.test.ts` couldn't run against the
remote test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier
this session, retried twice).

## 2026-09-13 (Checkpoints now capture home-system attributes too)

Operator observation: the same manual strategy that's working great on
THEO doesn't transfer to THEO-2 at all — the systems aren't comparable,
so a fair play-style comparison needs to control for the system's own
attributes (market count, etc.), not just tenant performance.

- `src/http/admin.ts` — `POST /tenants/:id/checkpoint`'s auto-captured
  `meta` now also includes the tenant's home system: waypoint count,
  market count, shipyard count, jump-gate count, and connected systems
  (all read from `GalaxyAtlas`, the same source the cartography page and
  desktop galaxy overview already use — free for the operator, no need
  to type any of it by hand). Sits alongside the existing credits/role-
  count capture on every checkpoint note.

Typechecked clean.

## 2026-09-13 (Tower Fleet List: sheet only opens on tap, with a close button)

Operator feedback (with a screenshot) right after the List view shipped:
switching to List immediately popped the action sheet open for whichever
ship happened to be selected, with no way to dismiss it — defeating the
point of a scan view.

- `public/m.html`/`m.css`/`m.js` — a new ✕ close button in the sheet
  header (own `.sheet-head` flex row alongside the ship name), shown
  only in List view. A new `sheetOpen` flag: List starts with the sheet
  closed and only opens it when a roster row is tapped; Deck ignores the
  flag entirely and keeps its existing always-shown-for-the-front-card
  behavior, since closing it there wouldn't mean anything (the next
  card just replaces it).

Typechecked N/A (no `.ts` touched); syntax-checked; audited against the
`[hidden]`-vs-`display` bug from the previous commit — `.sheet-close`
deliberately has no explicit `display` property, so the browser's
built-in `[hidden]` default just works without needing an override.

## 2026-09-13 (Fix: Deck/List toggle didn't actually switch — a CSS gap)

Operator sent a screen recording: tapping "List" correctly highlighted
the button, but the deck stayed on screen underneath it. Root cause:
`.deck` and `.roster` each set `display: flex` directly in their own
class rule; an *author* stylesheet rule always beats the browser's
built-in `[hidden] { display: none }` default regardless of
specificity, so `element.hidden = true` on either container did
nothing visually — no error, no console warning, just silently inert.
Tower already had the right fix pattern in three other places
(`.sheet[hidden]`, `.map-sheet[hidden]`, `.app[hidden]`/
`.auth-gate[hidden]`) — the two new containers from the List-view
commit just didn't get it, and neither, it turned out, did an existing
one.

- `public/m.css` — added `.deck[hidden]`, `.roster[hidden]`, and
  `.grid5[hidden]` (the sheet's own action-button grid, whose "collapse"
  handle tap had the exact same latent bug — never reported because
  nobody had gone looking for it, but confirmed the same root cause on
  inspection). All three now explicitly `display: none`, overriding
  their own class's `display` property the way `[hidden]` is supposed
  to.

Audited every other `element.hidden = ...` call site in `m.js` against
its CSS — everything else either already had a matching `[hidden]` rule
or had no competing `display` property to override in the first place,
so this closes the whole class of bug, not just the one reported.

## 2026-09-13 (Tower Fleet: a List view — see every ship's job in one place)

Operator feedback: seeing who's assigned to what route required
swiping through the deck one card at a time — no way to scan the whole
fleet at once. Also asked what happens at ~25 ships.

- `public/m.html`/`m.css`/`m.js` — a Deck/List segmented control above
  the Fleet screen. List renders every ship as one compact row (symbol,
  role, job/route — reusing the same `jobLabel()` vocabulary the deck
  cards already use — fuel%, hull%, a colored left-stripe for stranded/
  unassigned), tap a row to open the same traffic-manager sheet the deck
  uses. Both views share one `fleetIndex` and one sheet, so switching
  views mid-flow (e.g. open a card in Deck, flip to List to check
  someone else, flip back) doesn't lose the selected ship or reset any
  open form. `renderFleetView()` is now the one call site every mutation
  handler refreshes through — it always keeps the deck's internal state
  correct and additionally re-renders List when that's the active view.
- Answering "what happens at 25 ships": Deck was the one part of Tower
  that didn't scale (a 25-card swipe queue) — List fixes exactly that by
  scrolling instead of paging. Home's tiles/triage feed, Map's blips,
  and Markets/More are all already fleet-size-agnostic (aggregated
  counts, one small dot per ship, or unrelated to ship count), so
  nothing else needed a change.

Typechecked clean; syntax-checked.

## 2026-09-13 (Fix: "New agent" landed on the already-logged-in tenant)

Operator report: clicking "+ New agent" opened `/` in a new tab, but
since session auth is one cookie per browser (shared across every tab),
a tab that already has a live session for some tenant skips straight to
that tenant's dashboard — the sign-in form the button was supposed to
reach never showed.

- `public/v6.js`/`m.js` — `boot0()` now checks for `?login=1` first and,
  if present, force-shows the sign-in form regardless of any existing
  session cookie (then strips the param from the URL bar). Pasting a
  token there works exactly like any other login — it's only the
  "already authenticated, skip to the dashboard" shortcut that's
  bypassed.
- `public/admin.html` — the "+ New agent" link now points to
  `/?login=1`.
- `public/shared/mobileRedirect.js` — forwards the rest of the query
  string (not just its own `?ui=`) when it sends a mobile UA to `/m`, so
  `?login=1` survives that redirect too instead of being silently
  dropped.

**Worth knowing, not a bug**: logging in as a new agent from this link
overwrites the browser's one shared session cookie, same as any normal
login — if another tab in the same browser already has a tenant's
dashboard open, that tab will flip to the new agent on its next request
too. `docs/TODO.md`'s multi-tenant note covers the real fix (separate
per-tab credentials); "View as"/"+ New agent" both work within that
same-cookie constraint for now.

## 2026-09-13 (Admin page: visual pass + "New agent" + Cartography link)

Operator called "View as" a likely primary entry point going forward, so
the admin page got a design pass to match — plus two more one-click
paths that were missing.

- `public/admin.html` — full visual pass: a command-bar header ("Fleet
  Command"), Chakra Petch/IBM Plex Mono type (matching Tower's own
  identity choice, distinct from desktop's), a subtle radial-gradient
  background, glowing status-badge dots, refined table/button/panel
  styling. No functional/JS changes needed — every element ID stayed the
  same, so `admin.js` only needed two small markup tweaks (the `.dot`
  span the new badge CSS expects, and an `.agent-cell` class).
- `public/admin.html` — two new header links, both opening in a new tab:
  **+ New agent** (`/`, the normal sign-in/register page — the operator
  can add a tenant without leaving the admin page or hunting for the
  URL) and **Cartography** (`/cartography`, the public galaxy map).

No server-side changes. Visual-only + two static links; nothing to
typecheck differently, but worth a live look given how much of this is
CSS.

## 2026-09-13 ("View as": multi-tenant switching without logging out/in)

Operator has multiple tenants (THEO, THEO-1, soon THEO-2 for A/B play-
style comparison) and had to log out and back in with a different
SpaceTraders token every time they wanted to check a different one.

- `src/http/gate.ts` — exported `cookieOpts` (was module-private) so
  admin.ts can set the exact same session cookie shape a real login
  would.
- `src/http/admin.ts` — `POST /tenants/:id/impersonate` mints a session
  for the given tenant via the same `createSession()` gate.ts's own
  `/login` uses, and sets the signed cookie — no SpaceTraders token
  involved at all. The `ADMIN_KEY` this route already sits behind (same
  as tenant delete and reset-cleanup) IS the authorization; this is
  deliberately admin-issuing-a-session-for-someone-else, not a new login
  path, and only reachable by whoever holds that key.
- `public/admin.html`/`admin.js` — a "View as" button per tenant row;
  clicking it calls the endpoint, then navigates to `/` already logged
  in as that tenant.

Typechecked clean. `tests/admin.test.ts` couldn't run against the remote
test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this
session, retried twice) — worth a real run, and a live click-through,
next time either is reachable.

## 2026-09-13 (Play-style tracking: a profile label + a manual-override log)

Operator wants to compare "baseline automation" against their own manual
play across tenants — e.g. THEO (overrode automation early: command ship
→ tour, approved two miners, bought and converted a third to trader) vs
THEO-1 (just approving whatever the automation asks for). Landed the
foundation for that as an A/B-style tracking system, not just a one-off
note.

- `migrations/019_operator_actions.sql` — `tenants.play_profile` (a
  free-text label, e.g. "baseline"/"manual") and a new `operator_actions`
  table (tenant-scoped, RLS) logging deliberate operator interventions.
  Both are deliberately **excluded** from the reset-cleanup tool's
  tenant-data wipe (`Store.TENANT_GAME_TABLES`) — a role change from a
  dead universe is still a real data point for comparing play styles
  across resets, same reasoning as leaving `doctrine`/`chat_messages`
  alone. See `CLAUDE.md`'s reset section.
- `src/db/store.ts` — `recordOperatorAction()`/`listOperatorActions()`.
- `src/db/tenants.ts` — `setTenantPlayProfile()`; `listAllTenantsAdmin()`
  now also returns `playProfile`.
- `src/http/dashboard.ts` — `POST /fleet/role` and `POST /fleet/buy` now
  log a `role_change`/`manual_buy` operator action on success. Logged at
  the HTTP route specifically, not inside `FleetManager`'s shared
  `setShipRole()`/`buyShip()` — the engine's own autonomous calls
  (`maybeBuyShip()`, the new `maybeBuyScout()`/`maybeBuySiphoner()`
  approval-gated buys, auto-role-assignment) go straight through those
  methods and must never show up in this log as if the operator had done
  them.
- `src/http/admin.ts` — `PATCH /tenants/:id/profile` (set the label),
  `GET /tenants/:id/actions` (the log), `POST /tenants/:id/checkpoint` (a
  free-text manual note — if the tenant is currently booted in this
  process, its live role counts and credits are captured into the note's
  metadata automatically, so a "here's the current state" checkpoint
  doesn't need the operator to type role counts out by hand).
- `public/admin.html`/`admin.js` — a Profile column (inline-editable) per
  tenant row, and a "Play style" toggle that expands an inline panel:
  the action log plus a textarea to log a checkpoint.

Typechecked clean. Not yet run against a live tenant — the operator still
needs to log THEO's own early manual-override history by hand (see
`docs/TODO.md`), since it predates this feature and can't be
reconstructed automatically.

## 2026-09-13 (Three more approval gates: scout, siphoner, scanner buys)

Follow-up to the "set up more approval gates" TODO item. Investigated
which of the currently-automatic engine spends actually warrant a human
in the loop, and gated the ones that do.

- `src/engine/fleet.ts` — `maybeBuyScout()`, `maybeBuySiphoner()`, and
  `maybeInstallScanner()` now request operator approval (`buyScout`,
  `buySiphoner`, `installScanner`) before spending, via the same
  `ApprovalGate` pattern `maybeBuyShip()` already uses: a pending/denied
  request is just a guard clause (the function reruns every tick
  regardless), and an unanswered request auto-approves after 2h,
  matching each purchase's own prior fully-automatic behavior.
- **Deliberately left alone**: ship repairs (`maybeRepairFleet()`) — too
  cheap/frequent, and gating one risks losing the ship to a failure
  while waiting on a decision, the opposite of what a gate is for.
- **Investigated, found already covered**: ship sell/scrap. `sellShip()`
  only ever runs from an explicit operator "Sell" click
  (`POST /api/fleet/sell-ship`, desktop and Tower both); the `scrapHere`
  callback every `ShipAgent` role carries is plumbed but never actually
  invoked autonomously anywhere in the engine (confirmed by searching
  every call site) — so there was no automatic scrap decision to gate in
  the first place.

Typechecked clean. `tests/fleet.test.ts` couldn't run against the remote
test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this
session, retried once) — worth a real run next time it's reachable.

## 2026-09-13 (Tower: fix — sheets couldn't scroll, so long content was just cut off)

Operator report with a screenshot: "Full details" opened and showed the
"Cargo hold" heading, then nothing below it — no scrollbar, no way to
reach the rest. Root cause: `.body` clips anything past its own bounds
(`overflow: hidden`, so the deck above never bounces past its edge), and
neither `.sheet` (Fleet's traffic-manager sheet) nor `.map-sheet` had a
max-height or their own scroll — expanding one past the remaining space
just clipped the overflow into nothing, with no way to reach it. Ship
details' own inner `max-height: 46vh; overflow-y: auto` (from the earlier
commit below) never got a chance to run, since its parent was already
clipped shut.

- `public/m.css` — `.sheet` and `.map-sheet` now get `max-height: 62vh;
  overflow-y: auto; overscroll-behavior: contain` (and `flex: 0 1 auto`
  so they can actually shrink to fit) — the sheet itself scrolls as one
  unit now, so "Full details," a long ship-pick/route-pick list, or a
  waypoint with many shipyard listings are all reachable by scrolling
  instead of silently cut off.
- Removed `.ship-details`' own now-redundant inner scroll — nesting two
  independently-scrolling regions was more confusing than useful once the
  outer sheet scrolls correctly.

## 2026-09-13 (Tower Fleet: full ship details — cargo, loadout, modules, mounts)

Second half of the Fleet sheet's "coming soon" placeholder — role
assignment (below) covered one of the two, this covers the other:
"Full details" now expands rather than sitting disabled.

- `public/m.html`/`m.css`/`m.js` — `renderShipDetails()` renders cargo
  hold (with Jettison), loadout (frame/reactor/engine names), modules and
  mounts (with Remove), and components sitting in cargo ready to install
  (with Install) — the same fields desktop's ship-detail sheet shows,
  condensed into one scrollable block instead of desktop's row of
  sub-tabs. Calls the same `/api/fleet/jettison`,
  `/api/fleet/remove-component`, and `/api/fleet/install` endpoints
  desktop already uses. Nothing left placeholder on the Fleet sheet.

## 2026-09-13 (Tower Fleet: assign/switch ship role)

Operator feedback: the Fleet sheet's "Full details — coming soon"
placeholder was standing in for role assignment, which they needed now,
not later.

- `public/m.html`/`m.css`/`m.js` — "Change role" on the ship detail sheet
  expands a role picker (same 8 roles desktop offers), a live mismatch
  warning (`roleMismatchReason()` from `shared/domain.js` — e.g. "no
  mining laser mounted" for `miner`), and a keeper-market waypoint field
  when switching to `keeper`, matching desktop's own role-change UI.
  Calls the same `POST /api/fleet/role` endpoint. Full manifest/mount
  detail remains the one still-placeholder link.

## 2026-09-13 (Tower Map: pinch-zoom/pan, real ship movement, multi-system)

Follow-up to the asteroid-declutter pass below — operator still found it
cluttered (overlapping labels in dense clusters) and asked for pinch-zoom/
pan, plus flagged two things Map needed eventually: ship movement like
desktop's map, and a plan for multiple systems.

- `public/m.html`/`m.css`/`m.js` — **pinch-zoom + pan**: Pointer Events on
  a new `#scope-view` wrapper (one finger pans, two pinch-zooms, clamped
  1x-4x) drive a CSS transform on `#scope-field`, kept as a separate
  element from the field so the pan/zoom viewport never has to be
  threaded through the percentage-based blip coordinate math. A small
  reset button (⟲, top-right) snaps back to 1x/centered.
- `public/m.js` — **label decluttering**: a waypoint's symbol label now
  only renders when the system has ≤10 chartable waypoints, the scope is
  zoomed past 1.6x, or it's the selected waypoint — a dense system shows
  clean icons by default instead of the overlapping-text pile-up a tight
  cluster produced, and labels reveal themselves as you zoom in.
- `public/m.js` — **ship movement**: reuses `shared/domain.js`'s
  `shipTransitLerp()`/`shipHeadingDeg()`, the same functions desktop's
  own map already uses, so an in-transit ship now animates smoothly
  between origin and destination and renders as a small triangle rotated
  to its real heading instead of a static dot.
- `public/m.html`/`m.css`/`m.js` — **multi-system**: a chip row above the
  scope lists every charted system (from `state.systems`, the same
  `GalaxyAtlas.listSystems()` data desktop's galaxy overview already
  reads — no new server endpoint) and switches which one Map is showing.
  Purely a viewing choice; doesn't touch which system fleet/dispatch
  actions operate on. A zoomed-out galaxy view with jump-gate lines
  (like desktop has) was considered and deliberately deferred — this
  picker is the smaller step, worth revisiting only if system-hopping on
  Map turns out to be frequent.

Typechecked (`npx tsc --noEmit`, clean) and syntax-checked; not yet
verified live against a real phone's touch gestures.

## 2026-09-13 (Tower Map: drop asteroid clutter, zoom in on real destinations)

Operator feedback: the radar scope was too zoomed out because it plotted
every waypoint in the system, including asteroid fields and other
decorative bodies that outnumber the actual destinations (markets,
shipyards, jump gates).

- `public/m.js` — `isChartable(wp)` (market/shipyard trait, or a jump
  gate) now filters what `renderScope()` draws *and* what
  `computeMapProjection()` uses to compute the zoom extent — previously
  every waypoint's x/y fed the min/max span, so a handful of asteroids at
  the system's edge flattened every real destination into a tight cluster
  in the middle. A ship still renders even when parked at an excluded
  waypoint (e.g. mining an asteroid) — it's projected with the same
  transform as everything chartable, just not drawn as its own blip.
- The system header's charted count now reflects chartable waypoints
  (markets/yards/gates), not the raw waypoint total.

## 2026-09-13 (Tower: start/stop missions and contracts from More)

Follow-up to the Markets/More ship below — operator wanted the same
start/stop control desktop's Ops tab has for missions and contracts, not
just the read-only progress More shipped with initially.

- `public/m.html`/`m.js` — a "start a construction mission" row (waypoint
  input + Start button, `POST /api/missions/start`) above the missions
  list; each active mission card now has a Stop (`/api/missions/pause`,
  confirmed — releases the carrier ship) or Resume
  (`/api/missions/resume`) button instead of read-only progress only.
- `public/m.js` — contracts' "Stop working" (abandon) action now confirms
  first, matching desktop's warning (no cancel in the SpaceTraders API —
  the contract stays accepted and lapses at its deadline, costing
  reputation).
- Same `/api/missions/*`/`/api/contracts/*` endpoints desktop already
  calls — no new server-side surface.

## 2026-09-13 (Tower: Markets and More tabs — 5-tab IA complete)

Fourth and fifth screens of Tower (`/m`, the separate mobile app — see
`docs/mobile-app-design.md`), following Home/Fleet/Map: Markets and More,
completing the originally-designed 5-tab IA (Home · Fleet · Map ·
Markets · More).

- `public/m.html`/`m.css`/`m.js` — **Markets**: a Routes/Yards segmented
  control. Routes lists the top profitable routes by profit/trip (same
  computation `/api/markets` already returns); tapping "Assign a ship"
  expands an inline picker of trader ships rather than a separate sheet,
  calling the same `/api/dispatch` endpoint the Fleet deck's route-pick
  already uses. Yards groups shipyard/module intel by item (cheapest
  location leading, up to 2 alternates noted) with a direct Buy button —
  the same grouping desktop's Yards & outfitting panel uses, reading
  `intel.shipyards`/`intel.modules` from the shared store.
- `public/m.html`/`m.css`/`m.js` — **More**: a plain scroll of lower-
  frequency sections, per the design doc's own "a simple list-of-sections
  is enough" framing rather than a sub-tab bar. Contracts (accept/
  decline/undecline/abandon/resume with delivery progress bars, same
  `/api/contracts/*` endpoints desktop uses), Construction missions
  (read-only progress — starting a *new* mission stays desktop-only),
  Warehouse (stationed ship, total value, top goods held — full ledger/
  targets editing stays desktop-only), and Doctrine (on/off toggles only,
  no threshold sliders — mirrors the existing "mobile doctrine" pattern
  already shipped on desktop's own `#mobile-view`, same `/api/doctrine`
  endpoint).
- No new server-side surface — both screens read/write the same
  `/api/markets`, `/api/dispatch`, `/api/fleet/buy`, `/api/contracts/*`,
  `/api/missions`, `/api/warehouse`, and `/api/doctrine` endpoints every
  other UI version already calls, through the same `public/shared/
  store.js` loaders.

Typechecked (`npx tsc --noEmit`, clean — no `.ts` files touched) and
syntax-checked (`node --check public/m.js`); not yet verified live against
a real phone — see `docs/TODO.md`'s Tower verification item, now covering
all 5 tabs.

## 2026-09-13 (recover from a live SpaceTraders universe reset)

A real SpaceTraders weekly universe reset hit mid-session — every ship
across every tenant (DRAGOM, EWOK, CARO) started failing with `agent
token is from a previous server reset`, and the public cartography
page kept showing the now-defunct pre-reset galaxy. Operator
re-registered a fresh agent (THEO) and asked for a repeatable way to
clean up after this, since it'll happen again (SpaceTraders resets
weekly).

- `src/db/store.ts` — `truncateSharedGalaxyTables()` (every galaxy-wide
  table each already documents as "static for the life of a server
  reset": `galaxy_systems`, `galaxy_factions`, `galaxy_crawl_state`,
  `market_snapshots`, `market_latest`, `shipyard_inventory`,
  `module_catalog`, `galaxy_jump_costs`, `galaxy_gate_construction`)
  and `wipeTenantGameData(tenantId)` (per-tenant tables naming
  something from the dead universe — ships, contracts, missions,
  warehouse, financial history — deliberately excluding operator
  config like `doctrine` and login `sessions`, neither of which the
  reset makes wrong).
- `src/engine/galaxyCrawler.ts` — `resetCrawlState()`, so the
  background galaxy-wide crawl restarts from page 1 immediately in the
  current process rather than only on the next full restart.
- `src/http/admin.ts` — `POST /reset-cleanup` (wipes every tenant not
  named in `keepTenantIds`, always truncates the shared tables, resets
  the crawler); `GET /tenants` now also surfaces each tenant's
  `deadTokenReason` (client.ts's existing reactive `TOKEN_RESET_
  MISMATCH` detection was already there — just never surfaced past the
  app logs before this).
- `public/admin.html`/`admin.js` — a "After a server reset" panel: a
  banner when any tenant shows a dead token, a per-tenant checklist
  (defaulting to whichever tenants are currently dead-tokened), and the
  cleanup button.
- `CLAUDE.md` (new) — durable documentation of the whole scenario, the
  recovery procedure, and an open idea (not built) for detecting a
  reset proactively via SpaceTraders' own public status endpoint
  instead of waiting for a tenant's own call to fail first.

Typechecked clean. `tests/admin.test.ts` updated for the new
`createAdminRouter()` parameter (a `GalaxyCrawler` instance) but
couldn't be run against the remote test Postgres — same intermittent
timeout as earlier this session, retried once. Verifying live: about
to run the real cleanup now (DRAGOM/EWOK/CARO, keeping THEO).

## 2026-09-13 (Tower: Map — a literal radar scope)

Third Tower screen: the current system rendered as a real radar scope
rather than a generic map-tile view, per the approved design — ties
the visual identity directly to the "Radar" concept name.

- `public/m.html`/`m.css`/`m.js` — range rings, a sweep wedge, and
  shaped blips per waypoint type (triangle = jump gate, square =
  shipyard, diamond = market, dot = anything else, plus a small white
  dot per ship currently in-system), positioned from real waypoint x/y
  (`state.waypoints`) normalized into the scope's circular field.
  Tapping a waypoint opens a bottom sheet showing whatever shipyard/
  module intel is already known for it (`intel.shipyards`/
  `intel.modules`, populated via `loadMarkets()`), with a direct **Buy**
  for a ship — no ship-context needed, unlike installing a module onto
  a specific hull, which stays read-only from this screen for now.
- Current system only this pass — cross-system navigation isn't built
  yet.
- No new server-side surface: `/api/fleet/buy` is the same endpoint
  desktop's Yards & outfitting panel already calls.

Typechecked clean (no server-side changes), `m.js` syntax-checked,
`m.html` div-tag-balance sanity-checked. Not run against a local
server — verifying live post-deploy.

## 2026-09-13 (Tower: Fleet — the ship-card deck)

Second Tower screen after Home: a swipeable ship-card deck replacing
the desktop Fleet tab's sortable table for this mobile app, per the
approved design (`docs/mobile-app-design.md`).

- `public/m.html`/`m.css`/`m.js` — a stack of hull cards (front + a
  peek of the next 1-2 behind it), navigable by swipe or Prev/Next
  buttons. Each card shows role, job (reusing the desktop Fleet tab's
  `jobFor()`/Job-column vocabulary — route/contract/mission/warehouse
  buy-sell/unassigned), fuel/cargo/hull-condition gauges, and current
  position — stranded ships get a red border, unassigned traders amber.
- A traffic-manager action sheet underneath the deck, always targeting
  the front card's ship: **Send to waypoint** (inline text input),
  **Hold/Release** (toggles based on current state), **Assign route**
  (a short picker over the top 4 computed routes by profit), **Repair**,
  **Sell/Scrap** (with the same confirm-dialog wording desktop uses),
  and a disabled **Full details — coming soon** placeholder for
  anything rarer (full manifest, mount specifics) — deliberately not
  porting desktop's dense multi-tab ship-detail sheet, per the design
  doc's own call for a simpler mobile control surface.
- No new server-side surface: every action calls the same
  `/api/fleet/*`/`/api/dispatch` endpoints the desktop dashboard
  already uses.

Typechecked clean (no server-side changes this pass), `m.js`
syntax-checked, `m.html` div-tag-balance sanity-checked. Not run
against a local server — verifying live post-deploy.

## 2026-09-13 (Tower: a genuinely separate mobile app, Home only)

First implementation pass on the mobile app design (`docs/
mobile-app-design.md`, approved earlier today): a real `/m` route, not
another entry in the v2-v6 desktop version lineage — own manifest, own
app-shell CSS, own visual identity ("Tower": near-black ground,
phosphor-amber accent, Chakra Petch + IBM Plex Mono).

- `public/m.html`/`m.css`/`m.js` — the app shell (fixed, `100dvh`,
  `overscroll-behavior:contain`, `env(safe-area-inset-*)`, `viewport-
  fit=cover` + `user-scalable=no`) and the Home screen: Cockpit tiles
  (credits, rate, fleet health, best route) plus a Mission Control
  triage feed (pending approvals, stranded ships, unassigned traders),
  wired to the same `public/shared/*.js` store every desktop version
  already uses — no new data layer. Fleet/Map/Markets/More exist as
  tab targets with a "coming soon" placeholder; not built this pass.
- `public/shared/mobileRedirect.js` — sends a mobile User-Agent from
  `/` to `/m` automatically (own `localStorage` key, `?ui=desktop`/
  `?ui=m` escape hatches). Deliberately a plain classic script, not an
  ES module — a `type="module"` script is deferred past first paint,
  which would flash the desktop layout before redirecting; loaded as
  the very first thing in `v6.html`'s `<head>`, before any stylesheet.
- `public/manifest-tower.webmanifest` + `public/icons/tower-*.png` —
  Tower's own PWA identity (`scope: "/m"`, own name/icons/theme-color),
  distinct from the existing desktop manifest. Icons are a placeholder
  mark (radar rings + a blip, in the Tower palette) generated
  programmatically via Python/Pillow — real brand artwork can replace
  them later without touching anything else.
- `src/cli/index.ts` — new `/m` route, same free-standing pattern as
  `/admin`/`/cartography` (unauthenticated HTML; the page does its own
  client-side session auth). `src/http/uiVersions.ts`'s `cacheHeaders()`
  extended to give `m.css`/`m.js` the same 5-minute cache policy v2-v6
  already get.

Typechecked clean, `m.js`/`mobileRedirect.js` syntax-checked, manifest
JSON validated. Not run against a local server (would require the
production `DATABASE_URL`) — verifying live post-deploy instead, per
this session's established pattern.

## 2026-09-13 (architecture overview doc)

Added `docs/architecture-overview.md` — a system-by-system breakdown
(tenancy, `FleetManager`/roles, dispatcher, intent board, scheduler,
approval gate, galaxy knowledge, persistence, HTTP/dashboard layer,
frontend versions, doctrine) for anyone picking the codebase up cold.
Closes the long-parked TODO item asking for this to be saved somewhere
durable instead of only ever having existed conversationally.

## 2026-09-13 (Fleet tab: a Job column, so an unassigned trader stands out)

Operator request: at a glance on the Fleet tab, know whether each ship
is on a route, a mission, or a contract — so an idle trader that could
be reassigned isn't buried in a column of nav status text.

The data already existed (`RouteDispatcher.list()`, already used by
Trade Ops' Dispatch panel) but the Fleet tab never fetched or rendered
it — its "Doing" column only ever showed live nav status (docked/in
orbit/transit), not what the ship is actually working toward.

- New "Job" column (`public/v6.js`'s `jobFor()`) translates a trader's
  `TraderAssignment` into operator vocabulary: `route: GOOD`,
  `contract: GOOD`, `mission: GOOD`, `warehouse buy/sell: GOOD`, or
  `unassigned` (highlighted in accent color) when a trader has no
  assignment at all — the ships worth looking at first. Every other
  role shows "—": their Doctrine/Doing columns already say what
  they're doing.
- `dispatchAssignments` (`/api/dispatch`) was previously only fetched
  while on the Trade Ops tab; now also fetched on entering the Fleet
  tab and every 20s while it's open, and the Fleet table (desktop and
  both mobile fleet views) re-renders whenever dispatch data changes.

Syntax-checked with `node --check`; no server-side changes, so
`npx tsc --noEmit` is the only relevant check (clean). No automated UI
test coverage in this codebase for table rendering — worth a manual
glance next deploy to confirm the Job column populates correctly and
"unassigned" traders are visually distinct.

## 2026-09-13 (root-caused: approved keeper-probe purchase never bought)

Reproduced live: operator approved a `buyKeeperProbe` request (probe at
`X1-C59-D15X` for 26,261c) on the dashboard; ~12 minutes later, no
"purchasing SHIP_PROBE" log line had appeared at all — the decision just
sat in the DB, unread. This is the exact bug flagged in `docs/TODO.md`
after an earlier occurrence.

Root cause: `maybeRequestKeeperProbe()` — which both requests a new
approval AND reads back a decided one via `ApprovalGate.request()` — only
ever runs from `recordShipyardSnapshot()`, itself only reachable when some
ship physically docks at that exact shipyard again. Unlike `maybeBuyShip()`
(called unconditionally every tick, so a decision is always picked up
within one tick), an operator who approves a keeper-probe request while no
ship happens to be revisiting that waypoint has no path back to the
engine ever noticing — `ApprovalGate.request()` only detects a decided row
the next time it's called with that same `kind`, and nothing was calling
it.

Fix: split the purchase-execution half of `maybeRequestKeeperProbe()` into
`purchaseKeeperProbe()`, and added `resolvePendingKeeperProbeApproval()` —
called every tick, unconditionally — which re-issues the same
`"buyKeeperProbe"` kind through `ApprovalGate.request()` using the
cost/detail already stored on the pending row (no fresh shipyard scan
needed) and completes the purchase the moment a decision shows up.

`tests/fleet.test.ts` adds three cases: approves-and-buys with no
revisit (reproduces the live bug directly), still-pending is a no-op,
and denies-with-no-revisit. Typechecked clean. Could not run the new
tests against the remote test Postgres — same intermittent timeout as
earlier this session, retried once. Verifying live: watching for the
`X1-C59-D15X` probe purchase to actually go through on DRAGOM's next
tick after this deploys.

## 2026-09-13 (keeper-probe fix, take two: don't consume an approval SpaceTraders will reject)

The keeper-probe fix above shipped, and its very first live approval
(the same `X1-C59-D15X` request) immediately surfaced a second, real
bug: it correctly noticed the operator's approval this time, but the
purchase itself failed — `"Failed to purchase ship. Your agent must
have at least one ship available at the purchase location
(X1-C59-D15X)."` SpaceTraders requires one of the agent's own ships to
be physically docked at a shipyard to buy there. The old code got this
for free (it only ever ran mid-scan, while a ship was already
standing there); `resolvePendingKeeperProbeApproval()` deliberately
doesn't have that guarantee, and by the time the operator approved
(12+ minutes later), the triggering ship had moved on. Consuming the
approval and then failing the purchase is worse than the original bug
— now the decision is gone too, silently.

Fixed: `resolvePendingKeeperProbeApproval()` now checks
`fleetStatusSummary()` for a ship currently at the target waypoint
before letting `ApprovalGate.request()` consume an approve-bound
decision (explicitly approved, auto-approved, or a pending row past
its timeout with `onTimeout: "approve"`). A denial still processes
immediately regardless — no purchase needed, so no reason to wait.
`tests/fleet.test.ts` covers both: waits when no ship is present, then
buys once one shows up.

Typechecked clean. Could not run the new/updated tests against the
remote test Postgres — same intermittent timeout as earlier this
session, retried once. Watching live for the next `buyKeeperProbe`
approval to confirm the full round-trip (wait for ship → buy) works.

## 2026-09-13 (mobile Ops tab was missing Approvals entirely)

Operator report: the global "N approvals awaiting your decision" banner
showed on mobile and tapping it landed on the Ops tab, but nothing was
there to approve.

Root cause: mobile runs its own independent screen markup/state machine
(`#mobile-view`'s `.m-screen[data-mscreen=...]`, driven by
`setMobileView()`) rather than reusing the desktop `.view` sections
`setView()` drives — confirmed by reading both mobile's ops screen and
`renderApprovalsBanner()`'s comment claiming "clicking jumps to Ops,
where the actual Approve/Deny controls live," which was only true on
desktop. Two compounding bugs:
1. The banner's click handler only called `setView("ops")`, which has no
   effect on mobile's separate screen state at all.
2. Even ignoring that, mobile's Ops screen (`public/v6.html`) had no
   Approvals pane in its markup to begin with — `renderApprovals()` only
   ever wrote to the desktop `#approvals`/`#approval-count` elements,
   same shape as the `renderContracts()` bug this fixes: dashboard.ts
   already returns fresh approvals, they just had nowhere to render on a
   phone.

Fixed: added a mobile Approvals pane (`#mobile-approvals`/
`#mobile-approval-count`) as the first pane in mobile's Ops screen,
mirroring `renderContracts()`'s existing dual-render pattern;
`renderApprovals()` now writes to both desktop and mobile elements and
wires the Approve/Deny buttons on both; the banner's click handler now
also calls `setMobileView("ops")` when `isMobile()`.

Syntax-checked with `node --check`; no automated test coverage for
mobile DOM rendering in this codebase, so this needs a manual check on
a phone (or narrow viewport) next: confirm the banner navigates to Ops
and the approval actually renders with working Approve/Deny buttons.

## 2026-09-13 (Yards & outfitting: system filter + per-item pricing)

Operator request: shipyard/module intel should carry the same
`?system=` filter the Routes and Prices & snapshots panels already have
in the Markets view, and should compare prices for the same item across
locations rather than an arbitrary flat list.

Previously `GET /api/markets` ignored `?system=` for `shipyards`/`modules`
entirely (only `snapshots`/`routes` respected it), and the client rendered
the first 12 raw scan rows in whatever order the store returned them — so
the panel could show the same ship type or module twice at different
waypoints while a cheaper listing for it never made the cut, with no way
to scope it to one system.

- `src/http/dashboard.ts`'s `/markets` route now filters `shipyards`/
  `modules` by `systemFilter` the same way `snapshots` already does.
- `public/v6.html`/`v6.js`: added a `yards-system-filter` select next to
  the other two Markets-tab system filters, wired into the same
  `marketSystemFilter`/`loadMarkets()` plumbing.
- `renderShipyardIntel()` now groups shipyard rows by ship type and
  module rows by symbol, sorts each group by price, and shows the
  cheapest location plus up to 3 other locations for that same item —
  real per-item price comparison instead of a flat cut.

Typechecked clean; `public/v6.js` syntax-checked with `node --check`.
Not verified against `tests/dashboard.test.ts` — hit the same
intermittent `ETIMEDOUT`/timeout connecting to the remote test Postgres
seen earlier this session (retried once per the established policy, no
luck either time). Worth a manual pass in the live dashboard next
deploy: pick a system in the new Yards & outfitting filter and confirm
only that system's shipyards/modules show, and that a ship type or
module scouted at two locations shows both under one grouped entry.

## 2026-09-13 (persist gate-construction cache too)

- **Persisted `GalaxyAtlas`'s gate-construction cache**, the other half of
  the cross-system-routes-never-fire bug — the jump-cost persistence
  shipped earlier today only fixed the pricing side. `canJump()` (which
  `RouteDispatcher.recompute()` requires to be `true` before it will ever
  assign a cross-system `direct` route — see `dispatcher.ts:497`) reads
  from `gateConstruction`, a plain in-memory `Map`, also wiped on every
  restart. Confirmed live immediately after the jump-cost fix went out:
  the dispatch log showed real, correctly-computed cross-system candidates
  (`ELECTRONICS@X1-YB82-BD9F=44976`, `ANTIMATTER@X1-RN95-F13B=15480`) but
  DRAGOM-1 stayed assigned a same-system `FUEL` leg worth only `286`/trip
  — the gate-confirmation cache had reset on the last deploy, and nothing
  had freshly re-checked that exact pair yet this process lifetime, even
  though the fleet's own explorers had already jumped through it
  successfully before. Same shape as the jump-cost fix: new shared table
  `galaxy_gate_construction` (migration 018, no tenant_id — a gate's
  construction status is a fact about the galaxy), `Store.recordGalaxyGateConstruction()`/
  `getAllGalaxyGateConstruction()`, `GalaxyAtlas.loadGateConstruction()`
  (called at boot alongside `loadJumpCosts()`) — careful not to let a
  stale loaded "incomplete" downgrade a gate this process already
  confirmed complete live, matching `canJump()`'s existing one-way
  semantics. `tests/galaxy.test.ts` covers it directly.

## 2026-09-13 (persist learned jump costs)

- **Persisted `GalaxyAtlas`'s learned per-gate-pair jump cost average**,
  closing the real reason cross-system routes never fired even after the
  earlier jump-cost bootstrap fix: `jumpCosts` lived only in a plain
  in-memory `Map`, wiped on every process restart. With deploys happening
  several times a day, a learned cost never survived long enough to
  replace `CROSS_SYSTEM_JUMP_COST_ESTIMATE`'s flat 5,000c placeholder —
  every cross-system leg was priced against the placeholder forever
  regardless of how many real jumps actually happened. New shared (no
  tenant_id — a jump's real cost is a fact about the galaxy's gate
  network, not about who paid for it, so one tenant's real jump now
  helps every tenant converge faster) table `galaxy_jump_costs`
  (migration 017), `Store.recordGalaxyJumpCost()`/`getAllGalaxyJumpCosts()`,
  and `GalaxyAtlas.loadJumpCosts()` (called once at boot, `fleet.ts`'s
  `init()`) to seed the in-memory average instead of starting cold.
  `recordJumpCost()` stays synchronous at every call site — the durable
  write fires in the background and swallows its own errors, so a slow or
  failed persistence call never blocks a ship's own tick.
  `tests/galaxy.test.ts` covers the new persistence/seeding behavior
  directly against a fake store. **Not yet verified against the real
  database** — this session's sandbox hit the same intermittent
  `ETIMEDOUT` connecting to the remote test Postgres seen earlier
  (2026-09-12's auto-keeper-probe entry has the same note); the migration
  itself is simple, standard SQL and runs automatically on every boot
  (`cli/index.ts` calls `runMigrations()` before serving), so it should
  apply cleanly on the next real deploy — worth a quick log check
  afterward (a `dispatch recompute` line naming a cross-system leg with a
  learned, non-5000 fuel cost) to see it working live.

## 2026-09-13 (two live bugs: tour/keeper fuel estimate, stranded-rescue retry loop)

- **Fixed the dashboard's manual "Send to waypoint" reporting "needs
  Infinity fuel" for a perfectly healthy ship.** Found live: DRAGOM-14,
  300/300 fuel, a `tour` ship. `FleetManager.shipWaypoint()`/`cachedShip()`
  enumerated miners/traders/surveyors/scouts/siphoners/explorers but never
  `this.tours` or `this.keepers` — any ship in either role fell through to
  `idleShips` (empty, since the ship was actively working) and resolved to
  an unknown `""` position, which `estimatedFuelTo()` can only answer as
  `Infinity`. This blocked manual dispatch for every tour/keeper ship,
  which is exactly the tool an operator reaches for when trying to
  manually rescue one that's stuck. `tests/fleetNonBlocking.test.ts`
  covers both helpers directly for tour and keeper ships.
- **Fixed `escapeByJump()` (the stranded-ship rescue path) retrying an
  identical doomed jump forever.** Same bug shape as the `autoExplore()`
  fix from 2026-09-12 — a protection that existed on `exploreSystem()`
  (check the remote gate's construction status, record a skip, never
  retry the same doomed target) was never applied to this sibling
  jump-planning path. Found live: DRAGOM-14, stranded at X1-S84's own
  jump gate, retried a jump to X1-YB72-I62 every scheduler cycle
  (~5-6s) nonstop, each attempt failing with "Destination jump gate ...
  is under construction." `escapeByJump()` now filters candidate systems
  against the same `gateConstructionSkipUntil` skip-list and checks the
  remote gate before attempting, falling through to the fuel-tender
  rescue path (and remembering not to retry) instead of hammering the
  same doomed jump. `tests/fleetNonBlocking.test.ts` covers it directly.

## 2026-09-13 (per-tenant proxy support)

- **Added optional per-tenant forward-proxy support**, so a tenant can get
  its own dedicated public IP instead of sharing this process's one IP
  (and its one SpaceTraders 2 req/s ceiling) with every other tenant.
  Operator request, after confirming SpaceTraders rate-limits by source
  IP, not by agent token — running multiple agents "without sharing a
  rate limit" genuinely requires separate egress IPs, which neither
  Render nor Vercel provide per-service by default. Set
  `PROXY_URL_<AGENTSYMBOL>` (e.g. `PROXY_URL_DRAGOM=http://user:pass@host:port`)
  and that tenant's `Client` routes every request through it and gets its
  own private rate limiter instead of drawing from the shared one — see
  `.env.example`.
  - New `Client` option `proxyUrl`, using `undici`'s own `fetch` +
    `ProxyAgent` for the proxied path only. Confirmed directly (not just
    assumed) that mixing a `ProxyAgent` built from the separately
    npm-installed `undici` package with Node's *global* `fetch` — which is
    backed by its own internal, differently-versioned copy of undici — is
    unreliable: it throws outright when the two copies' majors differ,
    and silently hangs forever even when their minor versions are close.
    The unproxied path (every tenant without a `PROXY_URL_*`, and every
    existing test that mocks `globalThis.fetch`) is completely untouched.
  - `tests/clientProxy.test.ts` covers the real thing end to end: a real
    CONNECT-tunneling forward proxy in front of a real HTTPS target (the
    actual mechanism a dedicated datacenter proxy provides for reaching
    SpaceTraders' HTTPS-only API), confirming a proxied request genuinely
    tunnels through it and an unproxied one never touches it.

## 2026-09-12 (route planner prefers real scan data when it fully covers a route)

- **The Route Planner now tries the real scanned jump-gate graph first**,
  falling back to the physical-proximity estimate only when no fully
  scanned path exists between the two systems. So once tenants' fleets
  scan enough gates to connect two systems for real, the planner
  automatically starts returning that as a "confirmed" route instead of
  an "(estimated)" one — no separate wiring needed, since it reads the
  same `lastConnections` data the map's connection-line layer already
  refreshes every 30s. Answers an operator question about whether newly
  scanned connections would be picked up.

## 2026-09-12 (route planner: proximity estimate instead of scan-only)

- **Reworked the Route Planner to always produce a route**, instead of
  coming up empty for the (very common) case where no tenant has ever
  scanned a gate connecting two systems. Operator request, after
  confirming a real assumption gap: not every system has a jump gate at
  all (`JUMP_GATE` is one waypoint type among several — a system may
  simply have none), so real gate connectivity can never be fully known
  without scanning every system. Per operator direction, the planner now
  deliberately assumes every system has a gate and estimates connectivity
  by physical proximity — each system links to its 6 nearest neighbors by
  raw galaxy x/y — then runs the same breadth-first shortest-hop search
  over that graph. Results are labeled "(estimated)" and the panel says
  plainly that it isn't confirmed against any tenant's scan data. The
  map's own jump-gate connection-line layer is unaffected — still real
  scanned data only, unchanged.

## 2026-09-12 (cartography bookmarks, connections, route planner)

- **Added system bookmarks to `/cartography`**, listed under the Activity
  card. Since this is a public, no-login page there's no account to hang
  a bookmark list off, so it's stored in the viewer's own browser
  (`localStorage`) — private to that browser, doesn't follow across
  devices, but that's the honest tradeoff for staying login-free. A ☆/★
  button next to the search box bookmarks whatever system is currently
  highlighted; clicking a bookmark jumps the map straight to it.
- **Added subtle jump-gate connection lines**, drawn between systems once
  zoomed in enough to read as structure rather than a solid mess (same
  zoom-threshold approach as the symbol labels). A connection where both
  endpoints are marked "explored" draws in blue instead of the default
  muted gray, to call out routes that are actually usable today (both
  ends known well enough to know they connect) versus a route only known
  from one side's scan. New `Store.listGalaxyJumpConnections()` and
  `GET /api/cartography/connections`, both deriving system-to-system
  pairs from `galaxy_systems.jump_gates` (again tenant-exploration data,
  never the crawler's own).
- **Added a Route Planner tab.** Two system inputs and a breadth-first
  search over the same jump-gate connection graph — hop-count-shortest,
  not cost-shortest, since real per-jump fuel costs only ever live in a
  tenant's own in-memory `GalaxyAtlas` and are never persisted anywhere
  this public page can read. "Show on map" switches back to the map tab,
  fits the view to the route's systems, and draws it as a dashed violet
  line with its hop systems outlined to match.

## 2026-09-12 (cartography tenant-exploration layer + labels)

- **Added the tenant-exploration layer to `/cartography`**, the piece
  explicitly deferred when the page first shipped. A system is marked
  "explored" once *some* tenant's own fleet has actually visited it and
  populated its waypoints (`galaxy_systems.waypoints` non-empty) — the
  crawler alone only ever learns coordinates/type, never waypoint detail,
  so this is the one bit of real fleet activity visible on the otherwise
  tenant-agnostic crawl map. Explored systems get a subtle green outline
  on the map, toggleable via a checkbox, plus their own "Explored" stat
  tile. New `Store.listGalaxySystemPositions()` field `explored` (a cheap
  `jsonb_array_length(waypoints) > 0` check, not the waypoint blob itself).
- **Added system-symbol labels near each dot once zoomed in far enough**
  that they'd actually be legible — hidden entirely at the whole-galaxy
  view where thousands of overlapping labels would just be noise, shown
  past a zoom threshold (also whenever a search zooms in on a match).
  Same DOM-reuse approach as the dots: each system gets a paired `<text>`
  element once, and only its position/font-size/visibility are touched on
  zoom/pan, not a full rebuild.

## 2026-09-12 (cartography search + zoom)

- **Added system search and zoom controls to `/cartography`'s galaxy map.**
  Typing a system symbol and hitting Go (or Enter) jumps the map to that
  system's neighborhood; unobtrusive +/- buttons and a fit-whole-galaxy
  reset sit in the map's corner, alongside mouse-wheel zoom and click-drag
  panning. Switched the map's dots from being rescaled to fit a fixed
  0-800 box to being drawn at their raw galaxy x/y with the SVG `viewBox`
  doing all the zoom/pan work — panning or zooming no longer re-lays-out
  any dots, only moves the viewBox and rescales dot radius to match.

## 2026-09-12 (public cartography page)

- **Added a public, no-login galaxy map at `/cartography`.** Operator
  request, inspired by another developer's public SpaceTraders cartography
  tool. Built around `GalaxyCrawler`'s existing systems+factions crawl (the
  comprehensive, tenant-agnostic data source) rather than any one tenant's
  own partial exploration — shows a scatter-plot map of every crawled
  system colored by star type, a factions table, live crawl-progress stats
  (systems mapped vs. the galaxy's real total, now tracked via the API's
  own pagination total instead of just counting rows), and a scrolling
  activity log of crawl milestones. New `GET /api/cartography/{systems,
  factions,progress,activity}` endpoints, mounted ahead of `resolveTenant`
  in `src/cli/index.ts` (same pattern as `/api/gate`/`/api/admin`) since
  none of this is tenant-scoped. `GalaxyCrawler` now keeps an in-memory
  ~50-entry activity ring buffer and tracks the galaxy's total system count
  via a new `Client.getSystemsPage()` (captures the SpaceTraders pagination
  `meta.total`, which the generic `get()` helper used to discard). Added
  `Store.listGalaxySystemPositions()`, a lean read (no jsonb waypoint/
  jump-gate blobs) for the map's scatter plot. Tenant-exploration detail
  (markets/shipyards) was considered as a secondary data layer but not
  built in this pass — the crawler's systems+factions data was confirmed as
  the starting point.

## 2026-09-12 (auto keeper probes)

- **A tour ship (or any ship) visiting a shipyard with no keeper
  stationed there now requests to buy a probe on the spot to become
  one.** Operator request. A probe has no fuel and can never move, so
  buying one at that exact waypoint is the only way to plant a keeper
  there at all — this closes the gap where keeper coverage previously
  only ever came from converting an idle miner/shuttle onto a manually
  curated market list, never from a shipyard discovered opportunistically.
  Goes through the same operator approval gate as any other autonomous
  purchase. New doctrine switch `autoKeeperProbes`, on by default —
  turn off in the Book if unwanted. See `docs/TODO.md` for a test-infra
  note (one new test case couldn't be verified live in this session due
  to a transient connection timeout to the remote test database).

## 2026-09-12 (input-reset fixes)

- **Fixed Book page inputs resetting mid-edit too** — same root cause
  as the Markets/ship-detail fix below: `renderBook()` unconditionally
  rebuilds its whole sheet's innerHTML whenever it re-renders for any
  reason, wiping the Discord webhook URL field, co-pilot settings
  fields, and any in-progress numeric policy-value edit. Now skips the
  render entirely while a value chip's click-to-edit input is open (it
  isn't part of the template, so nothing could restore it anyway), and
  snapshots/restores every other input the same way
  `refreshOpenShipDetails()` already does.
- **Fixed inputs resetting mid-edit on Markets and in ship detail
  panels**, on both mobile and desktop (v5/v6). Two separate bugs:
  the price chart's material dropdown's `change` handler read a stale
  closed-over variable instead of the event's actual new value, so
  picking a different material didn't register at all — the next 20s
  poll just restored the old selection, looking like a revert; and
  `refreshOpenShipDetails()` only ever preserved one specific field
  (`.dispatch-wp`) across its full re-render (every 5s while a panel is
  open), so every other input — keeper-market waypoint, the tour-
  dispatch system picker — reset mid-edit on that same cycle. Both
  fixed: the dropdown now reads `e.target.value` and skips unnecessary
  rebuilds, and the ship-detail preservation now covers every input/
  select/textarea in the panel generically instead of one hardcoded
  field.

## 2026-09-12 (autoExplore retry-loop fix)

- **Fixed `autoExplore()` retrying a doomed jump forever.** Found live:
  `DRAGOM-C` retried the identical jump to `X1-YB72` (remote gate under
  construction) every few minutes for 45+ minutes straight. Same bug
  shape as the `exploringEnabled` bypass fixed earlier this session — a
  protection (`exploreSystem()`'s remote-gate construction check and
  skip-list) existed on the dedicated-explorer path but was never
  applied to `autoExplore()`, the parallel path that opportunistically
  borrows an idle tour/scout ship. `canJump()` only validates the local
  gate, so nothing stopped the same unreachable target from being
  reselected pass after pass. `autoExplore()` now filters against
  `gateConstructionSkipUntil` and checks+records the remote gate's
  status before ever proposing the jump, mirroring `exploreSystem()`
  exactly. `tests/fleetNonBlocking.test.ts` covers it directly.

## 2026-09-12 (jump-cost fix + health check)

- **Fixed the cross-system jump-cost bootstrap gap.** `GalaxyAtlas.recordJumpCost()`
  now also fires from `shipProxy.ts`'s shared explore-jump path (the one
  every tour ship and explorer actually uses), not just trader/fleet-
  manager jumps. Previously a real jump's cost — like DRAGOM-D's actual
  jump to X1-RN95 — never lowered `crossSystemLegCost()`'s estimate for
  that gate pair, so every cross-system leg stayed priced against the
  flat 5,000-credit placeholder forever, a closed loop that meant no
  cross-system route could ever become profitable enough to fly and
  correct the estimate. `tests/shipProxy.test.ts` covers the fix
  directly (asserts `recordJumpCost` fires with the local gate,
  destination system, and real transaction price from the JUMP phase).
- **What "tour more systems" actually takes today**, for reference: a
  tenant assigns/buys a Light Shuttle into the `tour` role, then either
  dispatches it to a specific system via the dashboard's Tour Dispatch
  panel (multi-hop auto-jump toward the target, one gate at a time) or
  just lets it roam — `marketTourTargets()`/`shipyardTourTargets()`
  already trait-scan every charted system, not just home. The one hard
  constraint: a tenant can't dispatch its last home-system tour ship
  away (`fleet.ts`'s `dispatchTourShip()` refuses) — keepers only cover
  the home system's big markets, the smaller ones rely on a tour ship
  passing through.
- **Added `GET /healthz`**, mounted ahead of every other route in
  `src/cli/index.ts`, so Render can be pointed at a real health check
  instead of having none configured at all. Existence alone is the
  signal — it always returns 200. Needs the Render dashboard's Health
  Check Path field set to `/healthz` by hand (no API/MCP tool exposes
  that field on an existing service) before it actually changes deploy
  behavior — see `docs/TODO.md`.

## 2026-09-12 (multi-tenant market scoping + UI)

- **Scoped market data and dispatch routes to systems a tenant has
  actually charted.** `market_latest` is a shared table across every
  tenant on this server reset (deliberate — a market's price is a fact
  about the server, not the observer). Nothing filtered reads from it,
  though: DRAGOM's Markets tab was showing prices and "same-system"
  routes for `X1-QV71`/`X1-CN35`, systems it has never sent a ship near,
  priced entirely off other tenants' exploration. `computeDispatchRoutes()`
  and the `/markets`/`/intel` dashboard endpoints now filter to this
  tenant's own `chartedSystems` record. The home system is charted at
  boot, so no regression there.
- **Waypoint labels through the UI now include their system** (e.g.
  "S84-A1" instead of a bare "A1") — now that cross-system operation is
  real, a local waypoint code alone is ambiguous (multiple systems can
  have a waypoint named the same thing). Dropped the now-redundant
  separate system badge next to it in `v5`/`v6`.
- **Root-caused why cross-system trade routes never fly**, even once
  connectivity and cross-system market data both genuinely exist:
  `GalaxyAtlas.recordJumpCost()` — which lowers the estimated cost of a
  cross-system leg once a real jump's price is known — is only wired
  into the trader's and fleet-manager's own jump paths, not the shared
  explore/tour jump path every tour ship and explorer actually uses.
  So every cross-system leg gets priced against a flat, deliberately
  conservative 5,000-credit placeholder forever, which nothing has
  cleared yet — a closed loop, since no cross-system route can become
  profitable enough to fly and record a real, lower cost. Not fixed yet;
  see `docs/TODO.md`.

## 2026-09-12 (live-ops)

- **Lowered DRAGOM's `marginFloor` doctrine value from 20c to 10c**
  (operator change, not a code change). DRAGOM-1's trader had been
  flapping on its own FUEL route for over an hour — the route's real
  margin sat right at 19-20c, so it bounced between viable and rejected
  on every live price tick. Verified via live logs: after the change,
  DRAGOM-1 went from mostly-stuck to 11 successful route pickups across
  FUEL/FOOD/MEDICINE in the following 51 minutes, with zero margin-floor
  rejections and no new failure mode introduced by the looser floor.

## 2026-09-12

- **Documented four API-governance gaps** found while comparing this
  app's rate-limiting design against another developer's SpaceTraders
  app: per-request priority never reaches the shared HTTP rate limiter,
  the limiter's queue has no cap/shedding, mutating API calls have no
  ambiguous-failure/reconciliation safety net, and API capacity isn't a
  doctrine-tunable resource the way credits are. See
  `docs/api-request-priority-plan.md`, `docs/rate-limiter-saturation-plan.md`,
  `docs/ambiguous-mutation-safety-plan.md`, `docs/api-capacity-doctrine-plan.md`.
  Not implemented — proposals only.
- **Explored (and closed) a Kubernetes pod-per-tenant migration.**
  Conclusion: doesn't hold up on cheap managed K8s tiers, since they
  don't solve the actual constraint (SpaceTraders rate-limits by source
  IP, not tenant token) and would replace the in-process priority-queue
  rate limiter with a harder distributed version of the same problem.
  See `docs/k8s-pod-per-tenant-exploration.md`.
- Started this changelog, `docs/TODO.md`, and `docs/adr/README.md` to
  keep multi-threaded work organized going forward.

## 2026-09-11 and earlier (recent highlights)

- `8cd04f0` Rescue stranded ships by jumping when a fuel tender could
  never work — closes a real incident where DRAGOM-C/14 got stuck with
  no reachable fuel tender.
- `7ac2fcc` Tour ships top off fuel at every market, not just when running
  low.
- `e41e648` Fix stranded tour ships never getting rescued — `ShipAgent`
  never self-flagged as stranded in the first place.
- `e416ed4` Fix cross-system holds getting permanently stuck, quietly
  draining tour coverage.
- `db3c473` Fix `autoExplore()` skipping real jump gates it never
  actually loaded.
- `293c504` Fix two exploring-switch bugs: `autoExplore()` bypass and an
  unadopted default.
- `46de3aa` Add operator approval gate MVP, wired into autonomous ship
  buying — a human-in-the-loop gate for consequential engine decisions.
- `5494f03` Block dispatching the last home-system tour ship.
- `3b963b8` Fix vanished sector tabs: union charted systems into
  `/api/state` too.
- `5b0373d` Fix exploring master switch: check `isEnabled()`, not
  `value() === 0`.
- `ec03b9d` Add remote tour ship dispatch: multi-hop auto-jump toward a
  target system.
- `042a33e` Add doctrine controls to pause expensive explorer jumps.
- Persisted open trade positions (`heldRoute`/`heldCost`) across restarts
  and closed a multi-tenant boot-priority gap — see
  `docs/architecture-plan.md` and the held-route persistence work
  (migration `013_held_route.sql`).

For anything before this, `git log` is the record until it's worth
backfilling further.
