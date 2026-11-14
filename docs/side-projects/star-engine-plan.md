# STAR Engine: an autonomous, LLM-free SpaceTraders player (design plan)

Status: plan only, no code. Written from a lessons digest plus the public SpaceTraders v2 API; the public docs were NOT
re-fetched for this draft, so every API shape claim is marked (A) = assumption to verify in M0.
Name "STAR" = SpaceTraders Autonomous Runner (placeholder).

---------------------------------------------------------------------------------------------------

## 1. Goals, non-goals, what "good" means

### Goals
1. Maximise **final wallet credits at the weekly reset** (the leaderboard metric). Working measure during the week:
   **matched profit** (realized profit on completed sells vs tracked cost basis) plus **wallet + holds** (cargo valued at
   expected fetch) as a smooth equity curve. Wallet delta alone is never used to judge a rule.
2. Run fully autonomously with **no LLM in the loop**: deterministic rules, numeric models, logged reasons.
3. Survive the weekly reset with zero manual steps beyond supplying account credentials (register a new agent, rebuild
   all state from the new galaxy).
4. Be the binding-constraint-aware player: the **API budget (per source IP, 2 req/s, burst 30)** is the scarce resource at
   scale, not credits. Every action competes for calls.
5. Be tunable live and explainable: every threshold is data, every skipped action logs a reason.

### Non-goals
- No LLM, no natural-language planning, no co-pilot. A human may read logs and edit parameters.
- Not a UI product. A read-only status page / JSON endpoint and log files suffice.
- No multi-IP proxy fleet in v1 (open question Q3). One IP, one limiter, one process.
- No mining/siphoning economy in v1 (trading, keepers, contracts, gate feeds only). Mining is a later milestone if
  the market model says raw-material feeds are worth it (A: digest centres on trading).
- Not matching the existing fleet's scale on day one. Target is "safe, positive, growing", then parity.

### Definition of "good" (targets, from digest calibration)
| Horizon | Target (stretch / floor) |
|---|---|
| Day 1 | 0.2-0.3M credits/h matched profit (floor 0.1M/h); never below start wallet minus 10% |
| Day 5 | ~2M/h (floor 0.8M/h) |
| Days 6-7 | 5-7M/h (floor 2M/h) |
| Week | reference weeks: ~461M and ~394M-by-hour-146 at ~10M/h with ~30 ships selling/h, 1,590 ships (~950 keepers), 54 units/sale, ~450c profit/unit, ~26k/sale. STAR v1 aims for 5-10% of that (20-40M); v2 for parity |
| Safety | zero single-trade loss > 150k; zero 429 storms (>5% of calls); zero duplicate purchases |

---------------------------------------------------------------------------------------------------

## 2. Architecture

### 2.1 Principles (from the design preferences)
- Small **pure** modules (no I/O, no clock, no globals): inputs in, `Decision[]` out, each with a one-line `reason`.
- **Policy as data**: every module takes a `Policy` object (JSON/YAML, hot-reloadable) with a feature switch; weight 0 /
  `enabled:false` reproduces "do nothing new" and has a test.
- **Thin shell** does all I/O: HTTP, DB, clock, scheduling. Modules never call each other's internals; the shell passes a
  `Snapshot` and applies `Decision`s.
- **Single writer**: exactly one process owns the wallet and command issuing (lockfile + DB advisory lock). No second
  instance can start (lesson d, f).
- **Idempotent commands**: every purchase/trade command carries an intent id (hash of kind+target+epoch); the executor
  records intent before the call, re-reads state after any error/timeout and before any retry (lessons d, g).

### 2.2 Module map

```
 API (HTTP) <-> [Budget Scheduler] <-> [Executor] <- Decisions
                      ^                    |
                      |                 [Ledger/Store]  (Postgres or SQLite, append-only events)
     [Observer] --raw--> Snapshot builder --> Snapshot ---+--> pure modules:
                                                         MarketModel -> OpportunityFinder -> FleetAllocator
                                                         PurchasePlanner  ExpansionPlanner  KeeperPlanner
                                                         ContractPlanner  GatePlanner  WindDown
                                                         RiskGuard (veto layer over every Decision)
                                                         Telemetry (pure reducers over events)
```

| Module | Pure? | Input | Output | Notes |
|---|---|---|---|---|
| Observer (shell) | no | API responses | `Observation` events | Normalises ship, market, shipyard, contract, agent, jump-gate payloads; stamps `observedAt` and `source` (keeper/trader/tour/contract). |
| Snapshot builder | yes | event log tail | `Snapshot` | Latest market per waypoint with age, ships with intent, wallet, holds value, API budget state. Single source of truth passed to all modules. |
| MarketModel | yes | price history per (waypoint, good), supply, activity, tradeVolume | `MarketView` (expected buy/sell price after n units, depth, recovery state, confidence by age) | Core: price = f(stock) reversible; ~4-5% per tradeVolume lot; ~30 min tick; staleness discount. |
| OpportunityFinder | yes | MarketViews, ship specs, distances, fuel costs | ranked `Route[]` with expected profit/trip, profit/hour, units, lots, pace gap, risk | Per-lot simulated price walk both sides; profit per API call also computed. |
| FleetAllocator | yes | ships, routes, jobs (contracts/feeds/gate), policy | `Assignment[]` | Hull-to-job matching (80-cargo on paying routes, 40-cargo shuttles on feeds into small markets). |
| PurchasePlanner | yes | wallet, cash gates, yard prices, route targets, growth health | `Buy` or `Wait(reason)` | Nearest-yard-to-destination rule, stale-price guard, cash gates and escape clause. |
| KeeperPlanner | yes | market scores, coverage, API budget | park/unpark/buy-keeper decisions | Ranks markets by goods x price; shipyard first; low-value parking with 90-min recheck. |
| ExpansionPlanner | yes | system graph, coverage, premium-age of live systems | scout/stage/release decisions | Pipeline scouted -> staged -> live. |
| ContractPlanner | yes | open contracts, prices | accept/fulfil/skip | One at a time, never paused early; deprioritised when trading beats it. |
| GatePlanner | yes | gate construction state, producer activity/supply | feed/buy decisions | Stop-at-HIGH feeds, price ceilings, recovery threshold. |
| WindDown | yes | time to reset, holds | phase flags | Stops hull buys, liquidates cargo. |
| RiskGuard | yes | any Decision + MarketView + realised results | allow / modify / veto + reason | Last word on every trade/purchase. |
| Budget Scheduler | no (clock) | requested calls with priority and value | grant order | Token bucket tuned below the limit; priorities 0-4; 429 backoff. |
| Telemetry | yes | event log | metrics, rule effect reports | Feeds the calibration loop. |

