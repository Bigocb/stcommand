# 04. Decision engine (no LLM)

All of this is PURE code in `src/core` (D3). Inputs: a `Snapshot` and a `Policy`. Output: `Decision[]`, each with a one-line
`reason` (X-06). Rule ids (`O-`, `G-`, `T-`, `M-`, `B-`, `K-`, `E-`, `C-`, `X-`, `S-`, `W-`) are the design plan's; this file
gives the exact formulas. Numbers come from the design plan and the 2026-11-14 lessons; every number is a policy
parameter (section 12), never a constant in code.

Honesty marker: three kinds of numbers appear below.
- POLICY: a tunable default taken from the design plan or the lessons (source cited).
- PRIOR: an initial guess for a model parameter that the engine FITS from observations (starting value is a placeholder, flagged PRIOR).
- (A): an assumption about the game API (verify in M0).

---------------------------------------------------------------------------------------------------

## 1. What the engine decides, in one picture

```
per tick:
  phase      <- winddown.phaseFlags
  views      <- marketModel.viewMarket for every (waypoint, good) with a recent observation
  plans      <- opportunity.findRoutes per ship class (generate, score, pace, reserve-aware)
  assigns    <- allocator.allocate (greedy, reservation-aware, hull-fit)
  purchases  <- purchase.planPurchase (only if autonomy>=2 and cash gates / phase allow)
  all        -> risk.review -> Decision[] (+ skips with reasons)
ship worker executes the assignment lot by lot, calling risk.review per lot (T-03, T-04, T-05, X-13)
```

---------------------------------------------------------------------------------------------------

## 2. Market model (`marketModel.ts`)

State per (waypoint, good): last quote (`buyPrice` = ask we pay, `sellPrice` = bid we receive, `supply`, `activity`, `tradeVolume`),
observation age, fitted impact per lot, recovery rate, cooling flag. Facts from the design plan: price is a function of
stock, path-independent and reversible; our own units move it about 4-5% per tradeVolume lot; markets update on a ~30 min
tick; fast loops crash the spread; trade volume grows with sustained heavy trading.

### 2.1 Price walk (per-lot step model)

Within one lot the price is treated as flat; after each full lot of `tv` units the price steps by `impact` (a fraction).
(Simplification: the true per-unit curve is unknown; OPEN QUESTION Q-CURVE: fit per-unit vs per-lot from recordings in M0.)

```ts
// buy side: we pay the ask, which rises as we buy
function walkBuy(view, units, p): {avg, last, lots, total} {
  const tv = Math.max(1, view.lastQuote.tradeVolume);
  const i  = view.impactPerLot;                    // prior policy.market.impactPerLotDefault = 0.045 (design: ~4-5%/lot); fitted per (wp,good) by M-05
  let total = 0, left = units, lot = 0, price = view.lastQuote.buyPrice;
  while (left > 0) {
    const n = Math.min(tv, left);
    total += n * Math.round(price);
    left -= n; lot++;
    price *= (1 + i);
  }
  return { avg: total / units, last: Math.round(price / (1 + i)), lots: lot, total };
}
// sell side: we receive the bid, which falls as we sell
function walkSell(view, units, p) { /* same loop with price *= (1 - i), starting at view.lastQuote.sellPrice */ }
```

Fitting `impactPerLot` (M-05): after each of our own lots the response (or the next read) gives the new price. Per (wp,good),
keep an EWMA of `(priceAfter/priceBefore - 1) / (units/tv)`, `alpha = impactEwmaAlpha (0.2)`, after at least 3 samples; before
that use the default. Bounds: `[0.01, 0.20]`; values outside are clipped and flagged.
KNOWN DISCREPANCY to resolve with data (do not paper over): FAB_MATS 20-unit lots moved +3.5-5.6% (about the 4-5% default),
while ALUMINUM 40 units at tradeVolume 60 moved 8-10% per load, i.e. about 12-15% per full lot. So impact is market/good
specific; the global default is only a starting point, and the simulator (06) must use per-(wp,good) values.

### 2.2 Depth

```ts
depthSellUnits(view, floorPriceFn): largest n such that the average sell price walkSell(view,n).avg >= minSellAvg   // minSellAvg from the route's cost basis: plannedBuyAvg*(1+minMarginFrac)
depthBuyUnits(view, ceilPrice):     largest n such that walkBuy(view,n).last <= ceilPrice = firstAsk * buyCeilFrac (T-05, 1.15)
```
Cap both at `lotsAllowed * tradeVolume` (T-06, `lotsAllowed` 1.5).

### 2.3 Staleness and confidence (T-02, K-04)

