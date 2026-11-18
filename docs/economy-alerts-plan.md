# Economy alerts and the buy-ship warning (plan; built 2026-11-18, see "What was built" at the end)

Note (2026-11-18): the dispatcher already nets jump fees per ship and per hold (`scoreItem()` in `src/engine/dispatcher.ts`, `routeHoldAware`); no dispatcher change is part of this plan.

Operator request, 2026-11-18: "I wonder how we could monitor for these types of situations and alert within the app. Additionally,
maybe if I go to buy a ship and the situation is a certain way it could give me a warning." Background: `docs/lessons-learned.md`,
"the domino week". Built as self-contained pure modules per CLAUDE.md, each behind a doctrine clause that ships off or advisory.

## 1. Economy health (pure module `src/engine/economyHealth.ts`)

Input, filled by the caller from data the engine already has (ledger roll-ups as in ops `pnl`/`profit_curve`, the fresh-system
queue, cargo values): per window (30 min, 1 h, 3 h) matched profit, sales, jumps and jump fees, fuel; wallet plus holds now and
1-3 h ago, hulls bought in the window; last release time and the number of staged systems with no tour ship; profit per sale
now against the 6 h average; traders and big hulls.

Output: a list of findings `{ id, level: "warn" | "bad", line, numbers }`, each explainable in one line:

| id | Fires when (defaults, all doctrine values) | Example line |
|---|---|---|
| `jumpsOverProfit` | jump fees > matched profit in the last hour and the 30 min before it | "Jump fees 486k against 232k profit in the last hour (80 jumps)." |
| `netNegative` | net after jumps and fuel < 0 for 2 h | "Losing about 290k an hour after jumps and fuel." |
| `worthFalling` | wallet plus holds down 2 h running, hulls added back | "Wallet plus holds 1.19M -> 0.85M in 2 h (no hulls bought)." |
| `releaseDrought` | no release for 3 h while staged systems wait | "No system opened for 3 h; 4 staged waiting, all tour ships busy." |
| `marginDecay` | profit per sale under 50% of its 6 h average | "Profit per sale 2.3k against 7.9k (6 h avg)." |
| `smallHullJumping` | a hull of 40 or less makes over 6 jumps an hour | "THEO-1 (40 cargo): 15 jumps an hour, 11k profit." |
| `cashStarved` | wallet under the working-capital floor (below) for 30 min | "Wallet 95k, floor 2.0M: traders can't load fully." |

Where it shows:
- Tower and Deck: an "Economy" card on the home screen with the findings, worst first (green "nothing to flag" when empty).
- Push: a new notify category `economy` ("Economy warning", default on, cooldown 60 min) through the existing pass in
  `src/engine/notify/` (categories.ts, detectors.ts), so quiet hours and the hourly cap apply. No credit figures in the push text
  beyond what the operator already sees, same as the stall alert.
- The hourly report reads the same findings (ops tool `economy_health`).
- Advisory only: nothing is changed automatically. Each finding carries a suggested action with the exact tool (for example
  `set_ship_reach THEO-1 system`, `set_doctrine positioningHops 3`), like the analysis engine's findings.

## 2. Buy-ship warning (pure module `src/engine/buyAdvice.ts`)

`buyAdvice({ price, cargo, wallet, holds, traders, bigHulls, lastBigHullBuy, economyFindings, rules })` returns
`{ ok: boolean, warnings: string[], floor }`. Rules are doctrine values:

- **Working-capital floor:** wallet after the buy under `bigHulls_after x 400k + other traders x 100k` (about 2M today).
- **Purchase line:** wallet before the buy under 3M (any hull) or 10M (a hull over 80 cargo), the CLAUDE.md "Cash discipline" lines.
- **Payback:** the last big hull bought less than 6 h ago and its matched profit since is under its price.
- **Falling margins:** any `economyHealth` finding at level bad (net negative, release drought, margin decay).
- **Escape clause shown, not blocking:** if cash has been flat or falling for 2 h and traders sit idle, say so, since the operator's
  escape clause allows a buy to restart growth.