### 2.3 Data flow (one tick, ~1-2 s loop plus per-ship async workers)
1. Observer ingests responses (every API response contains data worth keeping: trade results update price, navigate
   results update fuel, etc.) -> append `Observation` events.
2. Snapshot builder folds events into `Snapshot`.
3. Modules run in a fixed order (section 3.2) producing `Decision[]`, each tagged `{rule_id, reason, params_version}`.
4. RiskGuard filters. Surviving decisions become `Intent`s (idempotent keys) stored, then handed to the Budget Scheduler.
5. Executor issues calls in grant order, writes results as events, ships' per-ship state machines advance
   (navigate -> dock -> trade -> orbit). Arrival times are taken from the API (`route.arrival`), never from cached polling
   (lesson d).

### 2.4 What is persisted
Append-only `events` (observation, intent, result, decision, rule_fire, skip) keyed by `week_id = <agent>@<resetDate>`;
derived tables rebuildable from events: `market_history`, `ship_state`, `cost_basis` (lot-level FIFO per ship+good),
`ledger` (credits-in/out with cause), `rule_stats`, `experiments`. **Kept across resets**: `rule_stats`, `experiments`,
policy versions, per-week summary rows, parameter changelog (for cross-week calibration). **Dropped at reset**: all
galaxy-specific tables, all tokens, all ship state. Reason: ship symbols and systems repeat or vanish each week, so
rows without `week_id` are forbidden (schema constraint).

### 2.5 Surviving a weekly reset
- **Detect proactively**: poll unauthenticated `GET /v2/` (A: returns `resetDate`, `serverResets.next`) every ~5 min;
  also treat the "token from a previous reset" 401 (A: message matches `reset_date does not match`) as a latch that stops
  all calls for that agent.
- **Recovery state machine**: `LIVE -> RESET_DETECTED -> FREEZE (cancel intents, no calls but status) -> REGISTER (new
  agent via account token, POST /register; A: needs account-level token or a fresh callsign) -> ARCHIVE (close old week
  summary, snapshot rule_stats) -> BOOTSTRAP (fetch agent, ships, home system, waypoints, markets) -> OPENING`.
- Registration details (faction, callsign) are config. Fail loudly with an alert if registration needs a human (captcha/
  account token expiry) and keep polling.
- New week starts with the previous week's *policy* (tuned parameters) but empty beliefs about the galaxy.

### 2.6 Offline testing: recorder, replay, simulator
- **Recorder (M0)**: a tiny tool that logs every public/own API response (market, shipyard, waypoint, system, jump-gate,
  contract) with timestamps to NDJSON. Run it from day one on live weeks; this is the training data.
- **Replay harness**: feeds recorded events into the pure modules at original timestamps; checks decisions against
  invariants (never sells below floor, never buys above ceiling, never exceeds budget).
- **Market simulator** (the only custom physics we need): per (waypoint, good) state `{stock, tradeVolume, supply,
  activity}`, price = f(stock) fitted from recordings; our units move price ~4.5%/lot; ~30 min tick recovery of a few
  units/h for WEAK exports; activity climbs with sustained deliveries; trade volume grows with heavy trading. Calibrated
  so the 40-unit/90-s loop reproduces the observed crash (167->552 buy, 266->127 sell in 35 min). Includes API latency,
  429s, jump/fuel/travel costs, shipyards with price creep per purchase.
- **Test layers**: unit (each module, policy-off equals old behaviour); property tests (ledger conservation, no negative
  wallet, idempotent intents); seam test (shell + modules against simulator for a simulated week at 100x); chaos tests
  (inject 429 storms, timeouts after success, stale snapshots, reset mid-run).
- **Acceptance of the simulator itself**: fitted model must predict next-tick price within 10% on held-out recordings
  for 80% of observations (A: threshold to tune).

---------------------------------------------------------------------------------------------------

## 3. The Rulebook

### 3.1 Conventions
Each rule: `id | trigger | action | params (data, tunable) | rationale | log string`. All params live in `policy.yaml`
under the rule id and are hot-reloadable; each has `enabled` (default true unless stated). Log string is emitted with
`{rule_id, week, hour, key values}` on fire and (as `skip:`) on every silent skip.

Phases: **O** opening (h0 to ~h24), **G** midgame growth (day 2-4), **E** expansion (continuous from first live
system), **S** steady state (day 5-6), **W** wind-down (last ~24h). Concerns: T trading, H ships/hulls, B API budget,
M markets/price impact, X safety, C contracts/gate.

### 3.2 Decision order when rules conflict (highest first)
1. **X (safety) vetoes** always win: RiskGuard, loss guards, double-buy guards, reset freeze.
2. **W (wind-down)** flags override growth rules (no hull buys, liquidate).
3. **B (API budget)**: a decision the budget cannot afford is deferred, not dropped; lower-priority reads shed first.
4. **Cash gates** (H rules) over opportunity (a great route does not buy a hull below the gate unless escape clause fires).
5. **C (contracts/gate)** commitments in flight (one contract at a time is never paused) over new trading allocations,
   except where X vetoes.