```
ageMin = (now - observedAtMs) / 60000
confidence(ageMin) = 1.0                                        if ageMin <= policy.market.freshMin (15)
                   = linear from 1.0 at freshMin to 0.5 at maxPriceAgeMin (45)
                   = linear from 0.5 at maxPriceAgeMin to 0.0 at hardStaleMin (90)
                   = 0                                           if ageMin >= hardStaleMin
unknown = ageMin >= hardStaleMin  (K-04: excluded from routes)
```
Applied by shrinking the expected margin of a route toward zero: `expectedSellAvg_eff = buyAvg + (sellAvg - buyAvg) * min(confBuy, confSell)`.
(If the margin is negative nothing is shrunk: a stale route is never made more attractive.)

### 2.4 Cooling and recovery (T-07, T-08, M-04)

- Spacing: after our load at (A,B,good) at time `t`, the route is PACED until `t + minRevisitMin` where `minRevisitMin = max(policy.pace.minRevisitMin (35), spacingFromRecovery(view))` and `spacingFromRecovery = ceil(30 * ln(displacementFrac/0.1) / ln(1/(1-recoveryPerTick)))` bounded to `[30, 240]` min (the market tick is ~30 min; recover until residual displacement under 10%). `recoveryPerTick` PRIOR 0.25 (a quarter of the displacement recovered per 30-minute tick; UNVERIFIED, fit from `market_history` after our trades; the design only says "recovers only ~4-9c/hour when WEAK/RESTRICTED" for FAB_MATS at F53, which implies recovery depends on activity: use a lower prior 0.10 when `activity` is WEAK or RESTRICTED).
- Cooling (T-08): if the realised spread of the last trip on the route is below `minSpreadFrac (0.6)` of its 24 h median, mark COOLING for `coolingMin` (90) and exclude it.
- Trade volume growth (M-04): when an observed `tradeVolume` rises after heavy trading, the allowed lots rise with it: `lotsAllowedEff = lotsAllowed * (tvNow / tvAtFirstSight)^tvGrowthWeight` (0.5), decaying back over 6 h.
- Export health (M-02): if a market's EXPORT activity is RESTRICTED, do not plan purchases from it (state UNKNOWN with reason "RESTRICTED: input SCARCE"); inputs are fed only in the gate slice (M3).
- Over-feeding (M-01): never plan sells of an INPUT into an import whose supply is already HIGH or ABUNDANT beyond `stopAtSupply` (HIGH): sell units are clipped to zero if supply is ABUNDANT, and to one lot if HIGH.

### 2.5 Outlier guard (X-10)

Before an observation enters the model: reject if any price is 0 or non-finite, or the price differs by more than `outlierFactor` (5x) from the last accepted price for that (wp,good) within 60 min, unless corroborated by two consecutive observations. Rejected observations become `alert` events and are excluded from fits.

---------------------------------------------------------------------------------------------------

## 3. Travel and fuel model (`travel.ts`)

Facts available to the engine come from observation: the navigate response gives departure, arrival and fuel used (A). The
engine FITS `travel` from those and uses priors until it has `minSamples` (20).

```
distance(a,b)      = hypot(a.x-b.x, a.y-b.y)               // same-system waypoints; coordinates from waypoint facts (A)
travelSeconds(a,b,speed,mode) = fixedSec + max(1,round(distance)) * modeFactor[mode] / speed
fuelNeeded(a,b,mode)          = distance-proportional for CRUISE, ~constant small for DRIFT (A)
cross-system: jump hops via gate edges; each hop adds jumpSec (cooldown, fitted) and jumpCost credits (policy.jumpCost, POLICY 6,900 from stcommand's 2026-11-10 P&L: jumps average ~6.9k each)
```
PRIOR (from the public game docs as remembered; UNVERIFIED, flagged (A) and replaced by the fit): `fixedSec = 15`, `modeFactor = {CRUISE: 25, DRIFT: 250, BURN: 12.5}`. M0 logs predicted vs observed travel time for
every navigate; the fit replaces priors when `samples >= 20` and the model's median absolute error is under 10%.
DRIFT is allowed only when fuel is insufficient for CRUISE and the route's value over the (hours-long) drift still beats the best alternative (X-11); the default policy forbids DRIFT trade legs (`allowDrift: false`).

---------------------------------------------------------------------------------------------------

## 4. Route generation and scoring (`opportunity.ts`)

### 4.1 Candidate generation (cheap prefilter)

```
for each ship class C present or purchasable (only ships that are IDLE or about to be free matter):
  reachable systems = BFS over gateEdges from ship.system up to policy.route.maxHops(C)  (default 2 for shuttles/haulers, 4 for bulk; E-08 cap 12)
  markets = markets in reachable systems with hasPrices and not view.unknown
  for each good g:
     sources  = markets where g is an EXPORT or EXCHANGE and view.lastQuote.buyPrice > 0     // we can buy here
     sinks    = markets where g is an IMPORT or EXCHANGE and view.lastQuote.sellPrice > 0    // we can sell here
     for (A in sources, B in sinks, A != B):
        rawSpread = B.sellPrice - A.buyPrice
        if rawSpread < policy.route.minRawSpreadFrac (0.08) * A.buyPrice: continue
        push candidate with quickScore = rawSpread * min(A.tv, B.tv) / (hours(A,B) + dockHours)
  keep the top policy.route.candidatesPerShip (40) by quickScore per ship, sorted deterministically (score desc, then route id)
```
Complexity guard: if `markets^2 * goods` would exceed `policy.route.maxPairEvals` (250,000), the shell passes only markets in the
ship's 2-hop neighbourhood (never random sampling; determinism matters).

