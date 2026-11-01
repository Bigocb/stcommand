# API budget controller: who spends the 90 calls a minute, and who should decide

Written 2026-11-01. Status: **design and measured inventory, nothing built.** Related earlier plans:
`api-request-priority-plan.md` (the five urgency tiers, built), `rate-limiter-saturation-plan.md` (queue cap and
shedding), `api-capacity-doctrine-plan.md` (API capacity as a doctrine policy), `adr/0007-unified-scheduler-priority-queue.md`.
This document is about the part those do not cover: **nothing decides how the budget is divided between kinds of work.**

## 1. Why now

On 2026-11-01 every keeper stopped reading markets for about four hours and nothing noticed. Prices in most live
systems were 3-8 hours old, new systems had no routes, premium systems fell to zero, and a trade planned on a stale
price lost 1.5 million. The cause was a scheduling accident, not a bug in any one rule: the scheduler runs one task at a
time, traders first, and ends each pass 5 seconds after its first task, so with about 30 busy traders a pass never
reached the keepers. The opposite accident happened on 2026-10-07 (slow keepers held traders for half an hour), and
`PASS_MAX_MS` was added to fix it. Each fix moved the starvation to the other side because **no code states how much of
the budget each kind of work is entitled to.**

Other symptoms of the same gap, all seen this week:
- The keeper top-up refuses to add keepers because a **model** says keepers poll 72-90 calls a minute. Measured: 13-16.
- The ship-list refresh fell from 10.8 to 3.0 calls a minute when keepers resumed, and 13 ships showed their position
  4-7 minutes old. Nobody chose that trade; the limiter's tiers produced it.
- Two tenants share one pipe, and the second tenant's calls waited 12-25 seconds on average at the new fleet's size.

## 2. The constraint

- **One pipe: 1.5 requests a second, about 90 a minute, for the whole process and both tenants**
  (`RateLimiter` in `src/core/client.ts`; two processes on one IP share it, which is why a deploy overlap shows as a burst of 429s).
- **Urgency tiers** (`API_PRIORITY`): BOOT 0, CRITICAL 1 (trades, movement), ROUTINE 2, DEFERRABLE 3 (keeper reads),
  BACKGROUND 4. A waiting call moves up one tier per 20 seconds.
- **A second budget in front of it:** each tenant's `Scheduler` admits tasks against its own token bucket (1.5 a second,
  burst 5), unaware of the other tenant's or of the limiter's queue.
- **The rate does not grow with the fleet.** Hulls multiply; calls do not. The question that scales is *credits earned per call*.

## 3. Consumer inventory, measured

Source: `ops api_budget` / `ops instances`, the five-minute window ending 2026-11-01 01:16 UTC, 80.6 calls a minute
(90% of the cap), the keeper lane running (build c6a0d79). Calls are over 5 minutes; "wait" is the time a call spent queued.

### A. Execution: traders (priority 1, about 56 calls a minute, 70%)
| Purpose | Calls / 5 min | Per min | Avg wait |
|---|---|---|---|
| Market reads for prices, taken by traders (`liveSellPrice`, `liveBuyPrice`, post-dock snapshots) | 91 | 18.2 | 0.5 s |
| Sell cargo | 42 | 8.4 | 0.8 s |
| Dock | 32 | 6.4 | 0.5 s |
| Navigate | 31 | 6.2 | 0.6 s |
| Orbit | 28 | 5.6 | 0.5 s |
| Ship refresh (`TraderAgent.refresh`) | 18 | 3.6 | 0.5 s |
| Refuel | 18 | 3.6 | 0.6 s |
| Buy cargo | 11 | 2.2 | 0.6 s |
| Agent (spendable credits) | 7 | 1.4 | 0.7 s |
| Jump | 5 | 1.0 | 0.5 s |

About 1.9 calls a minute per trader (30 traders). Moving and docking (navigate, orbit, dock, refuel) are 45% of it.

### B. Intelligence: market data (priority 3, about 17 calls a minute, 21%)
| Purpose | Calls / 5 min | Per min | Avg wait |
|---|---|---|---|
| Keeper market reads (`ShipAgent.recordMarket`) | 65 | 13.0 | **13.8 s** |
| Remote survey market lists (`GalaxyAtlas.surveyMarkets`) | 19 | 3.8 | 12.0 s |
| Keeper shipyard reads | 2 | 0.4 | 15.8 s |

Keepers show **only** market and shipyard calls: one call a read, no ship read, dock or orbit.

### C. Bookkeeping (priority 2-4, about 6 calls a minute, 7%)
| Purpose | Calls / 5 min | Per min | Avg wait |
|---|---|---|---|
| Ship list (`refreshState`, pages the whole fleet, 809 ships) | 15 | 3.0 | **21.6 s** |
| Agent / credits (`refreshState`, `refreshCredits`) | 11 | 2.2 | 9.1 s |
| Contracts | 2 | 0.4 | 20.4 s |