6. **M (market impact/pace)** over **T (profit)**: a route that would crash its own spread is paced or skipped before
   being ranked.
7. **E (expansion)** over **S (steady state)** tuning for keepers/ships.
8. Within a concern, the rule with the lower id number wins; ties broken by higher expected value per API call.
Every override logs `overridden: <rule_id> by <rule_id>` once per (rule,hour).

### 3.3 Opening (O)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| O-01 | Week start, tokens valid | Bootstrap: read agent, ships, home system waypoints, all home markets (priority 1) | `bootstrapReadBudget=250 calls` | Prices unknown at start; only 11/31 home markets priced at hour 0 last week | "O-01 bootstrap: reading {n} home markets before first trade" |
| O-02 | Command ship idle, fewer than `minRoutes` profitable routes known | Command ship tours unpriced home markets nearest-first | `minRoutes=3`, `minRouteProfitPerHour=8000` | "tours until good routes, then trades" | "O-02 touring: only {k}/{minRoutes} good routes known" |
| O-03 | Routes known >= `minRoutes` | Command ship becomes trader on best profit/hour route, lot-limited | `lotCapFrac=0.6 of tradeVolume`, `maxUnits=40` | Build cash safely | "O-03 command ship trading {good} {A}->{B} est {x}/h" |
| O-04 | Keeper ships (starting probes) exist | Park each on best unpriced/high-value home market (shipyard first) | `keeperRankBy=goodsCount*medianPrice`, `yardsFirst=true` | Freshness; yard dock unlocks probes | "O-04 keeper {ship} parked at {wp} score {s}" |
| O-05 | Open contract available, none active | Accept the highest-net contract that a current ship can fulfil within `maxHours` | `maxHours=6`, `minNet=60000` | Contracts 120-230k manufactured goods, worth early; one at a time | "O-05 accepted contract {id} net {x}" |
| O-06 | Contract active | Never pause; fulfil with the best-fit ship; deliver in tranches | `pause=false` | Playbook: never pause contracts | "O-06 contract {id} {done}/{total}" |
| O-07 | Wallet >= `buyShuttleCash` (default 200k) and no contract ship | Buy 1 light shuttle (40 cargo) at the yard nearest the contract route, assign to contracts | `buyShuttleCash=200000` | Shuttles before probes; ship for contracts | "O-07 buying contract shuttle at {yard} ({hops} hops)" |
| O-08 | After O-07, wallet >= `buyTouringCash` (~200k above floor) | Buy 1 ship for touring/pricing (cheapest probe/surveyor at nearest yard) | `buyTouringCash=200000` | "one ship for contracts, one for touring" | "O-08 buying tour ship" |
| O-09 | Gate mission exists and gate materials known | Compute gate bill of materials (FAB_MATS 1,600; ADVANCED_CIRCUITRY 400; QUANTUM_STABILIZERS if not done) and producers; no spending yet | none | Know the chain from hour 1 | "O-09 gate BOM {goods} producers {ids}" |
| O-10 | Wallet >= `gateStartCash` (default 1,000,000) | Start gate feeds + mission buying (see C rules) | `gateStartCash=1000000` | Operator opening template | "O-10 gate feeds starting at wallet {w}" |
| O-11 | Wallet drops below `openingFloorCash` (30k) | Freeze all buys except fuel; command ship takes best safe route only | `openingFloorCash=30000` | Liquidity guard | "O-11 liquidity floor {w}: freezing non-trade spending" |
| O-12 | Hours 0-6 and any API use > `openingApiShare` (60%) by reads | Shed reads to priority 0-2 only | `openingApiShare=0.6` | Cheap early data matters more than late data | "O-12 shedding {n} low-priority reads" |

### 3.4 Midgame growth (G)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| G-01 | Wallet >= `hullCashGate` (3,000,000) after purchase and a route list shows >= `idleTraderGap` unserved good routes | Buy light hauler (80 cargo) at nearest-yard-to-destination | `hullCashGate=3000000` | Operator cash discipline 3M | "G-01 buy hauler for {route}, wallet {w} -> {w2}" |
| G-02 | Candidate yards list | Choose `min(price + hops*jumpCost + travelHours*valuePerHour)` | `jumpCost=6900`, `valuePerHour=ship profit/h` | Nearest yard, not cheapest | "G-02 yard {y}: price {p} hops {h} total {t} vs next {t2}" |
| G-03 | Purchase about to execute | Re-read yard price (age <= `maxPriceAgeSec` 120), abort if > quoted by `priceSlackPct` 3% | `maxPriceAgeSec=120`, `priceSlackPct=0.03` | Lesson g, stale hull price | "G-03 yard price moved {a}->{b}, aborting" |
| G-04 | One purchase done | Pause hull buys for `buyCooldownMin` | `buyCooldownMin=10` | Purchase raises yard price quickly | "G-04 cooling: next buy after {t}" |
| G-05 | Cash flat/falling for `stallHours` (2) OR rate < `stallRatePerHour` (80k) OR >= `idleTraderFrac` (20%) traders idle | Escape clause: allow ONE hull buy below the 3M gate, up to `escapeMaxFrac` 40% of wallet | `stallHours=2`, `stallRatePerHour=80000`, `escapeMaxFrac=0.4` | Operator escape clause | "G-05 escape: growth stalled ({why}); buying below gate" |
| G-06 | Wallet >= `keeperCashGate` (5,000,000) | Allow keeper buys | `keeperCashGate=5000000` | Keepers wait for 5M | "G-06 keepers allowed at wallet {w}" |
| G-07 | Wallet < keeperCashGate and keeper priced <= `lateAutoApproveCap` (60k) and wallet >= 10x price | Late-stage auto-approve of cheap probes | `lateAutoApproveCap=60000`, `walletMultiple=10` | Digest: 60k auto-approve cap | "G-07 auto-buy probe {p}c" |
| G-08 | Ship choice for a purchase | Match hull to job by hold size: big holds for paying routes, shuttles (40) only for feeds into <=60-unit markets, heavy freighter 225 / bulk 490 only when routes support units >= 0.7*hold | `bigHullMinUnitsFrac=0.7`, `bulkYardsMax` | Profit scales with hold size | "G-08 hull {type}: route supports {u}/{hold} units" |
| G-09 | Expected payback of a hull > `maxPaybackHours` (default 12 mid-week, 6 after day 5) | Do not buy | `maxPaybackHours=12` | Equity-based growth | "G-09 payback {h}h > {max}h; skip" |
| G-10 | Hauler idle > `idleMinutes` (10) | Reallocate to best unserved route else keeper-support tour | `idleMinutes=10` | Idle traders are the stall signal | "G-10 reallocating idle {ship} -> {job}" |
| G-11 | Ship count of traders > `routeCapacity` of good routes | Stop buying traders; buy keepers/expansion instead | computed | Avoid over-saturating routes | "G-11 route capacity {c} reached; shifting spend to coverage" |