### 4.2 Precise scoring (`scoreRoute`)

```ts
function scoreRoute(s, p, ship, route): RoutePlan {
  const vb = viewMarket(s, p.market, route.buyAt, route.good), vs = viewMarket(s, p.market, route.sellAt, route.good);
  if (!vb || !vs || vb.unknown || vs.unknown)                 return plan('UNKNOWN', 'T-02 stale or missing price');
  if (vb.cooling || vs.cooling)                               return plan('COOLING', `T-08 ${route.id} cooling until ${..}`);
  if (nextEligibleMs(route) > s.nowMs)                        return plan('PACED', `T-07 next in ${m}m`);
  if (exportRestricted(vb))                                   return plan('UNKNOWN', 'M-02 RESTRICTED');

  const hold = ship.frame.cargoCapacity - ship.cargoUsed;     // free hold
  const reserved = reservedUnits(s, route);                   // T-09
  const ceil = vb.lastQuote.buyPrice * p.trade.buyCeilFrac;
  // units: the smallest of the constraints (T-06)
  let u = Math.min(hold, depthBuyUnits(vb, ceil), Math.floor(p.trade.lotsAllowed * Math.min(vb.tv, vs.tv)) ... );
  const sellDepth = depthSellUnits(vs, minSellAvg=cost basis*(1+p.trade.minMarginFrac));
  u = Math.min(u, Math.floor(p.trade.sellDepthShare * sellDepth) - reserved.sell);            // T-09: our share of the sink's depth
  // high-margin trickle (T-10): tradeVolume<=hmTvMax(20) and margin>=hmMinFrac(0.4) => cap u at hmMaxUnits (8), allow more visits
  if (u < p.trade.minUnits) return plan('UNKNOWN', `T-06 units ${u} < min`);

  const buy  = walkBuy(vb, u, p.market), sell = walkSell(vs, u, p.market);
  const conf = Math.min(vb.confidence, vs.confidence);
  const gross = u * (sell.avg - buy.avg);
  const effGross = gross >= 0 ? gross * conf : gross;                                          // T-02: shrink only positive margins
  const hops = jumpHops(s, sysOf(route.buyAt), sysOf(route.sellAt)) ?? 0;
  const fuel = fuelCost(...) * p.travel.fuelPriceCredits;                                      // fuel unit price: fitted from refuel events, PRIOR policy.travel.fuelPriceCredits
  const costs = hops * p.jumpCost + fuel + p.trade.feePerTrip;
  const posHours = travelHours(ship.position -> route.buyAt)  // positioning leg
  const legHours = travelHours(buyAt->sellAt) + hops*jumpHours;
  const tripHours = legHours + 2*dockHours(p.travel.dockSec/3600) + readHours; // steady state; positioning amortised below
  const amortPos = posHours / p.route.amortTrips(3);
  const profitTrip = effGross - costs;
  const hours = tripHours + amortPos;
  const calls = callsPerTrip(ship.frame, lotsBuy, lotsSell, hops);                              // 02 section 8 formula
  return { ..., expectedProfitPerTrip: Math.round(profitTrip), tripHours: hours,
           expectedProfitPerHour: Math.round(profitTrip / hours), expectedCalls: calls,
           profitPerCall: profitTrip / calls, confidence: conf, state: 'OK',
           reason: `T-01 ${route.id} u=${u} buy~${r(buy.avg)} sell~${r(sell.avg)} conf=${conf.toFixed(2)} est ${r(profitTrip)}/trip ${r(profitTrip/hours)}/h` };
}
```
Rules enforced inside scoring:
- Margin quoted off the best price lies, so BOTH legs are simulated by lot (T-01).
- A route is OK only if `expectedProfitPerTrip >= p.route.minProfitPerTrip` (POLICY 15,000: the opening playbook's "route pays 15k a trip") and `expectedProfitPerHour >= p.route.minProfitPerHour` (POLICY 8,000, design O-02 `minRouteProfitPerHour`), and the margin after costs is at least `minMarginFrac` (0.06) of cost.
- Floor feasibility (T-04): `walkSell(...).last >= sellFloorFrac (0.8) * buy.avg` or the route is rejected: the plan must never contain a planned sale below the floor.
- Revalidation parameters are carried in the plan: `revalidateMinFrac (0.5)` (T-12) and the abort thresholds for the lots (T-03 `lotAbortFrac 0.85`).
- T-13 backhaul (post-M2, `backhaulWeight 0`=off): add `backhaulWeight * bestProfitPerTripFromSellAtBackTo(...)` to the score.
- Ties (T-11): if two plans are within `tieBreakEpsilon` (10%) on profit/h prefer higher `profitPerCall`.

### 4.3 Pacing and reservations (T-07, T-09)

`Reservation{ship, waypoint, good, side, units, untilMs}`: written when an assignment is committed; `untilMs = now + tripHours`.
`reservedUnits(s, route)` sums units reserved at the route's sink (SELL) and source (BUY). The sink share cap `sellDepthShare 0.5` means all our ships together may plan at most half the sink's depth, so concurrent traders do not crush one market.

---------------------------------------------------------------------------------------------------

## 5. Ship assignment (`allocator.ts`)

Design: FleetAllocator matches hulls to jobs (80-unit haulers on paying routes and contracts; 40-unit shuttles on feeds into 60-unit markets; big hulls on routes supporting at least 0.7 of their hold).

```
allocate(s, p, plans: Map<ship, RoutePlan[]>) -> Assignment[]:
  freeShips = ships with nav != IN_TRANSIT-with-cargo-job and (no assignment OR assignment finishing) and not HOLD
  // never reassign a ship mid-trip (reassigning interrupts what it is doing; lesson)
  pairs = []
  for ship in freeShips (sorted by symbol for determinism):
     for plan in top K=5 plans of ship where plan.state == 'OK':
        if not hullFits(ship.frame, plan, p): continue                   // G-08: HEAVY/BULK need plan.units >= bigHullMinUnitsFrac(0.7) * hold; SHUTTLE only for feed jobs when the sink tv <= 60
        pairs.push({ship, plan, key: plan.expectedProfitPerHour})
  sort pairs by key desc, then profitPerCall desc, then ship symbol, then route id
  reserved = clone(s.reservations)
  for pair in pairs:
     if assigned.has(pair.ship): continue
     if !reservationAllows(reserved, pair.plan, p): continue             // T-09
     assigned.add(pair.ship); reserved.add(reservation of pair.plan)
     out.push(assign(pair.ship, 'TRADE_ROUTE', pair.plan, ruleId 'T-01', reason))
  for ship in freeShips not assigned:
     if idle > p.fleet.idleMinutes (10): G-10: reallocate: best unserved plan with relaxed sell share (0.7), else POSITION toward the best plan's buy waypoint, else HOLD with reason
  return out
```
Hysteresis: a ship keeps its current route when `newPlan.profitPerHour < current.profitPerHour * (1 + p.fleet.switchGainFrac (0.15))` (S-03 `moveGainFrac`), to avoid flapping.
Optimal assignment (Hungarian) is deliberately NOT used in v1 (greedy with reservations is explainable and within a few percent for these sizes); revisit in the calibration phase after replay shows the gap (OPEN QUESTION Q-ASSIGN).

---------------------------------------------------------------------------------------------------

## 6. Ship purchases and cash discipline (`purchase.ts`)

NEVER enabled in shadow mode (it only logs `would_buy`). In live mode it needs `autonomy >= 2` and `policy.purchase.enabled`.

### 6.1 Gates (all must pass; each produces a reason)

| Rule | Condition | Parameter (POLICY, source) |
|---|---|---|
| W flags | `phase.stopHullClass[class] == false` and not `noNewBuys` | `winddown` (section 8) |
| X-07/O-11 | `wallet - price >= floorAfter(class, phase)` | see table below |
| G-01 | at least `idleTraderGap` (1) route plans unserved (OK plans with no ship assigned) OR `idleTraderFrac >= 0.2` | design G-01 |
| G-04 | no purchase in the last `buyCooldownMin` (10; S-01: 5 after day 5) | design |
| G-03 | the quoted yard price was read at most `maxPriceAgeSec` (120) ago; else issue a priority-1 read first (the lessons: yard prices carry over from stale reads; each buy steps the price 0.6-2%) | design G-03 |
| G-09 | `paybackHours <= maxPaybackHours` (12 mid-week, `paybackScale = hoursLeft/3` capped: S-05) | design |
| G-11 | `traders < routeCapacity` and `ships < budgetMaxShips` (03 section 5.4) | design |
| X-03 | intent not a duplicate within `dedupeMin` (30) | design |
| One bulk per yard per purchase | after a bulk purchase at yard Y, ignore Y for `sameYardCooldownMin` (30) | lessons: each buy steps the price 0.6-2% |

`floorAfter(class, phase)` (wallet that must REMAIN after paying):

| Situation | Floor remaining | Source |
|---|---|---|
| Opening, before the gate is open | no hulls except the whitelist (contract shuttle at 200k wallet, tour ship at 200k above floor, gate hauler) | design O-07/O-08; reset plan G4 |
| Steady (gate open > 24 h) light/shuttle/hauler | `hullCashGate` = 3,000,000 | operator 3M rule (design G-01) |
| Window of `postGateSpendHours` (24) after the gate opens | `postGateFloor` = 1,000,000 after the first 4 haulers | reset plan 7.3 (delta Δ3) |
| Bulk/heavy freighter | `bulkFloor` = 1,500,000 after paying (about 5M wallet for a 3.3M hull) | reset plan 7.5 (first bulk at price + 1.5M) |
| Keeper probe | wallet >= `keeperCashGate` 5,000,000, or price <= `lateAutoApproveCap` 60,000 and wallet >= 10x price (G-07) | design G-06/G-07 |

OPEN QUESTION Q-GATE: the operator's phrasing is "buy no hull until the wallet holds at least 3,000,000". The design plan reads
it as wallet AFTER purchase. This plan implements AFTER (the conservative reading); if the operator means BEFORE, set
`purchase.gateIsAfterPurchase: false`.

### 6.2 Escape clause (G-05)

```
stalled = wallet flat or falling for stallHours (2)   OR   profitPerHourLast2h < stallRatePerHour (80,000)   OR   idleTraderFrac >= idleTraderFrac (0.2)
if stalled and no escape used in the last 6 h:
    allow ONE hull buy below the gate, up to escapeMaxFrac (0.4) of wallet, and only the hull with the best payback
    log "G-05 escape: growth stalled ({why}); buying below gate"
```
Important evidence-based caveat carried from the lessons: when the wallet is under ~150k and every route reads negative, the
fix is to check the route list (cash-starved dispatch), not to buy a hull: the escape clause is skipped when `wallet < cashStarvedWallet (150,000)` and all plans are negative; it logs why.

### 6.3 Yard choice: nearest to the destination, not the cheapest (G-02)

```
target = best unserved route plan's buy system (or the fresh system being opened)
for yard in yards stocking hullType with fresh price (age <= maxPriceAgeSec):
   hops = jumpHops(yard.system, target.system) ?? INF ; if INF skip
   travelH = travelHours(yard -> target.buyAt) (+ hops*jumpHours)
   total = price + hops * policy.jumpCost (6,900) + travelH * valuePerHour        // valuePerHour = ship's expected profit/h (the plan's), PRIOR = hull-class median realised
   reason = `G-02 yard ${y}: price ${price} hops ${hops} total ${total} vs next ${total2}`
choose min total; prefer a yard INSIDE the target system on ties
```
Worked example from the operator's notes (2026-11-10): yard A at 316,860 with 0 hops beats yard B at 314,772 with 2 hops:
`316,860 + 0 = 316,860` vs `314,772 + 2*6,900 = 328,572` plus travel time.

### 6.4 Hull choice (G-08)

```
for each hull type H purchasable at the chosen yard (hullClass known from policy.hullClasses):
   units(H) = min(H.cargo, plan.unitsSupported)                       // route depth limits what a big hold can use
   if H is HEAVY or BULK and units(H) < bigHullMinUnitsFrac(0.7) * H.cargo: reject (a 490-hold hauling 60 units wastes the hull)
   ppH(H)   = plan.profitPerUnit * units(H) / plan.tripHours          // expected profit per hour for this hull on this route
   payback  = price(H) / ppH(H)                                       // hours
choose H with minimal payback subject to payback <= maxPaybackHours(now) and the cash floors; log all candidates (top 3) in the reason
```
Evidence for sanity bounds (POLICY, from the lessons): light hauler earns 44-160k/h (payback 3-8 h at end-of-week rates), bulk 0.4-1.0M/h typical (payback 7-9 h plus the first hour), heavy ~340k/h only on 2.5-5k goods (skip unless nothing else: `allowHeavy: false`). These are VALIDATION targets: if realised hull payback exceeds planned by 2x in 3 consecutive purchases, the planner raises `maxPaybackHours` strictness (halves it) and alerts.

### 6.5 After-gate spending window (delta Δ3), keepers, expansion

Post-gate window, keepers (K rules) and expansion (E rules) are M3 slices and post-M4; their formulas are in the design plan
and are not repeated. The hooks exist now: `phaseFlags` returns `postGateWindow: boolean`; `planPurchase` takes `need.kind in {'trader','keeper','tour'}`; keepers are refused unless `policy.keeper.enabled`.

---------------------------------------------------------------------------------------------------

## 7. Opening, contracts, gate (O, C rules) as modules

| Rule group | Module | Slice | Notes |
|---|---|---|---|
| O-01..O-04, O-11, O-12 | `decide.ts` phase OPENING branch + `opportunity` | M1 | bootstrap, command ship tours until `minRoutes (3)` routes at `minRouteProfitPerHour (8,000)` exist or 30 minutes pass, then trades (lot cap `lotCapFrac 0.6`, `maxUnits 40`) |
| O-05, O-06, O-07, C-06, C-07 | `contract.ts` | M3 | one contract at a time, never paused early; accept only if net >= `minNet 60,000` and feasible within `maxHours 6`; contract income deprioritised when trading beats it: policy default stop at fleet rate `contractIrrelevantRate = 2,000,000` per hour (Δ4) |
| O-08, G-xx purchases | `purchase.ts` | M3 | |
| O-09, O-10, C-01..C-05 | `gate.ts` | M3 slice | gate bill of materials; feed inputs from hour 1-2 with `stopAtSupply HIGH`; mission ceilings `ceilingMult` 2.5 x the first observed ask for FAB_MATS and about 1.45x for ADVANCED_CIRCUITRY (Δ2: 3,000 / 6,000 last week), lifted at 85% progress to hard stops 5,000 / 9,000 (FAB_MATS / ADVANCED_CIRCUITRY); no recovery wait and no inflation guard; both materials from the start; `gateComplete` latched only from the construction endpoint, never inferred from a failed read (C-05, lesson e); loss allowance per unit on feeds set at creation (IRON 40, COPPER 30, SILICON_CRYSTALS 10, QUARTZ_SAND 10 worked last week); carriers named before the feed starts (never the command ship) |
| K-01..K-08 | `keeper.ts` | M3 slice | score = goodsCount x median price, yard bonus 1.5; low-value parking; stale = unknown |
| E-01..E-11 | `expansion.ts` | post-M4 | scouted -> staged -> live; release every >= 15 min while premium count < 10 |

Because stcommand's own gate data (1,600 FAB_MATS + 400 ADVANCED_CIRCUITRY; QUANTUM_STABILIZERS already done last week; the materials can change each week) are examples, the gate module reads the BOM from the construction endpoint (A) and never hard-codes goods.

---------------------------------------------------------------------------------------------------

## 8. Wind-down (`winddown.ts`; W rules, delta Δ1)

Objective: the leaderboard is RAW WALLET at the reset; cargo aboard at the reset is destroyed; hulls, keepers and cargo count for nothing.

```
hoursLeft = s.hoursToReset (null => no wind-down logic; alert "reset time unknown")
W-01 per hull class: stop buying when hoursLeft <= paybackHours(class) * 1.3   (defaults: bulk 10, light hauler/shuttle 8, explorer 12; plan default for any class 18 if no payback data)
W-02 stop keepers and staging at hoursLeft <= 12 (design) ; the reset plan used 5 h for probes: policy.winddown.stopKeeperBuyH = 5 once expansion exists, 12 before
W-03 at hoursLeft <= liquidateH (3): do not buy cargo whose planned sell completes after reset; sell held cargo at the best reachable market within floor
W-04 at minutesLeft <= finalMin (45): floor relaxes to sellFloorFracFinal 0.5; sell everything reachable
NEW noNewBuys window (Δ1): minutesLeft <= noNewBuysMin  where noNewBuysMin = clamp(P95(buy-to-sell minutes over the last 24 h) + 5, 25, 60), default 35, NEVER 120
        (the stcommand wind-down of 120 minutes blocked every buy for the last two hours: 0 matched profit, ~11-16M lost)
        trips already under way are NOT cut short
W-06 at hoursLeft <= 1: no jumps (pure cost)
W-07 final 10 minutes: record wallet and week summary; accept no new commands except sells
W-08 scrapping: scrap=false (refund for big hulls unmeasured; 68-72% was measured for 85k shuttles only)
```
`P95(buy-to-sell)` is computed by a pure reducer over `trips` (closed trips in the last 24 h; with fewer than 30 trips use 35).
Cargo rule: in the last `finalMin` minutes any held cargo with a market in the ship's system is sold even at a loss (a 1c reading
still needs X-13 corroboration unless under 10 minutes remain: then loss is better than destruction).

