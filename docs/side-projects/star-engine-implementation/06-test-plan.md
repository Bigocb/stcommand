# 06. Test plan

Test layers (design plan 2.6): unit, property, replay against recorded market snapshots, fake API server, simulator, chaos.
Runner: vitest; property tests: fast-check. Everything is deterministic: a `FakeClock`, seeded PRNG, fixed `FC_SEED` in CI
(the nightly job uses random seeds and prints the seed on failure so the failure is reproducible).

Coverage targets (gate in CI): `src/core` lines >= 90% and branches >= 85%; `src/api/limiter.ts` and `src/store` >= 90%;
overall >= 80%. Coverage is a floor, not the goal: the properties below are the goal.

---------------------------------------------------------------------------------------------------

## 1. Unit tests (one file per module under `tests/unit/`, mirroring `src/`)

### 1.1 `marketModel`
| Test | Assertion |
|---|---|
| walkBuy monotone | avg buy price is non-decreasing in units; total equals sum over lots with the per-lot step |
| walkSell monotone | avg sell price non-increasing |
| impact 0 | avg equals first quote for any units |
| lot boundaries | units = k * tv gives exactly k lots; tv+1 gives k+1 lots |
| depthSell | the largest n with avg >= min; n+1 violates it (boundary test) |
| staleness | confidence 1 at 15 min, 0.5 at 45, 0 at 90, linear between; `unknown` at >= 90 |
| outlier | price 0, NaN, 6x jump rejected; 6x jump corroborated by two consecutive reads accepted |
| fit | feeding observations generated with impact 0.09 converges to 0.09 within 10% after 5 samples; clipped to bounds |
| cooling | route marked COOLING after spread below 0.6 of median; becomes eligible after `coolingMin` |
| over-feed | sell into ABUNDANT import clipped to 0 units, HIGH to one lot (M-01) |

### 1.2 `travel`
Distance symmetry and zero; `jumpHops` BFS on small graphs, unreachable = null; travel time monotone in distance and anti-monotone in speed; prior
used before `minFitSamples`, fit used after, predicted vs observed error computed; DRIFT never chosen when `allowDrift` false.

### 1.3 `opportunity`
| Test | Assertion |
|---|---|
| hand-computed route | a 2-market fixture with known prices yields exactly the profit computed by hand (written in the test as arithmetic) |
| floor | no plan contains a planned sale below `sellFloorFrac` of the planned buy average |
| ceiling | planned buy `last` never above `buyCeilFrac * firstAsk` |
| units constraint | units = min(hold, depthBuy, lotsAllowed*tv, share of sell depth - reserved) |
| stale discount | halving confidence halves a positive margin and never improves a negative one |
| paced | a route loaded 10 minutes ago is PACED with reason T-07 and next time |
| tie-break | two routes within epsilon prefer higher profit per call |
| high-margin trickle | tv 20, margin 0.5 -> units capped at 8 |
| determinism | shuffled input order gives identical output |

### 1.4 `allocator`
No ship assigned twice; a mid-trip ship is never reassigned; hysteresis keeps a route unless gain >= 15%; reservations sum under the share cap; heavy/bulk hulls never get a plan with units < 0.7 hold; idle > 10 min triggers G-10 with a reason; free ships with no plan get a HOLD decision (never silence).

### 1.5 `purchase`
| Test | Assertion |
|---|---|
| nearest yard | yard A 316,860/0 hops beats yard B 314,772/2 hops (+ jump costs) with the exact reason string; reversed when B is 0 hops |
| floors | wallet after < floor -> `wait` with reason; table-driven over the floor situations in 04 section 6.1 |
| stale price | yard price older than 120 s -> `wait: refresh` and no buy |
| slippage | re-read price over quoted by > 3% -> abort |
| cooldown | second buy inside `buyCooldownMin` waits; same-yard bulk cooldown |
| escape clause | fires on flat wallet 2 h / rate < 80k / idle >= 20%, at most once per 6 h, limited to 40% of wallet; does NOT fire when wallet < 150k and all routes negative |
| payback | hull with payback > max is rejected; hull choice picks min payback; heavy not chosen when `allowHeavy` false |
| wind-down | no bulk inside 10 h of reset, no hauler inside 8 h |
| disabled | `purchase.enabled=false` returns only `wait` |

### 1.6 `risk`
One test per X rule in 04 section 9, each with a minimal triggering decision and an expected verdict and reason; X-13 corroboration table: price 1c with another market paying 45% of cost -> veto naming the other market; paying 30% -> allow only if fresh re-read; under 10 minutes to reset -> allow.

### 1.7 `winddown`
`noNewBuysMin` = clamp(P95+5, 25, 60); default 35 with fewer than 30 trips; NEVER 120 for any input (property: output <= 60); hull stop times per class; cargo rules; unknown reset time -> no wind-down plus a warn flag.