### 3.5 Trading and market impact (T and M)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| T-01 | Choosing a route | Rank by `expectedProfitPerHour` from simulated per-lot walk on BOTH legs, minus fuel and jump costs | `fuelCostModel`, `jumpCost=6900` | Margin quoted off best price lies | "T-01 route {A}->{B} {good}: est {p}/trip {ph}/h units {u}" |
| T-02 | Route's last price read older than `maxPriceAgeMin` (45) | Discount confidence; if > 90 min, do not select | `maxPriceAgeMin=45`, `hardStaleMin=90` | Data is only as good as last read | "T-02 route {r}: price age {m}m, confidence {c}" |
| T-03 | Per-lot sell | Before each lot, compare expected price to realized price of previous lot; stop selling if realized < `lotAbortFrac` (0.85) of expected | `lotAbortFrac=0.85` | Lesson a, lone trader dumping | "T-03 realized {r} < {e}*{f}; stopping, {k} units held" |
| T-04 | Any sell | Hard floor: never sell below `sellFloorFrac` (0.8) of cost basis plus fees unless W-phase liquidation | `sellFloorFrac=0.8` | Lesson a | "T-04 sell floor hit at {price}" |
| T-05 | Any buy | Never buy a unit above `buyCeilFrac` (1.15) of the route's planned price; stop the load | `buyCeilFrac=1.15` | Don't chase | "T-05 buy ceiling hit at {price}" |
| T-06 | Planning units | `units = min(hold, depthUnits(sell side to floor), lotsAllowed*tradeVolume)` | `lotsAllowed=1.5` | ~4-5%/lot impact | "T-06 units {u}: depth {d}, hold {h}" |
| T-07 | Same route repeated | Enforce `minRevisitMin` between loads sized to recovery (~30 min tick), per-route spacing | `minRevisitMin=35`, `spacingFromRecovery=true` | Fast loops crash spread | "T-07 route {r} paced: next in {m}m (recovery {rec})" |
| T-08 | Realised spread of a route fell below `minSpreadFrac` (60%) of its 24-h median | Mark route COOLING; exclude for `coolingMin` | `minSpreadFrac=0.6`, `coolingMin=90` | Reversible price: let it recover | "T-08 route {r} cooling: spread {s} vs {m}" |
| T-09 | Several traders target the same sell market | Reserve volume: sum of reserved units across ships <= `sellDepthShare` (0.5) of depth | `sellDepthShare=0.5` | Multi-ship same-market crushes | "T-09 reservation {u} units at {m}; {left} left" |
| T-10 | Low-volume high-margin goods (tradeVolume <= 20, margin >= `hmMinFrac` 0.4) | Allow up to `hmMaxUnits` (8) per visit, higher visit frequency | `hmMaxUnits=8`, `hmMinFrac=0.4` | Barely moved at 4-8 units | "T-10 high-margin trickle {good} {u} units" |
| T-11 | Choosing between routes with similar profit/h | Prefer higher profit per API call (fewer polls) | `tieBreakEpsilon=0.1` | API budget binding | "T-11 tie-break by calls: {r} {ppc}/call" |
| T-12 | Ship arrives at buy market | Read market fresh (the trade response gives post-trade prices) and re-validate route; abort if profit < `revalidateMinFrac` (0.5) of plan | `revalidateMinFrac=0.5` | Stale plan guard | "T-12 revalidate failed: {p} < {plan}*{f}" |
| T-13 | Follow-on lookahead | Prefer a route whose destination offers a profitable backhaul within `backhaulWeight` | `backhaulWeight=0.5` (0 = off) | Don't deadhead | "T-13 backhaul {good} adds {x}" |
| M-01 | Feeding an import market | Stop at supply HIGH, never ABUNDANT (stopAtSupply) | `stopAtSupply=HIGH` | Over-feeding turns downstream SCARCE | "M-01 feed {good}@{m}: supply HIGH, stopping" |
| M-02 | Export activity RESTRICTED | Do not plan purchases from it; check inputs; add input feed | `restrictedAction=feed_inputs` | Exports restricted while an input is SCARCE | "M-02 {m} RESTRICTED: input {i} SCARCE" |
| M-03 | Sustained delivery to an import | Expect activity growth over ~12h; track and report | `trackHours=12` | Import activity climbs | "M-03 import {m}:{good} activity {a}" |
| M-04 | Market tradeVolume grows after heavy trading | Increase lots allowed in proportion, with decay | `tvGrowthWeight=0.5` | Volume grows with sustained trading | "M-04 tradeVolume {a}->{b}" |
| M-05 | Own units moved price more than model expects over 3 samples | Re-fit local impact parameter | `impactEwmaAlpha=0.2` | Calibration | "M-05 impact refit {m}:{g} {old}->{new}" |

