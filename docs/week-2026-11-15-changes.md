# Every change since the 2026-11-15 13:00 UTC reset

Compiled 2026-11-18 23:30 UTC at the operator's request ("it could be anything we touched").
Sources: `git log origin/main` since the reset, `git diff 1ec1db1..origin/main -- src migrations`, the doctrine
changes recorded in `docs/journal/2026-11-08.md`, and the analysis engine's config_change log.

## 1. Code deployed to main since the reset (19 code commits, 29 files, +2,158/-47 lines)

| When (UTC) | Commit | What | Files | Touches trading? |
|---|---|---|---|---|
| 11-17 03:31-03:56 | 80d9ccb, 9914ec5, 0af4a4a | Tower/Deck UI: chart enlarge, readability, By-system labels | public/ only | No |
| 11-17 13:17 | f5100f9 | Keeper queue takes turns by system (`keeperRotateSystems`); Approvals filter by system | fleet.ts, keeperRotation.ts, doctrine.ts | Keepers only |
| 11-17 13:38 | 81f4f4a | Approve on a "Coming up" row displaces the pending card | fleet.ts, keeperRotation.ts | Keepers only |
| 11-17 23:54 | 6f20c3d | Free tour ships whose system no longer needs a tour | fleet.ts, queueTours.ts | Tours |
| 11-18 00:30 | e358093 | Count tour ships in flight for queue tours | fleet.ts, queueTours.ts | Tours |
| 11-18 00:45 / 01:07 | b425c40, 7134e6b | Server health board, migration 068 `health_samples` | serverHealth.ts, healthRecorder.ts, store.ts (new table only), admin.ts, notify/* | No |
| 11-18 02:44 | 43d6409 | Deck Expand group | public/ only | No |
| 11-18 03:54 | b4b4f94 | Economy alerts and buy-ship warning (advisory) | economyHealth.ts, buyAdvice.ts, notify/*, dashboard.ts, mcp | No (advisory) |
| 11-18 04:01 | 371b8f6 | Record route refusals (`route_refused` events) | actionEvents.ts, fleet.ts, trader.ts | Logging only |
| 11-18 04:52 | 4ff600b | **Engine wallet follows every trade balance** (`noteCredits`); cash warning names cargo value | fleet.ts, economyHealth.ts, tenantRegistry.ts | **Yes: the credits figure every buy is sized from** |
| 11-18 11:45 | 69b674f | **Traders stop picking their own far routes** (`traderSelfClaim` off) and stop jumping to discover prices | fleet.ts, trader.ts, doctrine.ts | **Yes: route claiming** |
| 11-18 13:46 | 57c7927 | Price discovery skips same-system markets priced in the last 20 min | trader.ts | Yes: discovery |
| 11-18 14:39 | 7e3d501 | **Idle traders wait for the dispatcher** (`traderIdleDiscovery` off); **below the cash floor traders spend a share of the wallet** (`cashFloorTradeSharePct`, tradeBudget.ts) | fleet.ts, trader.ts, tradeBudget.ts, doctrine.ts | **Yes: route sizing and idle behaviour** |
| 11-18 16:12 / 16:20 | bf5a527, 858817f | Tour dispatch saves the destination first, waits on jump cooldown; tour ships keep operator assignments; auto-explore borrow denies on timeout (#46) | fleet.ts, queueTours.ts | Tours |
| 11-18 17:59 | 57d3d03 | No new jump routes while the wallet is under `jumpCashFloor` | dispatcher.ts, jumpCashGuard.ts, fleet.ts, doctrine.ts | **Yes: dispatcher reachability** |

**Market storage:** no commit this week touches how markets are stored or read. `src/db/store.ts` gained only the
health-sample table; nothing changed in market_snapshots, market_latest, the galaxy crawler, keepers' market recording or the
route-leg query. The route builder's pricing code (`priceLeg`) changed in one line: `spendable` now comes from
`tradeSpendable()` (the cash-share rule) instead of `spendableCredits()`.

## 2. Code deployed just before the reset, first live this week

| When | Commit | What | Live setting now |
|---|---|---|---|
| 11-15 05:19 | f25edb7 | **Route list reuse for the core tick** (`routeReuseMaxSec`, shipped off) | **ON, 60 s** (enabled 11-15 05:52, before the reset) |
| 11-14 20:28 | 3225244 | Keeper: release stale pins at boot | on |
| 11-14 14:42 | beb0fde | Keeper top-up waiting limit as a doctrine clause (`keeperTopUpMaxPending`) | **6**: top-up has added nothing all evening ("209 listed markets still wait, limit 6") |
| 11-12 04:08 | f96fc0d | Release a staged system once a tour ship priced it (`releaseOnTourPct`) | **on, 50%**: tonight's 5 releases were all on this path, with 0 keepers |

## 3. Doctrine / settings changes this week (from the journal and the config_change log)

| When (UTC) | Setting | Change | By |
|---|---|---|---|
| 11-15 opening | template v4.2 | cash floor 20k, top-up and idle parking off at start, keeper line, gate caps 2,250 / 4,250 | template |
| 11-16 ~23:00 | gate-open task o4-gateopen-1115b | cash floor 100k, `keeperAutoApproveMinCash` 3M (on), `systemReleaseMinCash` 500k, `keeperTopUpPerHour` on (12), idle parking on (20k) | template task |
| 11-16 23:35 | `freshStagedAhead` | 5 -> 3 | operator |
| 11-17 12:20 | `keeperAutoApproveMinCash` | 3M -> 5M | operator |
| 11-17 13:17 | `keeperRotateSystems` | new, on | deploy |
| 11-18 02:53 | `positioningHops` | 10 -> 3; THEO-1, THEO-3 local-only | operator-approved |
| 11-18 04:30 | THEO-1, THEO-3 reach | back to any | operator |
| 11-18 05:17 | `positioningHops` | 3 -> 8 -> 6 | operator (Deck) |
| 11-18 11:41 | `positioningHops` | 6 -> 3 | operator-approved |
| 11-18 11:45 | `traderSelfClaim` | new, off | deploy 69b674f |
| 11-18 12:09 | traders | local-only (several); two probes scrapped | operator |
| 11-18 13:20 | reach any | THEO-A1, -A7, -6A, -6B, -6C, -7, -A, -17, -38 | operator |
| 11-18 14:20 | `positioningHops` | 3 -> 6; `freshIdleParkHours` off; keepers unparked | operator |
| 11-18 14:45 | `traderIdleDiscovery` | new, off; `cashFloorTradeSharePct` new, 50% | deploy 7e3d501 |
| 11-18 15:47-16:25 | wave-1 tours | THEO-7, -1, -17, -6C sent touring JD68, CN92, QA67, BQ46 | operator |
| 11-18 16:25-17:47 | releases | BQ46, then JD68, CN92, QA67 | operator |
| 11-18 ~17:55 | reach | every trader local-only | operator |
| 11-18 18:00-18:30 | parked keepers | 8 scrapped | operator |
| 11-18 18:10 | `jumpCashFloor` | new, on, 100,000 | operator |
| 11-18 20:50 | `cashFloorTradeSharePct` | 50 -> 80 | operator |
| 11-18 20:52 | reach | 6A, 6B, 6C, A, 37, 38, 7, 17 back to any; THEO-7 released from hold | operator |
| 11-18 21:04-21:16 | scrapped | THEO-A1 (225), THEO-6A, THEO-17 | operator |
| 11-18 ~21:00 | FOOD contract | resumed (THEO-6B buying) | operator |
| 11-18 21:57-23:18 | releases | XR3, DC21, XS51, KT44, MV84 (tour path, 0 keepers) | engine (`freshGate` auto) |

Carried in from last week and unchanged this week: `freshTours` 8, `maxLotsPerTrip` 8, `freshGate` 2 (auto), `marginFloor` 10,
`routeMatchTopN` 12, `routeHoldAware`, `lotImpactMaxFactor` 3.

## 4. Fleet changes this week

Bought: bulk freighter THEO-763 (before the reset), heavy freighters THEO-A1 and THEO-A7 (11-17), light haulers THEO-A
(11-16), THEO-37 and THEO-38 (11-17 04:58), THEO-6A, 6B, 6C (11-17 12:20), tour shuttles THEO-4, THEO-8 and others, about 136
keepers. Scrapped: 2 probes (11-18 12:09), 8 parked keepers (11-18 18:00), THEO-A1, THEO-6A, THEO-17 (11-18 21:04-21:16).
Explorers: none bought this week (parked since 10-29).

## 5. Candidates for "something structural", ranked by how directly they touch trading

1. `routeReuseMaxSec` 60 s (f25edb7): the core tick reuses a route list up to a minute old. New code, first full week live.
2. `4ff600b` wallet tracking: every buy is sized from `this.credits`; a wrong balance mis-sizes every route.
3. `7e3d501` cash-share sizing (`tradeSpendable`) feeds `priceLeg`; with a low wallet, expensive goods drop out of the list.
4. `69b674f` / `7e3d501`: traders no longer self-claim or discover; when the dispatcher has nothing in reach they sit.
5. `releaseOnTourPct` + `keeperTopUpMaxPending` 6 + manual keeper cards: tonight's new systems were opened with 0 keepers, far
   from the traders, and their prices go stale after 90 minutes.
6. `positioningHops` changed 6 times in a day; `freshStagedAhead` 3.
