# 08. Go-live and safety

The engine moves real in-game credits and an agent's standing on a leaderboard. The failure history of the operator's own
fleet gives the threat list: a lone trader dumping into a crashing price (-700k, 2026-10-30), a rejected-but-executed
purchase followed by a second one (2026-10-08), approvals taken on 1c price artifacts (4 sales, -0.86M), a 2-hour
all-buy block (about -11 to -16M), unexplained fleet stalls, deploys during the last day, 429 storms from bursts. This file
is the control surface that makes those classes of failure impossible or loud.

---------------------------------------------------------------------------------------------------

## 1. Autonomy levels (the engine promotes itself on evidence, inside an operator ceiling; the operator can lower or kill at any time)

| Level | Name | Allowed | Default |
|---|---|---|---|
| 0 | observe | reads, recording, decisions logged as would-do, paper ledger | **default after any start, any reset, any kill, any drawdown breach, any unclean restart** |
| 1 | safe trader | level 0 + trade lots on assigned routes by existing ships, refuel; no purchases of hulls/keepers/contracts/gate | first live level (M1, M2) |
| 2 | growth | level 1 + hull and keeper purchases within caps, contracts | M3-A/B after operator consent |
| 3 | expansion | level 2 + staging/releasing systems, gate feeds | post-M3 |

Operator decision (2026-11-15): the point of the engine is to be autonomous, so it climbs the levels by itself. The operator keeps three things
that the engine can never change: the ceiling (`autonomy.maxLevel`, default 3), the spend caps and the kill/drawdown limit (section 3).

Rules:
- The process starts at level 0 after any start, reset, kill, drawdown breach or unclean restart. It may start straight at `runtime.autonomyLevel` only when that is set AND the start command carries `--i-understand-live`.
- **Promotion (new):** the engine raises its own level by one step when ALL of the promotion conditions for the next step hold, never above `autonomy.maxLevel`, and logs a `level.promoted` event with the evidence. Conditions:

| Promote | Conditions (all, measured by the engine from its own ledger) |
|---|---|
| 0 -> 1 | M0 checks passed this run: IP echo differs from the host's, API shapes verified, 10 minutes of sane `would-do` decisions, zero 429s in the last 10 minutes, free disk above the floor, kill switch file absent |
| 1 -> 2 | at least 2 hours at level 1, at least 30 completed trips, matched profit positive and above the hourly floor `promote.minProfitPerHour`, no `X` rule veto in the last hour, no drawdown above half of `maxDrawdownPct`, wallet above `promote.minWallet` |
| 2 -> 3 | at least 6 hours at level 2, hull and keeper purchases paid back on plan (realised vs planned within 25%), 429 ratio under 1%, no kill in the last 24 hours, wallet above `promote.minWalletL3` |

- **Demotion is immediate and automatic** (to 0 on a kill, drawdown breach or budget breach; one level down when a promotion condition stops holding for 30 minutes). After a demotion the engine waits `promote.cooldownMin` (default 60) before promoting again, and at most 2 promotions per rolling 6 hours.
- The operator can lower the level or kill at any time (edit `runtime.yaml` and SIGHUP, or the kill switch). Raising `autonomy.maxLevel` is operator-only. Shadow mode ignores the level for execution (forced 0).

## 2. Kill switch

Design: simple, local, impossible to lose, requires no network.

