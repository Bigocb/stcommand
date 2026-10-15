# Multi-week fleet plan (sketch)

Status: draft, not built. Written 2026-10-15 as a starting point for a plan that spans several weeks, so the fleet can
build toward something instead of racing for cash each reset. Each section says what the code does today, so the gaps
are visible. Updated 2026-10-15 with phases, the rollback rule, goals and the season record.

## Why this is hard

SpaceTraders resets the whole universe weekly (see CLAUDE.md, "SpaceTraders universe resets"). A reset regenerates
systems, markets, jump gates and shipyards, and every agent token dies at once. Anything that depends on the
galaxy's shape has to be rebuilt, and the bot currently starts each week with no plan beyond the doctrine rules.

## What carries over a reset today

| Kept | Why it survives |
|---|---|
| Code, doctrine settings, operator playbook (`docs/reset-opening-playbook.md`) | Stored in the repo and in tables a reset does not touch. |
| Ledger (`ledger`), keyed by agent and reset date | `universe_key` scopes each row to its week; comparisons across weeks work. |
| Play-style history (`operator_actions`, `tenants.play_profile`) | Deliberately kept, per CLAUDE.md. |
| Chat log and login state | Not game state. |
| Measured market mechanics | Not stored as data, but written down: ~4.5% price move per lot, slow refill (F53 FAB_MATS about 3 to 4 units an hour), volume growth under sustained trading. These may hold in the next universe; re-check each week. |

## What a reset wipes

- **Galaxy data**: systems, markets, shipyards, jump gates, learned jump costs. Every week starts with re-charting.
- **Fleet state**: ship roles, positions, claims, held routes, manifests.
- **Work in progress**: contracts, missions, feeds, warehouse stock and targets, and gate construction progress.

## What is rebuilt each week

- Every ship's role and position.
- Keeper placements.
- The reset-day steps: re-register, run the cleanup, wait for the galaxy crawl.

## Phases

A season is a sequence of weeks. Each week ends in one phase, and that phase decides where the next week starts.

1. **Recover:** re-register, clean up, finish the galaxy crawl, start feeds on the gate's inputs.
2. **Fund:** trade for cash and buy the right hulls for each job.
3. **Specialize:** haulers on proven routes, keepers on the markets that matter for trade decisions.
4. **Cross-system:** routes that cross gates, circuits, and warp tours.
5. **Build:** the gate and the materials for it.

**Rollback rule:** a reset wipes the gate network and the cross-system routes that depend on it. So if a week ends in
Cross-system, the next week starts at **Recover**, not at the last phase. Other phases pick up where they left off.
Goals are not reset by a rollback. A goal that was missed carries forward.

## Goals

Each goal has a week number, a measurable target, and a status (pending, met, or missed).

- Example: "Week 2: cut overhead 5%, status pending."
- **Overhead** means jump costs, refuels, and fuel, as a share of gross sales. The same breakdown `ops_pnl` already
  reports, so a target can be measured from data we have. The baseline is taken from the first full week of the season.
- A missed goal carries forward until it is met or the operator drops it.

## Season record

Each week ends with a record that the next week starts from:

- The phase the week ended in.
- The goals and their status, with the measured value.
- A snapshot: fleet by role, cash, reserve, and overhead share.

The next week reads the last record as its starting point. This is how the plan evolves over weeks instead of
restarting each reset.

## Proposed plan

### Days 1 to 2: recover

1. Re-register every tenant with a fresh token.
2. Run the reset cleanup from the admin page, unchecking any tenant that has already re-registered.
3. Let the galaxy crawl finish before routing anything beyond the home system.
4. Start feeds on the gate's inputs immediately, with `stopAtSupply HIGH`.
5. Buy shuttles before probes, per the playbook.

### Week 1: fund the build

- Trade for cash. Use the cash floor and ship budget to decide what to buy.
- Buy the right hull for each job: 80-unit haulers on paying routes and contracts, 40-unit shuttles on feeds into
  60-unit markets.
- Keep reinvesting until the fleet target is met.

### Week 2: specialize

- Haulers stay on proven routes.
- Keepers stay on the markets that matter for trade decisions.
- Explorers chart the systems near the gate.

### Week 3 onward: build

- Finish the gate, then scale the trading fleet.
- Each reset returns to a known plan, not a restart.

## What the code would need

1. **A season plan that survives resets.** A new table, outside `TENANT_GAME_TABLES`, holding the phase, goals and
   season record above. It would be written by the operator and read by the dispatcher and the auto-buyer.
2. **A reinvestment rule.** Today the only controls are the cash floor (`cashFloor`) and the ship budget
   (`shipBudget`). The plan needs a rule for how much profit goes into ships each week, and when to stop buying.
3. **Gate continuity across resets.** A new universe means a new gate, and last week's delivered materials do not
   count toward it. What carries is the requirement (last week it was 1,600 FAB_MATS and 400 ADVANCED_CIRCUITRY, so
   plan on something close again), the pacing that kept prices in check, and the target. The game's own gate status
   is the only real progress count. This is the hardest part and is not solved here.
4. **Reset-aware targets.** Doctrine values such as `shipCap:*` and `keeperCount` should follow the season plan, not
   stay fixed.
5. **Phase transitions.** Code that reads the last record, applies the rollback rule, and starts the next week in the
   right phase.

## Open decisions

1. Is the weekly goal cash, gate progress, or fleet size? (The plan can weight them differently.)
2. What share of each week's profit goes to ships versus the cash reserve?
3. Should the season plan live in the app (a table the dashboard edits) or in a doc the operator updates by hand?
4. Should the reset-day steps be automated, or stay manual through the admin page?

## Next steps if we build it

- Decide the open decisions above.
- Add the season-plan table and a read-only view, before anything reads it for decisions.
- Wire one target (for example, the fleet size by role) into the auto-buyer behind a doctrine clause, switched off by
  default, per the convention for new engine logic.
- Measure for a full week before changing anything else.
