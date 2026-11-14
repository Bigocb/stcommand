# 03. API client, source IP, request budget, 429 handling, weekly reset

The API budget is the scarce resource of this game at scale, not credits (design goal 4). This file specifies the only
code that touches the network. Everything marked (A) is an assumption about the SpaceTraders v2 API that the design plan
did NOT verify (it did not re-fetch the public docs). M0 task M0-3 verifies each (A) against the live public docs and
against recordings, and records the answer in `docs/api-facts.md` (with the date and a captured sample response). Until
verified, every (A) behaviour sits behind `src/api/endpoints.ts` + `src/api/schemas.ts` only.

---------------------------------------------------------------------------------------------------

## 1. Facts that are NOT assumptions (measured by the operator's stcommand, 2026-11-02)

| Fact | Detail |
|---|---|
| The limit is per SOURCE IP | A probe on a second account on the same IP sent 120 requests in 20 s and got 68 429s; response headers `x-ratelimit-type: IP Address`, `x-ratelimit-limit-per-second: 2`, `x-ratelimit-limit-burst: 30`, `retry-after: 1`; the live fleet on the other account got 429s during the burst |
| An account's agents share a limit | The game's dashboard says so. Both hold: the IP is the binding one |
| A second account on the same IP gets no extra budget | Only a different source IP does |
| stcommand runs at 1.75 req/s (105/min) with ~10 proxy lanes for read-only priority 3-4 traffic | At 99% utilisation (1.5 req/s) it logged 3-4% 429s all week |
| The 429 rate stayed 300-380/h (3-4%) even with 10 lanes | headroom matters more than lane count |

Consequences encoded below: STAR needs its own IP (section 3); its limiter budgets in calls per minute with hard caps
(section 5); it must be able to prove, from its own `api_calls` table, calls per minute and calls per profit unit.

---------------------------------------------------------------------------------------------------

## 2. Module layout

```
src/api/endpoints.ts   typed wrappers, one per endpoint: they build the path, the body, call client.request(), parse with a zod schema
src/api/schemas.ts     zod schemas for every response; the ONLY place that knows JSON field names; maps to src/domain types
src/api/client.ts      undici request, auth header, proxy agent, timeouts, error classification, header capture
src/api/limiter.ts     token bucket + sliding-window HARD caps (per minute, per hour, per day) + 429 back-off state
src/api/budget.ts      priority queue in front of the limiter, shedding, starvation promotion, accounting
src/api/readOnly.ts    ReadOnlyApi: type-level and runtime restriction to GET (+ nothing else)
src/api/resetWatcher.ts poll GET /v2/ (A), 401 latch, emits state.transition events
```

### 2.1 Types

```ts
export type Priority = 0 | 1 | 2 | 3 | 4;
// 0 in-progress trade/dock/navigate/orbit/refuel   (money is moving or a ship is mid-action)
// 1 purchases (ships) and contract/gate commitments
// 2 arrival-triggered market reads and ship refreshes that a decision is waiting on
// 3 keeper reads, scheduled intel reads
// 4 background: waypoint/system crawl, status poll for non-critical purposes
// EXCEPTION: the reset-status poll (GET /v2/) is sent at priority 0 but counts against the hard caps like any call

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;                       // e.g. "/my/ships/ABC-1/dock" (relative to baseUrl)
  body?: unknown;
  query?: Record<string, string | number>;
  priority: Priority;
  role: string;                       // 'trader' | 'keeper' | 'crawler' | 'bootstrap' | 'status' ...
  callType: string;                   // `${role}:${kind}`, written to api_calls
  ship?: ShipSymbol;
  auth: 'agent' | 'account' | 'none';
  mutating: boolean;                  // derived from method; enforced by ReadOnlyApi
}

export type ApiError =
  | { kind: 'rate_limited'; retryAfterSec: number; headers: RateHeaders }
  | { kind: 'dead_token'; message: string }                 // 401 whose text matches /reset_date does not match/i (A) -> latch
  | { kind: 'unauthorized'; message: string }                // other 401
  | { kind: 'client'; status: number; code: number | null; message: string }   // 4xx the game returned with an error code (A: error body shape)
  | { kind: 'server'; status: number }                       // 5xx
  | { kind: 'network'; message: string }                     // timeout, reset, DNS
  | { kind: 'invalid_payload'; zod: string };                // response failed schema validation
export type Result<T> = { ok: true; value: T; headers: RateHeaders; durationMs: number } | { ok: false; error: ApiError };
export interface RateHeaders { type: string | null; limitPerSecond: number | null; burst: number | null; remaining: number | null; retryAfterSec: number | null }
```

