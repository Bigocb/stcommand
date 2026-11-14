# 07. Shadow comparison harness

Goal: run STAR beside the operator's live stcommand fleet (agent THEO) during the week of 2026-11-15 to 2026-11-22 and
produce a FAIR, honest comparison, without touching the live fleet in any way.

What "fair" means here: STAR is a different agent. It registers into the same universe but starts at its own headquarters,
with its own ships, its own API budget and (in M0) no real trades. So raw outcome numbers cannot be compared
head-to-head. This file defines (a) how STAR runs without interfering, (b) how its would-have decisions are scored on a
paper ledger, (c) a method that removes the position difference by evaluating STAR's decisions on the live fleet's own
situations, (d) normalised metrics for the independent-agent view, and (e) what is recorded so that every difference can
be attributed.

---------------------------------------------------------------------------------------------------

## 1. Non-interference rules (hard)

| # | Rule | Reason |
|---|---|---|
| N1 | STAR uses its OWN agent token and account credentials; it never reads or uses any stcommand token, MCP server, API key or database | independence; the lowercase/other MCP servers have been unreliable |
| N2 | STAR leaves from a DIFFERENT source IP (03 section 3). It never shares the box's IP, the live fleet's proxy lanes, or `CRAWLER_PROXY_URL` | the limit is per IP; a shared IP halves both (measured 2026-11-02) |
| N3 | STAR sends no mutating game call in M0 (only the one registration POST, and, if explicitly enabled, own-ship moves; Q-SHADOW-INTEL) | zero effect on markets |
| N4 | STAR runs on a SEPARATE machine or VM (or at minimum a separate disk volume and OS user) from the stcommand box | the live box hit "No space left on device" on 2026-11-13; recordings are large; CPU contention could add latency to the live fleet |
| N5 | Nothing in STAR reads files from the stcommand repo or box at runtime. Any data from the live fleet arrives as an operator-placed export file in `imports/` (section 4) | one-way, auditable data flow |
| N6 | The total STAR request volume is capped by its hard per-minute cap (default 60 in shadow). A daily review compares `api_calls` to the cap | proof of low footprint |
| N7 | STAR's registration must not use the same callsign pattern as the live agent and must not claim to be the live fleet (the user-agent string is generic) | no confusion in game logs |
| N8 | If STAR ever goes live (M1+) in the same universe, it competes for the same markets: see 8 (interference) before turning it on during a week when the live fleet matters | markets are shared |

## 2. Topology

```
 [stcommand box, live fleet THEO]                           [STAR machine, own IP via STAR_PROXY_URL]
   (untouched; no inbound from STAR)                          star shadow  -> GET only -> SpaceTraders API
        |                                                      records/  decisions/  paper_trades  report
        | operator-run read-only export (optional, files)      ^
        +----> imports/live-export-YYYY-MM-DD.ndjson ----------+   (copied by the operator by hand: scp/USB; STAR never connects back)
```

Time line for next week (UTC):

| When | What |
|---|---|
| Before 2026-11-15 13:00 | Scaffolding and M0 tasks as far as complete; `doctor` passes on the STAR machine; STAR NOT running (a registration before the reset would die at the reset) |
| 2026-11-15 13:00-13:30 | Reset. Operator or STAR registers the new agent (M4-1 is not built yet: operator registers by hand with the account token and puts the agent token into `secrets/agent-token`, then `star shadow --config ...`) |
| +0 to +6 h | Shadow runs; recorder on; first `report` at hour 6 |
| daily | `star report --daily`; operator drops `live-export` for the elapsed day; `star compare` run (section 6) |
| 2026-11-22 12:00 | Final `report --week`; leave STAR running through the reset to test detection (M0 criterion 7); it freezes and archives |

---------------------------------------------------------------------------------------------------

## 3. The shadow loop and the paper ledger