### 1.8 `limiter` and `budget` (the hard budget)
| Test | Assertion |
|---|---|
| minute cap | with a FakeClock, 10,000 `tryAcquire` attempts over 10 simulated minutes never exceed the cap in any 60 s window |
| hour/day caps | same for hour/day with scaled configs |
| burst | after idle, no more than `burst` grants within 1 s |
| 429 | `on429` drains tokens, applies backoff, lowers the cap by `backoffFrac` for `backoffMin` minutes, restores afterwards |
| priority | with a full queue, priority 0 is always granted before 4; promotion after `starveMs` |
| shed | utilisation > 0.92 for 2 min sheds priority 4 then 3, never 0-2 |
| hot loop | 7th identical call in a minute is rejected with `budget.hot_loop` |
| no bypass | there is no exported function that sends without `tryAcquire` (grep-based test on `client.ts` usage) |

### 1.9 `store`
FIFO matching (partial lots, multiple lots, sold-more-than-held -> unmatched), `week_id` NOT NULL constraint, intent duplicate detection (`PRIMARY KEY` collision), rebuild equals incremental projections, single-writer lock.

### 1.10 `observer`, `schemas`, `recorder`
Fixture responses parse to domain types; unknown extra fields tolerated; missing required fields -> `invalid_payload` alert and no state change; recorder strips tokens (scan of output for the token string, for `Bearer`, and for fields named `token`).

### 1.11 Purity and policy
`tests/unit/purity.test.ts`: grep `src/core` and `src/domain` for forbidden tokens (`Date`, `Math.random`, `process.`, `fetch(`, `setTimeout`, `console.`); `dependency-cruiser` fixtures. `policy.test.ts`: default policy validates; each bound rejects out-of-range values with a readable error; every rule has `enabled` or is covered by a section switch; **policy-off equals no-op** (one test per section switch).

---------------------------------------------------------------------------------------------------

## 2. Property tests (fast-check; `tests/property/`)

Generators: `arbMarket` (prices, supply, tv), `arbSnapshot` (up to 40 waypoints, 8 ships, random positions, random reservations, wallet), `arbPolicy` (within bounds), `arbEventStream` (valid sequences of trades/refuels).

| Property | Statement |
|---|---|
| P1 ledger conservation | For any sequence of valid trades, `wallet_end = wallet_start + sum(ledger.amount)`; FIFO `sum(units_open) = bought - sold` for every (ship, good); no negative `units_open` |
| P2 no negative wallet | Starting from any wallet, applying `decide` + RiskGuard-allowed decisions in the fake exchange never makes the wallet negative or below `minWallet` except fuel |
| P3 idempotent intents | Submitting the same intent N times in one epoch bucket yields exactly one executed call and N-1 duplicate rejections |
| P4 budget invariant | For any random request arrival process and any budget config, the number of sends in every 60 s window <= effective cap; in every 3,600 s window <= hour cap |
| P5 decide determinism | `decide(s,p) == decide(shuffle(s),p)` (key order shuffled) and `decide` does not mutate `s` (deep freeze) |
| P6 reasons | Every Decision from `decide` has non-empty reason <= 240 chars; when `decide` emits no action for a free ship, there is a skip/hold with a reason (X-06) |
| P7 floor/ceiling | No allowed SELL is below `sellFloorFrac * costBasis` (outside W-04); no allowed BUY unit price above `buyCeilFrac * plannedFirstAsk` |
| P8 reservation | Sum of reserved units at any sink <= `sellDepthShare * depth` |
| P9 wind-down | For any `hoursToReset`, no buy decision is allowed when `minutesLeft <= noNewBuysMin`; `noNewBuysMin <= 60` |
| P10 rebuild | `rebuildProjections()` after any event stream yields the same projections as incremental maintenance |
| P11 FSM | The process FSM can only follow transitions in the allowed graph (03 section 6.2) for any random sequence of detector signals |
| P12 monotone purchases | With wallet w1 <= w2 and everything else equal, if the planner buys at w1 it buys at w2 (monotone in cash) |
| P13 policy hot-reload | Any random invalid policy edit is rejected and leaves the old policy active |

Settings: default 100 runs in CI with the fixed seed; nightly 10,000; shrinking enabled; every found counterexample becomes a
regression fixture under `tests/fixtures/regressions/`.

---------------------------------------------------------------------------------------------------

## 3. Replay tests against recorded snapshots (`tests/replay/`)

Input: NDJSON recordings (03 section 7). A tiny committed sample (`recordings/sample/`, under 2 MB, synthetic or scrubbed) is
used in CI; real recordings stay local and are used by `npm run replay -- <dir>`.

