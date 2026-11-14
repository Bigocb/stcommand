# 05. Milestones and build order

Five milestones, M0 to M4. Each has: scope, ordered tasks (each task is one reviewable change), acceptance criteria, and
what must NOT be built yet. Do not start the next milestone until the current one's acceptance passes and the evidence
(a short `docs/milestones/Mx-report.md` with numbers) is committed.

Mapping to the design plan's milestones (design plan section 6):

| This plan | Covers design milestone(s) | Note |
|---|---|---|
| Scaffolding (01, S1-S8) | none | prerequisite |
| M0 shadow | design M0 (recorder, store, replay, sim v0) + part of M1 (Observer, Budget Scheduler, MarketModel, OpportunityFinder, RiskGuard in advisory) + reset detection (part of M2) | decisions are logged, never executed |
| M1 single ship | design M1 (safe trader, O-01..O-04, T rules, X rules, B-01..B-04) | live money, one ship |
| M2 small fleet | design M1 remainder + G-10/G-11 + reservations | 3-10 traders; no hull purchases |
| M3 scaling and purchases | design M3 (opening, contracts, purchase planner), M4 (keepers), M5 (gate) as separate slices | each slice has its own acceptance; slices ship one at a time |
| M4 reset handling | design M2 (register, bootstrap, archive) + W rules from M7 | the first real reset is Sunday 2026-11-22 13:00 UTC |
| Backlog after M4 | design M6 (expansion), M7 (calibration/A-B), M8 (scale-out) | not planned in detail here |

Calendar context: the live stcommand fleet resets 2026-11-15 13:00 UTC and again 2026-11-22 13:00 UTC. Shadow mode may start at any
time during the week of 11-15 (registration works any time after the reset; there is no need to be ready by 13:00 on 11-15).
Suggested schedule for one implementer: scaffolding 1 day; M0 2-4 days (can run live from day 2 or 3 of the week); M1 and M2
on the week of 11-22; M3 and M4 later. The first reset the engine must survive autonomously is 2026-11-22 13:00 UTC only if M4
is finished; otherwise the operator re-registers by hand (documented in the runbook) and nothing is lost but time.

---------------------------------------------------------------------------------------------------

## M0. Read-only shadow mode (records and "would do" decisions)

### Scope
Everything that runs with ZERO risk: a registered agent on its own IP issues only GET requests (plus the registration POST),
records every response, maintains the market model, runs the full decision loop and logs what it WOULD do, scores those
would-have decisions on a paper ledger, detects resets, and exposes a read-only status. No mutating game call exists in
the shadow code path (type-level and runtime guard).

### Tasks (in order)