### D. Exploration and tours: 5 calls / 5 min (1 a minute).
### E. The second tenant (THEOREM): 13 calls / 5 min (2.6 a minute), **average wait 11.9 s**.

### What the numbers say
1. **Execution takes 70% and is served in about half a second. Everything else waits 10-25 seconds.** That is the design
   working (traders first), but the keeper wait of 13.8 s means a read happens when its turn comes, not when it is due.
2. **At 13 keeper reads a minute, a full pass over 602 keepers takes 46 minutes.** The design asks for 5-30 minutes. This is
   a throughput limit, not a scheduling one: the leftover budget (90 - 56 - 6 = about 28) is already being shared with the
   survey and the second tenant.
3. **Before the keeper lane (00:44, keepers silent) the same 81 calls a minute were:** traders about 58, ship list 10.8,
   agent 6.6, construction 1.6. Restoring keepers took their budget from the ship list. The ship list is the one consumer
   that can safely run slower, because 596 of the 809 ships it tracks are stationary keepers.
4. **The model is wrong by 5-6 times.** `keeperPollingCallsPerMin` reports 80-90; measured keeper reads are 13-16 a minute.
   Top-up, the keeper cap and the "no API room" check all read the model.

## 4. What breaks as the fleet grows

At today's rates a trader costs about 1.9 calls a minute and the other classes about 23. With a budget of 90 that leaves room
for roughly **35 traders before everything else is squeezed to nothing.** More hulls beyond that only help if each call earns
more: bigger holds (a 490-unit bulk freighter makes the same number of calls as an 80-unit hauler), fewer wasted moves, and
fewer redundant reads. Two already-known facts point the same way: the best hours of the 2026-10-18 week came from big hulls,
and a keeper costs about one call per read, so a keeper is cheap per call but not free per market.

## 5. Design: one controller that decides, the limiter that enforces

### 5.1 Responsibilities
| The controller owns | It does not own |
|---|---|
| How much each class of work may spend and the order it is served | What a trader trades or where a keeper stands |
| Which market is read next and when (the sweep plan) | The HTTP calls themselves |
| How often bookkeeping refreshes | Game rules, routing, pricing |
| Measuring real spend per class, and alerting on starvation | The enforcement point (the limiter stays the single gate) |
| Per-tenant shares of the one pipe | |
| A calls-per-hull signal for buying decisions | |

### 5.2 Classes and shares (policy as data, doctrine-backed)
| Class | What | Floor | Ceiling | Shed order |
|---|---|---|---|---|
| EXECUTION | trades, movement, refuel | none (always served first) | none | never |
| INTEL | market and shipyard reads, remote survey | a guaranteed share (start at 25 calls/min) | 45 | after bookkeeping |
| BOOKKEEPING | ship list, credits, contracts, gate scans | 3 calls/min | 8 | first |
| EXPLORATION | tours, charting, new-system scans | 0 | 5 | first |
| TENANT SHARES | each tenant's slice of the above | e.g. 80/20, raised for a tenant that is opening a week | | |

The floor on INTEL is the change that matters: today it gets whatever is left, and on 2026-11-01 that was nothing.

### 5.3 The wave scheduler for keepers (the idea raised 2026-11-01)
Keepers are in position and their read time is under our control, so reads do not need per-keeper timers.
- A **pure planner** (`src/engine/intelSweep.ts`) takes: each keeper's market, time since its last read, a value score (is a
  route using it, how fast do its prices move, is the system live or staged), and the INTEL calls a minute available. It returns
  the next reads in order, spread evenly in time (one read every 60 / rate seconds), not in bursts.
- A **thin runner** performs the reads through the existing keeper code (`ShipAgent.recordMarket`) and reports back what each
  cost. It replaces about 600 keeper tasks in the scheduler with one.
- Period: 602 keepers at 25 calls a minute is a rotation every 24 minutes, at 45 every 13. Value weighting lets the markets that
  active routes use be read every 5-10 minutes and the static ones every 30-60.
- Needs care: yard markets also read shipyard stock (a second call, on a slower sweep); a newly delivered keeper gets an
  immediate first read outside the wave; a market read should still be skipped when a trader has just recorded it.

### 5.4 Feedback instead of constants
The controller reads its own measurement each minute: the waits and 429s per class. If EXECUTION's wait rises above a
threshold it lowers the BOOKKEEPING and EXPLORATION ceilings first, then INTEL down to its floor, and says so in the log. If
there is headroom it raises INTEL toward its ceiling. Top-up, the keeper cap and the purchase gates read this measured
headroom instead of the model, which removes the 5-6x error.

### 5.5 Calls per hull
The controller can report, per class, calls per hull and credits earned per call. A purchase gate can then refuse to add a
small hull when the budget has no room, and prefer a hull that earns more per call. This is the data behind the "swap small
hulls for big" item already on the TODO list.