Where it shows: a new `GET /api/fleet/buy/preflight?shipType&yardSymbol` returns the advice; the Deck and Tower buy buttons call
it first and, when there are warnings, show them in a confirm sheet with "Buy anyway" and "Cancel". It never blocks: the
operator decides. `POST /fleet/buy` and the MCP `buy_ship` tool return the same warnings in their reply (and the MCP tool's
description tells a connected agent to read them).

## 3. Tests and rollout

- Each module tested in isolation (the 2026-11-17/18 numbers as fixtures: they must fire `jumpsOverProfit`, `netNegative`,
  `releaseDrought`, `smallHullJumping`, and the 22:11 heavy buy must warn on the floor and payback rules).
- One test at each seam: the notify detector, the preflight route.
- Doctrine clauses `economyAlerts` (on, advisory) and `buyAdvice` (on, warn only); off reproduces today's behaviour.

## What was built (2026-11-18) and what was not

Built, on the feature branch (CHANGELOG 2026-11-18, "Economy alerts and the buy-ship warning"):

- `src/engine/economyHealth.ts`: the seven findings above, pure, with `bucketsFromLedger`/`shipStatsFromLedger` to build the input
  from ledger rows. Windows are 30-minute buckets over 6 h. `jumpsOverProfit` needs the last hour and the half hour before it
  (a quiet half hour with no trades or jumps does not block it); `netNegative` needs every one of the last N hours negative and
  reports their average; `worthFalling` reads the wealth samples (credits plus holds, every few minutes) with hull spend from the
  SHIP rows added back; `cashStarved` reads the ledger's `wallet_after` readings. Each finding carries `numbers` and, where
  useful, `suggestion: { action, tool, args, why }` (`stcommand_set_ship_reach <ship> system`, `stcommand_set_doctrine
  positioningHops 3` when it is above 3, `stcommand_release_system <first staged>`, `stcommand_ops_system_queue`).
- `src/engine/buyAdvice.ts`: `buyAdvice()` and `workingCapitalFloor()`, warn only. A hull with no cargo (a probe) does not add a
  trader to the floor. The payback rule needs the last big hull's SHIP row in the last `max(6, paybackHours)` hours.
- `src/ops/economy.ts` (the thin source), ops tools `economy_health` and `buy_preflight` (MCP `stcommand_ops_economy_health`,
  `stcommand_ops_buy_preflight`, HTTP `/api/ops/...`), `GET /api/fleet/buy/preflight`, warnings in the `POST /api/fleet/buy` and
  MCP `buy_ship` replies, `FleetManager.economyQueueFacts()`.
- Notify category `economy` ("Economy warning", on, 60 min), `economyDetector`, read by `notify/live.ts` every 5 minutes.
- `public/shared/economy.js`: the Economy card (Tower home under Hourly, Deck Overview under the KPIs) and the buy confirm sheet
  ("Buy anyway" / "Cancel") used by Deck's and Tower's yard buy buttons.
- Doctrine: `economyAlerts` (on) with `economyDroughtHours` 3, `economySmallHullJumps` 6, `economySmallHullCargo` 40,
  `economyMarginDecayPct` 50, `economyNetNegativeHours` 2, `economyCashStarvedMin` 30; `buyAdvice` (on) with
  `buyAdviceBigHullLoad` 400k, `buyAdviceTraderReserve` 100k, `buyAdviceAnyHullLine` 3M, `buyAdviceBigHullLine` 10M,
  `buyAdviceBigHullCargo` 80, `buyAdvicePaybackHours` 6. Both ship on (advisory); off = no findings / no warnings.

Not built or deferred:

- **No dispatcher change.** A "score routes net of jump fees" fix was considered and dropped: the dispatcher already nets jumps
  (`scoreItem()` subtracts each ship's positioning jumps in full, `routeHoldAware` scores each ship on its own hold, and route
  building drops legs "not profitable after fuel, slippage and jump costs"). The open question, why the dispatcher's estimates
  and the realized trips diverged overnight on 2026-11-17/18, is being investigated separately.
- The hourly report does not quote the findings yet; it can read ops `economy_health`.
- The old UI variants (v2-v6) still buy without the preflight; only Deck and Tower call it.
- The `jumpsOverProfit` threshold ratio, `worthFallingHours` and the margin minimum sales are code defaults, not doctrine.