### 2.2 Endpoint wrappers (all (A): verify paths, verbs, body and response shapes in M0)

| Wrapper | (A) Method + path | Priority default | Purpose |
|---|---|---|---|
| `getStatus()` | GET `/` (the v2 root, unauthenticated) | 0 | `resetDate`, `serverResets.next`, announcements |
| `register({symbol, faction})` | POST `/register` with the ACCOUNT token | 1 | New agent; returns the agent token. Never retried automatically |
| `getAgent()` | GET `/my/agent` | 2 | credits, headquarters |
| `listShips(page)` | GET `/my/ships?limit=&page=` | 3 | ship states |
| `getShip(sym)` | GET `/my/ships/{sym}` | 2 | refresh one ship (X-05) |
| `orbit/dock(sym)` | POST `/my/ships/{sym}/orbit`, `/dock` | 0 | |
| `navigate(sym, wp)` | POST `/my/ships/{sym}/navigate` | 0 | response should carry arrival time and fuel (A) |
| `jump(sym, wp)` | POST `/my/ships/{sym}/jump` | 0 | gate hop (A: requires being at a gate waypoint; cooldown) |
| `refuel(sym, units?)` | POST `/my/ships/{sym}/refuel` | 0 | |
| `buy(sym, good, units)` / `sell(...)` | POST `/my/ships/{sym}/purchase`, `/sell` | 0 | response should carry transaction and agent credits (A3: post-trade market prices unknown, verify) |
| `listWaypoints(sys, page)` | GET `/systems/{sys}/waypoints?limit=&page=` | 4 | public (A: may need no token) |
| `getMarket(sys, wp)` | GET `/systems/{sys}/waypoints/{wp}/market` | 2-3 | prices only when a ship of ours is present (A) |
| `getShipyard(sys, wp)` | GET `/systems/{sys}/waypoints/{wp}/shipyard` | 3 | listings with prices only when a ship is present (A) |
| `getJumpGate(sys, wp)` | GET `/systems/{sys}/waypoints/{wp}/jump-gate` | 3 | connections (A) |
| `getConstruction(sys, wp)` | GET `/systems/{sys}/waypoints/{wp}/construction` | 3 | gate materials (A); M3 slice |
| `buyShip(yardWp, type)` | POST `/my/ships` | 1 | hull purchase (A); never in shadow mode |
| contracts: `listContracts`, `acceptContract`, `deliver`, `fulfil` | (A) `/my/contracts...` | 1 | M3 slice |

Pagination (A): list endpoints are paged; the wrapper loops until a short page. Each page is a call and counts against the budget; the crawler (priority 4) is allowed to stop mid-listing when shed.

---------------------------------------------------------------------------------------------------

## 3. Separate source IP (hard requirement)

Why: sharing the operator's box IP with the live fleet would (a) halve the budget of both (measured), and (b) put the
live fleet at risk of 429 storms caused by STAR. STAR must therefore leave from a different IP.