| # | Task | Details | Tests |
|---|---|---|---|
| M0-1 | Domain types and events | Exactly the types in 02 sections 2 and 4 | type tests; `events` JSON round-trip |
| M0-2 | Store | Migrations 001-003, `Store`, projections, single-writer lock, `rebuildProjections()`, FIFO lot matching | unit + integration (two processes) + rebuild equality property test |
| M0-3 | API facts and schemas | Fetch the public SpaceTraders v2 docs (operator-permitted manual step, not automated), write `docs/api-facts.md` with each (A) item answered: status endpoint fields, register body, market/shipyard fields and whether a ship must be present, navigate/dock/refuel/trade response fields (do trade responses carry post-trade prices? A3), error body shape, pagination limits, rate-limit headers, hull type symbols. Then write `schemas.ts` (zod) from captured sample responses stored under `tests/fixtures/api/` | schema tests against fixtures; every (A) in 03 has an answer or an OPEN QUESTION |
| M0-4 | Clock, client, limiter, budget | 03 sections 4 and 5; `ReadOnlyApi`; proxy agent; header capture | limiter property tests; fake-clock tests; 429 tests against the fake server (needs M0-8 minimal) |
| M0-5 | Recorder | 03 section 7, NDJSON with rotation, secret stripping, disk-space guard | recorder test: no token in output |
| M0-6 | Observer and snapshot | API payload -> events -> `Snapshot`; outlier guard X-10 | replay of fixtures builds an identical snapshot twice |
| M0-7 | Core modules v1 (advisory) | `marketModel`, `travel`, `opportunity`, `allocator`, `winddown`, `risk`, `decide`; no purchase planner yet | unit tests per module; policy-off no-op; reasons present |
| M0-8 | Fake API server v0 | `sim/fakeApi` with the endpoints used by M0 (status, agent, ships, waypoints, market, shipyard, jump-gate) and fault injection (429, timeout, 5xx, dead token) | used by M0-4 tests |
| M0-9 | Reset watcher and process FSM (detect + freeze + archive; NOT register) | 03 section 6 states LIVE -> RESET_DETECTED -> FREEZE -> ARCHIVE then a clean "waiting for operator" stop; auto-register is M4 | chaos test: scripted reset mid-run |
| M0-10 | ShadowExecutor and paper ledger | 07 sections 3-4; `paper.trade` events; `would_do` log | paper ledger unit tests with hand-computed fixtures |
| M0-11 | Intel gathering without trading | Shadow mode still needs prices: the shadow agent's own ships tour markets within the budget (read-only means no navigate!). See OPEN QUESTION Q-SHADOW-INTEL below: in strict read-only mode the agent can only read what its ships are already positioned at; so M0 supports the import feed (07 section 4) as the primary price source | feed import test |
| M0-12 | CLI `shadow`, `record`, `doctor`, `report` | `shadow` runs scheduler + ShadowExecutor + recorder + status server; `doctor` checks env, proxy/IP, disk, clock skew, schema; `report` prints the shadow KPIs (07) | smoke test against the fake server |
| M0-13 | Status endpoint + alerts file | 02 section 10 | HTTP test |
| M0-14 | Runbook and first live shadow run | `docs/runbook.md`: start, stop, what to read, how to hand the data to the comparison (07). Run live for at least 6 hours, then 24 hours | acceptance below |

OPEN QUESTION Q-SHADOW-INTEL: "read-only" and "learns prices" are in tension, because market prices are only visible where
the agent has a ship (A), and moving a ship is a mutating call. Three options, in increasing risk: (1) PASSIVE: the agent's start ships sit where they spawn (the
home waypoint) and only that market is read; plus an operator-supplied NDJSON import of the live fleet's market snapshots (read-only export from stcommand,
no API cost; the operator must agree to supply it). (2) ACTIVE-LIGHT: the shadow agent is allowed `orbit/dock/navigate` for ITS OWN
probe/command ship only, to tour home markets (mutating calls that cost nothing but fuel and affect only STAR's own agent, never the live fleet). (3) FULL: as M1.
This plan's default for M0 is (1) with option (2) available behind `shadow.allowOwnShipTour: true` (requires an explicit operator
decision because it changes "read-only" to "touches only its own agent"). Everything in M0's acceptance works under (1).

### M0 acceptance criteria (all must hold; evidence in `docs/milestones/M0-report.md`)

1. `npm run check` is green and CI is green.
2. Shadow mode ran live for at least 24 consecutive hours (or from a start time to the reset, whichever is shorter, minimum 6 h) with: 0 mutating requests (verified by `SELECT COUNT(*) FROM api_calls WHERE method != 'GET'` returning only the single allowed registration calls), 429 ratio under 2% of calls, `maxCallsPerMinute` never exceeded in any 60 s window (query over `api_calls`; this is the proof of the hard budget), and the egress IP check passed at start.
3. The recorder wrote a continuous recording with no token in any line (a scan test over the files) and no gaps over 10 minutes; recorded markets cover at least 90% of the markets the agent could legally read.
4. Every `decision` and `skip` event has a non-empty reason; the silent-skip detector reports 0 (design metric: silent-skip count target 0).
5. Determinism: replaying the recording through the pure core twice produces byte-identical decision logs (`tests/replay`), and the fixed sample in `recordings/sample/` runs in CI.
6. The paper ledger produced at least 30 would-have trades with confidence `verified` (a later observation of the sink market exists), and `report` prints matched paper profit per hour, calls per paper profit, and the share of `unverified` trades.
7. Reset detection: in a scripted fake-server test and in a forced test (point the watcher at a fake status that changes date) the FSM reaches ARCHIVE and stops cleanly; on the real reset (if M0 is running at 2026-11-22 13:00 UTC) the dead-token latch triggered within 2 poll intervals and no call was sent after the latch except status polls.
8. The simulator v0 starts and the sim smoke test finishes in under 5 minutes (design M0 criterion) even if calibration is unfinished.
9. All (A) items in `03` and `02` are answered or listed as OPEN QUESTIONS with a captured sample.