### 5.6 Interfaces (kept narrow, per the repo's module pattern)
- `ApiBudgetController` (pure core): `measure(window) -> ClassSpend`, `plan(policy, spend) -> Allowance`, one-line reasons.
- `IntelSweep` (pure core): `next(keepers, now, allowance) -> reads[]`.
- Adapters (thin): the limiter reads class allowances when ordering its queue; the keeper runner reads `next()`; the fleet
  state refresh reads its cadence; the top-up reads measured headroom.
- Doctrine clauses, every one defaulting to today's behaviour: `apiBudgetControl` (off = observe only), the per-class floors
  and ceilings, `intelSweepEnabled`, `intelSweepCallsPerMin`.
- Ops tool `api_controller`: spend per class, the allowances it would set and why, which class is being shed, and the sweep
  plan for the next minute.

## 6. Order of work (and the reset)

The reset is 2026-11-01 13:00 UTC and the second tenant has to start on the shared pipe. **Nothing that changes enforcement
should ship in the opening hours.**
1. **Observe only (safe before the reset):** the per-class measurement and an ops tool that shows what the controller would
   allow. No behaviour change. Also: make top-up and the keeper cap read measured keeper calls beside the model.
2. **After the opening settles:** the intel sweep behind `intelSweepEnabled`, tried on one system, then all keepers, with the
   per-keeper timers left in place as the fallback.
3. **Bookkeeping cadences:** ship-list refresh slower for stationary ships, the second tenant's share.
4. **Controller enforcement** with the floors and ceilings, tried against the measurement for a day before it is allowed to shed.
5. **Calls-per-hull** in the purchase gates.

## 7. Risks
- **A control loop that oscillates.** Mitigation: slow adjustment (once a minute, small steps), hard floors, observe-only first.
- **A starved class that nobody sees.** Mitigation: the controller's own alert when any class has had under half its floor for 10 minutes
  (the check that would have caught 2026-11-01 in the first quarter hour).
- **Two enforcement points.** The scheduler's token bucket and the limiter both limit today. The controller should set
  the limiter's class allowances and treat the scheduler's bucket as admission control only; this needs deciding before step 4.
- **Reads that replace trader-recorded snapshots.** A sweep that re-reads a market a trader just recorded wastes a call. The planner must see last-read times from every source.

## 8. Questions this inventory left open, and what we found (2026-11-01)

1. **Does a market read need the ship docked, or only present? Settled for keepers, open for anything that moves.** A keeper
   left in orbit docks once (THEO-2EB, NV72-BE5A: `02:05:07 orbit -> dock`, market read at 02:05:39) and then stays docked, so
   steady-state cost is one call a read and the dock is a one-time call per keeper. The code docks before the first read, so
   this does not show whether the game would accept a read from orbit; it only matters if a ship is ever used to sweep
   markets, where it would save one call per stop. Test once on a spare probe if sweeps by ship are ever wanted.
2. **Why does the ship list cost 3-11 calls a minute for 809 ships? Found.** `refreshState` in `tenantRegistry.ts` runs a fast
   pass every 20 seconds (one agent read, about 3 calls a minute) and a **full pass every 2 minutes** that pages the game's whole
   ship list (20 ships a page, 41 calls for 809 ships) plus contracts, at background urgency. If every full pass completed on
   time it would cost about 20 calls a minute, 23% of the pipe; in practice it completes when the limiter has room, which was
   10.8 calls a minute before the keeper lane and 3.0 after. Traders do not depend on it (their own state comes back in each
   action response); it feeds the dashboards and the stuck checks, which is why 13 ships showed "transit overdue" 4-7 minutes
   after the keeper lane started: a stale list, not stuck ships. **Recommendation:** make the full pass interval a doctrine
   value (start at 10 minutes), and have the stuck check read the fleet's own ship state for traders, not the polled list.
   Saves up to about 16 calls a minute at no cost to trading.
3. **What share should a tenant opening a week get?** Mostly answered by the reset itself: the old agent's token dies at the
   reset (`fatalAuthError` stops its calls), so THEOREM has the whole pipe from the first minute. A share rule is only needed
   if two agents run live at once. The early-week constraint is not the pipe (four ships) but the later hours, when the fleet
   reaches hundreds of hulls; that is covered by the class floors in section 5.2.
4. **Can exploration be priced against what it earns?** Not yet. The system queue shows recent profit per unit against the
   mature rate for systems with at least 15 sells: MR27 0.91, XK5 0.58, HS97 0.58 this week, below 1.0 where the plan assumed
   1.7 for about 8 hours. Most live systems have had no sales at all, partly because their prices were stale for hours. Re-measure
   after prices have been fresh for a day: profit per system over its first 8 hours, against the keeper and survey calls it used.
