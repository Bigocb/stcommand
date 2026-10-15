# Action tracking and the analysis engine

Status: v1 built 2026-10-15 (see "What v1 builds"). Written so the week-to-week plan (`docs/multi-week-plan.md`) can be
tuned from evidence: what worked, what didn't, what moved prices, and what a settings change did.

## The question it answers

"What did we do, what did we expect, what actually happened, and why?" Every finding has to be traceable to rows, with
a sample size, so a weak signal is never presented as a strong one.

## What we already record

| Source | What it holds | Kept across a reset? |
|---|---|---|
| `ledger` | Every buy, sell, refuel, jump, ship, contract; price, units, realized profit on sells, wallet after, route tag (`buy>sell auto circuit1`) | Yes, keyed by `universe_key` |
| `market_snapshots` | Price, supply, activity and trade volume per market and good, every time a ship or keeper reads it | No (shared galaxy data, wiped) |
| `market_transactions` | Every agent's recent trades at a market, ours and other players' | No |
| `ship_movements` | Warps and gate jumps with fuel and cost | Yes |
| `operator_actions` | Manual and MCP interventions | Yes |
| `fleet_events` | Role changes, ship purchases, approvals | Yes |
| `run_results`, `run_timeline`, `wealth_samples` | Weekly summaries and credit samples | Yes |
| `doctrine_fire_log` | When a rule actually changed a decision | Yes |
| `judge_decisions` | Decision-model answers | Yes |

## What was missing

1. **The expectation at decision time.** A trade is in the ledger, but not what the bot thought it would earn when it
   chose the route. Without that, "the estimate was wrong" can't be measured, and the bot can't learn how optimistic it
   is per route or good.
2. **Settings changes with before and after.** A doctrine edit was logged as an operator action, but not as "this
   value went from 6 to 3 at this time", which is what a before/after comparison needs. Lot policy and keeper-list
   changes weren't recorded at all.
3. **Findings that outlive the week.** Market tables are wiped at a reset, so anything learned from them (how hard a
   good moves, how fast a market recovers) is lost unless it is saved separately.

## Data model added

### `action_events` (migration 053, kept across resets)

One row per decision or change, keyed by `universe_key` like the ledger.

| Column | Meaning |
|---|---|
| `at`, `universe_key` | When, and which week |
| `kind` | `trip_planned`, `trip_closed`, `config_change` (more kinds can be added without a migration) |
| `actor` | `engine`, `operator`, `mcp` |
| `ship_symbol`, `good`, `waypoint` | Subject, when there is one |
| `correlation_id` | Links events of one decision: a trip's planned and closed events share it |
| `subject` | Free key: the route (`A>B`), or the setting (`doctrine:maxLotsPerTrip`) |
| `expected` (jsonb) | What the bot predicted: buy and sell price, units, profit, trip cost, minutes |
| `observed` (jsonb) | What happened: units, average prices, realized profit, minutes |
| `context` (jsonb) | Values in force: market trade volumes, lot size, before/after for a change |
| `reason` | One readable line |

### `analysis_findings` (migration 053, kept across resets)

A saved copy of an analysis report, one row per capture, so a finished week's lessons survive the wipe of the market
tables and can be compared with the next week.

## Analyses (pure modules under `src/engine/analysis/`)

Each takes plain rows and returns findings; no I/O, no clock. The store fetches rows; the ops tool wires them.

1. **Trips (`trips.ts`).** Rebuilds every trip from the ledger (per ship and good: buys until the hold is sold down),
   joins it with `trip_planned` / `trip_closed` when present, and reports per route: trips, realized profit, profit
   per trip and per hour, win rate, and estimate accuracy (realized over expected). Findings: routes that worked,
   routes that lost money, routes whose estimates are consistently too optimistic.
2. **Market impact (`marketImpact.ts`).** For each cluster of our lots at one market, measures the price move per lot
   from our own fill prices (first lot to last lot), and the recovery time from the snapshots after it. Compares with
   the model's 4.5% per lot. Findings: markets we move harder than the model assumes, and markets that recover slowly.
3. **Price moves (`priceMoves.ts`).** For each price move over 5% between consecutive snapshots, checks who traded in
   that window: us (ledger), another player (`market_transactions` with a ship that isn't ours), or nobody seen
   (drift, or trades we didn't observe). Findings: markets where we cause most moves, and markets with competition.
4. **Changes (`changes.ts`).** For each settings change, compares profit per hour and overhead share in a window
   before and after. Always labelled as a correlation with its sample size, never as proof.
5. **Suggestions (`suggest.ts`).** Turns findings into concrete, reversible actions with the exact tool and arguments
   (for example, a per-ship lot cap for a market we move hard). Advisory only: nothing is applied automatically.
6. **Calibration (`calibration.ts`), the first step to prediction.** A per-route and per-good factor of realized over
   expected profit, shrunk toward the fleet average when the sample is small. "The bot says 80k for this route; past
   trips earned 0.7 of the estimate, so expect about 56k."

## How it feeds the weekly plan

At the end of a week (or on demand), the report is captured into `analysis_findings`. The next week's plan reads the
last capture: lessons about goods and mechanics (impact per lot, recovery speed, estimate bias) carry over even though
the markets themselves are new. Goals in the season record can be checked against the same metrics.

## Toward predictions and suggestions

Order, each step gated on the previous one showing it is calibrated:

1. Calibration factors (v1): measured, shown, not acted on.
2. Use the calibration in route ranking behind a doctrine clause, off by default, with a before/after comparison.
3. A per-market impact model from measured impact per lot, used to size lots automatically (the per-ship lot policy
   is the knob).
4. Forecasts (profit per hour by route next week, from goods and mechanics that recur across universes), only once
   several weeks of captures exist.

## What v1 builds

- Migration 053: `action_events`, `analysis_findings`.
- Recording: `trip_planned` and `trip_closed` from the trader; `config_change` from doctrine edits, per-ship lot
  policy, and the keeper list.
- The pure analysis modules above, with tests.
- Ops tool `analysis` (MCP `stcommand_ops_analysis`, HTTP `/api/ops/analysis`): the full report for a window.
- MCP tools to capture a report into `analysis_findings` and to list past captures.

## Known limits

- Trips rebuilt from the ledger before v1 have no expectation, so estimate accuracy starts at zero samples.
- Market snapshots are as fresh as keepers and tours make them, so recovery times are bounded by read frequency.
- Other players' trades are only seen when we read a market, so "nobody seen" includes trades we missed.
- A before/after comparison overlaps everything else that changed in the same window. It is a lead, not a verdict.
  A change to one ship (its lot policy) is measured on that ship's own trips and costs, not the fleet's.

## Growth

`growthPerDay` (src/engine/growth.ts) is the one growth figure: net worth, meaning credits plus holds (wealth_samples)
plus hull capital (ship purchases less scrap proceeds from the ledger's SHIP rows), growing in percent a day between the
first and last sample in the window. Hull capital keeps buying a ship from showing as a loss. Holds move with the market,
so a window with few samples or a sudden cargo swing can read high or low; the rate needs at least half an hour of samples.