### 3.6 API budget (B)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| B-01 | Always | Token bucket at `targetRps` (1.75, below the 2 limit) with burst `burst` (20, below 30) | `targetRps=1.75`, `burst=20` | Per-IP limit, headroom against 429s | "B-01 budget {used}/{cap} calls/min" |
| B-02 | Each call requested | Priority classes: 0 trade/dock/navigate in progress, 1 purchases, 2 arrival-triggered market reads, 3 keeper reads, 4 background crawl | `priorities=[0..4]` | Lesson: priority lanes | "B-02 call {type} prio {p} queued {ms}ms" |
| B-03 | 429 received | Honour `retry-after`; drop budget by `backoffFrac` (0.25) for `backoffMin` (5) | `backoffFrac=0.25`, `backoffMin=5` | 429 storms | "B-03 429 from {type}: backing off" |
| B-04 | Utilisation > `shedAbove` (0.92) for 2 min | Shed priority 4 then 3 | `shedAbove=0.92` | Keep core trading responsive | "B-04 shedding prio>={p}: util {u}" |
| B-05 | Utilisation < `slackBelow` (0.7) | Allow more keepers/expansion reads | `slackBelow=0.7` | Use idle budget | "B-05 slack {s}; admit {n} keeper reads" |
| B-06 | Keeper count K | Poll each keeper at interval `keeperPollMin` chosen so calls/min <= `keeperShare` (0.4) of budget; digest: ~950 keepers ~140 calls/min implies ~7 min/keeper | `keeperShare=0.4`, `keeperPollMin=7` | Scale measurement | "B-06 keeper interval {m}min for {k} keepers" |
| B-07 | A trade/navigate response already carries state | Do not issue a separate read | `reuseResponses=true` | Calls are the constraint | "B-07 skipped read {x}: response already fresh" |
| B-08 | Hot polling loop detected (same call > `loopMax` 6/min per target) | Break and log | `loopMax=6` | Hot loops cause 429s | "B-08 hot loop {call}: throttled" |
| B-09 | Startup | Refuse to start if another instance holds the lock | `lock=true` | Overlapping instances | "B-09 instance lock held by {pid}" |
| B-10 | Marginal value of a call | `value = expectedProfitDelta / call`; below `minValuePerCall` skip | `minValuePerCall=0` default off | Make the budget an economy | "B-10 skip read value {v} < {min}" |

### 3.7 Keepers, freshness and coverage (K)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| K-01 | Candidate markets | Score = goodsTraded x median price (+ shipyard bonus `yardBonus=1.5`); cover best first | `yardBonus=1.5` | Cover the best markets first | "K-01 market {m} score {s} rank {r}" |
| K-02 | Market score < `lowScoreFrac` (0.3) of median AND no trades of ours AND no viable route | Park keeper | `lowScoreFrac=0.3` | Low-value keeper waste | "K-02 parking keeper {s} at {m}: score {x}" |
| K-03 | Keeper parked | Recheck after `recheckMin` (90) | `recheckMin=90` | A market with no read in 90 min cannot be judged | "K-03 recheck {m} after {t}m" |
| K-04 | Market with no read in 90 min | Treat as UNKNOWN: excluded from routes | `hardStaleMin=90` | Cannot be judged | "K-04 {m} unknown (last read {t}m)" |
| K-05 | Keeper buy approved | Buy probe at yard nearest the target market | G-02 | Nearest-yard rule | "K-05 probe from {y} to {m}" |
| K-06 | Ship docked at a yard | Treat yard market as high priority; keep a keeper at every yard system for purchase freshness | `yardKeeper=true` | Docked ship unlocks buys | "K-06 yard keeper {y}" |
| K-07 | Keeper coverage in a system < `stageCoverage` (80%) | System cannot go live | `stageCoverage=0.8` | Staging rule | "K-07 {sys} coverage {c} < 0.8" |
| K-08 | Keeper gone/stalled (no read for 2x interval) | Unpark/replace; log | `deadFactor=2` | Drift between state and reality | "K-08 keeper {s} silent {m}m" |

### 3.8 Expansion (E)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| E-01 | Gate network usable (gate complete) or ship can reach by jump | Scout: one cheap ship reads adjacent systems; no purchases | `scoutDepth=2` | scouted stage buys nothing | "E-01 scouting {sys}" |
| E-02 | Scouted system has market list | Rank by expected value (market count x goods x price, shipyard presence, hops from fleet) | weights as data | Always expand | "E-02 system {s} rank {r} value {v}" |
| E-03 | Staged system count < `stagedAhead` (4) | Stage the next: buy keepers for best `stageMarkets` (7-8) | `stagedAhead=4`, `stageMarkets=8` | Pipeline | "E-03 staging {s}: {n} keepers" |
| E-04 | Staged system, markets priced >= 80% and a tour ship assigned | Ready to release | `stageCoverage=0.8` | Staging rule | "E-04 {s} ready" |
| E-05 | Live premium systems < `maxPremiumLive` (10) and last release >= `releaseIntervalMin` (15) ago | Release the best ready system | `maxPremiumLive=10`, `releaseIntervalMin=15` | Release one every ~15 min | "E-05 releasing {s}; premium live {n}/10" |
| E-06 | System age > `premiumHours` (8) or yield/unit < `fadeFrac` (0.7) of its first-hour yield | Mark FADING (not counted as premium) | `premiumHours=8`, `fadeFrac=0.7` | ~1.7x for ~8h; yield falls as we sell | "E-06 {s} fading: age {a}h yield {y}" |
| E-07 | Staged system needs a tour ship and none free | Take a ship from the lowest-value task, or buy a probe | `maxWaitingStaged` is a param, default 6 | Lesson c: tunable, logged | "E-07 {s} waiting for tour ship ({who})" |
| E-08 | Target at >= `maxHops` (12) gate hops | Skip; log | `maxHops=12` | Out of reach is a bottleneck | "E-08 {s} at {h} hops > max" |
| E-09 | Yardless target | Deliver probes across gates | `probeDelivery=true` | Probes can cross gates | "E-09 delivering {n} probes to {s}" |
| E-10 | Big hull allocation | Prefer big hulls (80+ cargo) into newly live systems first | `bigHullFirst=true` | Best hours: big hulls into newly covered systems | "E-10 hull {s} assigned to fresh {sys}" |
| E-11 | Expansion queue stalls > `stallExpansionMin` (20) with no log reason | Emit the exact blocking rule; assertion in telemetry | `stallExpansionMin=20` | Lesson c | "E-11 expansion stalled {m}m: blocked by {rule}" |