### 3.1 What shadow mode does each tick
Same pipeline as live (snapshot, `decide`, risk review) but `ShadowExecutor` replaces the live executor:
1. Observer reads what the budget allows (GET only) and the import feed (section 4). The snapshot contains the agent's own (idle) ships at their real positions: in strict read-only mode they never move (Q-SHADOW-INTEL option 1), so the engine evaluates routes AS IF a ship stood at each candidate position ("virtual ships", section 3.3), which is what makes shadow decisions comparable.
2. `decide()` produces Assignments and trade decisions with reasons; `ShadowExecutor` writes them as `decision` events and `intent` events with state `SHADOWED`, and creates a `paper.trade` for each trade assignment.
3. Time and wallet advance only on the paper ledger: the paper wallet starts at the agent's real credits (175,000 if that is the start) and is updated by paper trades. The paper wallet and the real wallet are never mixed in any table.

### 3.2 Paper trade lifecycle (pure reducer `paperLedger.ts` in `core/telemetry`)

```
on assignment (route A->B, good g, units u) decided at time t0 by virtual ship v:
    planned: buyAvg = walkBuy(view(A,g), u).avg using the snapshot at t0 ; plannedSellAvg = walkSell(view(B,g), u).avg
    arrivalA = t0 + travel(v.pos -> A) ; arrivalB = arrivalA + load time + travel(A -> B)        (model times; fitted travel parameters)
    record paper.trade {decidedMs: t0, units: u, plannedBuyAvg, ...}
on first OBSERVATION of market A for good g at time in [arrivalA - slack, arrivalA + 30 min]:   // "buy side verification"
    realBuy = walkBuy(observedView(A,g), u).avg        // apply our own impact model to the observed quote
    paper cash -= u * realBuy
on first OBSERVATION of market B for good g at time in [arrivalB - slack, arrivalB + 30 min]:   // "sell side verification"
    paperSell = walkSell(observedView(B,g), u).avg
    paperProfit = u*(paperSell - realBuy) - costs(hops*jumpCost + fuel)
    confidence = 'verified'
if no such observation exists by arrivalB + verifyWindowMin (default 90): confidence = 'unverified', paperProfit = planned profit * 0 (reported separately, NOT counted in the headline)
```
Rules for honesty:
- Only `verified` paper trades count toward headline paper profit; `unverified` ones are reported as a count and share.
- Paper trades apply the engine's own price-impact model, so they are NOT evidence that the impact model is right; they test the route SELECTION. The impact model is tested separately against recordings (06 section 3.5).
- Paper trades respect the same pacing and reservations as live (otherwise paper profit would be inflated by repeating the best route every minute).
- Paper ships obey the same capacity: the paper fleet size is the real ship count (2-4 at the start) unless the run is configured with `paper.virtualFleet: N` for what-if runs; the headline always uses the real count.

### 3.3 Virtual ships
For decision-quality comparison (section 5.A) the engine can be asked "what would you assign to a ship of class C with hold H, fuel F, at waypoint P with wallet W". The snapshot builder can add a virtual ship (flag `virtual: true`); virtual ships never produce intents, only `decision` events marked `virtual`.

---------------------------------------------------------------------------------------------------

## 4. Import feed: market and trade data exported from the live fleet (optional but strongly recommended)

Why: prices are only visible where a ship is present (A), and STAR in M0 has 2-4 stationary ships. The live fleet reads
hundreds of markets every ~15-20 minutes (keeper rotation 13-22 minutes at the plateau). An export gives STAR broad market
coverage for free, with no extra API calls, and gives the comparison its ground truth.

The export is produced by the OPERATOR (or an stcommand session) from stcommand's own read-only data, outside this repo.
STAR defines only the file formats; it never connects to stcommand. OPEN QUESTION Q-EXPORT: the operator must agree to supply
it, and decide how often (hourly files are enough).

### 4.1 Format: NDJSON, one object per line, UTF-8, times in epoch milliseconds UTC

