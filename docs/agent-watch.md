# Agent watch: who registered when, and how fast start gates get built

Operator question (2026-10-24): what do other players do? The public API gives each agent's symbol, headquarters, credits,
starting faction and ship count, and nothing else: no registration time, and nothing on how its start gate stood. Analysis of
the 2026-10-18 reset (166 agents) is in the CHANGELOG entry for this feature; the short version is that start gates were all
unbuilt at the start, that 70 agents (all COSMIC) shared 13 start systems, that the agents that started alone did far better,
and that the data could not say whether sibling-named agents were chosen by gate state, because gate state at the moment of
registration was never recorded. This records it.

## What is recorded (migration 063, kept across resets, every row carries its reset date)

- `agent_sightings`: one row per agent per reset. `first_seen_at` and how sure that is (`source`):
  - `live`: it appeared between two scans, so its registration is bracketed by `prior_scan_at` .. `first_seen_at` (15 minutes);
  - `snapshot`: backfilled from the hourly `agent_credit_snapshots`, so within an hour;
  - `baseline`: already there when the watcher first ran, so `first_seen_at` is only an upper bound.
  Also faction, start system and HQ waypoint, how many agents shared that start in the scan that first saw it, credits and
  ships then and now.
- `agent_samples`: credits and ships per agent every 30 minutes (the leaderboard curve).
- `gate_progress_samples`: the start-system gate's fulfilled and required totals, written when they change (and once at first
  sight), so the state of a gate at any moment is the latest row at or before it, and the time to build one is first sample to
  complete.

`agent_credit_snapshots` (hourly, from the galaxy crawler) is on `Store.SHARED_GALAXY_TABLES` and is wiped at every weekly
reset. The first time the watcher runs for a reset it copies that reset's snapshots into `agent_sightings` and `agent_samples`,
so deploy it before the reset to keep a week.

## How it runs

`src/engine/agentWatcher.ts` is started from `src/cli/index.ts` and ticks every minute; a scan runs every 15 minutes:
`GET /` for the reset date, the whole agent list (about 9 requests), then the start-system gates that are due (a new agent's
system at once, an unfinished gate every 30 minutes, a finished gate never). All reads are public and tokenless, about 10 to 60
requests per scan, with a pause between requests and retries on 429 and server errors. It never touches the game, any tenant's
rate limiter or the fleet. A scan that cannot read the whole agent list writes nothing and is tried again next minute.
`AGENT_WATCH=off` disables it. The pure planning (`planScan`, `gatesDue`, `gateSampleChanged`, `gateAtOrBefore`,
`gateBuildTime`) is in `src/engine/agentWatch.ts`.

## Reading it

Ops tool `agent_watch` (`stcommand_ops_agent_watch`): filter by `agent` (part of a name, so `FIRST` finds FIRST and FIRST496),
`system`, `sinceHours` (first seen within the last N hours, baseline rows excluded) and `resetDate` (a past week). Each row gives
the source and bracket, who shared the start, credits and ships then and now, and the start gate at first sight, now and when it
finished. The summary gives sightings by source, new agents per hour, and the hours start gates took from the first sample to
finish.

## What it cannot tell you

- A `baseline` row has no registration time. The reset at 13:00 UTC on 2026-10-25 is the first one the watcher will see from
  the start, so that week's rows will be `live` (15 minute brackets).
- Gate timelines start at the watcher's first sample of a gate. A gate already finished at its first sample has no timeline.
- Name families and "kept versus dropped" are inferences from names and credits, not facts about people.