Replay harness (`cli/commands/replay.ts`):
```
load events in file order
for each line (timestamp t): FakeClock.set(t); feed observer; every tickMs of simulated time run buildSnapshot + decide
collect Decision[] with their timestamps -> write decisions.ndjson
```
Checks (each is a test or a report column):
1. Determinism: two runs produce identical `decisions.ndjson` (byte compare).
2. Invariants over the replay: no decision violates floors, ceilings, budget shares, or wind-down windows; no decision has an empty reason.
3. Stability: the same route is not flip-flopped between assignments more than once per hour (flap counter).
4. Paper ledger (07): scores would-have trades against later observations in the same recording.
5. Simulator fit check: for the held-out last 20% of each market's observations, the market model's one-step price prediction is within 10% for >= 80% of observations (design acceptance for the simulator; threshold to tune; the test only reports below the threshold in M0 and gates from M2).
6. Golden decision snapshot: `tests/replay/golden/<name>.decisions.ndjson` is compared with the new output; intended changes are reviewed as diffs (`npm run replay:update` regenerates).

Data wanted (OPEN QUESTION Q-SEED): recorded market snapshots from earlier weeks in a documented format to seed the simulator calibration; the operator's stcommand holds `market_snapshots` history (not accessible from this plan). The harness has an importer for an operator-supplied NDJSON of rows `{tMs, waypoint, good, buyPrice, sellPrice, supply, activity, tradeVolume}` (07 section 4).

---------------------------------------------------------------------------------------------------

## 4. Fake API server (`sim/fakeApi`)

Purpose: integration, chaos and sim tests without touching the real game. It is the "other side" of `03`; because (A)
endpoints are unverified, the fake server is generated FROM the schemas/fixtures captured in M0-3, so a wrong assumption
shows up as a failing schema fixture rather than a silently wrong fake.

Implementation: `node:http` (no framework), in-process on an ephemeral port, started per test. State in memory.

| Area | Behaviour |
|---|---|
| World | Seeded generator: N systems, waypoints with coordinates, traits, gates; markets with goods, supply, activity, tv; yards; start agent with 175,000 credits (design) and the start ships |
| Endpoints | Every endpoint in 03 section 2.2 with the same status codes and error shapes as captured in M0-3 |
| Time | A virtual clock the test advances; travel arrival computed by the same travel model parameters (the fake uses the TRUE game formula, which may differ from the engine's prior; tests assert the engine's fit converges) |
| Rate limit | Implements the per-IP limiter: 2 req/s, burst 30, 429 with `retry-after`; the bucket is keyed by the test's declared "source IP" (header `x-test-ip`) so tests can show two clients on the same IP halve each other and a client on another IP does not |
| Faults (`faults.ts`) | Configurable per endpoint: 429 storm for T seconds, timeout BEFORE processing, timeout AFTER processing (request applied, response lost), 5xx, malformed JSON, dead-token 401 with the reset text, reset-at-T (token invalidation and a new world), slow responses |
| Auth | Account token for register; agent tokens; dead tokens after a reset |
| Determinism | Seed and a scenario file make every run reproducible |

Scenario file (`sim/scenarios/*.json`): `{seed, world, startMs, durationHours, faults:[{at, kind, params}], expectations:[...]}`.
Expectations are invariants checked at the end (no negative wallet, final profit >= x, budget never exceeded, no duplicate purchase).

Must-have scenarios:
`opening-basic`, `crash-loop` (the 40-unit/90 s loop reproduces the crash), `timeout-after-success-buy`, `timeout-after-success-purchase-ship`, `429-storm-5min`, `proxy-down`, `reset-mid-run`, `reset-with-429-on-status`, `registration-fails-twice`, `second-reset-during-bootstrap`, `stale-snapshot-after-restart`, `kill-switch-mid-trade`, `fuel-starved-leg`, `gate-ceiling-wait` (M3-D), `100x-week`.

---------------------------------------------------------------------------------------------------

## 5. Market simulator (`sim/marketSim.ts`): the only custom physics

State per (waypoint, good): `{stock, tradeVolume, supply, activity, basePrice}`; price = f(stock) reversible (design); our trades
move stock by units; markets tick every 30 simulated minutes (design: ~30 min tick).

Parameters (calibrated; every parameter per (waypoint, good), defaults flagged PRIOR):
| Parameter | Meaning | Source |
|---|---|---|
| `impactPerLot` | price change per tradeVolume lot of our units | design ~4-5% default; FAB_MATS +3.5-5.6% per 20-unit lot; ALUMINUM 8-10% per 40-unit load at tv 60 |
| `recoveryPerTick` | fraction of displacement recovered per 30-min tick | PRIOR; design: FAB_MATS refill ~4-9c/hour when WEAK/RESTRICTED (slow) |
| activity dynamics | import activity climbs over hours of sustained delivery (iron WEAK -> STRONG over ~12 h of feeding) | design |
| export restriction | export RESTRICTED while any input SCARCE; WEAK once inputs LIMITED or better | design |
| tradeVolume growth | rises with sustained heavy trading (20 -> 43 in ~30 min steps) | design |
| shipyard price creep | each purchase steps the yard price 0.6-2% | lessons |
| fresh-system premium | a newly covered system pays ~1.7x profit per unit for ~2-8 h (modelled by lowering initial prices) | design A9: cause unknown |

