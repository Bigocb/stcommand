# STAR Engine: implementation plan (hand-off package)

STAR = SpaceTraders Autonomous Runner (placeholder name; the repository is called `star-engine` below). This folder is a
self-contained, mechanical build plan for a STANDALONE repository: an autonomous, no-LLM trading engine for the
SpaceTraders v2 API. It builds on the design-level plan (`docs/side-projects/star-engine-plan.md` in the stcommand repo,
cited here as "the design plan"). If you are the implementing agent you have never seen stcommand and do not need it:
everything you need from it is restated here. Do not copy code from stcommand; there is none to copy.

Written 2026-11-14 (the day before the 2026-11-15 13:00 UTC weekly reset). Today's context: the operator's production
fleet (stcommand, agent THEO) will run next week (2026-11-15 to 2026-11-22) and STAR is to run beside it in SHADOW mode
without touching it.

---------------------------------------------------------------------------------------------------

## 1. How to hand this to an implementer

1. Give the implementer this whole folder (9 markdown files) and an empty git repository. Nothing else is required.
2. Tell them: "Read README.md, then build in the order of `05-milestones-and-build-order.md`. Each milestone has acceptance
   criteria; do not start the next milestone until the current one passes. Where a file says OPEN QUESTION or (A), do not
   guess: implement the stated default behind a config switch and write the question into `docs/open-questions.md` in the
   new repo."
3. The implementer needs: Node.js 22 LTS, git, an SQLite-capable machine (no server), and, from M0 on, a SpaceTraders
   account token plus a SEPARATE source IP (see `03`). They do NOT need an LLM key, a Postgres server, or access to the
   operator's fleet.
4. The first deliverable is M0 (shadow mode). It must be safe to run with zero risk to anything: it only issues GET
   requests (plus one registration POST) and records. If the implementer wants to deviate from any "DECIDED" item below,
   they must write a short ADR (`docs/adr/NNNN-title.md`) first.
5. The operator (a human) answers the open questions listed in `08-go-live-and-safety.md` section 6 and below in
   section 6 before M1 goes live with real money.

## 2. File index

| File | Purpose | Read when |
|---|---|---|
| `README.md` | Index, glossary, decisions already made, deltas from the design plan | First |
| `01-repo-and-scaffolding.md` | Repo layout, language/tooling choice and reasons, config, secrets (env var names only), CI | Before writing any code |
| `02-architecture-and-interfaces.md` | Pure modules and exact TypeScript types, data model, SQL schema, event log | Before writing `src/core` and `src/store` |
| `03-api-client-and-rate-budget.md` | HTTP client, own token, separate source IP, hard per-minute budget, 429s, reset detection and recovery | Before writing `src/api` |
| `04-decision-engine.md` | Market model, route scoring, assignment, purchases, cash discipline, reasons, policy file | Before writing `src/core` logic |
| `05-milestones-and-build-order.md` | M0..M4 with tasks and acceptance criteria | Always; it is the work order |
| `06-test-plan.md` | Unit, property, replay, fake API server, simulator, chaos | While writing each module |
| `07-shadow-comparison-harness.md` | How to run beside the live fleet next week and compare fairly | Before the first live run |
| `08-go-live-and-safety.md` | Kill switch, spend caps, go-live checklist, never-automate list, open questions | Before M1 live |

## 3. Glossary