```jsonc
{"type":"market","tMs":1731686400000,"waypoint":"X1-AB12-C3","system":"X1-AB12","good":"IRON_ORE","kind":"EXPORT","buyPrice":120,"sellPrice":110,"supply":"HIGH","activity":"STRONG","tradeVolume":60}
{"type":"trade","tMs":1731686401000,"ship":"THEO-5","waypoint":"X1-AB12-C3","good":"IRON_ORE","side":"BUY","units":40,"pricePerUnit":121,"total":4840,"walletAfter":181234}
{"type":"ship","tMs":1731686410000,"ship":"THEO-5","hull":"SHIP_LIGHT_HAULER","cargoCapacity":80,"waypoint":"X1-AB12-C3","nav":"DOCKED","fuel":90,"cargoUsed":40}
{"type":"hour","hourStartMs":1731686400000,"matchedProfit":412345,"wallet":9123456,"ships":210,"selling":18,"apiCallsBox":78,"calls429":2}
{"type":"meta","exportedAtMs":1731690000000,"fleet":"live","universe":"2026-11-15","note":"..."}
```
Fields named here are STAR's import schema, not the game's. Prices follow the same convention as `GoodQuote` (buyPrice = what a buyer pays at the market). The importer (`src/shell/importFeed.ts`) validates with zod, drops unknown types, stamps `source:'import-file'` and appends `observation.market` events; trades and ships go to a separate `live_reference` table (never into STAR's own ledger or lots).

Privacy/safety: the export must contain NO tokens, keys or credentials and no operator names; STAR's import test rejects any line containing `token`, `Bearer` or a long base64-like string.

Coverage caveat: market rows from the live fleet are observations by ITS ships, taken at its own times; STAR's decisions using them are legitimate (public information in the game) but STAR cannot act on them in M0 anyway.

### 4.2 What to export (list for the operator; minimal)
1. Market quotes (all goods) per market whenever stcommand read them, last 24 h at a time.
2. Completed trades of the live fleet (buy and sell lines per ship) with timestamps and wallet-after.
3. Hourly profit-curve rows (matched profit per hour, wallet, selling-ship count, box API calls and 429 count). The live system keeps an hourly `profit_curve`, an `api_calls` history and a ledger; the exact export query is the operator's; STAR only reads the file.
4. Ship roster snapshots every ~15 minutes (class, cargo capacity, position, nav status).

---------------------------------------------------------------------------------------------------

## 5. Metrics

Definitions are computed by pure reducers over events/tables, one function per metric, tested against hand-computed fixtures (06).

### 5.1 Core metrics (STAR side; the same definitions applied to the live reference where data allows)

| Metric | Definition | Notes |
|---|---|---|
| Matched profit per hour (MPH) | sum of matched profit on completed round trips in the window / hours. Live: `ledger.matched_profit`. Shadow: `paper_trades.paper_profit` where `confidence='verified'` | The same FIFO matching method the live fleet's operator uses: pair a sell with an earlier buy of the same ship and good; leftovers are open positions, not losses; wallet delta is NEVER the profit |
| Wallet | live: real credits. Shadow: paper wallet (start + paper profit - paper spends), always labelled PAPER | never summed with real |
| Equity | wallet + holds at expected fetch | working measure only |
| Calls per profit unit (CPP) | API calls sent in the window / (profit in thousands of credits) | the binding-constraint metric. Live has ~105 calls/min; STAR shadow ~<=60/min |
| Profit per call | inverse of CPP | |
| Profit per ship-hour (PSH) | profit / sum over ships of hours the ship was assignable | normalises fleet size |
| Profit per hold-unit-hour | PSH / cargo capacity | normalises hull class (the live fleet's profit rose with bulk freighters: 490-hold) |
| Profit per sale and per unit | profit / sells; profit / units sold | live reference: 17.9k then 27.3k per sale, 49-57 units per sale, 352-475 profit/unit in the last 24 h of the two weeks |
| Idle fraction | ship-hours without an assignment / ship-hours | stall detector |
| 429 ratio | 429 responses / total | live reference 3-4% at the plateau; STAR target under 1% |
| Budget utilisation | calls last minute / hard cap | |
| Decision agreement | section 6.A | |
| Regret | oracle profit - achieved, per decision, section 6.A | |
| Staleness | median age of the quotes behind each decision | |

### 5.2 Reference numbers from the live fleet (for orientation; from the lessons doc; not targets for STAR)

| Window | Reference |
|---|---|
| Command ship alone, first 5-6 hours (home system) | 2.2M in hours 1-5 (0.43M/h) in the week of 11-08; 1.5M in the first 6 h in the week of 11-01 |
| Home system after hour 8-10 | profit per unit down about 90%; fleet about 0.1-0.25M/h until the gate opens |
| Cumulative matched at hours 24/48/72/96/120/147 (week of 11-08) | 4.15M / 7.24M / 12.99M / 36.7M / 145.9M / 402.6M |
| Selling ships | 21-22 selling ships at 5M/h (about 0.26M/h per selling ship) |
| Wallet / cumulative matched | 62-65% |
| API | 105 calls/min limiter, box lane 55-90 calls/min, 3-4% 429 |

STAR in shadow on an equivalent day-1 window should be compared to the first row of this table only through section 6 (not directly),
because the home system, start ships and opening are different.

---------------------------------------------------------------------------------------------------

## 6. How to compare fairly

Three complementary methods; report all three and say which is strongest. None is an experiment; each is a correlation with
stated sample sizes (design 5.2).

### 6.A Counterfactual on the live fleet's own situations (strongest; removes the position difference)

Idea: take real decision points of the live fleet (a ship became free at a place with a hold, fuel, wallet, at time t), reconstruct the
snapshot at t from the exported market rows, and ask STAR's `findRoutes`/`allocate` what it would have done for THAT ship. Then
evaluate both choices with the same later observations.

```
for each live trip start (ship s, time t, position p, hold H, fuel F):      // from export: the first BUY of a trip
    snap_t = snapshot built from import rows with tMs <= t (apply STAR staleness rules)
    star_plan = scoreAndRank(snap_t, virtual ship (class(s), H, F, p))[0]
    live_plan = the route the ship actually executed (buy waypoint, good, sell waypoint, units)
    outcome_live  = live realised matched profit of that trip (from export trade lines)                    // ground truth
    outcome_star  = paper outcome of star_plan using the observed sink quote after arrival (section 3.2)   // verified or not
    also compute oracle = best verified paper outcome among all candidate routes for that ship at t (hindsight)
record per decision: agree = (star_plan.route == live_plan.route), ratio, regret_live = oracle - outcome_live, regret_star = oracle - outcome_star, tripHours estimates, calls per trip
```
Aggregate: agreement rate; mean and median regret of each side with a bootstrap 90% interval over decisions (resample by hour to respect autocorrelation; minimum 200 decisions else "insufficient data"); profit-per-hour difference restricted to decisions where both outcomes are `verified`; breakdown by hull class and by system age (fresh premium systems vs old).
Caveats to print in every report: the live fleet's own trades moved the prices the paper trade is then evaluated on (its sells depressed the sink), so `outcome_star` for a route the live ship did NOT take is evaluated on an undisturbed sink, which flatters STAR slightly; and for a route the live ship DID take, STAR's paper trade double counts the impact. Mitigation: for agreed routes use the live outcome for both; for disagreements flag `undisturbed_sink_bias`.

### 6.B Independent agent, normalised

STAR (when live, M1+) or its paper fleet vs the live fleet, normalised:
1. Per ship-hour and per hold-unit-hour, cohort by hull class (live cohort: hulls of the same class that were selling in the same hours).
2. Per API call: CPP and profit per call.
3. First-N-hours curve from the agent's own start (both started the week with the same 175,000 credits per the operator's notes; check at registration: start ship counts can differ, Q-START). Report cumulative at hours 6, 12, 24, 48 next to the live reference table in 5.2, with the context columns in 6.D, and NO ranking claim when contexts differ.
4. Rolling 6-hour windows (so a single lucky trade does not dominate), reporting median and interquartile range.

### 6.C Opportunity-capture ratio (position-independent)

`capture = achieved profit / oracle profit` over the same window, where the oracle is the best fully-informed paper profit for the same ship fleet
(same hulls, positions, holds) using the observed quotes in hindsight with the same pacing and reservation constraints. Because each agent is divided by ITS OWN opportunity set, home-system differences cancel to first order. Compute it for STAR (paper) and, where the export allows, for the live fleet. It is a bounded diagnostic (0..1), not a profit claim. State the oracle's definition in every report (greedy hindsight with the same constraints; it is NOT a true optimum).

### 6.D Context recorded with every comparison window (so differences are attributable)

| Field | STAR | Live |
|---|---|---|
| Agent / week id, home system, number of markets in the home system | recorded at bootstrap | export `meta` |
| Ships by class, start credits | bootstrap | export |
| Markets known with prices, share fresh (< 45 min) | snapshot | export |
| Budget cap and measured calls per minute, 429 ratio, source IP class (separate / shared) | `api_calls` | export `hour` rows |
| Autonomy level and mode | config | n/a |
| Gate state (open or not), live systems count, hours since reset | observed (A: STAR's own gate is a different gate) | export |
| Policy version and param hash | `policy_versions` | n/a |

### 6.E Statistical hygiene (mandatory)
- Every figure carries n (sells, trips, hours). Under 30 sells or 200 decisions: print "insufficient data".
- Bootstrap intervals by hour blocks; no p-values from tests that assume independence.
- Never present paper profit as money earned. Never add paper and real.
- Do not compare totals over different durations; compare rates and curves.
- Weekly report states what could NOT be compared and why (different home system, different start fleet, shared market impact).

---------------------------------------------------------------------------------------------------

## 7. Recording fairly: a checklist to run during the week

1. `doctor` before start: separate IP proven, clock skew under 2 s, disk free over 20%, schema/fixture check against the first `/` status response, policy hash recorded.
2. At bootstrap, store a `context` event with the 6.D fields; refresh it every 6 hours.
3. Record in `recordings/` continuously (03 section 7); rotate daily; copy the previous day's file off the machine (the live box's disk lesson).
4. Never edit policy during a comparison window without a `config.change` event; if policy changes, start a new comparison window (a new `policy_version` segment) so before/after is separable.
5. Keep STAR's tick schedule fixed (1.5 s core, 5 s maintenance) so decision counts are comparable across days.
6. Save, per day: `report-YYYY-MM-DD.md`, `decisions-YYYY-MM-DD.ndjson.gz`, `paper-trades-YYYY-MM-DD.csv`.
7. At the end: `star report --week` with the tables in section 8 and the list of things not comparable.

## 8. Report format (`star report --week`, markdown, generated; hand-written commentary is separate)

1. Header: week id, mode, hours observed, context table (6.D).
2. Budget proof: max calls in any 60 s window vs cap; mutating call count (must be 0 in M0); 429 ratio; calls per profit.
3. Decision log health: decisions, skips by rule, vetoes by rule, silent skips (0), reasons coverage 100%.
4. Paper ledger: verified paper trades, paper profit/h, share unverified, by hull class and route class.
5. Method 6.A table (agreement, regret, hourly profit difference with intervals) if an export was provided.
6. Method 6.B normalised table and 6.C capture ratio.
7. Market model quality: predicted vs observed price (one-step) error distribution, impact fits per (wp,good) with sample counts, the ALUMINUM-style discrepancy list (04 section 2.1).
8. Findings and suggestions: each suggestion names the exact policy path and proposed value (advisory only, nothing applied).
9. Not comparable / caveats / open questions raised.

Interference note for live STAR (M1+): STAR's own trades move shared markets (about 4-5% per lot); the live fleet's hundreds of ships also move them. During a week
when STAR trades live in the same universe, STAR keeps `sellDepthShare` at 0.5 or lower, avoids a hard list of markets the operator names, and the report estimates its own
footprint (units sold per market per hour). OPEN QUESTION Q-INTERFERE: whether the operator accepts any live STAR activity in a universe where THEO plays; recommended default: shadow only until the live fleet's week has ended (after 2026-11-22 13:00 UTC), then M1 on the new week.