Calibration acceptance (design): the 40-unit / ~90 s loop on a tv-60 good reproduces, within 20% on the price path, the
observed crash: buy price 167 -> 552 and sell price 266 -> 127 in 35 minutes (ALUMINUM, 2026-10-06). The `crash-loop` scenario
asserts this with `impactPerLot` fitted for that good (~0.12-0.15 per lot) AND asserts the engine's pacing rule (T-07/T-08)
stops the loop long before the crash completes. Held-out-recording fit: one-step price within 10% for >= 80% of observations (06 section 3.5).

Simulator also includes: API latency (lognormal around 300-500 ms), 429s from the fake server, jump and fuel costs, and ship
purchase price creep. The 100x week scenario runs a whole simulated week in under 5 minutes of wall time (design M0 criterion) by
using the virtual clock and skipping real sleeps.

---------------------------------------------------------------------------------------------------

## 6. Chaos tests (`tests/chaos/`; nightly and before every live milestone)

Each runs a fake-server scenario with the full shell wired (LiveExecutor in the fake world) and asserts invariants P1-P4 plus the specific outcome.

| # | Fault | Expected outcome |
|---|---|---|
| C1 | 429 storm for 5 min on all endpoints | limiter backs off, no cap breach, no 429 ratio blow-up after recovery, trades resume; priority 0 not starved |
| C2 | Timeout AFTER a buy was applied | executor reads cargo and wallet, marks the intent CONFIRMED, no second buy |
| C3 | Timeout BEFORE a buy was applied | executor reads, finds it did not happen, creates a NEW intent (attempt+1) and succeeds once |
| C4 | Timeout after `buyShip` applied (M3-A) | exactly one ship; the double-hull incident of 2026-10-08 never reproduces |
| C5 | 5xx on navigate | ship refreshed (X-05), re-planned, no stuck state |
| C6 | Stale snapshot after restart | startup reconciliation reads all ships first; no decisions from the stale one |
| C7 | Reset mid-trip | latch -> FREEZE -> ARCHIVE; no calls with the dead token except status |
| C8 | Reset + 429 on the status poll | retries, detection within 2 intervals |
| C9 | Registration fails twice | alerts, 60 s spacing, fallback callsign once, never a tight loop |
| C10 | Second reset during bootstrap | FSM restarts from RESET_DETECTED |
| C11 | Proxy down | no direct fallback ever (assert zero requests with the direct dispatcher), breaker, alert, recovery |
| C12 | Kill switch mid-trade | new intents stop within one tick; the open trip follows policy `onKill` (hold cargo, do not dump) |
| C13 | Drawdown breach | autonomy to 0, alert, state preserved |
| C14 | Clock jump (suspend/resume) | arrival times from the API, no negative durations, budget windows not corrupted |
| C15 | Disk full on recording | recorder stops with an alert; the engine and store continue (recorder is not on the critical path) |
| C16 | Malformed JSON / schema drift | `invalid_payload` alert, observation dropped, no crash |
| C17 | Two instances | the second refuses to start (lock), the first unaffected |
| C18 | Hot loop bug injected | B-08 throttles; the budget cap holds |

---------------------------------------------------------------------------------------------------

## 7. Integration tests (`tests/integration/`)

Shell + store + fake server, no faults: bootstrap reads the expected number of calls (<= `bootstrapReadBudget`); a full
route trip end to end (the ledger shows one BUY and one SELL with correct FIFO profit and the `trip.closed` event shows planned vs
realised); shadow mode against the fake server issues zero non-GET requests; recorder output replays to the same decisions;
status endpoint JSON matches the schema; policy hot-reload applies at a tick boundary and writes `config.change`.

## 8. Test data hygiene
- Fixtures contain no real tokens or callsigns; scrub before committing recordings (`scripts/scrub.mjs`).
- Golden files are small; large recordings are not committed.
- No test calls the real SpaceTraders API. The only allowed real-network step is the manual M0-3 docs/schema capture, done by the operator or the implementer by hand, never in CI.
- Time-dependent tests use `FakeClock`; any use of the real clock in `src/core` is a failing test.

## 9. Definition of done for any module
1. Unit tests incl. policy-off no-op; 2. property tests where listed; 3. one seam test at the shell caller; 4. reasons present;
5. the module appears in the replay run without errors; 6. documented in the module file header with its rule ids; 7. `npm run check` green.