| Term | Meaning |
|---|---|
| Agent | A SpaceTraders player identity (callsign, faction, token, credits). STAR gets its OWN agent. |
| Account token | Long-lived account-level credential used only to register a new agent each week (A: see open questions). |
| Agent token | Per-agent bearer token, dies at every weekly reset. |
| Reset | The weekly full regeneration of the game universe (typically Saturday/Sunday; next: 2026-11-15 13:00 UTC, then 2026-11-22 13:00 UTC). All agent tokens die; systems, waypoints, gates and markets are new. |
| Week id | `<agent callsign>@<reset date>`, e.g. `STARX@2026-11-15`. Every persisted game row carries it. |
| Market | A waypoint trading goods. Each good has `purchasePrice`, `sellPrice`, `supply`, `activity`, `tradeVolume` (A: field names verified in M0). |
| tradeVolume (tv) | Units per "lot" the market moves price on. Our own units move price about 4-5% per tradeVolume lot (design plan; measured on FAB_MATS 20-unit lots). |
| Supply | SCARCE / LIMITED / MODERATE / HIGH / ABUNDANT. Price is a function of stock, reversible, ~30 min market tick. |
| Activity | RESTRICTED / WEAK / GROWING / STRONG. For an export: production strength; for an import: consumption strength. |
| Lot | One buy or sell call of up to tradeVolume units. |
| Route | (buy waypoint, sell waypoint, good) plus planned units. |
| Trip | One execution of a route by one ship: navigate, buy lots, navigate, sell lots. |
| Matched profit | Realised profit on completed sells against a FIFO cost basis tracked per (ship, good). Wallet delta is never used to judge a rule. Unmatched sells are reported as revenue but not scored. |
| Equity | Wallet + holds, with holds valued at expected fetch. Smooth working measure. The leaderboard counts raw wallet credits only; cargo aboard at reset is destroyed. |
| Keeper | A cheap ship (probe) parked permanently at one market to keep its price data fresh. |
| Hull | A purchasable ship type (probe, light shuttle 40 cargo, light hauler 80, heavy freighter 225, bulk freighter 490; sizes from the design plan, prices vary by yard and rise 0.6-2% per purchase). |
| Gate | The home system's jump gate; it must be constructed with materials (last week: 1,600 FAB_MATS + 400 ADVANCED_CIRCUITRY) before ships can leave the home system. Until it opens the whole economy is one saturated system. |
| Premium | A newly covered ("fresh") system pays about 1.7x the usual profit per unit for about 2-8 hours. |
| Decision | Output of a pure module: `{ruleId, action, reason, ...}`. |
| Intent | A Decision that survived RiskGuard, stored with an idempotency key BEFORE any call is made. |
| Shadow mode | STAR runs the full decision loop and logs what it WOULD do; the executor is replaced by a recorder; no mutating call is ever sent. |
| Paper ledger | The shadow-mode bookkeeping that scores would-have trades against subsequently observed prices. |
| Priority 0-4 | API call classes: 0 in-progress trade/navigate, 1 purchases, 2 arrival-triggered reads, 3 keeper reads, 4 background crawl. |
| Autonomy level | 0 observe, 1 safe trader, 2 growth, 3 expansion; changeable live; the kill switch forces 0. |
| (A) | An assumption about the game API that must be verified in M0 against the live public docs/recordings. Never treat as fact. |

---------------------------------------------------------------------------------------------------

## 4. Decisions already made (DECIDED: do not re-litigate without an ADR)