### Do not build in M0
Any mutating call outside registration; purchases; contracts; gate; keepers; expansion; calibration loop.

---------------------------------------------------------------------------------------------------

## M1. A single ship trading (live money, tiny)

### Scope
Autonomy level 1 ("safe trader"): the command ship trades one route at a time with all T, M, X and B rules; no hull purchases;
no contracts; the kill switch and spend caps exist and have been tested; the process survives forced restarts.

### Tasks

| # | Task | Details | Tests |
|---|---|---|---|
| M1-1 | Full API wrappers (mutating) | orbit, dock, navigate, jump, refuel, buy, sell with schemas; `FullApi` | fake-server contract tests |
| M1-2 | Fake API server v1 | all mutating endpoints, wallet, cargo, fuel, arrival times, market physics (the simulator core, 06 section 5) | server self-tests |
| M1-3 | Ship worker FSM | 02 section 8; state machine with refuel, orbit/dock sequencing, arrival-time sleep, X-05 refresh | FSM tests incl. every ERROR path |
| M1-4 | LiveExecutor | intents with idempotency, read-before-retry, risk review at send time (02 section 7) | chaos tests (timeout after success, 429, duplicate) |
| M1-5 | Opening v1 (O-01..O-04, O-11, O-12) | bootstrap reads, command ship tours until `minRoutes` routes (using navigate) then trades, lot cap 0.6 x tv, max 40 units | sim scenario "opening" |
| M1-6 | Matched-profit ledger | `recordBuy/recordSell`, FIFO, trips table, `trip.planned/closed`, planned-vs-realised | property tests |
| M1-7 | Kill switch, caps, autonomy levels | 08 sections 2-3; file flag, SIGUSR1/SIGTERM handling, status endpoint shows state | tests: kill flag stops new intents within one tick; open trips are finished or held per policy `onKill` |
| M1-8 | Restart safety | 03 section 6.3 reconcile; clean-shutdown flag | forced-kill integration test (kill -9 mid-trade, restart, no duplicate buy, cargo known) |
| M1-9 | Live checklist run | 08 section 4 checklist; autonomy 1 for the first 2 hours with the operator watching, then unattended | acceptance |

### M1 acceptance criteria
1. Single-ship trading on a live week: positive matched profit over at least 12 hours; wallet never below start minus 10%; zero single-trade losses over 150,000 (X-01); zero duplicate intents rejected as bugs (rejections are logged and counted, but a duplicate that reached the API is a failure).
2. 429 rate under 1% of calls; hard per-minute cap never exceeded (query as in M0); utilisation under 0.92 sustained.
3. Survives a forced restart mid-trade (kill -9 during AT_SELL and during TO_BUY): after restart no duplicated buy/sell, the cargo and cost-basis lots reconcile with the API's cargo (a startup reconciliation check compares), and the trip completes or aborts with a logged reason.
4. Every skip and veto is logged; the E-11/X-14 watchdog fired correctly in a sim stall test.
5. The kill switch demonstrably stops new trades within one tick in a live test (operator present), and `autonomy` returns to 0 on a simulated drawdown over `maxDrawdownPct`.
6. The shadow comparison (07) for the same window shows the live decisions agree with what shadow would have chosen at least 80% of the time (sanity of the shadow loop; not a profit claim).

### Do not build in M1
Hull purchases, contracts, gate, keepers, expansion, multi-ship allocation beyond one ship, A/B experiments.

---------------------------------------------------------------------------------------------------

## M2. A small fleet (3-10 traders; still no hull purchases)

