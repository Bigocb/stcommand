# Reset plan for 2026-11-15 13:00 UTC and the week to 2026-11-22 13:00 UTC (THEO)

Prepared 2026-11-14 about 17:30 UTC (T minus 19.5 h) for the operator and the Claude session that runs THEO, the operator's own production fleet.
It is independent of any other engine or project being designed elsewhere. It uses `docs/lessons-2026-11-01-to-11-14.md` for the evidence (cited as "lessons"), the
journals, `CLAUDE.md`, `docs/reset-opening-playbook.md`, `docs/post-gate-recovery-plan.md`, and read-only reads of the live box on 2026-11-14 16:38 UTC. Nothing in the fleet
or the doctrine was changed while writing it. "T" is the reset, 2026-11-15 13:00:00 UTC (`ops_reset_watch.nextReset`). Week hours are counted from T.

Two resets are in this plan, and they are different jobs:

* **Reset A: 2026-11-15 13:00 UTC** ends the week of 11-08 (THEO now at 409M matched profit and 252.5M wallet at hour 147.7) and starts the new week. Section 1.2 and section 6.5 hold
  what must still be done to close this week well. **The wind-down is set to 120 minutes and enabled; left alone it blocks every new buy from 11:00 UTC tomorrow (about 20M of profit, see lessons L1).**
* **Reset B: 2026-11-22 13:00 UTC** ends the new week. Section 6 is its wind-down.

---

## Summary (item 8 of the brief; read this first)

**What the data says**

* This week (reset 11-08) overtook last week at hour 117 and is at 402.6M against 312.5M at hour 147 (+29%); wallet 248.9M against 174.1M. Last week ended at 461.2M matched and 297.7M wallet.
  The drivers: bulk freighters (profit per sell 27k against 18k), 133 live systems against 84, and a 3.4-hour earlier gate.
* **The gate gap is real and about the same in both weeks:** after the gate opened (hour 47.2 and 50.5), profit per hour took about 36 hours to reach 1M and about 60 hours to reach 5M. The
  first 24 hours after opening made 5.4M (0.23M/h) this week, 12.0M last week. The gate costs about 5M and eats nearly all pre-gate income, so the wallet at opening was 0.77M (this week), 1.2-1.3M (last), 0.49M (10-25).
  Hulls bought in the 24 hours after opening: 194 / 149 / 46 across the three weeks, and matched profit in those 24 hours 25.6M / 12.0M / 5.7M (lessons, "The gate gap").
* **Last week's last 2 hours made nothing because the 120-minute wind-down blocked every buy; it is still enabled at 120.**
* The tuning of the gate cost this week 5-13 hours: ceilings at 2,000/4,000 raised seven times, circuitry started at hour 12 instead of 1, feeds blocked 20 hours, a 2-hour stall, and the last 20 circuitry units
  waiting 4-6 hours for a 5,000 ceiling when the ask was 5,050-5,350.

**Headline plan**