### 3.9 Gate and contracts (C)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| C-01 | Gate under construction | Feed EVERY input of gate materials from hour one using stopAtSupply HIGH | `stopAtSupply=HIGH` | Playbook | "C-01 feeding {input} into {m}" |
| C-02 | Gate mission wants to buy material | Allow only if producer activity in {GROWING, STRONG} and `recoverPct` gate satisfied | `activityOk=[GROWING,STRONG]`, `recoverPct=0.5` (A) | Refill is slow | "C-02 buying {mat}: activity {a} recover {r}" |
| C-03 | Price of material above ceiling | Wait | `ceil.FAB_MATS=2000`, `ceil.ADVANCED_CIRCUITRY=4000` | Operator ceilings | "C-03 {mat} {p} > ceiling {c}; waiting" |
| C-04 | Shuttle (40) vs hauler (80) | 40-unit shuttles for feeds into 60-unit markets; haulers on contracts | G-08 | Right size | "C-04 carrier {s} cargo {c} for feed" |
| C-05 | Gate API reports complete | Latch `gateComplete=true` permanently (set only from the construction endpoint, never inferred from a failed read) and re-open all gate routes | `latch=true` | Lesson e | "C-05 gate complete latched" |
| C-06 | Contract open and trading profit/h of the assigned ship > `contractIrrelevantRate` (1M/h fleet) | Stop accepting new contracts; finish current | `contractIrrelevantRate=1000000` | Irrelevant once trading earns millions/h | "C-06 contracts disabled: fleet {r}/h" |
| C-07 | Contract deadline risk | If cannot meet deadline by `slackH`, decline early | `slackH=1` | Penalty avoidance | "C-07 contract {id} infeasible" |

### 3.10 Safety (X)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| X-01 | Any single trade realized loss > `maxTradeLoss` (150k) | Pause that ship + route for `pauseH` (6), alert | `maxTradeLoss=150000`, `pauseH=6` | Lesson a (~700k) | "X-01 loss {l} on {ship}: pausing route" |
| X-02 | Rolling 1h matched profit < `-lossLimit` (500k) | Global trade pause, require human or auto-resume after `resumeMin` (30) with halved sizes | `lossLimit=500000` | Circuit breaker | "X-02 circuit breaker: 1h {p}" |
| X-03 | Any purchase | Idempotency key + read-before-retry; second identical intent within `dedupeMin` (30) rejected | `dedupeMin=30` | Lesson d | "X-03 duplicate intent {k} rejected" |
| X-04 | Call error/timeout on a command | Read state first; never blind retry | `retryRequiresRead=true` | Lesson d | "X-04 {call} errored; reading before retry" |
| X-05 | Ship state "in transit" past arrival time | Distrust cache; query ship | `arrivalGraceSec=15` | Lesson d | "X-05 {ship} past arrival: refreshing" |
| X-06 | Silent skip anywhere | Must emit `skip: reason` (enforced by test) | `skipLogRateLimit=1/min/key` | Lesson c | "X-06 skip {rule}: {reason}" |
| X-07 | Wallet < `minWallet` (25k) | Only fuel, trades that pay within one trip | `minWallet=25000` | Never strand | "X-07 low wallet; restricted mode" |
| X-08 | Reset detected | Freeze, archive, re-bootstrap | section 2.5 | Tokens die | "X-08 reset detected; entering freeze" |
| X-09 | Same instance, DB lock lost | Halt | n/a | Single writer | "X-09 lost writer lock; halting" |
| X-10 | Market data suspicious (price 0, NaN, change > 5x in one read) | Discard observation, flag | `outlierFactor=5` | Bad data kills trades | "X-10 outlier at {m}:{g}" |
| X-11 | Ship has fuel < required for planned leg | Refuel first or reroute; drift only if value justifies | `drift=allowed_if_value>x` | Drift ETAs of hours | "X-11 fuel {f} < {n}; refuelling" |
| X-12 | Policy hot-reload | Validate schema, bounds; reject bad values; keep old and log | bounds per param | Live tuning without foot-guns | "X-12 policy {p} rejected: {why}" |

### 3.11 Steady state (S)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| S-01 | Day >= 5 and all gates open | Raise hull buys cadence: `buyCooldownMin` 5 | `s.buyCooldownMin=5` | Compounding | "S-01 steady cadence" |
| S-02 | Weekly keeper review | Re-rank markets, park bottom-scoring below `lowScoreFrac` | K-02 | Budget goes to best markets | "S-02 review parked {n}" |
| S-03 | Per-system yield trend | Move haulers from fading to fresh systems | `moveGainFrac=0.15` | Fresh systems pay 1.7x | "S-03 moving {s} {from}->{to}" |
| S-04 | Saturation: sale count per hour per market > saturation | Spread ships over more markets | `maxSalesPerMarketHour` data | Price impact | "S-04 saturation {m}" |
| S-05 | Payback horizon shortens | Raise `maxPaybackHours` scaled by hours left | `paybackScale=hoursLeft/3` | Buy only what repays by reset | "S-05 payback {p}h vs left {l}h" |

### 3.12 Wind-down (W)