---------------------------------------------------------------------------------------------------

## 9. Risk guard (`risk.ts`): the last word on every Decision (X rules)

```ts
review(s, p, d): RiskVerdict   // order matters; first veto wins; a veto is logged as `veto` with ruleId and reason
```
| Order | Rule | Check | Verdict |
|---|---|---|---|
| 1 | X-08/killSwitch | `s.killSwitch` or autonomy 0 or process state not LIVE | veto all mutating decisions ("X kill switch") |
| 2 | X-09 | writer lock lost (shell flag in snapshot) | veto, halt |
| 3 | X-03 | duplicate intent in `dedupeMin` | veto |
| 4 | X-07 | `wallet < minWallet (25,000)` and decision is not fuel or a one-trip payoff trade | veto/modify to restricted mode |
| 5 | X-02 | rolling 1 h matched profit < `-lossLimit (500,000)` | global trade pause; auto-resume after `resumeMin (30)` with sizes halved (`sizeFactor 0.5`) |
| 6 | X-01 | any single trade realised loss > `maxTradeLoss (150,000)` | pause that ship and route for `pauseH (6)`, alert |
| 7 | spend caps (08) | purchase would exceed `maxSpendPerPurchase` or `maxSpendPerDay` | veto |
| 8 | T-04 | a SELL below `sellFloorFrac (0.8)` of cost basis (+fees) outside W-04 | veto or modify to "stop selling, hold remainder" |
| 9 | X-13 (Δ5) | a SELL below floor whose price is not corroborated: need either a fresh read within `corroborateMaxAgeMin (5)` AND the same good priced at two other known markets within `corroborateFrac (0.4)` of cost basis (if another market pays at least `corroborateFrac` of cost, veto: sell there instead) | veto with the better market named |
| 10 | T-05 | a BUY unit price above `buyCeilFrac (1.15)` of the plan's first ask | modify (stop the load) |
| 11 | T-03 | realised lot price below `lotAbortFrac (0.85)` of the expected | modify (stop selling; the ship holds the remainder and re-plans) |
| 12 | X-11 | planned leg needs more fuel than aboard | modify (refuel first) / veto DRIFT unless allowed |
| 13 | X-05 | ship state older than arrival + `arrivalGraceSec (15)` | modify (refresh first) |
| 14 | X-14 (Δ7) | watchdog: no SELL in `watchdogMin (15)` while >= 3 traders have assignments | alert + read-only diagnostic (list ships, last calls, budget); never auto-restart |