### Scope
The fleet the engine starts with plus any hull the OPERATOR buys by hand (STAR detects and adopts new ships automatically
from `listShips`). Route reservations, pacing, cooling, idle reallocation, API capacity accounting. Still no autonomous
hull purchases.

### Tasks
| # | Task | Details | Tests |
|---|---|---|---|
| M2-1 | Allocator with reservations | 04 section 5, T-09 sink share, hysteresis | property tests: reservations never exceed depth share |
| M2-2 | Pacing and cooling | T-07, T-08, M-04, M-05 impact refit | sim tests with the crash scenario: no more than 1 load per recovery window |
| M2-3 | Adopt new ships | `observation.ship` for unknown ships creates `ships` rows; class by hull type; policy `adoptManualShips` | integration |
| M2-4 | Idle reallocation | G-10 | sim |
| M2-5 | Capacity accounting | 03 section 5.4 `maxShips` and the hull class payback table prepared for M3 | unit |
| M2-6 | Fault matrix hardening | 06 chaos suite: 429 storm, timeouts after success, stale snapshot, proxy down, reset mid-run | chaos |
| M2-7 | Calibration recorder | `trip.planned` vs `trip.closed`, per-route-class multiplier kept as DATA (weight 0, not used) | calibration reducer tests |
| M2-8 | Metrics and report | `report` for the weekly KPIs (07 section 5) | fixture-based |

### M2 acceptance criteria
1. 3-10 traders for at least 24 hours: positive matched profit; profit per ship-hour within the shadow estimate's 40% (a rough check); idle trader fraction under 20% averaged over the run.
2. No more than one load per (route, recovery window) per the pacing rule; no sink where our reserved units exceed the depth share; cooling events fire in the crash scenario.
3. 429 ratio under 1% at the hard cap with 10 ships; calls per profit unit reported; `maxShips` formula matches observed calls per trip within 25%.
4. Zero X-01 events (a loss over 150k); at most one X-02 circuit-breaker (and if one fires the log explains why).
5. A forced restart with 10 ships in flight is survived with no duplicate buys (extended M1 test).

---------------------------------------------------------------------------------------------------

## M3. Scaling and ship purchases (slices, shipped one at a time)

Each slice is behind its own policy switch and starts in advisory mode (logs `would_buy`) for at least one week of shadow
evidence before autonomy 2 enables it. The operator must explicitly turn each slice on (08 section 3).

### Slice M3-A: purchase planner (cash discipline, nearest yard, payback, escape clause)
Tasks: `purchase.ts` per 04 section 6; yard observation maintenance (G-03 refresh read before buy); `buyShip` live path with intent idempotency and read-before-retry (the 2026-10-08 double-buy lesson); yard price creep tracking (store price after each purchase to learn the 0.6-2% step); hull payback realised-vs-planned tracking; spend caps.
Acceptance:
1. In sim: reaches 3M by hour <= 36 on the calibrated scenario (design M3 floor) and day-1 profit >= 0.1M/h; buys at the nearest yard (a test where the cheapest yard is 2 hops away must choose the closer one when `price + hops*jumpCost` says so, with the reason line).
2. The escape clause fires in a stalled-growth sim and does not fire when the wallet is cash-starved (the 86k case).
3. No purchase is ever issued twice (duplicate key test), none below the floors, none above `maxSpendPerPurchase`, none inside the wind-down windows.
4. Live: the first autonomous purchase happens only with the operator present (08 checklist), with `maxSpendPerPurchase` at the operator's cap; realised payback of the first three hulls is logged against plan.

### Slice M3-B: opening and contracts (O-05..O-08, C-06, C-07)
Acceptance (design): one contract at a time, never paused early, declined early when infeasible; contract stop rule at fleet rate above `contractIrrelevantRate`; net >= `minNet`; a shuttle bought for contracts at 200k wallet only if the policy allows.