| id | Trigger | Action | Params | Rationale | Log string |
|---|---|---|---|---|---|
| W-01 | Hours left <= `stopHullBuyH` (derived per hull: `payback x 1.3`, default 18) | Stop buying that hull class; wallet-only value counts | `stopHullBuyH=18` | Hulls do not count at the end | "W-01 no more {class}: repay {p}h > left {l}h" |
| W-02 | Hours left <= `stopKeeperBuyH` (12) | Stop keepers and expansion staging | `stopKeeperBuyH=12` | Same | "W-02 stop keepers/staging" |
| W-03 | Hours left <= `liquidateH` (3) | Stop buying cargo that cannot sell before reset; sell held cargo at best reachable market, within floor | `liquidateH=3` | Cargo does not count | "W-03 liquidating {good} {u}u" |
| W-04 | Hours left <= `finalH` (45 min) | Floor relaxed to `sellFloorFracFinal` 0.5 of cost for unsold cargo; sell everything reachable | `sellFloorFracFinal=0.5` | Credits only | "W-04 final dump {good} at {p}" |
| W-05 | Hours left <= 24 | Contracts: accept only if completes + pays before end | n/a | Wallet only | "W-05 contract timing check" |
| W-06 | Hours left <= 1 | Ships sitting on non-sellable cargo do nothing risky; no jumps (fuel cost) | `noJumpH=1` | Avoid pure costs | "W-06 no jumps in final hour" |
| W-07 | Final 10 min | Take final snapshot, record week summary, queue reset watcher | n/a | Calibration data | "W-07 final snapshot" |
| W-08 | Ship scrapping option (sell_ship equivalent) | Not used by default (A: refund unknown) | `scrap=false` | Unproven; test in sim | "W-08 scrap disabled" |

Rule count: 12 + 11 + 18 + 10 + 8 + 11 + 7 + 12 + 5 + 8 = about 102 raw lines, of which ~70 are distinct decision rules
(the rest are log/guard/lookup entries). If trimming to 40-80, ship M1-M3 with the starred core: O-01..O-08, G-01..G-06,
T-01..T-09, M-01, M-02, B-01..B-04, K-01..K-04, X-01..X-07, W-01..W-04, C-01..C-03, C-05 (about 55).

---------------------------------------------------------------------------------------------------

## 4. Week timeline

### First 24 hours (phase O -> early G)
| Hour | Engine does |
|---|---|
| 0:00-0:10 | Detect reset, register, bootstrap (O-01). Read the 31 home markets in priority order; park starting keepers at best (O-04). Start recorder. |
| 0:10-1:00 | Command ship tours unpriced markets (O-02). Accept a contract (O-05). Compute gate BOM (O-09). API share heavily on reads (O-12). |
| 1:00-3:00 | First route found; command ship trades 20-40 units with lot checks (O-03, T-03/04/05). Wallet floor 30k (O-11). Target ~0.1-0.3M/h later. |
| 3:00-6:00 | At ~200k: contract shuttle (O-07); then touring ship (O-08). Contract fulfilment ongoing (O-06). Pace loops (T-07). |
| 6:00-12:00 | Keep trading; second route; revalidate. Keepers on yards/top markets only within cash discipline. Gate mission starts when wallet hits 1M (O-10); feeds run stop-at-HIGH (C-01). |
| 12:00-24:00 | First light haulers only if G-01 gate (3M) reached or escape clause fires (G-05). Reassess idle traders hourly. Day-1 target 0.2-0.3M/h; end of day cumulative a few million. First telemetry report (section 5). |

### Days 2-5 (G, E, S)
- Day 2: wallet crosses 3M -> hauler buys (G-01/02/03), gate feeds continue; gate finishes around hour 50 (C-05 latches). Keepers after 5M (G-06).
- Day 3: gate open -> E-01 scouting begins; stage first system (E-03), release one per 15 min once ready (E-05). Prefer big hulls to fresh systems (E-10).
- Day 4: expansion pipeline steady (4 staged ahead, up to 10 premium live). Keeper count scales with API headroom (B-05/B-06). Weekly-style keeper review (S-02).
- Day 5: ~2M/h; payback horizons begin shortening (S-05); saturation spreading (S-04).

### Last day (W)
- Hours -24..-18: stop buying classes that cannot repay (W-01); contracts only if they complete in time (W-05).
- Hours -12: stop keepers/staging (W-02).
- Hours -3: liquidate cargo (W-03). Last 45 min: final dump (W-04), no jumps (W-06), final snapshot (W-07). Expect 5-7M/h on day 6-7 at full scale.

---------------------------------------------------------------------------------------------------

## 5. Metrics, experiments and calibration (no LLM)

### 5.1 Metrics
- **Primary**: final wallet; matched profit per hour; equity = wallet + holds (cargo at expected fetch).
- **Secondary**: profit per sale/unit (reference: 54 units, ~450c/unit, ~26k/sale), sales/hour, idle ship fraction, API utilisation and 429 rate, keeper coverage %, premium-system count and age, realised-vs-expected price ratio per lot, hull payback realised vs planned, silent-skip count (target 0), intents rejected as duplicates.
- All computed by pure reducers over the event log, one function per metric, tested against hand-computed fixtures.

### 5.2 Rule effect measurement
Each rule fire is recorded as `rule_fire(rule_id, ts, params_version, scope)`. For each rule R with a measurable outcome:
1. **Before/after**: matched profit/h for the scope (ship, route, system) in a window of `w` before vs after a parameter change (default w = 2h, min samples n >= 30 sales each side, else "insufficient data"). Report delta, both n, and a bootstrap 90% interval; it is correlation, and says so.
2. **Matched control (preferred)**: where scopes are exchangeable (two similar routes, two ships of the same hull), randomly assign the parameter A/B (deterministic hash of ship id) with a max `experimentShare` (20%) of the fleet; compare profit/h per ship-hour with a permutation test.
3. **Counterfactual logs**: for veto and skip rules (X, T-03), record the avoided trade's simulated outcome so the rule's cost (missed profit) and benefit (avoided loss) are both visible.
4. **Calibration**: predicted vs realised profit per trip (`trip_planned` vs `trip_closed`); keep a per-route-class multiplier (EWMA) used by T-01 once stable (weight starts 0, ships off, proven across >= 2 weeks).
5. Cross-week: `rule_stats` persists per policy version and per week; a parameter is promoted only if it wins in >= 2 weeks or in sim plus 1 live week.