RiskGuard has no knowledge of strategy; it reads only the decision, the snapshot's realised stats and the policy. It is
tested against random decisions: "no allowed decision violates an invariant" (06).

---------------------------------------------------------------------------------------------------

## 10. Reasons: format and catalogue (`reasons.ts`)

Rules: one line, at most 240 characters, starts with the rule id, embeds the numbers that drove it, no multi-line strings,
no secrets. Helper: `reason(ruleId, template, values)` where `template` is a literal from the catalogue and values are
formatted with fixed rounding (credits integer with thousands separators, fractions 2 d.p.).

Examples (from the design plan log strings, with values):
```
T-01 route X1-AB-C3>X1-AB-D4 IRON u=38 buy~412 sell~571 conf=0.93 est 5,722/trip 38,100/h
T-12 revalidate failed: 1,204 < 5,722*0.50 (plan); aborting trip
G-02 yard X1-AB-A2: price 316,860 hops 0 total 316,860 vs next 328,572
G-05 escape: growth stalled (rate 61,000/h < 80,000); buying below gate
X-13 sell below floor vetoed: ELECTRONICS 1c at X1-AB-C3; X1-CD-E5 pays 3,100 (>= 40% of cost 7,400)
W-03 liquidating FIREARMS 20u at X1-AB-C3 (2.7h left)
X-06 skip O-08: wallet 150,000 < buyTouringCash 200,000
```
Skips are rate limited per `(ruleId, subject)` to `skipLogRateLimit` (one per minute) but counted (`skips.count`), so
silence is never possible and the log stays small.