| # | Decision | Reason |
|---|---|---|
| D1 | TypeScript on Node 22 LTS, strict mode, ESM, npm. | Design plan open question 5 leaves it open with "TypeScript for parity"; one language for engine, simulator, fake server and tests; the operator's tooling is Node. See `01` for the alternatives rejected. |
| D2 | SQLite (better-sqlite3, WAL) for v1; Postgres is NOT used. | Single writer, single process, single machine (design 2.1). Zero ops, trivially copyable weekly files, deterministic tests. All SQL is kept portable (no SQLite-only features in `core`), and a `Store` interface isolates it. Design plan says "Postgres or SQLite". |
| D3 | The decision core is PURE: no I/O, no clock, no randomness (a seeded PRNG is passed in), no globals. | Design 2.1; makes replay deterministic. Enforced by lint (`dependency-cruiser`) and a test. |
| D4 | No LLM anywhere: not in the runtime path, not in tests, not in tooling that touches decisions. | Design goal 2. |
| D5 | STAR has its OWN agent, its OWN agent token, and a SEPARATE source IP. It must never share the IP budget of the live stcommand fleet. | The rate limit is per source IP (measured 2026-11-02: limit-per-second 2, burst 30); a second account on the same IP gets no extra budget and halves both. |
| D6 | The request budget is a first-class feature: a hard per-minute cap enforced BELOW the token bucket, so no code path can exceed it. Default shadow cap 60 calls/min, default live cap 105 calls/min (1.75 req/s). | Lesson from stcommand: 99% utilisation all week caused 3-4% 429s. |
| D7 | Shadow mode first (M0), advisory-first for every new rule, autonomy levels, kill switch. | Design 5.3. |
| D8 | Single writer: one process, a lockfile plus an SQLite exclusive lock; a second instance refuses to start. | Design 2.1; B-09, X-09. |
| D9 | Idempotent commands: an Intent row is written BEFORE the call; after any error or timeout the executor reads state and never blind-retries. | Lessons: a `buy_ship` reported rejected had executed and a second one followed (2026-10-08). |
| D10 | The ledger answers "did we make money": matched profit, FIFO per (ship, good), never wallet delta alone. | Lessons; design goal 1. |
| D11 | Hull purchases are policy-gated and NEVER enabled by default in the first live week. Autonomous purchases arrive in M3 behind autonomy level 2 and a per-purchase cap. | Operator history: hull buying has stayed manual; a harness refused an unattended buying task twice. |
| D12 | Everything game-API-specific is marked (A) and lives in ONE place (`src/api/endpoints.ts` plus the zod schemas in `src/api/schemas.ts`); nothing else knows a URL or a JSON field name. | The design plan did not re-fetch the public docs; this contains the blast radius of a wrong assumption. |

### 4.1 Deltas from the design plan (build on it, but here is where, and why, this plan differs)

