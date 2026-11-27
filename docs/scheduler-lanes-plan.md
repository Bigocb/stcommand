# Splitting the scheduler's main loop into lanes

Operator, 2026-11-27: "We are kind of being held back by these performance issues." Plan for running trade work concurrently
instead of one task at a time, and for the long synchronous jobs that block the whole process. Issue: https://github.com/Bigocb/stcommand/issues/88.

## Status (2026-11-27 18:45)

- P0 deployed 18:05 (queue delay per task kind; ops `db_queries`).
- P1 lanes and P2 cash reservations built (trade lane off by default, `schedulerTradeWorkers`); DB pool 30. Not deployed yet.
- Left: per-market sell lock, P3 ramp (operator's call), P4.
- 2026-11-27 22:20: trade lane on at 2 (20:20) and 4 (21:05). Database fixes built: pool 50, 10 connections held for traders
  (`src/db/dbLanes.ts`), market writes without the disk wait; `keeperBatchedSnapshotWrites` on. Next: the hot `fleet_flags` row
  (325 upserts a minute at 637 ms).

## 1. Why: what 2026-11-27 showed

| Time | What we saw | Cause | Fixed |
|---|---|---|---|
| 14:22-15:30 | Staged systems 0% priced for over an hour; X1-KQ85's 8 keepers sat at the gate; trade, tour and rescue tasks "starved for 100 passes" | Tasks charged the client's whole call count (everyone's concurrent calls), so the token budget sat at ~1.3 | 13f0097, 6e26a7d |
| 15:30-16:49 | Tokens full, nothing skipped, still ~2 tasks a second against 3,700 ready | The keeper lane was refilled only once per main-loop pass; one trade task can hold a pass for 96 s | 40758da |
| 17:20 | Box CPU 103% at 0 h uptime | Unstarved, ~4,000 keepers woke every 5 min (13 tasks a second, 80% no-ops) | 9395aa6 (not deployed yet) |
| all day | 1.33 GB of JSON built per 30 min; the phone reloading | `/api/dispatch` returned all ~250,000 routes (90 MB) every minute | dbef8df |

Every one of these traces to the scheduler's shape: one serial loop, one shared token bucket, and lanes bolted on beside it.

## 2. What the loop is today (src/engine/scheduler.ts)

- `run()` repeats: `startLowPriority()` (fill the keeper lane), then `runOnce()`, then sleep 100 ms.
- `runOnce()` sorts the ready tasks by priority and **awaits each one in turn** until the pass has run 5 s (`PASS_MAX_MS`).
- Priority 3 and up (keepers, survey, tours) run in the keeper lane (`keeperLaneWorkers`, 12), which since 40758da refills as each
  task ends.
- So the serial part is priority 0-2: rescue, missions, **trade (94 traders)**, explorers, miners. A trade task holds the loop
  about 4-5 s on average and up to 96 s, and about 85% of that is waiting (API limiter, the game's answer, the database), not CPU.
  While one trader waits, the other 93 wait behind it even when the API has room (box at 19 of 105 calls a minute at 14:22).
- Admission: one token bucket (1.5 a second, burst 5) for the box's own IP; since 6e26a7d a task is charged only the calls it
  sends from the box.

## 3. Goal and non-goals

Goal: trade steps start within ~2 s of coming due (p90) with 94+ traders, without raising 429s or breaching the cash floor, and
the box under ~80% CPU.

Not in scope: changing what traders decide (routes, lots, prices). The API rate limit stays the real cap: lanes only stop tasks
from waiting on each other.

## 4. Phases

### P0. Measure (no behaviour change; half a day)

- Per task kind, record **queue delay** (start time minus `earliestRunAt`) next to the hold time `taskTiming` already records:
  avg, p90, max over 10 minutes, in `ops keeper_coverage taskTiming` (or a new `ops scheduler`).
- **Event-loop blocking by source:** time each synchronous job over 200 ms (route build, fuel stops, big JSON) with its name.
- **Trader steps per hour** and trips finished per hour per ship.
- Baseline for 2 hours before changing anything.

### P1. Lanes as the scheduler's shape (one day; ships switched off)

- Replace "main loop + keeper lane" with a list of lanes, each `{ name, takes: (task) => boolean, workers: () => number }`:
  - `rescue` (priority 0): 1 worker, always.
  - `mission` (priority 1): 1 worker.
  - `trade` (priority 2): `schedulerTradeWorkers` (new doctrine clause, **default 1 = today's behaviour**, max 16).
  - `explore/mine` (priority 2, non-trader kinds): 2 workers.
  - `keeper` (priority 3+): `keeperLaneWorkers` (12).
- One dispatcher loop: whenever a worker frees up or a task comes due, start the highest-priority due task in that lane that the
  token bucket admits (the refill-on-finish of 40758da, made general).
- Token admission stays shared (box IP); rescue may borrow ahead.
- Per-ship exclusivity stays: one task chain per ship (already true); add an assert.
- Tests: lane isolation, per-ship exclusivity, workers=1 reproduces today's order, a slow trade task no longer delays another.

### P2. Make trading state safe for concurrent traders (1-2 days; before raising trade workers above 1)

| Shared thing | Risk with two traders at once | Guard |
|---|---|---|
| Cash (`tradeSpendable`, `spendableCredits`) | both read 200M, both buy as if alone, the floor is breached | a reservation ledger: reserve the load's cost before the first buy, release the unspent part on settle; `tradeSpendable` subtracts open reservations |
| One market's lots (`lotGuard`, price impact) | two ships sell into the same market in the same seconds; each quote is stale | per `waypoint+good` mutex around a buy or sell pass |
| Dispatcher assignment | recompute while a trader reads its assignment | single-flight recompute (one build at a time; readers get the last finished list) |
| Ledger writes, cost basis | interleaved rows for the same ship | already per-ship; add a test with two ships |
| DB pool (`max: 20`) | trade workers plus 12 keeper workers plus HTTP | raise to 40, or reserve connections per lane |

### P3. Ramp (a few hours, watched)

`schedulerTradeWorkers` 1, 2, 4, 8, one step an hour, a step back on any of: 429s per minute up, box CPU over 90% for 10 min, a
cash-floor breach, a lot sold under its floor, matched profit per trip down over 20%. Record each step in the journal and on the
hourly page.

### P4. The long synchronous jobs (separate track, 2-3 days)

These block every lane, whatever the worker counts:

- **Route build** (about 20 s, 15 s of it the query on 2026-11-27): 325,000 stored legs, 247,556 priced. Prefilter to the
  best N legs per good and market pair before pricing; rebuild only the systems whose prices changed since the last build. The
  earlier worker-thread move (`dispatcherWorker`) ran out of memory at 3 GB because it copied the whole world into the worker; if
  revisited, send it a compact input.
- **`fuelStops`** (8% of CPU in the 13:00 profile): memoize across builds keyed by (system, from, to, fuel), cleared when the gate
  graph changes.
- **Market-row parsing** (`mapMarketRow`, `parseDate`; about 10%): select only the columns used, cache latest snapshots per market.
- **Big JSON**: done for the screens (issue #87); keep `ops http_endpoints` in the hourly look.

## 5. Order and timing

The weekly reset is about 2026-11-29 13:00 and the opening matters most.

1. P0 with the next deploy (no behaviour change).
2. P1 and P2 built and tested on the feature branch, deployed with `schedulerTradeWorkers` at 1 (nothing changes).
3. P3 ramp in a quiet window, or right after the opening has settled next week.
4. P4 alongside, one piece at a time, each measured with the P0 figures before and after.

## 6. Done when

- Trade steps start within 2 s of due (p90) at 94+ traders.
- Box CPU under 80%, event-loop p99 under 200 ms, outside route builds.
- No rise in 429s, no cash-floor breach, no lot sold under its floor in the ramp hours.
- Route build under 5 s.

Rollback at any point: `schedulerTradeWorkers` back to 1.