### 5.3 Modes
- **Advisory** (default for new rules and M1): module outputs a `Decision` plus `reason` but the executor logs "would do X" and applies the incumbent behaviour (or nothing); a weekly report ranks would-have deltas.
- **Autonomous**: the executor applies. A rule graduates to autonomous when it has >= N shadow fires (default 200), simulated gain > 0 in replay, and no safety invariant broken. X-rules are autonomous from M1 (they only restrict).
- **Kill switches**: per-rule `enabled`, global `autonomy` level 0 (observe) / 1 (safe trader) / 2 (growth) / 3 (expansion), changeable live.

### 5.4 Parameter tuning loop
Offline: grid/random search in the simulator on recorded weeks (objective: final equity subject to safety invariants), with out-of-week validation. Online: slow hill-climb on a few parameters at a time (one change per `tuneIntervalH` 6; revert if the 2h after is worse by more than 1.5 sigma). Every change writes a `config_change` event with before/after.

---------------------------------------------------------------------------------------------------

## 6. Milestones, risks, open questions

### Milestones
| M | Scope | Acceptance criteria |
|---|---|---|
| M0 | Recorder + event store + replay harness + market simulator v0 | Records a full live week of public data without >2% 429; simulator reproduces the 40-unit/90-s crash within 20% on price path; replay is deterministic; CI runs the sim week in < 5 min |
| M1 | Safe trader: Observer, Budget Scheduler, MarketModel, OpportunityFinder, RiskGuard, O-01..O-04, T rules, X rules, B-01..B-04 | On a live week: single-ship trading, positive matched profit, zero trade losses over 150k, 429 rate < 1%, zero duplicate intents, survives a forced restart mid-trade |
| M2 | Reset survival: detection, register, bootstrap, archive | Passes a recorded/mocked reset; real reset: autonomous trading within 30 min of reset with no human step |
| M3 | Opening + contracts + purchase planner (O, G-01..G-11, C-06/07) | Reaches 3M by hour <= 36 (floor) and day-1 profit >= 0.1M/h; buys hulls at nearest yard; escape clause fires correctly in sim |
| M4 | Keepers + coverage (K rules, B-05/06) | Keeper coverage of top-20 markets >= 90% fresh (< 45 min); API utilisation 70-92% |
| M5 | Gate feeds and mission buying (C-01..C-05) | Gate completed by hour <= 72 in a live week; no price above ceilings; gate latch test passes |
| M6 | Expansion pipeline (E rules) | >= 3 systems staged -> released; premium live count tracked; E-11 reports reason on every stall |
| M7 | Wind-down + calibration loop + A/B framework | Wallet-equity gap at reset < 1%; first weekly rule-effect report with n, intervals |
| M8 | Scale-out (more hulls, bigger holds, multi-IP optional) | Reaches 2M/h by day 5 live |

### Risks
| Risk | Mitigation |
|---|---|
| Simulator mismatch with live market physics | Calibrate on recordings (M0), shadow mode before autonomy, X guards independent of the model |
| API budget exhaustion / 429 storms | B rules, priorities, single process, lock |
| Cold start slower than hand-tuned human opening | Opening rules + commission-free recording of weeks; accept lower day-1 |
| Wallet drawdown from a bug | X-01/02/07, advisory-first, autonomy levels |
| Reset registration breaks (account token, API change) | M2 test; alerts; keep a manual fallback |
| Overfitting parameters to one week's galaxy | Cross-week validation requirement |
| Rule conflicts causing silent stalls | Decision order, X-06 enforced skip logging, E-11 stall detector |
| Keeper cost vs value at small scale | Cash gate, K-02 parking, measured via K metrics |

### Assumptions (verify in M0)
A1: `GET /v2/` public status exposes reset date and next reset. A2: market responses expose supply, activity, tradeVolume and per-good prices. A3: a trade response returns post-trade market prices (so reads can be saved, B-07). A4: registration requires an account token or a callsign and is automatable. A5: shipyard purchase raises yard price quickly (digest) but the size is unknown; modelled per yard. A6: contracts are accepted/fulfilled via standard endpoints with deadlines and penalties known per contract. A7: `recoverPct` meaning (threshold of stock recovered since last purchase) is an interpretation. A8: ship scrapping refunds are unknown. A9: simulated fresh-system 1.7x premium and 8h decay are modelled by lowering initial prices; the true cause (price vs stock) is unknown. A10: no explicit rate budget change by game version. A11: probes can cross gates by their own jumps and need fuel (digest says delivery is possible). A12: single IP is available; extra IPs cost money and need a separate limiter.

### Open questions for the human
1. Which faction/callsign and how do we get account-level tokens for re-registration each week?
2. Autonomy appetite: is advisory-only for the first live week acceptable, and what maximum drawdown triggers a human page?
3. Are extra source IPs (proxies) allowed, and who pays? It changes the whole keeper economics.
4. Run alongside the existing fleet (same IP, which would share the 2 req/s budget and halve both) or on a separate account/IP? Strongly prefer a separate IP; otherwise cap STAR at 20% of the IP's budget.
5. Hosting and storage: single small VM + Postgres/SQLite? Language (TypeScript for parity vs Rust/Python)?
6. Is mining in scope after M6, or stay a pure trader/keeper engine?
7. Do we have recorded market snapshots from earlier weeks to seed the simulator, and in what format?
8. Which numbers in the digest should be treated as hard policy (3M gate, 5M keeper gate) versus defaults the engine may tune?
9. Should W-08 (scrap hulls at the end) be explored, and who can confirm refund values?
10. Leaderboard rules: is only final wallet counted, or also ships? (We assume wallet only per the digest.)