| Mechanism | Effect | Latency |
|---|---|---|
| Kill file `data/KILL` exists | autonomy forced to 0 at the next tick | <= 1 tick (1.5 s) |
| SIGUSR1 to the process | same as creating the file (writes `data/KILL` with reason `signal`) | immediate |
| SIGTERM/SIGINT | graceful stop: finish the current API call, mark intents, write `cleanShutdown`, release the lock; open trips are left to be reconciled at next start | seconds |
| SIGKILL / crash | state recovered at next start by reconciliation (03 section 6.3) | n/a |
| `maxDrawdownPct` breach (default 10% of the week's start credits, or 10% of the peak equity once equity exceeds 2x start; whichever the operator configures) | writes `data/KILL` itself with reason `drawdown`, raises a critical alert | <= 1 tick |
| Budget hard cap hit | alert critical; the limiter already blocks; if repeated 3 times in 10 minutes autonomy -> 0 | |
| X-14 watchdog (no sells in 15 min while traders assigned) | alert critical; diagnostic dump; autonomy stays (diagnostic only) unless it persists 45 minutes, then autonomy -> 0 | |

What "kill" does to an open trade (policy `onKill`, default `hold`): a ship carrying cargo does NOT dump it. It holds
(waits docked or in orbit), because a forced dump at a bad price is the exact failure of 2026-10-30. The operator decides afterwards to
resume (delete `data/KILL`, restart at level 1) or to sell manually. `onKill: finishTrip` (only sell at the already-planned sink if the floor holds) is selectable.

Clearing a kill: delete the file and restart the process or send SIGHUP; the engine starts at level 0 and the operator raises the
level deliberately. There is no auto-resume, except X-02's circuit breaker auto-resume within level 1 (30 minutes, sizes halved), which is bounded to once per 6 hours.

## 3. Spend caps and exposure limits (policy data; enforced in RiskGuard at decision time AND at send time)

| Cap | Default | Applies to |
|---|---|---|
| `maxSpendPerPurchase` | the lesser of 500,000 and 5% of the wallet (hull or keeper); for a bulk freighter, the lesser of 5,000,000 and 5% of the wallet | one purchase; the engine never raises this itself |
| `maxSpendPerDay` | 10,000,000 or 25% of the wallet, whichever is lower | sum of ship + contract/gate purchases in a rolling 24 h (M3); raised only by the operator |
| `maxTradeNotional` | 25% of wallet, hard 400,000 for level 1 | cargo cost of one trade (units x buy avg) |
| `maxCargoExposure` | 60% of wallet | total cost basis of cargo aboard all ships (guards against ending with cargo that cannot sell) |
| `maxOpenTrades` | ships count | |
| `minWallet` (X-07) | 25,000 | below it only fuel and trades that pay within one trip |
| `purchase.policy` | `autonomous` (operator decision 2026-11-15; replaces the 24 h window) | at level 2 and above the engine may buy hulls and keepers by itself, but only inside the caps in this table; `windowed` (with `purchase.enabledUntil`, an ISO timestamp at most 24 h ahead) remains available to the operator as the stricter mode |
| `maxHullSpendPctPerHour` | 10% of the wallet, and never more than `maxSpendPerDay` | rolling hour; the binding cap on growth. A share of the wallet scales with the engine's own success and shrinks after a loss; the fixed `maxSpendPerDay` is the backstop. Operator may change both |
| `maxTradeLoss` (X-01) | 150,000 | single trade realised loss triggers pause + alert |
| `lossLimit` (X-02) | 500,000 per rolling hour | global trade pause |
| `maxDrawdownPct` | 10% | kill |
| API hard caps | 105/min live (60 shadow), hour, day | no code path bypasses |

All caps are read from policy at every tick; a cap raise is a `config.change` event with who/when/before/after.

## 4. Go-live checklist (every item is a checkbox in `docs/runbook.md`; M1, then each M3 slice, then each reset)

### 4.1 Before the first live run (once)
- [ ] M0 acceptance evidence committed; M1 tasks M1-1..M1-8 done; CI green on the commit to be run.
- [ ] `STAR_*` secrets present only as env/secret file; `.gitignore` verified; secret scanner clean.
- [ ] Separate source IP proven by `doctor` (proxy differs from direct; matches `STAR_EXPECT_EGRESS_IP`); not any stcommand proxy variable.
- [ ] Operator decisions recorded for: autonomy appetite, maximum drawdown, Q-INTERFERE, spend caps (section 3), first-week mode.
- [ ] Kill switch tested live: create `data/KILL` and confirm level 0 within one tick; SIGUSR1 test; drawdown test in sim.
- [ ] Forced-restart test on the fake server passed (kill -9 mid-trade).
- [ ] Hard budget proof query run on the shadow data: max calls in any 60 s <= cap.
- [ ] Alerts reach a human: `alerts.log` is watched or the webhook (Q-ALERT) is configured; test alert fired.
- [ ] Disk free over 20% and recordings rotation works; clock sync (NTP) checked.
- [ ] Runbook read by the operator; stop procedure rehearsed.

### 4.2 Every live start
- [ ] `star doctor` green. Policy hash recorded. Autonomy level written down.
- [ ] Wallet and ships read; reconciliation passed (no unknown intents).
- [ ] Start at level 0 for 10 minutes: decisions look sane (read the `would-do` reasons), then level 1 with the operator watching for the first hour.
- [ ] First hour: check calls per minute under cap, 429 ratio under 1%, no X-01, trade ledger FIFO plausible (buy and sell lines pair), trips closing.
- [ ] Set a calendar reminder for the next hourly check; unattended runs need alert delivery.

### 4.3 Daily
- [ ] `star report --daily` read; skips and vetoes by rule scanned for surprises (a rule that never fires or always fires).
- [ ] Wallet/equity vs paper expectation; matched profit trend; idle fraction; budget utilisation.
- [ ] Disk space; recording copy off the machine; no uncommitted policy edits.

### 4.4 Reset day (the week's last 24 h and the reset)
- [ ] No deploys, restarts or policy changes in the last 24 h (lesson: restarts re-ran bursts and left state half-restored).
- [ ] W rules active; `noNewBuysMin` is 35 (not 120) and the P95 reducer has at least 30 trips, else the default.
- [ ] `purchase.enabledUntil` not extended past the hull stop times.
- [ ] At T-35 min: confirm no buys; at T-15: cargo sweep reviewed; at T-5: record wallet.
- [ ] After T: poll status only; confirm RESET_DETECTED -> ARCHIVE; either auto-register (M4) or register by hand; start at level 0; raise level only after bootstrap reads look sane.

### 4.5 Rollback
Everything is reversible except spent credits. Rollback = set level 0 (kill), leave ships where they are, keep recording. A bad
policy version is reverted by restoring the previous `policy_versions` row (the engine can load any stored version by number).

---------------------------------------------------------------------------------------------------

## 5. What must NEVER be automated (hard list; each is enforced by absence of code or a typed gate)

| # | Never automated | Why |
|---|---|---|
| NA1 | Raising `autonomy.maxLevel`, raising spend caps (`maxSpendPer*`, `maxHullSpendPctPerHour`, `maxTradeNotional`), raising `maxDrawdownPct`, editing the kill switch or the promotion conditions | operator authority; the engine may promote itself only within `autonomy.maxLevel` on the conditions in section 1, and must never widen its own limits |
| NA2 | Hull buying beyond the caps in section 3 | the operator chose autonomous buying (2026-11-15), so a purchase needs no window; it still needs level 2, the caps, the 3,000,000 wallet gate and a read-before-buy. Superseded: the earlier rule "no unattended hull buying without an open window" |
| NA3 | Approving a below-floor sale on a single price reading; auto-selling at a loss over `maxTradeLoss` | 4 sales lost 0.86M on 1c artifacts; X-13 corroboration is a veto, not a suggestion |
| NA4 | Scrapping or selling ships (`scrap=false`) | refund unmeasured for big hulls; irreversible |
| NA5 | Registering agents on any account other than the configured one, changing account credentials, creating accounts | credentials and account standing |
| NA6 | Changing proxies/IPs, buying proxy plans, authorising addresses | money and network policy |
| NA7 | Touching, commanding, or reading the live stcommand fleet, its MCP servers, its database, its proxy lanes | independence and safety |
| NA8 | Self-modifying code, self-deploying, pulling and running new code, auto-updating dependencies | integrity |
| NA9 | Restarting or redeploying itself (a supervisor may restart a CRASHED process; it must not restart a healthy one, and never in the last 24 h) | restarts re-run bursts and lose in-flight context |
| NA10 | Retrying a mutating call after an error/timeout without a prior state read | double-buy history |
| NA11 | Using an LLM, remote model, or any non-deterministic advisor in a decision path | design goal 2 |
| NA12 | Sending any token, key or credential to logs, recordings, status endpoints, alerts or third parties | secrets |
| NA13 | Deleting week files, recordings or the meta database | calibration data |
| NA14 | Running live on a shared source IP without an explicit operator decision | halves both budgets |
| NA15 | Entering contract penalties or deliberately accepting contracts that cannot meet their deadline (C-07 declines early) | penalties |
| NA16 | Warp-drive pre-gate expansion experiments and other untested strategies without a shadow week | unproven |

## 6. Open questions for the operator (consolidated; answer before the milestone named)

Each has the plan's default so work can proceed. Also record each in the new repo's `docs/open-questions.md`.

| Id | Question | Plan default | Needed by |
|---|---|---|---|
| Q-ACCT | May a second agent be registered on the same account concurrently with the live agent? Does registration need a captcha or other manual step? How are account tokens obtained and rotated each week? | assume yes; register by hand the first week | before M0 live (11-15) |
| Q-CALLSIGN / Q-FACTION | Which callsign pattern and faction for STAR? Does faction matter for the start? | callsign `STAR<n>` (generic), faction operator's choice | M0 |
| Q-SAMEIP / Q-PROXY / Q-IPECHO | Can the operator supply a SEPARATE source IP (proxy), who pays, how is the machine's address authorised, which IP-echo service is trusted? If not, may STAR run capped at 20% of the shared IP (about 21 calls/min)? | separate IP required; shared-IP shadow only at 20 calls/min with an interference caveat | before M0 live |
| Q-HOST | Where does STAR run (a separate VM/machine, not the stcommand box)? | separate machine, SQLite | before M0 |
| Q-STACK | Is TypeScript/Node + SQLite acceptable, or Postgres/another language preferred? | TypeScript/Node 22, SQLite | before S2 |
| Q-SHADOW-INTEL | May the shadow agent move its own start ships to read prices (option 2), or must it stay strictly passive (option 1) with only an import feed? | option 1 plus import feed | before M0 live |
| Q-EXPORT | Will the operator supply the live-fleet export (market rows, trades, hourly curve, roster) as files, how often, and via what hand-off? | hourly files; STAR never connects to stcommand | before 11-15 |
| Q-SEED | Are recorded market snapshots from earlier weeks available to seed the simulator, and in what format? | none; calibrate on the first recordings | M0 |
| Q-AUTONOMY | How much autonomy and what maximum drawdown triggers a human? Is advisory-only for the first live week acceptable? | shadow week, then level 1 with 10% drawdown kill | before M1 |
| Q-INTERFERE | May STAR trade live in a universe where THEO plays (shared markets)? | no: shadow only during the live fleet's week; M1 on the next week | before M1 |
| Q-HARD | Which numbers are hard policy versus defaults STAR may tune: 3M hull gate, 5M keeper gate, 1.5M bulk floor, post-gate 1.0M window, 35-minute wind-down, ceilings multipliers? | all are defaults in policy, operator-tunable; STAR never tunes caps | M3 |
| Q-GATE | Is the 3M hull gate measured before or after the purchase? | after (conservative) | M3-A |
| Q-START | How many ships and what credits does a new agent start with (175,000 and 2-4 ships were seen)? | read at registration; context table | M0 |
| Q-SCRAP | Explore scrapping hulls at the end (refund for bulk unmeasured; 68-72% measured for 85k shuttles)? | no (`scrap=false`) | after M4 |
| Q-MINING | Is mining/siphoning in scope after M3? | no | after M4 |
| Q-LANES | Multiple source IPs (lane pool) later? | no, single IP in v1 | after M4 |
| Q-ALERT | How should alerts reach a human (file, webhook, email, chat)? | `alerts.log` plus optional webhook | before M1 |
| Q-RESETTIME | Is the reset exactly at `serverResets.next`; how long until registration works after it? | assume minutes; poll | M0 |
| Q-FEE | Do trades carry a separate fee? | unknown; modelled 0 | M0-3 |
| Q-CURVE | Per-lot versus per-unit price curve? Why did ALUMINUM at tv 60 move 8-10% per 40-unit load while FAB_MATS moved 3.5-5.6% per 20-unit lot? | per-(wp,good) fitted impact | M0/M2 |
| Q-ASSIGN | Is greedy assignment within a few percent of optimal? | greedy; measure in replay | M2 |
| Q-LEADERBOARD | Confirmed by the operator on 2026-11-14: raw wallet only at the end; hulls and cargo do not count | wallet | resolved |
| Q-API-A | Every (A) in 02/03/04 (status fields, register, market presence rule, trade response contents, error body, pagination, hull type symbols, travel formula, fuel formula, rate headers) | verified in M0-3 | M0 |

## 7. Alerts (codes; written to `alerts.log` and as `alert` events)

`budget.cap_hit` (critical), `budget.429_ratio` (warn >1%, critical >5%), `budget.hot_loop` (warn), `proxy_down` (critical),
`egress.ip_mismatch` (critical, refuses start), `reset.detected` (info), `reset.overdue` (warn), `register.failed` (critical), `latch.dead_token` (critical until reset flow completes),
`killswitch.on` (critical), `drawdown.breach` (critical), `risk.x01_loss` (critical), `risk.x02_breaker` (critical), `watchdog.no_sells` (critical),
`schema.invalid_payload` (warn, rate limited), `disk.low` (critical under 10%), `lock.lost` (critical, halts), `policy.rejected` (warn),
`purchase.window_closed` (info), `shadow.mutating_call_attempt` (critical: a bug; the call was blocked).

## 8. Incident handling (first actions; every row begins with READ)

| Incident | First actions |
|---|---|
| Sales losing money | `star status`; read `ledger` worst trades; kill if X-01 repeated; do not approve anything manually without two-market corroboration |
| 429 storm | confirm cap and utilisation in `/status`; look for a hot loop (`api_calls` by call type last 10 min); lower `maxCallsPerMinute` by 20% via policy; do not restart |
| Stall (no sells 15 min) | read ships and last calls; compare `ships` arrival times vs now (X-05); read `api_calls` rate; if >= 5 ships hung for 30 min, restart ONCE (log the minute), then reconcile |
| Double purchase suspected | read `intents`, `purchase.ship` events, agent ship count BEFORE any further action; never buy to "balance" |
| Reset not detected | `curl` the unauthenticated status through the proxy; check `kv.lastResetDate`; if dead-token latch is set but state is not RESET_DETECTED, restart the watcher (not the process) |
| Disk full | stop recorder first; free `recordings/`; never delete week files |
| Proxy down | do nothing: the engine pauses by design; fix the proxy; never configure a direct fallback |

## 9. Definition of safe-to-run (summary)

STAR may run live only if: a separate IP is proven; a kill switch exists and was tested; caps are set by the operator; the hard
budget proof holds on recorded data; forced-restart and chaos tests passed; the operator is watching the first hour; and every item in
section 5 is still true in the code (a CI test greps for forbidden capabilities: no `sell_ship`-style endpoint wrapper is imported by `core`, no LLM dependency, no write path to `autonomy`).