The design plan was written from a lessons digest before the 2026-11-14 lessons write-up. These changes come from
`lessons-2026-11-01-to-11-14.md` and `reset-plan-2026-11-15.md` (operator's own fleet, two real weeks of evidence). Each is
a default in `policy.default.yaml` (see `04`), so it is tunable and reversible.

| # | Design plan says | This plan does | Why (evidence) |
|---|---|---|---|
| Δ1 | W-03/W-04: stop buying cargo that cannot sell before reset at 3 h; final dump at 45 min | Keeps W-03/W-04, and ADDS a rule that the "no new buys" window is `P95(buy-to-sell time) + 5 min`, default 35 min, hard max 60, NEVER 120 | Last week stcommand's 120-minute wind-down blocked every buy; the last two hours made 0 matched profit and cost 11-16M (3.5-5% of the final wallet) |
| Δ2 | C-03: gate ceilings FAB_MATS 2,000 / ADVANCED_CIRCUITRY 4,000 | Default 3,000 / 6,000 (about 2.5x the first observed ask), lifted to hard-stop 5,000 / 9,000 at 85% progress; no recovery wait, no inflation guard; both materials from hour 1-2 | Ceilings were raised seven times; 5-13 hours of gate time lost; the last 20 units waited 4-6 hours for ~100k of saving. The numbers are a ratio of the observed ask (`ceilingMult`), not constants |
| Δ3 | G-01: 3M hull cash gate always | Keeps 3M as the default steady gate but SUSPENDS it for 24 h after the gate opens (floor 1.0M after the first 4 haulers), and first bulk freighter at `price + 1.5M` | Hulls bought in the 24 h after opening were 194/149/46 across three weeks and matched profit 25.6/12.0/5.7M; the 3M rule froze exactly those hours |
| Δ4 | C-06 stop contracts at 1M/h fleet rate | Default stop at 2M/h (about hour 96 last week) | Contracts roughly equalled trading income before the gate; negligible after |
| Δ5 | T-04: sell floor 0.8 of cost basis | Keeps it, and ADDS X-13: a sell below floor needs the price corroborated at two OTHER markets (or one fresh re-read) because 1c readings were valuation artifacts as often as real | Four below-floor sales on a 1c reading lost 0.86M; one 1c reading was a pure artifact and sold for +384k elsewhere |
| Δ6 | Design counts "wallet + holds" | The final-week objective is RAW WALLET; holds count only as working equity; cargo at reset is destroyed (worth less than zero) | Operator, 2026-11-14 |
| Δ7 | E-07 "maxWaitingStaged 6" | Keeps it and adds a stall detector that names the blocking rule in the log (E-11), AND a generic watchdog `X-14`: any state where no sale occurred for 15 minutes while traders exist raises an alert and an automatic read-only diagnostic | The 2026-11-10 two-hour fleet stall had no detection and an unknown cause |
| Δ8 | M0 = "recorder + store + replay + simulator v0" | M0 = recorder + store + shadow decision loop + paper ledger + reset detection; the simulator v0 is built alongside but is not the M0 gate | The operator wants STAR beside the live fleet next week; real recordings are worth more than a calibrated sim on day one |
| Δ9 | Milestones M0..M8 | The requested M0..M4 (see `05`); the design plan's M4-M8 (keepers, gate feeds, expansion, wind-down calibration, scale-out) become "M3 scope slices" and a post-M4 backlog. A mapping table is in `05` | The operator asked for five milestones |

### 4.2 What is NOT in scope (v1)

No mining/siphoning; no multi-IP fleet of proxies (one source IP, one limiter); no UI beyond a read-only JSON status
endpoint and logs; no gate-construction logic until M3 slices; no warp-drive pre-gate expansion (untested, G9 of the
reset plan); no ship scrapping (unmeasured refund; W-08 stays `scrap=false`); no contract automation before M3.

---------------------------------------------------------------------------------------------------

## 5. MVP scope in five lines

1. M0: read-only shadow agent on its own IP: records every market/shipyard/waypoint response, builds the market model, and logs the trade/ship decisions it would make with reasons, scored on a paper ledger.
2. Hard per-minute API budget, 429 back-off and weekly-reset detection from day one.
3. M1: one real ship (the command ship) trades one safe, lot-limited route at a time with RiskGuard, loss guards and a kill switch.
4. M2: a small fleet (3-10 traders) with route reservations, pacing and idempotent purchases of fuel and cargo only; still no hull purchases.
5. M3/M4: policy-gated hull buys at the nearest yard, then full reset survival (register, bootstrap, opening) without a human.

## 6. Where the open questions live

Each file ends with or contains OPEN QUESTION markers. The consolidated list for the operator is in
`08-go-live-and-safety.md` section 6. The implementer keeps a running copy in the new repo at `docs/open-questions.md`
and links answers to the ADR that resolves them.

## 7. Source facts this plan relies on (from the two lessons docs; treat as numbers to tune, not as game facts)

| Fact | Value | Where used |
|---|---|---|
| Rate limit | per source IP: 2 req/s, burst 30 (headers `x-ratelimit-limit-per-second: 2`, `x-ratelimit-limit-burst: 30`, `retry-after: 1`, `x-ratelimit-type: IP Address`) | `03` |
| stcommand budget | 1.75 req/s = 105/min shared limiter; at 99% utilisation 3-4% 429s | `03` |
| Start | 175,000 credits; 2-4 ships (command ship plus probe/shuttle; check at registration) | `04`, `07` |
| Home system | 31 markets, ~11 priced at hour 0; home saturates by hour 8-10 (profit per unit down ~90%) | `04`, `05` |
| Home earnings | first 5-6 h 0.3-0.5M/h from one ship, then 0.1-0.25M/h; pre-gate fleet ~100k/h | targets |
| Gate | 1,600 FAB_MATS + 400 ADVANCED_CIRCUITRY (+ QUANTUM_STABILIZERS, done at start last week); about 5M of materials; opened at hour 47.2 and 50.5 | `04` gate slice |
| Price impact | ~4-5% per tradeVolume lot on our own units (FAB_MATS 20-unit lots +3.5-5.6%); ALUMINUM 40 units at tv 60 moved 8-10% per load; markets tick ~30 min | `04`, `06` |
| Trip | mean buy-to-sell about 9 minutes; 11 trips started per 5 minutes by 20 trading ships | wind-down |
| Hull prices | light shuttle 85k, light hauler 273-354k (rises per purchase), heavy 2.76-2.81M, bulk 3.0-4.3M, probe 20-35k, explorer-frame 0.67-0.88M | `04` |
| Hull earnings | light hauler 44-160k/h, heavy ~340k/h on 2.5-5k goods, bulk 0.4-1.0M/h typical, 2.68M best hour | `04` |
| Scrap | three 85k shuttles returned 68-72%; bulk refund unmeasured | W-08 off |
| Reference weeks | 461M matched / 297.7M wallet (week of 11-01); ~600M projected at 10M/h plateau (week of 11-08); wallet is 62-65% of cumulative matched | targets |
| Per-sale | ~54 units, ~450c/unit, ~26k/sale at the plateau | metrics |
| Cash discipline | 3M hull gate, 5M keeper gate, escape clause (flat 2 h / under 80k/h / idle traders) | `04` |
| Reset | detection by polling unauthenticated `GET /v2/` (A) every ~5 min; a 401 matching `reset_date does not match` latches the agent dead | `03` |

## Operator answers (2026-11-14) — these override the defaults in 05, 07 and 08

| Question | Answer | What changes in the plan |
|---|---|---|
| Q-PROXY / Q-SAMEIP | Separate source IP via proxy | Drop the shared-IP 20% fallback. Full live budget (105/min) on its own proxy IP. The engine must refuse to start if its IP-echo check returns the box's own IP. |
| Q-HOST | Same box as stcommand | Run as a separate OS user and process with its own SQLite file, log directory and disk quota. Add a free-disk watchdog (stop and alert below a set free-space floor; the box hit a full disk on 11-13). Never share the stcommand Postgres. CPU/memory limits (systemd or cgroup). |
| Q-SHADOW-INTEL | Go straight to trading | M0 (read-only shadow) becomes a short smoke test on the first reset day, not a week. It still runs first so the unverified API shapes (marked A) are checked before the first purchase. Skip the import-feed work (Q-EXPORT) for the MVP. |
| Q-INTERFERE / Q-AUTONOMY | Trade live from next week (reset 2026-11-15 13:00 UTC); it affects THEO no more than any other player | Remove the "shadow only until 11-22" default. Keep the kill switch, spend caps and drawdown guard from 08 (they protect the new agent's own money, not THEO). Level and drawdown threshold: still use the plan default (level 1, 10%) unless the operator changes it. |

Still open (defaults in 08 section 6): Q-ACCT, Q-IPECHO, Q-HARD, Q-GATE, Q-ALERT, Q-STACK, Q-START, Q-FEE, Q-CURVE, Q-SEED, Q-RESETTIME, Q-SCRAP, Q-MINING, Q-LANES.
Timing note: the next reset is about 14 hours away; the plan is a build spec for another agent, so live trading next week needs the repo, a second agent token and a proxy ready before 13:00 UTC 11-15, or it slips a week.

## Operator decision (2026-11-15): autonomy

The engine's purpose is to be autonomous. Changed in `08-go-live-and-safety.md`: the engine promotes itself from level 0 to 3 on evidence
(section 1), up to an operator-set `autonomy.maxLevel`; hull and keeper buying is autonomous inside caps (a share of the wallet an hour plus a
fixed daily backstop, section 3) instead of needing a 24-hour window; NA1 and NA2 were rewritten. Still operator-only: the ceiling, the caps,
the drawdown limit, the kill switch, and everything in NA3-NA10. Assumption to confirm: the binding hull-spend cap is a share of the wallet
(10% an hour) with the fixed daily backstop; say if you prefer a fixed amount an hour.
