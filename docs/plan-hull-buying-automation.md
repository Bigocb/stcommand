# Plan: hull buying without the operator in the loop

Status: **draft, not started** (written 2026-11-26 at the operator's request: "write it up in a plan, we will work on it later").
Tracking issue: [#86](https://github.com/Bigocb/stcommand/issues/86). Lesson behind it: `docs/lessons-learned.md`, 2026-11-26,
"scale the trading fleet much faster".

## 1. Why

- **The top agents run far more trading hulls than we do.** Unique ships seen trading this week: SPACELORD 390 (many of them small),
  HERMES-BRAVO 185, JEANLUC 137, TIPTAP 113. We had 51 at hour 86.
- **They scaled in the first hours after the gates opened.** They bought dozens to over a hundred ships per 3 h and kept going for
  about a day. We added 5-43 per 3 h.
- **The gap is hull count and timing, not earnings per hull.** Per hull we earn as much or more: about 370k/h against about 230k/h
  for JEANLUC at its peak.
- **Every hull we buy waits for a person, one or two at a time.**
  - Buy prompts closed unanswered three times overnight on 11-24.
  - The engine cannot buy trading hulls at all.

## 2. What exists today

| Piece | Where | What it does | What it lacks for this |
|---|---|---|---|
| Opening tasks (`openingAutomation`, on) | `src/engine/openingTasks.ts`, `openingRunner.ts`, templates in `openingTemplates.ts` | Steps run in order behind triggers (`cashAtLeast`, `gateProgressAtLeast`, `routeProfitAtLeast`, `taskDone`, `minutesSinceQueued`, `all`/`any`). A `buyShip` step has `shipType`, `maxPrice`, `preApproved`, `keepCash`. A pre-approved step buys with no card. | Buys at the **cheapest** yard, not the nearest to the route. Runs once, start to finish, not continuously. No stop on falling profit per unit. |
| Engine buyer (`autoBuyShips`, **off**) | `FleetManager.maybeBuyShip()`, `src/engine/fleet.ts` ~4489 | Each tick proposes one hull: a tour shuttle, mining drones up to `minerTarget`, otherwise the best-scored hull from `scanLoadouts()`. | Every buy raises an approval card; nothing auto-approves hulls. `shipBudget` headroom is 30k and its range tops out at 500k. `shipCap:FRAME_*` is 4 for every frame. It fills the fleet's "biggest gap" by its own score, not by free traders, fresh markets or measured profit per 1M. |
| Buy advice (`buyAdvice*`) | `src/engine/buyAdvice.ts` | Warnings only: working-capital floor (`buyAdviceBigHullLoad` 400k per big hull, `buyAdviceTraderReserve` 100k per other trader), `buyAdviceAnyHullLine` 3M, `buyAdviceBigHullLine` 3.5M, `buyAdviceBigHullHolds` 1M, `buyAdvicePaybackHours` 6. | Never blocks or buys. Its floor is the right cash test for an automatic buyer. |
| Keeper auto-approve | `autoApproveKeeperProbes` (price cap 60k), `keeperAutoApproveMinCash` | The working model of "approve automatically under a price cap and over a wallet line". About 1,600 probes were bought this way this week. | Keepers only. |
| Manual and scheduled buys | MCP `stcommand_buy_ship`, now allowed without a permission prompt (`.claude/settings.json`, 2026-11-26) | Scheduled Claude tasks (for example the heavy ramp) can buy unattended within the rules in their prompt. | Needs a model session awake and its prompt kept current. Not engine logic, and lost if the session ends. |

## 3. Part A: the gate-open wave in the opening template (little or no code)

Goal: the first day after the gate is when the rivals scaled. Have the wave ready before the reset, so nobody has to approve it live.

1. **Add pre-approved buy steps to "Opening: auto at reset"** (`stcommand_add_opening_task` / `stcommand_add_opening_template`).
   Triggers combine the gate opening with cash: `all: [gateProgressAtLeast 100, cashAtLeast X]`.
   Proposed shape, with the numbers for the operator to set:
   - **Wave 1, at the gate:** N1 light haulers (about 300k each) with `keepCash` = working-capital floor + 500k.
   - **Wave 2, at cashAtLeast Y:** N2 more light haulers or heavies, depending on what the 11-26 light-hauler test shows.
   - **Wave 3 and on:** heavies, one step per buy, each behind a `cashAtLeast` step.
2. **Small code change: a nearest-yard option on `buyShip`.** The rule is CLAUDE.md "nearest yard to the destination, not the
   cheapest". An optional `yardChoice: "cheapest" | "nearestToRoute"` uses the unflown-routes yard list (`ops unflown_routes` logic)
   or the system with the most uncovered fresh markets. The default stays "cheapest", so existing templates do not change.
3. **Set the new hulls to trader.** A `setRole` step with `ship: { by: "step", step: n }` already does this.

Open decisions for the operator: N1, N2 and Y; the hull mix by wave; whether `keepCash` is the floor alone or the floor plus a
cushion.

## 4. Part B: continuous buying by extending `autoBuyShips`

Goal: after the opening, the engine keeps adding trading hulls whenever traders are the constraint and cash allows, and stops by
itself when the markets saturate. It extends the existing buyer rather than adding a second one.

Shape, following CLAUDE.md "Build new logic as self-contained modules":

- **A pure decision module, `src/engine/hullBuyer.ts`.**
  - It returns `{ buy: { shipType, yard, price } | null, reason }` and takes only inputs, no I/O:
    - the wallet, the working-capital floor (from `buyAdvice`) and the holds;
    - free traders, and how long they have been 0;
    - live fresh systems with no sales of ours, and uncovered viable markets;
    - profit per unit, last hour against the 6 h average;
    - measured matched profit per 1M of hull cost by hull type over the last 12-24 h, from the ledger;
    - known yards per hull type: price, hops to the target system, whether a ship of ours is docked there, read age;
    - buys in the last hour and their spend;
    - the policy (below).
  - Weight 0 / clause off reproduces today's behaviour exactly, with a test.
- **Policy as doctrine** (all new keys go in `src/engine/doctrineGroups.ts`, or `tests/doctrineGroups.test.ts` fails):
  - `hullAutoBuy`: 0 off, 1 shadow (log only), 2 approval cards, 3 automatic.
  - `hullAutoBuyMaxPerHour`, `hullAutoBuyMaxSpendPerHour`.
  - `hullAutoBuyKeepCash`: the floor plus this cushion must remain after the buy.
  - `hullAutoBuyTypes`: allowed hull types (light hauler, heavy, bulk).
  - `hullAutoBuyMaxPrice` per type.
  - `hullAutoBuyIdleMin`: free traders must be 0 for this long.
  - `hullAutoBuySaturationPct`: no buy while profit per unit is under this share of its 6 h average; say "add systems before hulls".
  - Raise or retire the frame caps for trader frames (`shipCap:FRAME_HEAVY_FREIGHTER` etc. are 4, below today's fleet).
  - Widen `shipBudget`'s range, or replace it with `hullAutoBuyKeepCash` for this buyer.
- **Hull choice:** the type with the best measured profit per 1M over the window. Light haulers win when cash is small, if the 11-26
  test confirms it. Fall back to a fixed order while there are too few samples.
- **Yard choice:** the nearest-yard rule (price + hops x about 7k + travel time). The yard must have a ship of ours docked there, or
  the buy is skipped with that reason.
- **Approvals:** in mode 2 each buy is a normal approval card. In mode 3 it is auto-approved under `hullAutoBuyMaxPrice` and over
  `keeperAutoApproveMinCash`-style wallet lines, like `autoApproveKeeperProbes`.
- **Durable state** (operator rule, "nothing a decision depends on lives only in memory"): last buy time, buys and spend this hour,
  and the idle-since mark go into a fleet flag. They are restored at boot, with a test that a fresh instance restores them. No
  double buys after a restart.
- **After a buy:** set the role to trader, write a ledger SHIP row as today, an `action_events` row with the reason (for
  `ops analysis`), and a log line.
- **Readout:** an ops tool `hull_buyer` (what it would buy now and why not), plus a line in the hourly report.

Rollout: shadow for at least 12 h, comparing its picks with what the operator or the ramp bought. Then cards for a day. Then
automatic, with tight per-hour limits that are raised once its picks hold up.

## 5. Part C: the API for hundreds of traders

- **Measure first.** Calls per trader per minute (`ops api_calls` by role); the box limit is 105/min per IP.
- **Trade lanes** (`tradeLaneShips`, issue #71) pin traders' calls to proxies. Plan lanes for 200-400 traders and check the proxy
  plan's bandwidth cost (`api_budget` `planBilling`).
- **Keep keeper reads within budget** as the trader count grows (`ops keeper_coverage` pass time).

## 6. Inputs we are waiting for

- **The 11-26 light-hauler test:** 20 light haulers against 3 heavies bought the same hour. A 6 h read at 09:30 UTC
  (scheduled task), then a 12 h read. It decides the hull mix in Parts A and B.
- **This week's end** (2026-11-29 13:00): whether the late scale-up raised the final number. Confirm or revise the provisional lesson.

## 7. Order of work (when we pick it up)

1. Part A, steps 1 and 3 (template only), before the 2026-11-29 reset, with the operator's wave numbers.
2. Part A, step 2 (the nearest-yard option), small; can ship with step 1.
3. Part B in shadow mode, then cards, then auto, over the following week.
4. Part C measurement alongside Part B; lanes as the count grows.