| When | What |
|---|---|
| **Today, before 22:00 UTC** | Set `resetWindDown` to 35 (this week's close). Check the box disk, `ops_instances`, approvals. Edit the saved template to "Opening v4" (section 1.3). **No deploys after 22:00 today.** |
| **T+0 to T+4 h** | Recovery runs by itself (about 13:05). THEO-1 tours, then trades. Gate mission with ceilings FAB_MATS 3,000 and ADVANCED_CIRCUITRY 6,000, no guards, both materials from hour 1-2. Contract shuttle at 200k. One hauler on the gate crew at about 500k. Feeds with loss allowances. Keepers only on the chain markets until the gate opens. |
| **Days 1-2** | Everything not on the path to the gate waits. Target gate open at **hour 36 (par), hour 30 (stretch)**; this week was 47.2. |
| **Gate open (hour 0 of the ramp)** | The 3M hull gate and keeper line switch off for 24 hours (`keeperAutoApproveMinCash` 500k, `systemReleaseMinCash` 500k). Spend every hour: haulers, keepers on 2-3 staged systems, tours by `jump_ship`. First bulk freighter as soon as wallet >= price + 1.5M (about 5M). |
| **Days 4-7** | Plateau 8-11M/h: one bulk pair every 6-8 hours while payback is under 10 hours, `freshTarget` 10, `freshStagedAhead` 4, keepers to 1,000, lanes 10. |
| **Reset B wind-down** | Bulk buys stop at T-10 h, haulers T-8 h, probes and staging T-5 h. `resetWindDown` 35. Scrap only what can reach a yard (decision 7.3). No deploys in the last 24 h. |

**Targets** (cumulative matched profit; "par" is this week's curve, "stretch" is this week's curve 11 hours earlier): hour 24 5M; hour 48 9M; hour 72 14-19M; hour 96 37-70M; hour 120 146-234M;
hour 144 372-480M; hour 168 about 600M par, 650-700M stretch (the plateau may cap this; see 3).

**Biggest decisions for the operator** (section 7): (1) `resetWindDown` 35 now; (2) lift the gate ceilings automatically and start circuitry at hour 1; (3) drop the 3M hull gate and the keeper line for the
first 24 hours after opening; (4) scrapping at the end (up to 30M of hull value, unverified refund); (5) first bulk at about 5M instead of 8-9M; (6) whether to pause contracts after the gate opens;
(7) a no-deploy freeze from 22:00 today and from T-24 h next week.

**Flags** (could not verify): the scrap refund for bulk freighters; whether `add_opening_template` replaces a template of the same name; whether a warp-drive hull can trade in a linked system before the gate is complete;
the box's free disk; the trip duration for sizing the wind-down; who owns the hourly scheduled task for the new week. See section 10.

---

## 1. Pre-reset checklist (today, the morning of the reset)

### 1.1 What to read in the app (all read-only), and what you should see

| Check | Tool | Expected | Today's reading (16:38 UTC) |
|---|---|---|---|
| Reset time and watcher | `stcommand_ops_reset_watch` | `nextReset` 2026-11-15T13:00:00Z, `accountTokenConfigured` true, `state` idle | idle, next reset 2026-11-15T13:00:00Z, token configured, `lastError` "status fetch failed: status 429" (the watcher's own status poll was rate-limited at 16:37) |
| One server instance | `stcommand_ops_instances` | `aliveCount` 1, `overlap` false, uptime since last deploy | one instance, uptime 68 min (restarted about 15:30), 0 429s in the last 60 s, box lane 79.6 calls a minute of 105 |
| API budget | `stcommand_ops_api_budget` | box under 90 calls/min, 429s under 1% | within range; 10 of 20 proxy lanes active; p8 carries the fleet-state refresh (31.5 GB a month projected; the whole pool projects 37.6 GB of a 250 GB plan) |
| Approvals | `stcommand_get_approvals` | none open | not re-read after 16:12 (journal: none open) |
| Opening template exists | `stcommand_get_opening_templates` | "Opening: auto at reset" (id 6) | exists, **unchanged since 11-08** (v3 with 1M triggers, guards, ceilings 2000/4000; see 1.3) |
| Old opening tasks | `stcommand_get_opening_tasks` | Tasks 7-27 (10-25 week) and 35-46 (11-08 week) are done or cancelled | all done or cancelled (the 11-08 `o3-*-1108` keys end `-1108`, so next week's `-1115` keys cannot be blocked by them) |
| Doctrine | `stcommand_get_doctrine` | see 1.2 | read; 121 rules; the output is 160 KB, read it into a file and query with `jq` |
| Gate state | `stcommand_get_gate_status` | the home gate of this week reads complete | complete (this week); the new home gate shows only after the reset |
| Disk | on the box: `df -h` for the Postgres data volume | at least 20% free | **not readable from here**; a "No space left on device" event hit at 11-13 15:01 (lessons item 14) |
| Scrap refund data | `stcommand_ops_ledger` filtered to SHIP/SCRAP, or `ops_timeline` kinds `ship_scrapped` | the three 11-09 shuttle scraps at 68-72% | read from the journal only |
| Hourly report trigger | the scheduled task list | one hourly read-only update scheduled for the new week | **not checked** (the 11-08 week's trigger is a session-bound scheduled task; confirm it survives the reset) |

### 1.2 Doctrine at reset: values to leave alone, set now, and set after the reset

Doctrine is **not** wiped by the reset (`doctrine`, `doctrine_fires` and `doctrine_fire_log` are outside `TENANT_GAME_TABLES`), so today's values carry into the new week, except those the opening template overwrites.

| Key | Current | Set to | When | Reason |
|---|---|---|---|---|
| `resetWindDown` | 120 (enabled) | **35** | **now** (it governs this week's close at 11:00 tomorrow, and next week's) | Last week it blocked every buy for the last 2 hours and cost about 11-16M (lessons L1). 35 minutes (opens 12:25 UTC) is about four times the measured mean trip (about 9 minutes: 11 trips started per 5 minutes by 20 trading ships, `ops_trade_tempo` 13:50-16:50 on 11-14); the tail beyond 35 minutes is not measured (section 6.3). The doctrine range is 5-1440. |
| `keeperAutoApproveMinCash` | 3,000,000 | template `o4-start` sets 100,000 at T+0; then 500,000 at gate open; 3,000,000 again after hour 36 of the ramp | at T+0 (template), gate open (task), +24 h (by hand) | The opening task sets it; today's 3M would block the first keepers on the chain markets. |
| `systemReleaseMinCash` | 1,000,000 | 500,000 at gate open for 24 h, then 1,000,000 | gate open | 8 keepers per system cost 250-350k; with the 1M floor and a wallet of 0.5M nothing stages (journal 11-10 13:35). |
| `autoApproveKeeperProbes` | 60,000 | keep | | Cap per probe; the 60k+ cards are mostly yard-gouged (347-363k at YH19-C44); deny those. |
| `cashFloor` | 100,000 | template sets 20,000 at T+0 and 100,000 at gate open | | As in v3. |
| `keeperTopUpPerHour` | 12 (enabled) | template disables at T+0, re-enable at gate open | | Nothing to top up at home; saves API calls. |
| `keeperTopUpMaxPending` | 6 | keep | | The hardcoded 3 stalled top-up for 2.4 h on 11-14. |
| `keeperTopUpMaxCalls` | 150 | keep | | The ceiling of the clause. |
| `keeperMaxTotal` | 1,000 | keep | | The polling budget binds near 960. |
| `freshGate` | 2 (auto) | keep | | |
| `freshTarget` | 10 | keep | | 10 beat 7 (lessons hour 125.5). |
| `freshStagedAhead` | 4 | keep | | |
| `freshMinGapMin` | 15 | keep | | |
| `freshTours` | 4 | 4 at gate open; 2 before | gate open | Tour ships for staged systems; 4 ships wait for "no free tour ship" at the end of this week, so raise to 6 once a second explorer-frame hull is owned. |
| `releaseOnTourPct` | 50 | keep | | The tour-priced release rule, live since 11-12 04:25. |
| `releaseMinPricedPct` | 80 (enabled) | keep | | |
| `freshIdleMinHourlyProfit` | 20,000 (enabled) | template sets disabled at T+0, 20,000 at gate open | | |
| `freshIdleParkHours` | 3 | keep | | Mass unparking caused the 11-13 429 spike; `freshIdleRecheckMin` 45. |
| `apiLaneCount` | 10 | keep (max 20) | | 10 lanes carry 55-90 calls a minute; raise to 14 only if `ops_api_budget` shows a lane over 80 of 90. |
| `apiLaneProxy` | 3 (enabled) | keep | | |
| `autoBuyShips` | 1 (disabled) | keep disabled | | Hull buying stays manual. |
| `shipBudget` | 30,000 | keep | | Caps auto buys only. |
| `shipCap:*` | 4 per frame | keep | | Apply to auto buys; manual buys bypass. |
| `openingAutomation` | 1 | keep | | Without it the template is not applied. |
| `autoApproveFloorSale` / `autoApproveFloorSaleMaxLoss` | 40 / 600,000 | **lower the max loss to 200,000 at T+0** | after reset | With these values a below-floor lot sells **without a card** when the market pays at least 40% of the cost basis and the loss is under 600k (that is how THEO-95's -236k at 65% of basis and THEO-5's -138k went through on 11-13/14; the 1c sales of THEO-43 and THEO-44 were cards a person approved). At 200k the -236k case would ask. Decision 7.8. |
| `marginFloor`, `maxLossPct` | 10, 15 | keep | | |
| Gate mission pacing (not a doctrine key) | n/a | see 1.3 and section 9 | T+0 and gate progress | Set through the template and `stcommand_set_mission_pacing`. |

### 1.3 The saved opening template: what it holds and what to change

`get_opening_templates` (2026-11-14 16:38): id 6 "Opening: auto at reset" holds 9 tasks (`o3-tour`, `o3-start`, `o3-gatemission`, `o3-trader`, `o3-yardkeep`, `o3-contract`, `o3-topkeep`, `o3-gatehaul`, `o3-finalpush`, `o3-gateopen`; keys get `-1115` appended at the reset).
Compared with what actually worked this week (lessons (e), "The gate gap"), v3 has these faults:

| Task | Holds | Problem | Change in v4 |
|---|---|---|---|
| `o3-gatemission` | paused; ceilings 2,000/4,000; `buyGapMin` 30; `recoverPct` 3; lots 20; `maxInflationPct` 25 | Guards held buying at hour 4-6; low ceilings were raised 7 times | ceilings **FAB_MATS 3,000, ADVANCED_CIRCUITRY 6,000** (about 2.5x the opening ask; check the ask at T+0:15 and set 2.5x); `buyGapMin` 15; no `recoverPct` (null); `maxInflationPct` 1000; `buyLotUnitsBy` {FAB_MATS 40, ADVANCED_CIRCUITRY 20}; `yieldToTrading` true |
| `o3-topkeep` | at 1M, keepers on 10 top markets, top-up on | 0 markets added at home on 11-08 (empty directory) | drop (cancelled last week) |
| `o3-gatehaul` | at 1M, hauler, gate buying | Too late: this week's hand task bought at 600k and the first lot was at hour 4 | trigger `cashAtLeast` 450,000 after `o3-contract`; hauler max 330k keeping 100k; start the mission **unpaused**, `cashFloor` 100,000, `cashResume` 200,000 |
| gate 85% | `o3-finalpush`: cash floor 0 | does not lift the ceilings | add `maxPriceBy` FAB_MATS 5,000 and ADVANCED_CIRCUITRY 9,000 to the same step; keep `cashFloor` 0 |
| gate 100% | `o3-gateopen` | | also `keeperAutoApproveMinCash` 500,000 (value), `systemReleaseMinCash` 500,000, `keeperTopUpPerHour` enabled, `freshIdleMinHourlyProfit` 20,000 |
| (missing) | feed tasks | the playbook says "from hour 1"; feeds cannot be templated because the producer waypoints are unknown | by hand at T+0:30 (section 2) |
| (missing) | a second circuitry task | circuitry started at hour 12 | covered by `o4-gatemission` (both materials buy from the start) |

**How to change it.** `stcommand_add_opening_template` ("Create or update ... name ... tasks") saves by name (`saveOpeningTemplate`); whether the same name replaces id 6 or adds a second is **not verified**.
Do it today, then read `get_opening_templates`. If it creates a duplicate, `applyOpeningTemplate` takes the saved template by name: check which one wins by reading `get_opening_tasks` at T+0:10.
If the replacement does not take, the fallback is to leave v3 and edit the queued tasks after the reset with `stcommand_add_opening_task` (the same key updates a queued task) and `stcommand_set_mission_pacing`.
The task kinds seen in the template are `setRole`, `buyShip`, `setDoctrine`, `startGateMission`, `keepers`, `gateCrew`, `startFeed`, `contractDuty`, `waitFor`; triggers `always`, `cashAtLeast`, `taskDone`, `routeProfitAtLeast`, `minutesSinceQueued`, `gateProgressAtLeast`, `any`, `all`, `shipHoldEmpty`.

### 1.4 Which data survives the reset and which is wiped (`CLAUDE.md`; `Store.TENANT_GAME_TABLES`, `SHARED_GALAXY_TABLES`)

| Survives | Wiped |
|---|---|
| Ledger (kept, keyed `THEO@<reset date>`; the new week starts at `THEO@2026-11-15`) | Ship state and ships (`fleet_state`, `ship_state`, `ship_claims`, `ship_log`, `ship_manifest`, `held_route`, ...) |
| Doctrine, `doctrine_fires`, `doctrine_fire_log` | Missions, feeds, `pending_approvals`, warehouse tables, `bucket_ledger`, `buckets`, `activity`, `state_snapshot` |
| Opening templates and old opening tasks (tasks 7-46 are still listed) | Shared galaxy tables: `galaxy_systems`, `galaxy_factions`, `galaxy_crawl_state`, `market_snapshots`, `market_latest`, `shipyard_inventory`, `module_catalog`, `galaxy_jump_costs`, `galaxy_gate_construction` |
| `run_results` (the scoreboard row is saved just before the wipe), `action_events`, `analysis_findings`, seasons, `operator_actions`, `ship_movements`, `chat_messages`, sessions | Keeper lists and the system queue (they are ship- and galaxy-keyed) |
| Webshare proxy pool and its limiter configuration (environment) | |

Consequence: the new week knows **nothing** about markets, yards or gates until the crawler and the tour ship re-read them. The shipyard prices of this week (bulk yards at BT86, FR76, QP22, ...) do not carry over; the new yards are unknown.
Re-read `get_shipyard_inventory` after the first tour. Save this week's report before the reset: `stcommand_capture_findings` (and `stcommand_close_season_week` if the season screen is in use).

### 1.5 How the reset recovery works, and the admin page

1. **Detection.** `GalaxyStatus` (`resetWatcher.ts`, `resetWatcherLive.ts`) polls the game's unauthenticated `GET /` for `resetDate`; a new date starts the recovery. The reactive path (a 401 "reset_date does not match" latches `fatalAuthError`
   and shows a banner on `/admin`) is the backup. The watcher needs `ST_ACCOUNT_TOKEN` (set: `accountTokenConfigured` true); without it the state is `needs_account_token` and nothing changes.
2. **Recovery** (automatic, no operator action): save the scoreboard (`run_results` row), wipe the tenant and shared galaxy tables, register a fresh agent for each tenant (THEO only on this box), boot it, apply the
   saved opening template (`applyOpening`, name `OPENING_TEMPLATE` or "Opening: auto at reset"; if THEO has none saved it seeds the built-in `OPENING_V3` from `openingTemplates.ts`).
   Last week it finished by 13:05 (`ops reset_watch`: recovered, handledResetDate 2026-11-08, THEO booted).
3. **Admin page** (`GET /admin`, `ADMIN_KEY`-gated): the "After a server reset" panel is the manual path: re-register the tenant first, then check the tenants whose data should be cleared and click
   "Clean up checked tenants + shared galaxy data" (`POST /api/admin/reset-cleanup`, which truncates the shared tables and calls `GalaxyCrawler.resetCrawlState()`). **Uncheck any tenant that has already re-registered**
   (`keepTenantIds`), or its new data is wiped. Needed only if `ops_reset_watch` is stuck in `needs_account_token` or `error` after 13:15.
4. **Risk to name:** the watcher's status poll already shows `status fetch failed: status 429`. Both the watcher and the fleet share the IP budget. If `ops_reset_watch` still reads `idle` with `apiResetDate` 2026-11-08 at 13:10, check
   `https://api.spacetraders.io/v2/` by hand (unauthenticated, `curl`), then use the admin panel. The watch does not need the fleet's own 429-prone budget; it is a separate call.

### 1.6 Token and proxy readiness

| Item | Check | Status |
|---|---|---|
| Account token | `ops_reset_watch.accountTokenConfigured` | true. The agent token is replaced by the recovery; do not paste any token into chat. |
| Agent registration | after T+0:05, `get_fleet_status` shows THEO-1 at the new HQ with 175,000 credits | to verify at the reset |
| Proxy pool | `ops_api_budget` / `ops_instances.lane`: `activeProxies` 10, `configuredProxies` 20, breakers closed, 0 failures | read: p1-p10 active, breakers closed, `projectedGBPerMonthAllProxies` 37.6 of 250 |
| Webshare account | the proxies' IP authorization for the box's address; plan GB used (about 3 GB of 250 in the 11-13 reading) | not re-read (the Webshare tools were not used here) |
| Rate limit | per source IP, 2 requests a second, burst 30 (measured 2026-11-02); the box limiter is 105 a minute (`API_RATE` 1.75) | one limiter shared by every tenant on the box |
| Box limiter at the reset | the sharp edge is the first minutes: the new agent, the crawler restart (7,000 systems) and the recovery all start at once | keep the crawler on its own proxy (`CRAWLER_PROXY_URL`, set last week) |

### 1.7 This week's close (2026-11-14 17:30 to 2026-11-15 13:00): what to do about the money

The ranking is the wallet at 13:00 tomorrow. At 10M/h the last 19.5 hours are worth about 195M of profit and the wallet is 252M. So the choices that matter are small percentages of a large number:

| Item | Recommendation | Evidence |
|---|---|---|
| Wind-down | Set `resetWindDown` to 35 **today**. It opens at 12:25 UTC tomorrow. | L1: 120 minutes blocked all buys last week and the last two hours made 2.1M and 0. |
| Bulk freighters (3.1-4.1M each) | Last bulk purchase at about **03:00 UTC tomorrow** (T-10 h). The first two hours of a new bulk earn 0.05-1.4M (mean about 0.4M/h); the ones bought after hour 122 averaged 0.45M/h. Payback about 7-9 h, hull is worth zero at the end. | lessons (g); hours 122-146 |
| Light hauler / shuttles | Stop at about 05:00 (T-8 h). | payback 3-8 h at the end-of-week rates |
| Keeper probes (25-35k) | Stop auto-buying and new staging at about 08:00 (T-5 h): the premium lasts about 2 h after a release, and a probe is worth zero at the end. Turn off by `set_doctrine keeperTopUpPerHour` disabled and `freshGate` hold, not by pausing the fleet. | |
| Contracts | Already stopped by the operator. | |
| Cargo at the end | With `resetWindDown` 35, trips already under way finish and sell; check `ops_trade_tempo` at 11:30 for trips that cannot finish (cross-system trips with 3+ hops). | resetWindDown.ts |
| Scrapping | See section 6.5 and decision 7.4. This week's close is the first chance to measure the refund on a bulk. | |
| Deploys | **None after 22:00 today.** Two restarts on 11-14 reset Tower's history and re-ran probe bursts. A restart at 12:00 tomorrow with 200 ships in flight is the worst case. | lessons item 13 |
| Save | `capture_findings` at about 12:30 tomorrow (read-only on game state), and a final journal entry at 12:45. | CLAUDE.md |

---

## 2. T-0 to T+4 h, minute by minute

All times are UTC on 2026-11-15. "C" is the Claude session, "O" the operator. Read before writing (CLAUDE.md: re-checking is cheap, re-issuing is not).

| Time | Who | Action | Tool | Expected |
|---|---|---|---|---|
| 12:40 | C | Final pre-flight: `ops_instances`, `ops_api_budget`, `get_approvals`, `get_fleet_status`; confirm `resetWindDown` 35 took; write the pre-reset journal entry and `capture_findings`. | read tools | one instance, no approvals, wind-down window open from 12:25 |
| 12:55 | O+C | Stop touching the fleet. No doctrine edits, no purchases. Note the last wallet and cumulative matched profit (this is the week-1 score). | `ops_profit_curve` | |
| 13:00 | | Reset. All agent tokens die. `fatalAuthError` latches on THEO; the wind-down's reset-time check turns the window off ("the reset has passed"). | | the fleet logs `reset_date does not match` |
| 13:01 | C | Poll `stcommand_ops_reset_watch` every 60 s (read-only). Do not call fleet tools; the old token is dead and each call is a wasted request. | `ops_reset_watch` | `state` moves from idle to running |
| 13:05 | C | Recovery done: `handledResetDate` 2026-11-15, THEO booted. Check `get_fleet_status` (THEO-1 command ship at the new HQ, one more ship probably a probe or shuttle: last week 2 ships; credits 175,000) and `ops_instances`. | read | |
| 13:07 | C | Read `get_opening_tasks`: expect `o4-*-1115` (or `o3-*-1115` if the template replace did not take). `o4-tour`, `o4-start` and `o4-gatemission` should be done; the rest queued. | `get_opening_tasks` | |
| 13:08 | C | If the template did not take: apply v4 by hand now with `add_opening_task` for the tasks in 1.3 and `set_mission_pacing` on the gate waypoint. | `add_opening_task`, `set_mission_pacing` | |
| 13:10 | C | Record the home system, HQ, **the gate waypoint**, and what the gate needs: `get_gate_status` (last week: FAB_MATS 1,600, ADVANCED_CIRCUITRY 400, QUANTUM_STABILIZERS already done; the materials can change; read them). | `get_gate_status`, `get_missions` | |
| 13:10 | C | `ops_api_budget`: the crawler restarts at 7,000 systems; confirm the box limiter under 90% and 0 429s. | `ops_api_budget` | |
| 13:15 | C | **Chain discovery from the public market lists** (no ship needed, as on 11-08 16:48): who exports FAB_MATS and ADVANCED_CIRCUITRY, what each imports, where the inputs are sold. | `get_chain_health`, `ops_market_directory`, `get_goods`, `get_best_price`, `ops_systems_candidates` | last week: F53 (FAB_MATS, from IRON, QUARTZ_SAND, SILICON_CRYSTALS, COPPER), D49 (circuitry, from ELECTRONICS, MICROPROCESSORS, ALUMINUM, MACHINERY) |
| 13:20 | C | Set the gate ceilings from the asks just read: **FAB_MATS 2.5x the ask (last week 1,197 -> 3,000)** and **ADVANCED_CIRCUITRY about 1.45x (last week 4,100-4,200 -> 6,000; its ask is already high and ran to 14,392 in the 11-01 week)**, `maxInflationPct` 1000, no `recoverPct`. Unpause the mission only when the gate hauler exists (below). | `set_mission_pacing` | |
| 13:30 | C | THEO-1 should be touring. It becomes a trader on the first route paying 15,000 a trip or after 30 minutes (13:35 at the latest). | automatic (`o4-trader`) | last week THEO-1 made 0.28M in the first hour and 2.2M in 6 |
| 13:30-14:00 | C | Approve (O) the keeper-probe cards whose target is a shipyard; deny the rest and anything over 60k. | `get_approvals`, `decide_approval` | |
| 14:00 | C | **First hourly report** (section 4). Cumulative matched profit target: 0.3-0.5M. | `ops_profit_curve` | 0.28M last week hour 1 |
| at 200k wallet (about 13:50-14:15) | auto | Keepers on the home shipyards (`o4-yardkeep`), then a light shuttle on contract duty (`o4-contract`, max 130k keeping 60k). | | contracts were about half of pre-gate income; one shuttle did 100-600k an hour on good hours |
| at 450-500k (about 15:00-16:30) | auto | One light hauler (max 330k, keeping 100k) on the gate crew and **the mission unpaused** (`o4-gatehaul`), lots of 40/20, no recovery wait. | | this week the hauler bought at 600k at hour 3.8 |
| 14:30-15:30 | C | **Feeds, with allowances from the start** (the 11-09 lesson): `start_feed` into the FAB_MATS producer from the cheapest input source, `maxLossPerUnit` IRON 40, COPPER 30, SILICON_CRYSTALS 10, QUARTZ_SAND 10, `stopAtSupply` HIGH, `carrierTarget` 0 until the carrier is named; `assign_feed_carrier` a shuttle that is a trader (a feed carrier must be one). **Do not let the feed take THEO-1.** Start only the inputs whose supply is LIMITED or SCARCE (last week IRON and COPPER); max 2 shuttles, not 6. | `start_feed`, `set_feed_limits`, `assign_feed_carrier`, `set_ship_role` | |
| 15:00 | C | **Keepers on the chain's markets only** (the producers and their input markets, 6-8 probes at 20-30k) with `set_keeper_markets`; the pacing reads those prices. Nothing else until the gate opens. | `set_keeper_markets` | last week's hand-bought 12 keepers at hour 4 earned nothing before the gate |
| 16:00 | C | Hour 3 report. Gate: first lots of both materials bought? | `get_gate_status`, `ops_gate_history` | FAB_MATS 80 at hour 4 this week |
| 17:00 | C | Hour 4 checkpoint: FAB_MATS >= 160, ADVANCED_CIRCUITRY >= 20 delivered; wallet >= 0.3M. If circuitry is 0, check the ceiling against the ask and raise it (do not wait). | `get_missions` | |
| 19:00 | C | Hour 6: 0.6-0.9M cumulative matched profit expected to have flattened; the home system saturates (profit per unit 100-150 by hour 9). **Do not add keepers or shuttles to "fix" it**; this is the saturation both weeks. | | |
| 13:00-17:00 | C | API budget (hours 0-4): box limiter 20-40 calls a minute, 0 429s. `apiLaneCount` 10 stays; `keeperTopUpPerHour` is disabled by `o4-start`. | `ops_api_budget` | |

Cash gates in force for hours 0-4 (and why): `cashFloor` 20,000 (v3); `keeperAutoApproveMinCash` 100,000 (v3); **no hull other than the contract shuttle, the gate hauler and 2 feed shuttles**; the 3M hull gate does not apply (the wallet never reaches it before the gate).
The auto-approve cap per probe stays at 60,000. Escape clause (CLAUDE.md): if cash is flat or falling for 2 hours or traders sit idle with the wallet under 500k, the answer is to *check the route list* (a cash-limited dispatcher reads -5,000/-10,000 for every route when the wallet is 86k), not to buy a hull.

---

## 3. Day by day, days 1-7

Reference curves (ledger): this week "W2" (reset 11-08) and last week "W1" (reset 11-01). Hours are from T. Profit per hour is the mean of the hourly buckets in the window.

### 3.1 Targets at checkpoints

| Hour | Cumulative matched, W1 | W2 | **Par target (this week's curve)** | **Stretch (gate at 30-36 and a funded start)** | Profit/h W1 / W2 | Hulls selling | Live systems (W2) | Keepers (W2) | Wallet W2 |
|---|---|---|---|---|---|---|---|---|---|
| 6 | 1.7M | 2.2M | 2.0M | 2.5M | 0.2 / 0.5M | 1-2 | 1 | 3-8 | 0.9-1.2M |
| 12 | 3.1M | 3.3M | 3.0M | 3.5M | 0.2 / 0.1M | 2-4 | 1 | 16 | 0.8M |
| 24 | 5.3M | 4.2M | 4.5M | **5.5M** (FAB_MATS >= 1,000, circuitry >= 250) | 0.1 / 0.1M | 4-5 | 1 | 16-19 | 0.6-0.9M |
| 36 | 6.6M | 6.1M | 6.5M | gate **open** | 0.1 / 0.1M | 4-5 | 1 | 19 | 0.5-1M |
| 48 | 8.2M | 7.3M | 7.5M | **9.4M**; 1M/h by hour 48 | 0.4 / 0.2M | 5-8 | 3-5 | 38 | 0.1-0.5M |
| 72 | 19.8M | 13.0M | 13M | **19-20M** | 0.6 / 0.3M | 8-12 | 9-10 | 80-110 | 3-5M |
| 96 | 56.3M | 36.7M | 37M | **70M** | 2.0 / 1.4M | 15 | 28 | 250 | 3-8M |
| 120 | 140.1M | 145.9M | 146M | **234M** | 4.6 / 5.9M | 22-25 | 70 | 700 | 45M |
| 144 | 294.7M | 372.2M | 372M | **480M** | 7.1 / 10.6M | 28-30 | 126 | 880-960 | 230M |
| 168 | 461.2M | about 600M projected (hour 168 at 10M/h) | 600M | **650-700M** (capped by the keeper limit 1,000, the API budget and the live systems; a plateau of 10-11M/h from hour 130 is what the data supports) | | | | | wallet about 62% of cumulative |

"Stretch" is W2's curve shifted 11 hours earlier (a gate at hour 36 instead of 47.2). It assumes the ramp length of about 60 hours after opening is unchanged; if the opening capital is also higher it could be shorter, if the early cash rules bite again it could be longer.
It is a target for planning, not a forecast: the data has two weeks and one plateau.

### 3.2 Day by day

| Day (hours) | What happens | Decisions | Checks |
|---|---|---|---|
| **Day 1** (0-24) | Opening v4 runs. THEO-1 trades, contract shuttle, gate hauler, two feeds, chain keepers. Home profit 0.5M/h in hour 1-5 then 0.1M. | No hulls other than listed. Raise gate ceilings to FAB_MATS 4,000 / circuitry 7,000 at hour 12 if FAB < 450 or circuitry < 120 (this week hour 11: 406 / 0). | Hour 12: FAB >= 450, circuitry >= 120. Hour 24: FAB >= 1,000, circuitry >= 250 (W2: 866 / 160). |
| **Day 2** (24-48) | Gate 85% by hour 28-32; `o4-finalpush` lifts ceilings to 5,000 / 9,000 and drops the gate cash floor. | At 85% decide: hold the wallet floor 0 so every credit goes to materials. At 95% pre-position (section 9, G7). | Hour 36: FAB done; circuitry >= 330. **Go/no-go for opening: section 9, "Target timeline".** |
| **Day 3** (48-72) | Gate open at hour 30-36 (stretch) or 40-47 (par). Release the first 2 systems within 40 minutes; spend every hour: haulers, keepers on 2-3 staged systems, `jump_ship` tours into the 5 linked systems (not `dispatch_tour`, which scouts the home system first). | The 3M hull gate and the 5M keeper line are suspended for 24 h (decision 7.3); `systemReleaseMinCash` 500k. Light haulers until wallet >= 5M. | Wallet at opening, hulls bought in 24 h (target 80-100, W2 46, W1 149), profit/h at +12 h (target 0.5M). |
| **Day 4** (72-96) | 10 -> 28 live systems, 15 traders; first bulk freighter when wallet >= price + 1.5M (about 5M). `releaseOnTourPct` auto releases. | One bulk per yard per buy; yard by `price + hops x 7k + travel time` (CLAUDE.md); before each buy re-read `get_shipyard_inventory`. Heavy freighters: no (W2: THEO-93 2.8M earned less than a bulk on cheap goods). | Hour 96: 28 live, 1.4-3M/h. |
| **Day 5** (96-120) | Bulk pairs every 6-8 hours (W2: hours 98, 102, 105, 108, 110, 122), keepers toward 600, lanes 10. | Bulk buy rule: wallet >= price + 1.5M floor, first 6 bulks at the yard nearest the live cluster. Stop contracts when profit > 2M/h (hour ~96). | Hour 120: 5-6M/h, 21-25 selling ships. |
| **Day 6** (120-144) | Plateau. 70 -> 126 live systems; keepers 700 -> 960; tours supply is the limit ("no free tour ship within 12 gate hops"): buy 2 explorer-frame tour ships (670-880k) at about hour 110. | `freshTours` 6; `freshTarget` 10; parking and unparking: do not mass-unpark. | 8-11M/h; 429s under 4%. |
| **Day 7** (144-168) | Last bulk at T-10 h (hour 158), haulers T-8 h, probes and staging T-5 h; wind-down at T-35 min; final sequence in section 6. | See section 6. | Hourly: wallet vs cumulative (target 62%). |

### 3.3 Decision rules

**Bulk freighter vs light hauler**

| Hull | Cargo | Price | Evidence | Rule |
|---|---|---|---|---|
| Light hauler (SHIP_LIGHT_HAULER) | 80 | 273-354k (price rises as you buy at A2: 273k at hour 4, 354k at hour 85) | 44-160k/h each (journal 11-12 02:15) | Until a bulk is affordable: buy one per hour after opening while the wallet stays >= 1.5M after paying (3 traders per 1M of wallet). Yard in the trade system. |
| Heavy freighter | 225 | 2.76-2.81M (a single yard seen: DJ26-CC4B) | THEO-64 about 340k/h on 2.5-5k goods; THEO-93 on cheap goods earned less | Skip unless it is the only big hull available. |
| **Bulk freighter** | 490 | 3.0-4.3M (BT86 3.81-3.90M, FR76 3.83-3.90M, QP22 3.02-3.11M, FB76 4.12-4.28M, AF66 3.97-4.11M this week) | 0.4-1.0M/h typical, 2.68M in a best hour (THEO-275); profit per sell 27k | **First bulk when the wallet >= price + 1.5M** (about 5M; W2 bought at 8.9M, which delayed it 8-13 h). One per yard per purchase (price steps 0.6-2%). Buy at the yard nearest the live cluster, not the cheapest. |
| Explorer-frame tour (SHIP_EXPLORER) | 40, speed 36, warp | 0.67-0.88M | staged systems wait for tours | 2 at about hour 100, more only if "no free tour ship" appears in the queue log. |
| Keeper probe | probe | 20-35k (avoid yards charging 60-363k) | | At the 60k cap, deny above. |

**How many systems live:** the engine target. `freshTarget` 10 premium systems not fading, `freshStagedAhead` 4, gap 15 minutes: that released 2-3 an hour and reached 133 live at hour 147. Keep it. The binding constraint is the keeper limit (1,000) and polling (150 ceiling) near hour 140, not the system count.
**Keepers:** let `keeperTopUp` and `keeperAutoApproveMinCash` run once the gate is open (500k for 24 h, then 3M if the wallet exceeds 10M; the engine bought about 30 probes an hour from hour 100). Parking is automatic (`freshIdleParkHours` 3); do not re-park by hand.
**Gate construction timing:** both materials from hour 1-2, at 2.5-3x the opening ask, lifted at 85% (section 9).
**Contracts:** one shuttle on contract duty from 200k until the fleet earns over 2M/h (about hour 96), then off. Evidence: contracts were about equal to matched trading income before the gate (about 6M against 7.3M this week) and 100k/h net from one ship after it. The operator stopped them at hour 130; that is right for the plateau and wrong before it.
**Expansion cadence:** from hour 87 `releaseOnTourPct` 50 makes systems open when half the markets are priced and a tour ship is in them; the stalls were "no tour ship" (hours 132-147): own 4 tour-capable ships at the start of day 4 and 6 at day 6.

---

## 4. The hourly-update protocol

**Cadence and form.** One read-only update at :12 past each hour, in tables, appended to `docs/journal/2026-11-15.md` (the format is in `docs/journal/README.md`). Read first, write nothing to the fleet. Times in UTC. The journal baseline error of this week (lessons (c))
means: **take cumulative matched profit from `stcommand_ops_profit_curve` (hourly buckets, `cumulativeProfit` of the last completed bucket), never from a running sum of earlier updates**, and take the same-hour comparison for last week with
`resetDate` 2026-11-08 (and 2026-11-01) in the same call.

**Every update contains**

| Item | Source | Flag when |
|---|---|---|
| Matched profit: last hour, 3-hour mean, cumulative; the same elapsed hour in the weeks of 11-08 and 11-01 | `ops_profit_curve` (sinceHours 3; resetDate for the other weeks) | the last hour is 25% under the previous 3-hour mean |
| Wallet, holds (cost and value), wallet + holds, hulls bought and their cost this hour | `get_cargo_value`, `ops_profit_curve.shipsBought`, the ledger SHIP rows | wallet falls two hours running with no gate/hull reason |
| Wallet / cumulative matched ratio | the two above | falls under 55% (it was 61-65%) |
| Gate: FAB_MATS and ADVANCED_CIRCUITRY delivered, ask vs ceiling, yield state, carriers | `get_gate_status`, `get_missions`, `ops_gate_history` | an ask over its ceiling for 60 minutes while progress is under 100% (raise it, section 9, G1) |
| Systems: live, staged, last release, tour ships and "no free tour ship" lines | `ops_system_queue`, `ops_logs` | no release for 60 minutes with a staged system 80% ready |
| Keepers: covered, uncovered, rotation, top-up last added, polling against the 90 budget | `ops_keeper_coverage`, `ops_keepers` | top-up silent for 90 minutes with uncovered markets; rotation over 30 minutes |
| API: box calls/min of 105, 429 count, proxy lanes | `ops_api_budget`, `ops_instances` | 429s over 5% of calls, or more than one alive instance |
| Health: stuck critical, transit overdue, approvals, restarts (uptime), disk | `ops_stuck`, `get_approvals`, `ops_instances` | any critical; a card above 200k; uptime reset |
| Losses: worst sales of the last 300 rows | `ops_ledger` | any sale under -100k |
| Bulk and heavy yards: price and where, with the read time | `get_shipyard_inventory` | wallet >= price + 1.5M (the buy rule) |
| Trader idleness | `ops_trade_tempo`, `ops_dispatch_explain` limit 5 | trips started per 5 minutes under 5 for 15 minutes |

**What to watch per phase** (the first line of each update names the phase)

| Phase | Hours | The report watches |
|---|---|---|
| A. Opening | 0-6 | THEO-1 trading by hour 0.5; the template tasks done in order (`get_opening_tasks`); the gate mission created with the right ceilings and unpaused when the hauler exists; chain markets identified; feeds running (not "no margin"); no carrier is the command ship; wallet not under 150k; **no keepers beyond the chain markets**. |
| B. Gate building | 6 to the opening | FAB_MATS and circuitry against the checkpoints (hour 12: 450 / 120; 24: 1,050 / 250; 32: 1,500 / 340); ask against ceiling; cash reserve at the 85% line (target 2M); idle shuttles; the contract shuttle's contract; saturation of home (profit per unit under 150 is expected, not a fault). |
| C. Opening, +0 to +24 h | | Systems released within 40 minutes of opening; hulls bought per hour (target 4 an hour); wallet never under 1.0M after the first 4 haulers; profit/h 0.5M by +12 h; `jump_ship` tours priced; traders-to-keepers not under 1:6. |
| D. Ramp, +24 to +72 h | | Bulk affordability; live systems versus the table; staged queue not empty; tours free; keeper polling; 429s; cash-starved dispatch (every route negative at a low wallet). |
| E. Plateau | +72 to T-24 h | The 25% flag; keeper rotation; 429 rate; disk; restarts; yard prices; the T-minus cutoffs in section 6. |
| F. Wind-down | T-24 h to T | The cutoffs, `resetWindDown` state, holds at the end, scrapping progress (section 6). |

**Scheduled task.** The 11-08 week's hourly trigger and the daily price check (`trig_01AHmaNYVby74hjofDN6QP27`) are bound to a session. Confirm at T+0:30 that an hourly read-only task exists for the new week (`mcp__Claude_Code_Remote__list_triggers`); if not, create one at the operator's word (a recurring unattended task that **buys** is refused by the harness, and should stay refused).
If the Tailwinds connection drops (11-13 13:17-14:40) write a short "not produced" entry, say what the last good reading was, and do not substitute the lowercase `stcommand` server.

---

## 5. Failure playbook

Rule for every row (CLAUDE.md): read the state first, and do not re-issue a call that errored until a read shows it did not happen (the 2026-10-08 double hauler). "C" is the Claude session, "O" the operator.

| Incident | Detection signal | Immediate action | Who |
|---|---|---|---|
| **Fleet stall** (11-10 01:43-03:50) | `ops_trade_tempo` `tripsStarted` near 0 for 15 minutes with traders known; `ops_stuck` several "in transit, arrival passed" over 20 minutes; the API call rate falling from 15 to 4/min; no ledger sells | C: read `ops_instances` (one instance?), `ops_logs`, `ops_stuck`; **do not** issue dispatches. After 30 minutes with 5+ traders hung, ask O. O: restart the server (this is the one allowed restart; log the minute). Cargo on hung ships sells after the restart. | C detects, O restarts |
| **429 storm** | `ops_instances.rateLimit.hits60s` over 30 for 3 minutes; `ops_api_budget` 429s over 5% of calls; a burst after mass unparking, a probe-purchase batch, or a restart | C: find the burst (keepers unparked together, 11 systems on 11-13 15:36-16:11; probe batches; hop retries). Raise `apiLaneCount` by 2-4 if a lane is under its limit, lower `keeperTopUpPerHour` to 6 for an hour. Do not restart. 3-4% of calls retried is the normal state at the plateau. | C |
| **Double instance** (deploy overlap) | `ops_instances.aliveCount` over 1, `overlap` true; 429 storm with two heartbeats | O: stop the older process on the box. C: never starts or stops servers. | O |
| **Redeploy or restart** | `ops_instances.uptimeMin` resets; Tower's hourly history empties; "restored role" lines | Avoid. If needed: not in the first 6 hours after a release batch, not in the last 24 hours. After one: re-read `ops_stuck`, `get_approvals`, tour ships' destinations (`queueTours` restores a destination only for ships it dispatched), keeper top-up last-added, and the gate mission pacing. | O decides, C re-reads |
| **Stranded ship** | `ops_stuck` critical ("stranded", fuel 0/300, `rescueStranded` looping at about 8 calls/min, e.g. THEO-213) | C: `get_ship_state`, then `refuel_ship` or `dispatch_ship` for the one ship; if a loop persists over 60 minutes, `park_ship` it. Do not call `set_ship_role` on a mid-task ship. | C with O's word |
| **Market crash / thin market** | A route's profit per unit falls three sells in a row; `ops_dispatch_explain`; a ship sells at a falling price (THEO-5 LASER_RIFLES 13.5k -> 10.8k) | C: `get_price_trend`, `get_best_price` for the good; `block_good` for a good that falls; `set_ship_lot_policy` to cap lots on a thin market; `ops_blocked_goods` to confirm | C, O approves block |
| **Large trade loss** | A sell under -100k in `ops_ledger`; a `sellBelowFloor` card | **Before approving any card, read the price at two other markets** (`get_best_price`) and the cost basis; a card showing 1c has been right (THEO-43, THEO-44) and wrong (THEO-AC). Deny if another market pays at least 40% of cost. Auto-approved sales happen at 40%+ of cost with a loss under `autoApproveFloorSaleMaxLoss`. | O decides |
| **Dead token** | `/admin` banner; `fatalAuthError` in the log; every call failing "agent token is from a previous server reset" | At the reset: wait for `ops_reset_watch` (about 5 minutes). If `needs_account_token` or stuck after 13:15: re-register the tenant, then the admin panel clean-up with the re-registered tenant **unchecked**. Mid-week (no reset): O re-registers. | O |
| **Reset recovery fails or hits a 429** | `ops_reset_watch.lastError` "status 429"; `apiResetDate` not moving at 13:10 | C: `curl -s https://api.spacetraders.io/v2/` (no token) to confirm the new `resetDate`; wait one more minute; then O uses the admin panel. | C then O |
| **Disk full** | "No space left on device" in the log; state snapshots not saved | O on the box: free the Postgres volume (`df -h`, old logs, the rolled `market_snapshots`). C: do not delete tables. Never during the wind-down: check at T-48 h. | O |
| **Tailwinds connection drops** (11-13 13:17-14:40) | Tool calls fail with 503; the lowercase server answers 401 | The fleet keeps trading. C: write "update not produced", retry every 10 minutes through the connector, do not use the lowercase server. Use Tower on the site (traders.cloutier.work) for a read. | C |
| **Keeper top-up stall** | top-up "last added" older than 90 minutes with uncovered markets listed (11-14: 2 h 24 min); `queue-idle` note missing | C: check `keeperTopUpMaxPending` (6), `autoKeeperProbes`, the cash line, the polling ceiling; `approve_upcoming` for the listed markets; read `ops_logs` for the `mcool/mslot/mother/mcov` notes. | C |
| **Tours starve staged systems** | "need a tour: no tour or explorer ship" for 60 minutes | C: send a free shuttle by `dispatch_tour`; then buy 2 explorer-frame hulls (0.67-0.88M) | C proposes, O approves the buy |
| **Gate waits on a ceiling** | the gate mission "yielding" with an ask 1-10% over the ceiling for 60 minutes and progress under 100% | C: `set_mission_pacing` `maxPriceBy` up by 30% (or to the hard stop in section 9); log the new number | C (with O's standing consent in decision 7.2) |
| **Cash-starved dispatch** | wallet under 150k, every route "-5,000/-10,000", traders waiting (11-10 14:30) | C: do not buy; `ops_pnl`; sell stranded cargo; leave the gate mission paused until the wallet is back over its floor | C |
| **Feed carrier is the command ship** | feeds list shows THEO-1; the command ship's sales stop | C: `remove_feed_carrier` THEO-1, `assign_feed_carrier` the intended ship; create feeds with `carrierTarget` 0 until the carrier is named | C |

---

## 6. The end-of-week wind-down (Reset B, 2026-11-22 13:00 UTC; and this week's close for Reset A)

**What counts.** The leaderboard ranks raw wallet credits at the end of the week. Hulls, keepers and cargo count for nothing; **cargo still aboard at the reset is destroyed, so it is worth less than nothing** (it was bought with credits).
Matched profit is the working measure all week; the wallet is the score at the end (62-65% of cumulative matched profit in both weeks; the rest is hulls, keepers, jumps, fuel and cargo bought).

### 6.1 When to stop buying

The rule: a hull is worth buying while (hours left) x (its hourly profit after its first hour) exceeds its price, because at the end it is worth nothing unless it can be scrapped.

| Class | Cost | Evidence of earnings | Payback | **Stop buying at (T minus)** |
|---|---|---|---|---|
| Bulk freighter | 3.0-4.1M | first hours 0.05-1.4M, typical 0.4-0.5M/h (bulks bought after hour 122 averaged about 0.45M/h) | 7-9 h plus the first hour | **10 h** (03:00 on the day of reset) |
| Light hauler, light shuttle (trader) | 85-360k | 44-160k/h | 3-8 h | **8 h** |
| Explorer-frame tour | 0.67-0.88M | keeps staged systems fed; indirect | n/a | **12 h** |
| Keeper probes and staging | 20-35k each | a release lifts profit per unit for about 2 h; keepers add price freshness | not measurable | **5 h** (also turn off `keeperTopUpPerHour` and hold `freshGate` staging) |
| Releases of already staged systems | free | the premium | | until the wind-down opens |

Two cheap safeguards: no purchase on the day of reset that needs a role card to be approved (a card left pending at 13:00 is a hull with no job), and no bulk purchase if the yard price was read more than 30 minutes before (prices step up 1-2% per buy).

### 6.2 The wind-down window and cargo

The clause `resetWindDown` blocks every new buy for its value in minutes before the reset (it is enabled; `windDown()` in `src/engine/resetWindDown.ts`; it blocks trades, feeds, missions, ship and probe buys, keeper purchases) and lets ships only sell what they hold; a trip already under way is **not** cut short.

| W (minutes) | Profit lost to idleness (at 10M/h, mean trip 9 min: rate x (W - mean/2)) | Cargo risk (trips longer than W) |
|---|---|---|
| 120 (current) | about 19M (last week measured about 16M at 8M/h) | none |
| 60 | about 9M | very low |
| 35 (recommended) | about 5M | a trip over 35 minutes at the cut-off loses its cost; not measured; the mean is 9 minutes (`ops_trade_tempo`, 20-24 trading ships, 11 trips started per 5 minutes) |
| 20 | about 2.6M | probably 2-3 ships a week, 1-3M each |

Measure the tail tomorrow at 11:00 from the ledger (for each SELL the preceding PURCHASE of the same ship and good): the 95th percentile of buy-to-sell time sets W for the week after (W = P95 + 5 minutes, between 25 and 60).
The silent ships in `ops_trade_tempo` (5-18 of about 30 per 5-minute bucket) are ships in a long flight or waiting; their tail is exactly what W must cover.

### 6.3 T-minus checklist for Reset B (all times UTC; T = 2026-11-22 13:00)

| T minus | Action | Tool | Note |
|---|---|---|---|
| T-72 h | Check disk, `ops_instances`, API budget; decide scrap policy (7.4); confirm `resetWindDown` 35; write the "end of week" journal entry stub | read tools | |
| T-48 h | Last chance for code deploys; **freeze at T-24 h** | | no deploys after T-24 h |
| T-24 h (11-21 13:00) | No deploys, no restarts. Doctrine changes only the ones in this list. Last explorer-frame/tour purchases by T-12 h. | | |
| T-12 h | Last tour/explorer buy. Park nothing, unpark nothing en masse (the 11-13 429 spike). | | |
| T-10 h (03:00) | Last bulk freighter (price read within 30 minutes; role card approved). | `buy_ship` | |
| T-8 h (05:00) | Last light hauler/shuttle. | `buy_ship` | |
| T-5 h (08:00) | Last keeper probes and new staging: `keeperTopUpPerHour` disabled; `freshGate` stays auto but `freshStagedAhead` 0 so nothing new stages. Releases of ready systems continue. | `set_doctrine` | |
| T-3 h (10:00) | Scrap pilot if not done earlier (6.5): 2 ships. Capture findings: `capture_findings`. | `sell_ship`, `ops_run_results` captureNow | |
| T-2 h (11:00) | Yards and holds read: `get_cargo_value` (cargo value and cost), `ops_trade_tempo`. Decide the scrap list. | | |
| T-60 min (12:00) | Final reads; operator and Claude both stop making changes except the items below. Journal entry. | | |
| **T-35 min (12:25)** | `resetWindDown` opens: no new buys. Keepers are not bought, feeds stop, the gate mission stops. Ships sell what they hold. | automatic | check `windDownState` in the log: "no new buys, selling what is held" |
| T-30 min | Check ships still buying (should be none): `ops_trade_tempo` `tripsStarted` falls to 0 by T-30. If a ship is still buying, find why before acting (the clause is per call site; the line numbers in `fleet.ts` use `buysBlocked`). | read | |
| T-20 min | **Scrapping run** (6.5) starts for hulls that already sit at a yard and have sold out. | `sell_ship` | |
| T-15 min | List loaded ships: `get_cargo_value`. For each ship still loaded with cargo worth over 200k and a market in its system: `trade_cargo` sell (accept a loss against destruction). Ships in transit with cargo: let them land. | `get_cargo_value`, `trade_cargo` | cargo at 13:00 is destroyed |
| T-10 min | Last cargo sweep; **no more commands** after T-5 min except scrapping. | | |
| T-5 min | Record the wallet: `get_cargo_value` (wallet), `ops_profit_curve` cumulative. | read | the final figure is the `run_results` row at about T+5 min |
| T | Reset. Do nothing. | | |
| T+1 to T+5 | Poll `ops_reset_watch` only (section 2). | | |

### 6.4 What NOT to do near the end

* **No redeploy or restart in the last 24 hours** (two on 11-14 reset Tower's history, re-ran probe-buy bursts, and left tours without destinations). A restart inside the window leaves traders loaded and the wind-down state recomputed.
* No `set_fleet_paused` (it stops sales too) and no mass `set_ship_role` (it interrupts whatever the ship was doing).
* No new contracts, feeds, missions, or gate missions in the last 6 hours; do not unpause anything.
* No parking or unparking of systems en masse (the 429 storm of 11-13).
* No hull or keeper purchases after the cutoffs, even "cheap" ones; every probe is a loss of the wallet.
* No approval of a `sellBelowFloor` card without checking two other markets; in the final hour a loss is better than destroyed cargo, but a 1c card on a 20k-per-unit good is probably a pricing artefact.
* No scrapping of keepers by hand (about 3 API calls each; 960 keepers is 2,900 calls; the box does 105 a minute and the traders need them). The engine's own scrap path is switched off (`FleetManager.WIND_DOWN_SCRAP` false) and untested since 10-25.
* No change to `resetWindDown` inside the window.

### 6.5 Hulls: scrapping

What `sell_ship` does: `stcommand_sell_ship` (`confirm=true`, irreversible) sends the ship to the **nearest shipyard in its system or one gate hop away** (`FleetManager.sellShip`) and scraps it for part of its price; if it is already docked at the yard waypoint it scraps at once. It releases the keeper station and takes the ship off the dispatcher.
**Measured refund:** three 85k light shuttles scrapped on 11-09 22:39-22:41 returned 57,492, 61,247 and 60,981 (68-72%). No bulk freighter, heavy hauler or probe has been scrapped in this record (the 10-18 and 10-25 wind-downs scrapped probes only; the operator disabled scrapping on 10-25 as "complex for little return" for 20k probes).

| Hull class | Count (11-14) | Refund at 68-72% (not measured for these) | Remaining earnings in the last 2 h | Net of scrapping at T-2 h | Verdict |
|---|---|---|---|---|---|
| Bulk freighter | 12 | 2.0-3.0M each, about 24-35M | 0.4-1.0M/h x 2 h = 1-2M | +1 to +2M each, about +12 to +24M | **Worth a pilot and then the whole class** if each ship can reach a yard in under an hour. Bulk yards are few (QP22, BT86, FR76, FB76, AF66 this week) and the ships roam 100+ systems. |
| Heavy freighter | 2 | about 1.9M each | 0.34M/h | +1.2M each | Same rule |
| Light hauler/shuttle trader | about 30-40 | 0.19-0.25M each | 0.05-0.16M/h | about +0.1M each | Only if already at a yard |
| Keeper probes | about 960 | 14-24k each, 14-23M in all | none at the very end | positive but needs 2,900 calls | **Not feasible by hand**; this is where the engine's disabled scrap path would be the tool |
| Parked hulls | about 600 | the engine never scraps parked ships | | | none |

The honest ceiling: the realistic gain is 10-25M (2-5% of the wallet) and it depends on one number (the bulk refund) that has never been measured. The decision is therefore a **pilot first**:

1. **This week, 11-15 about 10:00 (T-3 h):** scrap two ships that are already docked at a yard (a bulk freighter if one is, otherwise light haulers) with `sell_ship confirm=true`; read the ledger SHIP/SCRAP rows afterwards to get the refund percentage and the time. Cost about 1M of forgone trading for a bulk.
2. **Next week, T-2 h:** if the refund is at least 65%, scrap every bulk and heavy that can reach a yard in under 60 minutes, starting with the ones at the yard. Keep the ones that cannot trading to the wind-down. Order by (refund - remaining earnings).
3. Ships scrapped before the wind-down are removed from the dispatcher by `sell_ship`; do not scrap a loaded ship (its cargo is destroyed with it, and the 15-minute deadline in `windDownScrap.ts` is about the engine's path, which is off).

---

## 7. Decisions for the operator, with a recommendation each

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 7.1 | Set `resetWindDown` to 35 (from 120) **before 11:00 tomorrow** | **Yes, now.** | Last week's window cost about 16M; this week's would cost about 20M. |
| 7.2 | The gate: ceilings FAB_MATS 3,000 / ADVANCED_CIRCUITRY 6,000 at the start, 5,000 / 9,000 at 85%, no recovery wait or inflation guard, both materials from hour 1-2; Claude may raise a ceiling 30% when it blocks for 60 minutes | **Yes.** Standing consent to raise within the hard stop. | 5-13 hours of gate time this week (lessons items 3, 20); the material price saving was 20-40k at the end. |
| 7.3 | After the gate opens: suspend the 3M hull gate and the keeper line (`keeperAutoApproveMinCash` 500k, `systemReleaseMinCash` 500k) for 24 hours; wallet floor 1.0M after the first 4 haulers; traders:keepers not below 1:6; then back to 1.5M floor and 3M | **Yes.** | Hulls in the next 24 h 194/149/46 against profit 25.6/12.0/5.7M; this week's rule froze the exact hours that matter (post-gate plan item 4). |
| 7.4 | Scrapping hulls at the end | **Pilot two ships tomorrow at T-3 h; decide the bulk class at T-24 h of next week with the measured refund.** Keepers: no. | 10-25M possible, one unmeasured number. |
| 7.5 | First bulk freighter when wallet >= price + 1.5M (about 5M), not at 5M for a heavy | **Yes.** Bulk, one per yard per purchase, nearest the live cluster. Skip heavies. | The first bulk this week was bought at hour 98 with an 8.9M wallet; the wallet was 3.6-4.2M at hours 90-92. |
| 7.6 | Contracts | **One contract shuttle from 200k until the fleet makes 2M/h** (about hour 96), then off. | About equal to trading income before the gate (about 6M against 7.3M); 100k/h net after it. The operator's 11-13 rule is right for the plateau only. |
| 7.7 | A no-deploy freeze: from 22:00 today and from T-24 h next week | **Yes.** Any code change that is wanted (keeper-jump cooldown 9c, the disk check) waits for the week after. | Two restarts on 11-14; stalls and lost tour destinations. |
| 7.8 | `autoApproveFloorSaleMaxLoss` 600k -> 200k | **Yes** (a card then asks for losses between 200k and 600k at 40-100% of cost). | The -236k and -138k sales of 11-13/14 were sold without a card. |
| 7.9 | How many feed shuttles | **Two, only for inputs that are LIMITED or SCARCE, with loss allowances from the start; carriers pinned.** | Six shuttles this week earned nothing and were scrapped at 68-72%. |
| 7.10 | Gate-open target | **Hour 36 (par), hour 30 (stretch).** Do not starve the wallet below 2M at 85% to chase it. | The playbook's 18 is unreachable on cash (about 8M needed by hour 20 against about 4M of income). |
| 7.11 | A pre-gate warp-drive hull | **No** until one explorer yard is in the home system and the gate is 80% funded. | Untested; 0.67-0.88M per hull. |
| 7.12 | Restate the "neighbourhood idea" | Write it into `docs/TODO.md` item 9. | It exists only in a conversation. |
| 7.13 | Who owns the hourly report in the new week | Confirm at T+0:30 (section 4). | Scheduled tasks are session-bound. |

---

## 9. Narrowing the gap (the operator's question of 2026-11-14)

The question: we open the gate with too little money, and after it opens trading takes a day or more to get going; how do we narrow that, and how do we open the gate faster and still make money? The evidence is in lessons, section "The gate gap".
Short answer from the data: **the gap has three parts, and each has a different fix.**

1. Before the opening: the gate took 47-50 hours when the refill rate and the cash would allow about 33-36, because ceilings, a late circuitry start, blocked feeds, a stall and an early non-gate spend each ate hours. (Fixes G1-G4: 7-20 hours of the 47.)
2. At the opening: the wallet is 0.5-1.3M because the gate costs about 5M and pre-gate income is about 7M plus contracts. (G4, G7.)
3. After the opening: the ramp to 5M/h took about 60 hours in both weeks, driven by how fast the little cash becomes selling hulls and live systems (194/149/46 hulls in the first 24 h; profit 25.6/12.0/5.7M). (G5, G6.)

### 9.1 Options, with estimates

Hours saved are against this week (gate at hour 47.2, 5M/h at +60 h). The estimates are mine, from the figures cited; the "hours saved" are not additive and carry the confidence shown.

| # | Option | Hours saved | Forgone trading income | Risks | Keys and tools | Confidence |
|---|---|---|---|---|---|---|
| G1 | **Ceilings that move**: FAB_MATS 3,000, ADVANCED_CIRCUITRY 6,000 at the start; to 5,000 / 9,000 at 85% (hard stop); `maxInflationPct` 1000; no `recoverPct` | **5-13** to the opening (hours 43-47 alone were about 5; mission "yielding" in hours 7-12, 14-23, 29-33) | none (the home earns about 0.1M/h whatever the gate does) | Pays more per unit: roughly +10-20% on the 25% of units bought near the ceiling, 0.3-1M in all; a spike like last week's circuitry 14,392 (cap 9,000) | `set_mission_pacing` (`maxPriceBy`, `maxInflationPct`, `recoverPct`, `buyLotUnitsBy`, `yieldToTrading`), `start_mission`, template tasks `o4-gatemission`, `o4-finalpush` | Moderate-high for the end (the ask vs ceiling gap is observed); moderate for the early hours |
| G2 | **Circuitry in parallel from hour 1-2** (not hour 12) | **0-8** (circuitry was the limiter: 400 at hour 47 against FAB_MATS at 39) | circuitry is about 1.7M of cash brought forward; the same cash would have funded hulls that earned nothing pre-gate | Circuitry's price climbs fast with 20-unit lots (3.7k -> 14.4k in the 11-01 week); mitigate with lots of 20 and the 6,000 ceiling to start | `buyLotUnitsBy` ADVANCED_CIRCUITRY 20, `maxPriceBy`; feed ELECTRONICS and MICROPROCESSORS if the data shows the producer starved | Moderate |
| G3 | **Feeds into the FAB_MATS producer from hour 1-2, with loss allowances (IRON 40, COPPER 30, SILICON 10, QUARTZ_SAND 10), only for inputs LIMITED/SCARCE, 2 shuttles** | **0-4** (FAB_MATS at about 52 an hour with feeds against about 35 an hour in the 20 hours they were blocked: 1,600/52 = 31 h against 39 h) | 2 shuttles (170k) at 68-72% scrap value; allowances under 0.1M | Unproven: asks stayed 2,200-4,700 with feeds; a feed pulls the command ship if not pinned | `start_feed`, `set_feed_limits`, `assign_feed_carrier`, `stcommand_get_chain_health` | **Low**: confounded by the ceiling changes |
| G4 | **Spend only on the gate, the contract shuttle, one gate hauler, 2 feed shuttles and chain keepers until the opening** (this week: 12 hand keepers at hour 4, 3 shuttles, 4 more shuttles at hour 6, 6 shuttles sold: about 1.1M of non-gate spend by hour 6, and a third of the pre-gate income) | **1-3** to the opening, **plus about 1M more cash at the opening** | none (those hulls earned nothing pre-gate; the home market saturates at about 100-250k/h from hour 6) | If a hull is refused, the traders may idle; the home is thin (8 routes, 50 of 74 legs unprofitable) | the template (`o4-yardkeep` only on the shipyards; no `o4-topkeep`), `cancel_opening_task`, `park_ship` for extra hulls | High that nothing is lost; moderate on the hours |
| G5 | **Spend every hour for 24 hours after the opening**: suspend the 3M hull gate and the keeper line (500k / 500k); traders:keepers at least 1:6; wallet floor 1.0M | **10-25** off the ramp (an upper bound from the compounding model below; 194/149/46 hulls in 24 h gave 25.6/12.0/5.7M) | the wallet earns nothing while it sits (this week 3-5M sat for 11 hours at hours 68-79) | Over-buying keepers before traders (11-10: 53 intel hulls for 9 traders); cash-starved traders (the heavy hauling 56k loads at a 0.66M wallet) | `keeperAutoApproveMinCash`, `systemReleaseMinCash`, `approve_upcoming`, `buy_ship`, `stage_system` | Moderate (three weeks, a strong correlation, not proof) |
| G6 | **Pre-position for the opening**: two shuttles (the finished feed carriers) docked at the gate waypoint at 95% so `jump_ship` fires the minute it opens (not `dispatch_tour`, which scouts the home system first and cost 7 minutes this week); the best two systems from `ops_systems_candidates` picked from the public market lists; `stage_system` them the minute the gate opens | **0.5-1** (the first tour was in at +8 minutes, the first release at +40; the next ones waited on cash) | none | Staging was blocked by a closed gate in the 11-01 week (not re-tested); the linked systems are unsurveyed (0 markets known) before the opening | `jump_ship`, `stage_system`, `release_system`, `hold_system`, `ops_systems_candidates`, `ops_system_queue` | Moderate |
| G7 | **A reserve at the opening** (wallet at 85% >= 2M, at the opening >= 1.2M) | see 9.2: net **positive** only when it comes from G4, not from delaying the gate | each 1M held back delays the gate by about 4 hours (pre-gate income about 0.25M/h incl. contracts) | The gate is the larger prize; do not hoard | `cashFloor` on the gate mission; `o4-finalpush` | Low-moderate |
| G8 | **A second contract shuttle** | unknown | an 85-130k ship | Contracts come one at a time; the second may have nothing to do | `set_contract_duty`, `ops_contract_money` | **Cannot tell**: measure with `ops_contract_money` in the first 12 hours |
| G9 | **Warp-drive hull to open an adjacent system before the gate is complete** | unknown | 0.67-0.88M per hull | Not shown to work; 40-hold; fuel; cargo cannot come back for free | `dispatch_tour` (warpTours doctrine key 1), yard scan `ops_yard_scan` | **Cannot tell**; do not do it in the first week it is mentioned |

### 9.2 Break-even: gate materials against early hulls, and how much cash the gate crew needs

**The gate crew's cash.** The gate costs about 5M in materials (FAB_MATS about 1,600 x 3k and circuitry 400 x 4.5k) plus 0.3-1M of feeds and carriers; pre-gate income was about 7M of matched profit plus about 6M of contracts this week (contracts estimated from the hourly updates).
A crew of one light hauler (273k) and the contract shuttle is enough: the gate buys in lots of 20-80 units (about 90-300k a lot at the early prices), at most one lot every 15-30 minutes. **It needs about 0.4-0.6M on hand at any time, and about 0.9-1.2M in the last 15% when lots are priced at 4-5k.**

**A hull before the gate against the gate.** A pre-gate light hauler (315k) earns at most about 20k an hour on the saturated home market (profit per unit 100-150, 4-8 selling ships earning 60-140k/h together), a payback of 16 hours or more, and it can be bought just as well at the opening. The same 315k delays the gate by about 1.3 hours (at 0.25M/h of pre-gate income),
and an hour of the opening is worth up to the plateau rate if the ramp is only shifted (a bound of 5-10M). **So nothing but the gate, the contract shuttle, the hauler and the feed shuttles is bought before the opening.**

**Cash at the opening against the opening hour (a model).** The profit rate rose by a factor of 20 in 39 hours (0.25M/h at hour 68 to 5M/h at hour 107), an e-fold of about 13 hours. If the ramp time scales with log(target capital / starting capital), then ΔK extra at the opening saves about 13 x ln((0.77 + ΔK)/0.77) hours:

| Extra cash at the opening ΔK | Hours saved on the ramp | Gate delay to earn it at 0.25M/h | Net |
|---|---|---|---|
| 1M | 10.8 | 4 | +6.8 |
| 2M | 16.6 | 8 | +8.6 |
| 3M | 20.6 | 12 | +8.6 |

The net is positive and flat from 2M, and the whole model rests on one week's curve; so **the rule is: take the extra cash from G4 (about 1M is free), do not delay the gate to hoard, and spend the first 24 hours after the opening (G5)**. That is a model, not a result: the correlation between the first-24-hours hull count and profit (three weeks) is the only direct evidence.

### 9.3 What the fleet does with its money while the gate is closed

| Question | Data | Reading |
|---|---|---|
| What does trading earn before the gate? | home profit per hour, hours 8-47: 0.11M (W2), 0.14M (W1); the first 5-6 hours 0.3-0.5M/h from the command ship alone; contracts another 0.1-0.2M/h; the market saturates (profit per unit 1,635-1,998 at hour 0-1, 100-150 by hour 10, 42-77 on day 2) | Pre-gate hulls beyond THEO-1 and one contract shuttle earn almost nothing. |
| What does the gate unlock? | 0.5M/h at +12 to +28 h, 1M/h at +27 to +36 h, 5M/h at +60 h; the first 6 hours after the opening paid about 3-4 times the profit per unit of the last pre-gate hours (premium of the first release: AR37 429 a unit, BY84 319-726) | Every hour of the gate is worth the ramp, not the pre-gate rate. |
| Can the first day run without the gate? | Days 1-2 in both weeks made 6.1-6.5M in 48 hours: 4-5M in the first 24 h, 1-2M in the second. | The first 6 hours are the only worthwhile home hours; after that the gate is the only exit for ships without a warp drive. The crawler marked 7,027 of 7,033 systems "no known gate path" until the gate opened. |
| Does the home system plus the adjacent systems yield more without the gate? | The adjacent systems are not reachable without the gate (or a warp-capable hull). | Not testable on this data. |

### 9.4 Can any of the ramp happen before the opening?

| Item | Possible before the gate? | Evidence |
|---|---|---|
| Keepers on the chain markets and the shipyards at home | Yes, and needed (the pacing reads those prices) | v3/v4 template |
| Keepers on other home markets | Allowed but pointless: the home saturates at 100-250k/h and 3 hours of keeper-heavy spend this week produced nothing | journal 11-08 17:25 vs 18:15 |
| Tours and price discovery in the home system | Done in the first hour by THEO-1 | |
| Price discovery in the 5 linked systems | **Goods lists come from the public market lists without a ship** (F53's exports were read that way at 16:48 on 11-08); **prices need a ship in the system** (VN83 was priced 56 minutes after a tour arrived) | journal |
| Staging systems and buying their keepers | **No** (a closed home gate stops staging, 11-03 note, not re-tested here); pick the targets in advance from `ops_systems_candidates` | CHANGELOG 2026-11-03 |
| Hulls docked at the gate for the opening | Yes: G6 | |
| The queue of systems released in the first hours | The first system opened 40 minutes after the gate this week (AR37 at 12:58); the second needed cash (gate staging at 1M) | journal 11-10 |

### 9.5 Proposed gate target timeline, with go/no-go checks

(Hours from T. Checkpoints for FAB_MATS / ADVANCED_CIRCUITRY delivered. W2 means this week at the same hour.)

| Hour | Target | Go check | If no-go |
|---|---|---|---|
| 0.25 | Ceilings set 3,000 / 6,000, mission paused, lots 40 / 20, no guards | `get_missions` shows them | fix by `set_mission_pacing` |
| 1-3 | Unpause when the gate hauler exists; first lots of both materials; feeds started (2 shuttles, allowances) | FAB_MATS >= 40, circuitry >= 20 by hour 3 (W2: 80 / 0 at hour 4-5) | check ask vs ceiling; raise 30% |
| 6 | 150 / 40; wallet >= 0.3M | W2: 160 / 0 | do not buy keepers or shuttles; raise the circuitry ceiling to 7,000 |
| 12 | **450 / 120** (W2: 406 / 0 at hour 11) | | raise ceilings 30% (FAB_MATS 4,000, circuitry 8,000) |
| 18 | 750 / 180 | | |
| 24 | **1,050 / 250** (W2: 866 / 160) | wallet >= 0.5M | If FAB < 700 or circuitry < 150, the gate will open after hour 48: accept par and resume buying the playbook hulls (G5 rules) from hour 30; do not freeze |
| 28-30 | 85% (1,360 / 340): `o4-finalpush` fires: ceilings 5,000 / 9,000, gate cash floor 0 | wallet >= 2M | if under 1M, delay the final push by one hour rather than starting the post-gate week at 86k |
| 32 | 1,500 / 340-360 | | send 2 shuttles to the gate waypoint |
| **34-36** | **Open** (W2: 47.2; W1: 50.5) | `get_gate_status` complete; wallet >= 1.2M | |
| +0:00 | `jump_ship` tours into the 5 linked systems; `stage_system` the 2 best | `ops_system_queue` | |
| +0:40 | First release; second at +1:15 | | `release_system` by hand; `hold_system` to stop an unwanted one |
| +1 to +24 | Spend every hour (G5): 4 hulls an hour, 80-100 hulls in 24 h, profit 0.5M/h by +12 h and 1M/h by +24-36 h | | |

The value of the timeline: at hour 36 against 47.2 the whole week's curve shifts 11 hours earlier, 11 hours at the plateau rate (8-11M) is the stretch column's extra 50-100M; the plateau is capped by keepers and the API budget, so treat 30-60M as the realistic gain.

---

## 10. Things I could not verify

| Item | Why it matters | How to check |
|---|---|---|
| Whether `add_opening_template` replaces id 6 when the name repeats | The v4 changes may not apply | read `get_opening_templates` after saving; read `get_opening_tasks` at T+0:07 |
| The scrap refund for bulk freighters, heavies and haulers | 10-25M | the 11-15 10:00 pilot |
| Whether a warp-drive hull can trade in a linked system before the gate is complete | G9 | not tested |
| The tail of buy-to-sell time (P95) | the wind-down length | the ledger query in 6.2 |
| The box's free disk | a full disk during the wind-down | `df -h` on the box |
| The gate cost (about 5M) from a ledger sum; the pre-gate contract income (about 6M) | the break-even in 9.2 | `ops_ledger` PURCHASE rows tagged to the gate; `ops_contract_money` |
| Whether staging is blocked by a closed gate in the current code | G6 | `stage_system` on the first day (read-only attempt with `ops_system_queue`) |
| Whether the hourly scheduled task survives the reset | section 4 | `list_triggers` at T+0:30 |
| Webshare account state and IP authorization of the box | the proxy lanes | `mcp__Wenshare__list_ip_authorizations`, `get_plan` (not called here) |
| Whether the next week's gate needs the same materials (FAB_MATS 1,600, ADVANCED_CIRCUITRY 400, QUANTUM_STABILIZERS done on 11-08; different on 11-01? it also needed 1,600 / 400) | the checkpoint table | `get_gate_status` at T+0:10 |
| The number of traders, hulls by class and the keeper roles on 11-14 (the journal says 1,621 ships; roles not re-read) | targets | `get_fleet_status` (large output) |
| The hourly figures in the lessons doc for hours 0-12 of last week use the ledger buckets; the day boundaries are UTC calendar days | none | |
| Whether `resetWindDown` also blocks the engine's role cards and keeper approvals the operator makes by hand | the last hour | the log line "wind-down" |