### Slice M3-C: keepers and coverage (K rules, B-05, B-06)
Acceptance (design M4): keeper coverage of the top-20 markets >= 90% fresh (< 45 minutes); API utilisation stays between 70% and 92%; a keeper is never bought below the keeper cash gate; parking and recheck work; no mass unparking (stagger unparks, max N per 5 minutes: the lessons' 11-system unpark caused a 429 spike).

### Slice M3-D: gate (C-01..C-05; design M5)
Acceptance: completes the gate by hour <= 72 in a live week (floor; par 47; target 36); no price above the hard stops; the latch test passes (a failed read never un-completes it); ceilings lift at 85%; both materials start in the first 2 hours; feeds carry loss allowances and pinned carriers; the command ship is never auto-staffed as a feed carrier.

### M3 global acceptance
Day-5 matched profit rate >= the floor of the design table (0.8M/h) in a live week OR the shadow/sim evidence plus the operator's go; zero duplicate purchases; zero X-01 events; wallet at the reset within 1% of equity (W rules: no cargo left).

---------------------------------------------------------------------------------------------------

## M4. Reset handling (full autonomy across a weekly reset)

### Scope
Detect the reset, freeze, archive, register a new agent, bootstrap the new galaxy, run the opening, with no human step beyond supplying credentials (design goal 3); wind-down rules active in the final day.

### Tasks
| # | Task | Details | Tests |
|---|---|---|---|
| M4-1 | Registration | 03 section 6.2 REGISTER with retries/suffixed callsign, secret file, new week file | fake-server reset scenarios |
| M4-2 | Bootstrap v2 | home system, markets in priority order, shipyards, gate waypoint, BOM read; 250-call budget; recorder restart | scenario |
| M4-3 | Archive and cross-week data | `week_summary`, `rule_stats`, `policy_versions`; the new week starts with last week's POLICY but empty beliefs | tests |
| M4-4 | Wind-down in live | W-01..W-07, noNewBuys window by P95 (Δ1), cargo sweep, final snapshot at T-5 min | sim week test with a reset at the end: final wallet >= wallet at T-35 min minus tolerance |
| M4-5 | Reset rehearsal | A 3-hour rehearsal against the fake server that simulates: 429 on the status poll at T, registration failure then success, a second reset during bootstrap | chaos |
| M4-6 | Runbook | reset day checklist; the manual fallback (re-register by hand and `star bootstrap --week ...`) | review |

### M4 acceptance criteria
1. Passes the recorded/mocked reset rehearsal (design M2): FSM states traversed in order, each with a `state.transition` event; no call to the agent API after the latch except status polls.
2. On a REAL reset: autonomous trading (first live trade intent executed or, if autonomy 0, first would-do) within 30 minutes of the reset with no human step; the previous week's archive is complete (`week_summary`, `final_credits` from the last known wallet).
3. In the final 35 minutes before a reset (live or sim): no buys; all reachable cargo is sold; no loaded ship sits idle with cargo it could sell; the final wallet is recorded.
4. A registration that fails (account token expired) produces a critical alert within 60 seconds and keeps polling; never a tight loop (max 1 register call per minute, asserted in the chaos test).

### Do not build in M4
Expansion, calibration loop, A/B framework, multi-IP lanes (all post-M4).

---------------------------------------------------------------------------------------------------

## Cross-milestone rules
1. Keep the stcommand lesson: read state before acting, and before any retry. Re-issuing "to make sure it took" is a bug.
2. No deploys or restarts in the last 24 hours before a reset except emergencies (lesson: two restarts reset history and re-ran bursts).
3. Each milestone report lists: acceptance numbers, open questions answered, new open questions, deviations from this plan with ADR links.
4. Evidence beats assertion: every claim in a report cites a query (SQL in `docs/queries.sql`) that reproduces it.
5. If a milestone's acceptance cannot be met, STOP and write down why; do not proceed to autonomy with a known gap.

## Backlog after M4 (for orientation only)
Expansion pipeline (E rules) and fresh-system premiums (1.7x for ~2-8 h); keeper rotation economics at scale; A/B framework and
calibration multiplier (weight 0 until proven in 2 weeks); Hungarian assignment; multi-IP lane pool; mining/siphoning if the model says so; webhooks for alerts; a
tuned simulator calibrated to recorded weeks.