---------------------------------------------------------------------------------------------------

## 11. Cash and objective bookkeeping (what the engine optimises)

- Working objective: matched profit per hour, subject to the safety invariants; monitor `equity = wallet + holds` (holds valued at the expected fetch, discounted by confidence).
- Final-week objective: raw wallet. The W rules and the purchase payback test (hours left x hourly profit > price, because a hull is worth zero at the end) make purchases consistent with it.
- Targets (design plan; STAR v1 aims for 5-10% of the stcommand scale): day 1 0.2-0.3M/h (floor 0.1M/h); day 5 ~2M/h (floor 0.8M/h); days 6-7 5-7M/h (floor 2M/h); week 20-40M (v1), parity later (reference weeks 461M and 400M+). Do not present these as predictions.
- Safety targets: no single trade loss over 150k; 429 ratio under 5% (stretch 1%); zero duplicate purchases.

---------------------------------------------------------------------------------------------------

## 12. `config/policy.default.yaml` (complete default; zod schema mirrors it; every key has bounds in `policy.ts`)

```yaml
version: 1
global:
  enabled: true
market:
  impactPerLotDefault: 0.045      # PRIOR design: ~4-5% per tradeVolume lot
  impactBounds: [0.01, 0.20]
  impactEwmaAlpha: 0.2            # M-05
  freshMin: 15
  maxPriceAgeMin: 45              # T-02
  hardStaleMin: 90                # T-02, K-04
  outlierFactor: 5                # X-10
  recoveryPerTick: 0.25           # PRIOR (fit); 0.10 when activity WEAK/RESTRICTED
  tvGrowthWeight: 0.5             # M-04
  stopAtSupply: HIGH              # M-01
trade:
  lotsAllowed: 1.5                # T-06
  sellDepthShare: 0.5             # T-09
  buyCeilFrac: 1.15               # T-05
  sellFloorFrac: 0.8              # T-04
  sellFloorFracFinal: 0.5         # W-04
  lotAbortFrac: 0.85              # T-03
  revalidateMinFrac: 0.5          # T-12
  minUnits: 4
  minMarginFrac: 0.06
  feePerTrip: 0
  hmTvMax: 20                     # T-10
  hmMinFrac: 0.4
  hmMaxUnits: 8
  backhaulWeight: 0               # T-13 off
  tieBreakEpsilon: 0.1            # T-11
pace:
  minRevisitMin: 35               # T-07
  minSpreadFrac: 0.6              # T-08
  coolingMin: 90
route:
  minRawSpreadFrac: 0.08
  minProfitPerTrip: 15000         # opening playbook: route pays 15k a trip
  minProfitPerHour: 8000          # O-02
  candidatesPerShip: 40
  maxPairEvals: 250000
  maxHopsByClass: { SHUTTLE: 2, HAULER: 2, HEAVY: 3, BULK: 4, COMMAND: 2 }
  amortTrips: 3
travel:
  allowDrift: false
  jumpCost: 6900                  # POLICY from stcommand P&L 2026-11-10
  fuelPriceCredits: 0             # PRIOR; fitted from refuel events (A)
  dockSec: 5                      # PRIOR
  minFitSamples: 20
fleet:
  idleMinutes: 10                 # G-10
  switchGainFrac: 0.15            # S-03
  bigHullMinUnitsFrac: 0.7        # G-08
opening:
  minRoutes: 3                    # O-02
  tourTimeoutMin: 30
  lotCapFrac: 0.6                 # O-03
  maxUnits: 40
  openingFloorCash: 30000         # O-11
  bootstrapReadBudget: 250        # O-01
  openingApiShare: 0.6            # O-12
purchase:
  enabled: false                  # D11: off until M3 and operator consent
  gateIsAfterPurchase: true       # Q-GATE
  hullCashGate: 3000000           # G-01
  postGateFloor: 1000000          # Δ3
  postGateSpendHours: 24
  bulkFloor: 1500000              # reset plan 7.5
  keeperCashGate: 5000000         # G-06
  lateAutoApproveCap: 60000       # G-07
  walletMultiple: 10
  buyShuttleCash: 200000          # O-07
  buyTouringCash: 200000          # O-08
  maxPaybackHours: 12             # G-09
  paybackScale: true              # S-05
  buyCooldownMin: 10              # G-04 (5 after day 5)
  maxPriceAgeSec: 120             # G-03
  priceSlackPct: 0.03
  sameYardCooldownMin: 30
  idleTraderGap: 1
  stallHours: 2                   # G-05
  stallRatePerHour: 80000
  idleTraderFrac: 0.2
  escapeMaxFrac: 0.4
  cashStarvedWallet: 150000
  allowHeavy: false
  maxSpendPerPurchase: 500000     # 08 spend caps; raised only by the operator
  maxSpendPerDay: 1000000
contracts:
  enabled: false                  # M3
  minNet: 60000
  maxHours: 6
  contractIrrelevantRate: 2000000 # Δ4
gate:
  enabled: false                  # M3 slice
  ceilingMult: { FAB_MATS: 2.5, ADVANCED_CIRCUITRY: 1.45 }
  hardStop: { FAB_MATS: 5000, ADVANCED_CIRCUITRY: 9000 }
  liftAtProgress: 0.85
  maxInflationPct: 1000
  recoverPct: null
risk:
  maxTradeLoss: 150000            # X-01
  pauseH: 6
  lossLimit: 500000               # X-02
  resumeMin: 30
  sizeFactor: 0.5
  minWallet: 25000                # X-07
  dedupeMin: 30                   # X-03
  arrivalGraceSec: 15             # X-05
  corroborateFrac: 0.4            # X-13
  corroborateMaxAgeMin: 5
  watchdogMin: 15                 # X-14
winddown:
  noNewBuysMin: 35                # Δ1, clamp [25, 60], never 120
  noNewBuysClamp: [25, 60]
  stopHullBuyH: { BULK: 10, HEAVY: 10, HAULER: 8, SHUTTLE: 8, EXPLORER: 12, default: 18 }
  stopKeeperBuyH: 12
  liquidateH: 3                   # W-03
  finalMin: 45                    # W-04
  noJumpH: 1                      # W-06
  scrap: false                    # W-08
budget:
  keeperShare: 0.30
  tradingShare: 0.55
  loopMax: 6                      # B-08
  shedAbove: 0.92                 # B-04
  slackBelow: 0.70                # B-05
  reuseResponses: true            # B-07
  minValuePerCall: 0              # B-10 off
keeper: { enabled: false }
expansion: { enabled: false }
hullClasses:                      # type symbol -> class; (A) type symbols verified in M0
  SHIP_PROBE: PROBE
  SHIP_LIGHT_SHUTTLE: SHUTTLE
  SHIP_LIGHT_HAULER: HAULER
  SHIP_HEAVY_FREIGHTER: HEAVY
  SHIP_BULK_FREIGHTER: BULK
  SHIP_EXPLORER: EXPLORER
```