Implementation:
1. `STAR_PROXY_URL` holds a forward proxy URL (HTTP/HTTPS; may include credentials, so it is a secret). The client builds `new ProxyAgent(url)` from `undici` and passes it as `dispatcher` for every request. When unset, the process may run ONLY in `--offline`/replay/sim modes; `run`, `shadow` and `record` refuse to start (`egress.requireSeparateIp: true`).
2. The proxy must not be one of the live fleet's proxies. STAR's config never reads the stcommand variable names (`PROXY_URL_*`, `API_LANE_PROXY_URL`, `API_LANE_PROXY_URLS`, `CRAWLER_PROXY_URL`). The `doctor` command checks that `STAR_PROXY_URL` differs from any of those if present in the environment, and fails loudly if equal.
3. IP sanity check at start (`doctor` and start-up): fetch an IP-echo URL through the proxy and compare with `STAR_EXPECT_EGRESS_IP`; also fetch it WITHOUT the proxy and require the two to differ (proves the traffic leaves from another address). OPEN QUESTION Q-IPECHO: which echo service the operator trusts (the plan names none; the check is skipped with a warning if `egress.ipEchoUrl` is unset). A mismatch is a hard start-up failure.
4. If the proxy fails (network error to the proxy, 407, 502/503 from it): the client does NOT fall back to the direct route. It trips a breaker (`proxy_down`), pauses all calls, raises an alert, and retries the proxy with exponential back-off from 5 s up to 5 min. A direct fallback would silently share the live fleet's IP.
5. Single-IP rule inside STAR: all STAR roles (trader, keeper, crawler, bootstrap) share ONE limiter because they share one IP. If the operator later supplies several IPs, the limiter becomes a pool keyed by lane (post-M4, open question Q-LANES). Do not build lanes in v1.
6. The proxy's own cost/bandwidth is the operator's (open question Q-PROXY: provider, authorisation of the machine's address, byte budget). STAR estimates its monthly traffic from `api_calls` (average bytes per call is recorded) and shows it in `/status`.

OPEN QUESTION Q-SAMEIP: if the operator cannot supply a second IP, the fallback in the design plan is to cap STAR at
20% of the shared IP budget (~21 calls/min of 105). That is implemented as `budget.maxCallsPerMinute: 20` and marked
`sharedIp: true`; the shadow harness (07) then states that its numbers carry an interference caveat. Do not run live
(autonomy >= 1) on a shared IP without an explicit operator decision.

---------------------------------------------------------------------------------------------------

## 4. Client behaviour (`client.ts`)

1. Headers: `Authorization: Bearer <token>` per `auth` kind (agent token or account token; none for status), `Content-Type: application/json`, `User-Agent` from config (generic name; no personal details, no contact email unless the operator supplies one).
2. Timeout: `api.timeoutMs` (default 15 s) via `AbortSignal.timeout`. A timeout is a `network` error with status 0 recorded in `api_calls`. For mutating calls a timeout means UNKNOWN outcome: the executor must read state before any retry (D9, X-04).
3. Classification: 2xx -> parse with zod, failure -> `invalid_payload` (event `alert` warn; the observation is dropped, X-10). 429 -> `rate_limited` with `retry-after` header (default 1 s if missing). 401 with body text matching `/reset_date does not match/i` (A) -> `dead_token`; other 401 -> `unauthorized`. 4xx with a JSON error body -> `client` (A: error body has a numeric `code` and `message`; store both). 5xx -> `server`.
4. Header capture on every response: `x-ratelimit-type`, `x-ratelimit-limit-per-second`, `x-ratelimit-limit-burst`, `x-ratelimit-remaining` (A: may not exist), `retry-after`. The latest values are stored in `kv` and shown in `/status`. If `x-ratelimit-limit-per-second` ever differs from 2 the limiter re-derives its target (design assumption A10) and raises a warn alert.
5. Idempotency: the client never retries by itself. Retries are decided by the budget layer for 429 only (the request was not processed), and by the executor for everything else after a state read.
6. Recording hook: every request/response pair is passed to the recorder (`record` and `shadow` commands), with `Authorization` removed and `/register` token fields stripped.
7. Mutating guard: `client.request` throws `ReadOnlyViolation` if `mode: shadow` and the request is not a GET and not the single allowed registration call (`register`, only when `bootstrap` explicitly authorised it). This is the runtime half of the type-level `ReadOnlyApi` (section 8).

---------------------------------------------------------------------------------------------------

## 5. The request budget (first-class feature)

### 5.1 Concepts

| Term | Meaning | Defaults (shadow / live) |
|---|---|---|
| `targetRps` | Token-bucket refill rate, below the game's 2 req/s | 1.0 / 1.75 |
| `burst` | Bucket depth, below the game's 30 | 10 / 20 |
| `maxCallsPerMinute` | HARD sliding-window cap over any 60 s | 60 / 105 |
| `maxCallsPerHour` | HARD sliding-window cap over any 3,600 s | 3,300 / 6,000 |
| `maxCallsPerDay` | HARD cap over a rolling 24 h; a runaway-loop safety net | 70,000 / 140,000 |
| `shedAbove` | Utilisation (calls last minute / cap) above which priorities 4 then 3 are shed | 0.92 |
| `backoffFrac`, `backoffMin` | On a 429 the effective cap drops by this fraction for this many minutes | 0.25, 5 |

"Hard" means: no code path can send a request when a cap is reached. The limiter has no bypass flag; priority 0 calls
also wait. A hard cap hit is an alert (`budget.cap_hit`), because it means the plan or a loop is wrong.

### 5.2 Limiter algorithm (`limiter.ts`), pure enough to unit-test with a fake clock

```ts
class Limiter {
  constructor(private cfg: BudgetCfg, private clock: Clock) {}
  private tokens = cfg.burst;            // fractional tokens
  private lastRefillMs = clock.now();
  private sent: number[] = [];           // ring buffer of send timestamps (ms) for the last 24 h; trimmed lazily
  private backoffUntilMs = 0;
  private backoffCapFrac = 1;            // multiplier on caps while backing off (1 - backoffFrac)

  /** Returns 0 if a call may be sent now (and consumes a token and records the send), else ms to wait. */
  tryAcquire(): number {
    const now = clock.now();
    this.refill(now);
    const capMin  = Math.floor(cfg.maxCallsPerMinute * this.capFrac(now));
    const nMin = this.countSince(now - 60_000), nHour = this.countSince(now - 3_600_000), nDay = this.countSince(now - 86_400_000);
    if (nMin  >= capMin)                    return this.waitForWindow(now, 60_000, capMin);   // oldest in window expires at t+60s
    if (nHour >= cfg.maxCallsPerHour)       return this.waitForWindow(now, 3_600_000, cfg.maxCallsPerHour);
    if (nDay  >= cfg.maxCallsPerDay)        return this.waitForWindow(now, 86_400_000, cfg.maxCallsPerDay);
    if (this.tokens < 1)                    return Math.ceil((1 - this.tokens) / cfg.targetRps * 1000);
    this.tokens -= 1; this.sent.push(now);
    return 0;
  }
  on429(retryAfterSec: number, now: number) {
    this.backoffUntilMs = Math.max(this.backoffUntilMs, now + Math.max(retryAfterSec, 1) * 1000);
    this.penaltyUntilMs = now + cfg.backoffMin * 60_000;          // reduced cap for backoffMin minutes
    this.tokens = 0;                                               // drain: no burst right after a 429
  }
  private capFrac(now: number) { return now < this.penaltyUntilMs ? 1 - cfg.backoffFrac : 1; }
  // while now < backoffUntilMs tryAcquire() returns (backoffUntilMs - now)
}
```

Unit-test properties (see `06`): for any random arrival sequence and any config, the number of sends in ANY 60 s window
never exceeds the effective minute cap, any 3,600 s window never exceeds the hour cap, and no more than `burst` sends occur
within one second after an idle period.

### 5.3 Priority queue and shedding (`budget.ts`)

```
request(req) -> Promise<Result>:
   if killed(req) -> reject
   enqueue(req) in queue[req.priority] (FIFO)
loop (every 50 ms or on enqueue/response):
   if clock < backoffUntil: wait
   util = callsLastMinute / effectiveMinuteCap
   if util > shedAbove for >= 2 consecutive minutes:  shed priority 4 then 3  (reject with {kind:'shed'}; the callers treat it as "not now", re-schedule later; B-04)
   pick the lowest-numbered non-empty priority (promotion: an item waiting > starveMs[p] counts as priority p-1)
   wait = limiter.tryAcquire(); if wait > 0: sleep(min(wait, 250ms)); continue
   send; on completion: account (api_calls row), update stats
on 'rate_limited': limiter.on429(...); re-queue the SAME request at the FRONT of its priority (a 429 means it was not processed) with attempt+1; max 5 attempts, then fail with rate_limited
on slack (util < slackBelow=0.7 for 2 min): `budget.slack` event; keeper/crawler schedulers may raise their request rates (B-05)
```

Rules (design plan B-01..B-10):
- B-02 priority classes as in 2.1. Trades are never starved by reads: a priority 0-1 request is granted before any 2-4.
- B-04 shedding keeps trading responsive.
- B-07 `reuseResponses`: the ship worker and observer use the response of a trade/navigate/dock call to update state; no confirm-read follows a successful call. Tests assert a successful `sell` triggers zero follow-up GETs for that ship in the same trip step.
- B-08 hot-loop detector: if the same `(callType, ship|waypoint)` is requested more than `loopMax` (6) times in a minute, the budget layer rejects further ones for a cool-down (`budget.hot_loop` alert with the call key). A test makes a fake worker spin and expects throttling.
- B-10 `minValuePerCall` is `0` (off) by default; the keeper scheduler uses `expectedProfitDelta / call` once it exists (M3).

### 5.4 Planned budget allocation (shares of `maxCallsPerMinute`), policy-controlled

| Consumer | Share (live default) | Calls/min at 105 | Notes |
|---|---|---|---|
| Trading ships (priorities 0-2) | 0.55 | ~58 | ~10-16 calls per trip, 9-minute mean trip => ~1.3-1.8 calls/min/ship => about 32-44 ships worth (formula below) |
| Purchases and gate/contract | 0.05 | ~5 | rare |
| Keeper reads (priority 3) | up to `keeperShare` 0.30 | ~31 | design B-06: keeper interval chosen so calls/min <= keeperShare; the stcommand fleet used ~140 calls/min for ~950 keepers (about 7 min each). STAR has no keepers in M0-M2 |
| Background crawl (priority 4) | 0.10 | ~10 | shed first |
| Reserve (never planned; absorbs 429 back-off) | 0.15 headroom is kept by setting the cap below the game's, not by a separate bucket | | |

Capacity formula used by the scheduler to decide "can we afford one more trading ship": `maxShips = floor(0.55 * cap / (callsPerTrip / tripMinutes))`.
Example with live cap 105, callsPerTrip 14, tripMinutes 9: `0.55*105 / (14/9) = 37`. In shadow (cap 60): `0.55*60/(14/9) = 21`. The purchase planner (04) refuses to buy a hull when `ships >= maxShips` (rule G-11 "route capacity") and logs the formula.

Calls per profit unit: `api_calls` joined to `ledger` gives `callsPerKCredit = calls in window / (matched profit / 1000)`. It is a headline metric
(07) and an input to T-11 tie-breaks (`profitPerCall` in `RoutePlan`).

### 5.5 Budget accounting and observability

Every sent request writes an `api_calls` row (columns in 02 section 5.1): time sent, call type, priority, queue wait, duration, status, `retry-after`.
`/status.budget` reports: calls in the last minute/hour/day, utilisation, 429 count in the last 10 min and 24 h, ratio 429/total, queue depth per priority, the call types ranked by count over the last 10 minutes (mirrors stcommand's `api_calls` ops tool), and the latest rate-limit headers.

Alert thresholds (written to `alerts.log` and `alert` events): 429 ratio over 1% for 10 min (warn) / over 5% (critical, drop autonomy to 0 after 30 min unresolved); utilisation over `shedAbove` for 10 min (warn); a hard cap hit (critical); the proxy breaker open (critical).

---------------------------------------------------------------------------------------------------

## 6. Weekly reset detection and recovery

Reset facts (design plan 2.5, stcommand CLAUDE.md): the game universe resets weekly (typically a weekend morning; the next two:
2026-11-15 13:00 UTC and 2026-11-22 13:00 UTC); every agent token dies at once; systems, waypoints, gates and markets are regenerated.
A dead token otherwise appears as a wall of 401s whose text says (A) the token is from a previous reset and the `reset_date` does not match.

### 6.1 Two independent detectors

1. **Proactive poll** (`resetWatcher.ts`): every `resetPollMin` (default 5; 1 inside the 15 minutes around the expected reset) call `getStatus()` (A: unauthenticated `GET /v2/` returns `resetDate`, `serverResets.next`, `serverResets.frequency`, `announcements`). Store `kv.lastResetDate`. If `status.resetDate != kv.lastResetDate` -> RESET_DETECTED. Persist `serverResets.next` as `resetAtMs` (the Snapshot's `resetAtMs` for wind-down math). If `serverResets.next` is in the past by more than 2 minutes and the date has not changed, raise a warn alert ("reset overdue"), keep polling every minute.
2. **Reactive latch**: any response classified `dead_token` sets `fatalAuthError` on the client; all further agent-authenticated calls fail immediately without sending (saves budget, matches stcommand). The latch also triggers RESET_DETECTED after confirming with one `getStatus()`.

The status poll itself can be rate-limited (stcommand's watcher saw `status fetch failed: status 429` on 2026-11-14 16:37). Therefore: the poll runs at priority 0, honours `retry-after`, retries up to 5 times with 1 s spacing within the poll, and a failed poll never marks the state unknown for more than one interval. At T-2 minutes the process pre-warms: free budget (shed priority 3-4) so the status poll and registration are not queued behind reads.

### 6.2 Process state machine (events `state.transition`)

```
LIVE ──(reset detected)──> RESET_DETECTED ──> FREEZE ──> ARCHIVE ──> REGISTER ──> BOOTSTRAP ──> OPENING ──> LIVE
                                                                     │ failure                    │ failure
                                                                     └──> REGISTER_WAIT (alert; retry)   └──> BOOTSTRAP_RETRY
```

| State | Entry actions | Exit |
|---|---|---|
| RESET_DETECTED | write alert; set `killSwitch=false` but `autonomy=0` internally | immediately -> FREEZE |
| FREEZE | cancel all PLANNED/SENT intents (mark ABORTED "reset"); stop all ship workers; budget accepts only status, register and bootstrap calls; no mutating calls | next |
| ARCHIVE | final read is impossible (token dead): use the last stored wallet/equity; `store.archiveWeek(endMs, lastKnownCredits)`; copy `rule_stats`, policy version, config changes into `meta.sqlite`; mark week file read-only; flush the recorder | -> REGISTER |
| REGISTER | `register({symbol, faction})` with `STAR_ACCOUNT_TOKEN` (A); callsign derived from config; on success write the agent token to `secrets/agent-token` (0600), open the new week file `<callsign>@<newResetDate>.sqlite` (the week id uses the NEW reset date), create the `weeks` row | -> BOOTSTRAP |
| BOOTSTRAP | `getAgent`, `listShips`, waypoints of the home system (paged), market of every waypoint where a ship is (prices) and market LISTS elsewhere, shipyards, jump gate; `bootstrapReadBudget` default 250 calls priority 1-2; start the recorder | -> OPENING |
| OPENING | hand control to the normal scheduler with phase OPENING (opening rules O-01..O-12 in 04) | -> LIVE |

Failure handling:
- REGISTER failure (A: account token expired, callsign taken, faction unavailable, rate limit): alert critical `register.failed` with the error code and message; retry every 60 s with the same callsign for 3 attempts, then with a suffixed callsign `<callsign>2` (config `callsignFallbackSuffix`) ONCE; then wait for a human (alert repeating hourly). Never loop faster than 1 call/min. Never call `register` twice concurrently. A registration that returned success but whose response was lost (network timeout) is treated as UNKNOWN: try a `GET /my/agent` with any token on file; if that fails, retry registration with the suffixed callsign (document in runbook that an orphan agent may exist).
- The ARCHIVE step must never block REGISTER for longer than 30 s; failure to archive is an alert, not a stop (the week file is already durable).
- A second reset detected during BOOTSTRAP restarts the machine at RESET_DETECTED.

### 6.3 Restart safety

On process start: read `kv`: `lastResetDate`, `weekId`, `autonomy`, `state`. Then `getStatus()`; if the game's reset date differs from the stored one, enter RESET_DETECTED. Otherwise resume `LIVE` in the same week file: rebuild projections if the last shutdown was unclean (`kv.cleanShutdown` absent), read all ships fresh (priority 2), reconcile every non-terminal intent (PLANNED/SENT intents from before the crash are marked `FAILED needsReadBeforeRetry` and reconciled by reads, never replayed), and only then let the scheduler assign jobs. A forced restart mid-trade must never lose cargo knowledge or duplicate a purchase (M1 acceptance).

OPEN QUESTIONS (reset): Q-ACCT (does the account token allow a second agent concurrently with stcommand's agent? any per-account agent limits? is a captcha or manual step involved? design A4); Q-CALLSIGN (callsign policy per week, must be unique per reset); Q-FACTION (which faction and does it change the start); Q-RESETTIME (the plan assumes the reset lands at the `serverResets.next` instant to within minutes; last observed: finished recovery by 13:05 UTC on the stcommand side).

---------------------------------------------------------------------------------------------------

## 7. Recorder (`record` command and always-on in `shadow`)

Purpose (design 2.6): the training data for the simulator and the replay harness. Output: NDJSON, one line per API exchange or
observation, rotated per day, per week directory: `recordings/<weekId>/YYYY-MM-DD.ndjson`.

Line schema:
```json
{"t": 1731686400123, "week": "STARX@2026-11-15", "type": "http", "method": "GET", "path": "/systems/X1-AB12/waypoints/X1-AB12-C3/market", "status": 200, "priority": 3, "role": "keeper", "durMs": 412, "headers": {"retry-after": null, "x-ratelimit-type": "IP Address"}, "body": { "...": "response JSON, tokens stripped" }}
```
Rules: strip secrets; compress daily files with gzip after rotation; cap a recording directory at a configured size (default 5 GB) and refuse to start the recorder when disk free is under 20% (the live box hit a full disk on 2026-11-13). The replay harness (06) reads these lines and feeds `observer` as if they had just arrived.

---------------------------------------------------------------------------------------------------

## 8. `ReadOnlyApi` (shadow-mode safety at the type level)

```ts
export interface ReadOnlyApi {
  getStatus(): Promise<Result<StatusFact>>;
  getAgent(): Promise<Result<AgentFact>>;
  listShips(page: number): Promise<Result<ShipState[]>>;
  getShip(sym: ShipSymbol): Promise<Result<ShipState>>;
  listWaypoints(sys: SystemSymbol, page: number): Promise<Result<WaypointFact[]>>;
  getMarket(sys: SystemSymbol, wp: WaypointSymbol): Promise<Result<MarketObservation>>;
  getShipyard(sys: SystemSymbol, wp: WaypointSymbol): Promise<Result<YardObservation>>;
  getJumpGate(sys: SystemSymbol, wp: WaypointSymbol): Promise<Result<GateEdges>>;
  // deliberately NO orbit, dock, navigate, jump, refuel, buy, sell, buyShip, deliver, accept, register
}
export interface FullApi extends ReadOnlyApi { /* mutating methods; only the LiveExecutor and bootstrap are typed to receive it */ }
```
`ShadowExecutor` and `Observer` are typed with `ReadOnlyApi`. `bootstrap` receives a separate `RegistrationApi` with only
`register`. A test (06) uses TypeScript's type checker (`tsd`-style `// @ts-expect-error`) to prove `ShadowExecutor` cannot
call a mutating method, and a runtime test proves `client.request` throws on a POST in shadow mode.

OPEN QUESTION Q-READS: whether reading market/shipyard prices needs a ship present, and whether the public market endpoint
returns only the goods lists without a ship (stcommand's operators observed: goods lists readable without a ship, prices need a
ship). In shadow mode the price coverage is therefore limited to waypoints where STAR's own ships are, unless the operator supplies an
import feed (`07` section 4).

---------------------------------------------------------------------------------------------------

## 9. API budget impact on the design (rules to carry into `04`)

1. Never poll a ship in transit: use `arrivalMs` from the navigate response and sleep until then (+ `arrivalGraceSec`).
2. A trade response is the market read: after a buy/sell, the ship worker updates the quote from the response if it carries post-trade prices (A3). Otherwise one read after the LAST lot of a visit, not after each lot.
3. Do not read a market at its sell destination before arrival unless the route is being validated by a keeper read already on a schedule; use the cached quote with its age discount.
4. Keeper polling is a purchase of freshness: cost per poll (1 call) versus the profit delta; M3 slice.
5. During OPENING the bootstrap reads (250 calls) are allowed to use up to 60% of the budget for 6 hours (O-12), then shed to priorities 0-2.
