# API lanes: a pool of proxies

Status: phase 1 built 2026-11-08 (pool, failover, bytes counter; see CHANGELOG); phases 2-3 and the bandwidth guard not built. Plan written 2026-11-07 ( operator: "if we need to we can add another proxy and split the keepers"; then "I have 100 with a 256 gig monthly limit").

## Why

SpaceTraders limits calls per source IP: 2 a second, burst 30. Today there are two lanes (`src/engine/apiLanes.ts`, doctrine clause `apiLaneProxy`):

- the **box lane** (this machine's IP, `API_RATE` 1.75/s = 105 a minute) carries every write and the urgent reads (trades, docks, navigation, a ship's own state);
- the **proxy lane** (`API_LANE_PROXY_URL`, 90 a minute) carries read-only GETs at priority 3-4: keeper market and shipyard reads, remote surveys, fleet-state refreshes. The crawler has its own proxy (`CRAWLER_PROXY_URL`).

Readings on 2026-11-07 (ops `api_budget`): box 94-98% full, proxy lane 69-75 of 90, keepers' real reads about 35 a minute. Three things the pool would fix:

1. **A dead proxy dumps its reads on the box.** At 17:13 the lane's breaker was open (the plan had run out of bandwidth); its reads fell back to the box, which queued them for 25-60 s, and ship polling lagged (22 ships showed "transit overdue"). A second proxy would take over before the box is touched.
2. **One lane is a ceiling for the keepers.** `keeperTopUpMaxCalls` sits at 135 against an estimate of 131 and top-up stopped at 21:10-22:10 (see journal 21:15, 22:15). More lanes lift that.
3. **The box lane is the real limit on trading** and the only way past it is a second IP for urgent calls (phase 3, risky, optional).

## The numbers (estimates, to be measured)

Bandwidth is the proxy plan's real budget, not the number of proxies: 100 proxies share 256 GB a month, and each proxy IP gets its own 2 a second, so 100 IPs are 12,000 calls a minute of rate we will never use.

- Proxy lane today: about 70 calls a minute. At a guessed 5-10 KB a call (a market read is a few KB, a page of ships 20+ KB) that is roughly 20-40 GB a month. If every call, box lane included, moved to proxies it would be roughly 30-50 GB. Either way about 12-20% of 256 GB, so there is room for about five times today's volume.
- These byte figures are a guess. **Step 0 of the build is a bytes-per-call counter** (response size by call kind) shown in `ops api_budget`, so the real number replaces this paragraph before any decision depends on it.
- Use few lanes, not 100: 3-6 active proxies cover failover and the keeper growth; keep the rest as spares to swap in when one is slow or blocked.

## Design

Pure module `src/engine/lanePool.ts` (project rule: pure, policy as data, explainable, tested alone), replacing the two-value `Lane = "box" | "proxy"`:

```
Lane = { id: "box" } | { id: "p1" .. "pN" }
LanePool = { lanes: [{ id, label, ratePerSec, breaker, stats }], policy }
chooseLane(req, pool, now) -> { lane, reason }
```

- **Classes.** `urgent` (priority 0-2 and every non-GET) stays on the box in phases 1-2. `deferrable` (GET at priority 3-4) uses the pool.
- **Which proxy.** A stable key from the call (the system the market is in, else the ship) maps to a preferred lane by rendezvous hashing, so one system's reads stay on one IP and adding or removing a lane moves only a small share. If that lane's breaker is open or its bucket is full, take the next lane in the hash order. Only when every proxy is out does a read go to the box, and only if its priority is 3; priority-4 telemetry waits or is dropped rather than touch the box.
- **Per lane:** its own token bucket (rate clamped as today), its own breaker (three failures open it for two minutes, one trial request closes it, as `LaneBreaker` does now), and rolling latency and failure counts used to demote a slow lane.
- **Bandwidth guard:** a clause `apiLaneMonthlyGB` (256). From the byte counter, project the month; when the projection passes the clause, shed priority-4 first, then remote surveys, then slow the keepers, before any urgent call is affected. Alarm line in the hourly update.
- **Config:** `API_LANE_PROXY_URLS`, comma separated, each `http://user:pass@host:port` with an optional `|rate` suffix. The single `API_LANE_PROXY_URL` keeps working as a pool of one. Credentials only ever in the box's environment; the logs and tools show `maskProxyUrl` labels.
- **Doctrine:** `apiLaneProxy` stays the on/off switch (ships off); new `apiLaneCount` says how many of the configured proxies are active (the rest are spares).

## Phases

1. **Failover** (build first). Pool of N proxies, preferred order by hash, next proxy when one fails, box last. Weight 1 proxy = today's behaviour, with a test. Also: byte counter and per-lane rows in `ops api_budget` (calls a minute, wait, breaker, bytes, projected GB).
2. **Sharded reads.** Spread keeper and survey reads across the active proxies; raise `keeperTopUpMaxCalls` (max 150 now, raise the clause maximum if lanes allow) so the top-up counts the new capacity.
3. **Trader lanes** (only if the box lane is the limit, and only per ship): pin each trader to one proxy for its whole trip; urgent calls on a proxy need a low-latency, reliable one, so test with a few ships first. Writes through a proxy that dies mid-trade are the bad case, so this phase gets its own plan.

## Tests

`tests/lanePool.test.ts`: one proxy equals today's `chooseLane`; stable mapping while the pool is unchanged; only the removed lane's keys move when one is removed; an open breaker is skipped; box fallback for priority 3 only; priority 4 sheds when every proxy is out; a bandwidth overrun sheds in the stated order; writes and priority 0-2 never leave the box in phases 1-2.

## Risks

- Shared datacenter proxies can be rate-limited by other customers of the same IP; the per-lane failure counts and breaker are the defence, and spares are what you swap in.
- A slow proxy adds latency to reads that something is waiting for (keeper top-up decisions); latency stats demote it.
- Bandwidth overrun silently kills every lane at once (it did at 17:13); hence the projection, the clause and the alarm.
- Reset week: at the start there are few ships and few reads, so the pool costs almost nothing; the galaxy crawl at hour 0 (see the charting item in `docs/TODO.md`) could use the pool instead of its separate proxy.

## Open questions for the operator

- How many proxies to switch on at first (suggest 3)?
- ~~Does the plan's 256 GB reset monthly on a fixed date?~~ Answered 2026-11-08 (operator): the plan renews on the same day each month, so the current period ends 2026-12-08 (it started 2026-11-08). Still open: whether the 256 GB counts request and response bytes both (ByteMeter counts the response only).
- Should the crawler's proxy join the pool or stay separate?
