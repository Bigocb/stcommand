# stcommand Player Guide

Your fleet trades on its own between your orders. This guide shows you how to read it,
steer it, and avoid the expensive mistakes. A shareable HTML version of this guide is
published as an Artifact; this file is the same content in Markdown.

## Quick start

Do these five things in your first session. Nothing here spends credits.

1. **Look at Home.** Note the wallet, the fleet mode, and the activity list.
2. **Check the fleet mode.** Home has an AUTO / HALT switch. AUTO lets the fleet trade;
   HALT stops every ship from starting new work. Leave it on AUTO unless you have a reason.
3. **Open one ship.** Go to Fleet and tap a ship. Its sheet shows role, location, cargo and fuel.
4. **Read the metrics.** Open Metrics. Use the 1h and Since reset buttons to compare a short
   window with this week.
5. **Ask the co-pilot.** Open Co-pilot and ask, "What is the fleet doing right now?" It answers
   from live data and can change nothing until you confirm.

> **Before you change anything:** read first, act second. Read the fleet status and the last
> hour of metrics, then decide. Most problems that look urgent settle within a few hours.

## How the game works

SpaceTraders is a trading game. Ships buy goods at one market, carry them, and sell them where
the price is higher. The difference, after fuel and jump fees, is profit.

- **The universe resets every week.** Markets, routes, gates and starting credits all begin
  again. Your score for a week is the credits you end with, plus cargo still in your ships.
- **Prices move with stock.** Buying pushes a price up at that market; selling pushes it down.
  Prices recover slowly, a few percent an hour. Spreading trades over several markets keeps
  profit up.
- **Gates link systems.** A gate works only when its construction is finished at both ends.
  Each jump costs about 5,000 credits and a cooldown.
- **Fuel is taken up front.** When a flight starts, the game takes its full fuel cost, so a ship
  on a long leg shows the same fuel until it arrives.
- **The fleet runs itself.** Ships keep working between your orders. Act less than you think you need to.

## Tower: the phone screens

Tower is built for a phone. Its tabs run along the bottom of the screen.

| Tab | What it is for |
|---|---|
| Home | Wallet, fleet mode (AUTO / HALT), recent activity. |
| Fleet | Every ship. Tap one for its sheet: role, location, cargo, fuel, and a jump planner when it can jump. |
| Metrics | Profit, spending and wallet over time, with a table of where profit came from. |
| Markets | Current prices by market and good. Check a price before you trust a route. |
| Co-pilot | Chat. It reads fleet data and proposes changes. |
| More | *Work* (contracts, missions, feeds), *Fleet* (keepers, roles), *Rules* (doctrine switches and values). |

> **Screens look out of date?** Tower's script can be cached for up to four hours. Reload the
> page. If it is still stale, ask the operator to clear the cache.

### Changing a doctrine value in Tower

Open More, then Rules. Each rule has an on/off switch. A rule with a number also has a value box.
Type a new number and leave the box: it saves at once. A value outside the allowed range is
refused and the old value comes back.

## Deck: the desktop screens

Deck is the desktop version of the same information, with more detail on one screen: ship lists,
route boards, doctrine and operations panels. Anything you can change in Tower, you can change in
Deck, and both show the same live state.

## The co-pilot

The co-pilot is a chat assistant. It can answer questions about the fleet, markets, ledger, metrics
and gates from live data, and it can propose a change to a ship or the whole fleet. It cannot run a
change on its own: every change is a **proposal** until you confirm it.

**Example: holding a ship.** You type "Hold THEO-17 at its market." The co-pilot replies with a
proposal and an id, for example `a1b2c3`, and a one-line summary. Reply `/confirm a1b2c3` to run it,
or `/cancel a1b2c3` to drop it. A proposal expires after 30 minutes.

Proposals the co-pilot can make today: set a ship's role, hold a ship, release a ship, halt the whole
fleet, and resume the whole fleet. The gear icon on the co-pilot screen holds the model settings
(service address, model name, key). The key is stored only on the server; never paste it into the chat.

## Ship roles

Every ship has one role. Changing a role interrupts whatever the ship is doing, so change it only
between jobs.

| Role | What it does | Leave it alone when |
|---|---|---|
| trader | Buys and sells on its own, round trip, using the best route it can reach. | Almost always. The dispatcher picks its routes. |
| miner / siphoner | Extracts ore or gas for traders and the warehouse. | It is feeding a trader or a warehouse. |
| surveyor | Scouts mining sites so miners work faster. Carries no cargo. | It is surveying. |
| explorer | Jumps to unvisited systems to chart them. Costs jump fees. | It is mid-jump. |
| tour | Visits every market in a system to keep prices fresh. | It is partway through a system. |
| keeper | Sits at one market so its prices never go stale. | Almost always. Keepers stay where they are. |

## Moving ships

- **Dispatch** sends a ship to a waypoint in its *current* system, where it stops.
- **Jump** sends a ship through one gate to a neighbouring system.
- **Tour** sends a ship to a *system* more than one jump away. It finds the gates itself. Give it a
  system name, not a waypoint.

In the jump planner, a greyed row means that gate is not finished, or the ship is moving. Greyed rows
cannot be selected.

## Reading the metrics

- **Net trading**: profit from completed sales, less fuel and jump fees. The honest figure.
- **Wallet change**: the real change in credits. It includes purchases and cargo still held, so it can
  differ from net trading for a while.
- **Net per hour**: net trading divided by the hours in the window. Compare windows of the same length.
- **Since reset**: everything since the current universe began. Use it for the week's score.

**Example: a bad hour.** The 1-hour chart shows a large red bar. Check three things: did a ship buy a lot
of cargo that is still unsold; did a sale go below cost on purpose; did jumps cost more than usual. A bad
hour inside a good week is normal.

> **Rolling windows mix weeks.** Straight after a reset, a 3-day or 1-hour window can include trades from
> the old universe. For a fair picture of this week, use Since reset.

## Supply chains

Most goods are made from other goods. A market that exports a good needs inputs it imports, and
those inputs may need inputs of their own.

| Made good | Made from | One step further back |
|---|---|---|
| FAB_MATS | IRON, QUARTZ_SAND | IRON comes from IRON_ORE |
| ADVANCED_CIRCUITRY | ELECTRONICS, MICROPROCESSORS | check chain health for the next step |

- **Supply** is how much of a good a market holds: SCARCE, LIMITED, MODERATE, HIGH, ABUNDANT.
- **Activity** is how strongly it produces (export) or consumes (import): RESTRICTED, WEAK, GROWING, STRONG.

A producer stays RESTRICTED while any input is SCARCE. Aim to hold every input at HIGH. ABUNDANT costs
more and makes the market consume more.

A **feed** is a crew that sources a good (by mining or buying) and sells it into a target market. Set its
stop level to HIGH and it stops itself once the target reaches that supply.

## Circuits

A **circuit** is a pair of trips planned together, so a ship is not empty on the way back:

1. **Leg 1:** buy good A at market X, sell it at market Y.
2. **Leg 2:** from Y, buy good B and carry it back toward X, then sell it.

The planner only plans leg 2 when it can start within the circuit reach (10 minutes of flying by default).
Leg 2 is kept for that ship until leg 1's cargo is sold. If leg 2's margin falls to half of what was planned,
or its market leaves the board, the planner drops it and the ship takes new work.

Doctrine rules that control circuits: *Two-leg circuits* (on, 75 % weight) and *Circuits across a gate*
(on).

## Building a gate

A gate works only when its construction is finished at both ends. Construction needs materials delivered to
the gate's market. Each gate has its own list. One gate checked in October needed FAB_MATS 1,600,
ADVANCED_CIRCUITRY 400 and QUANTUM_STABILIZERS 1. Read your own gate's list from the gate status view first.

1. **Read the gate.** Ask the co-pilot for the system's gate status.
2. **Read the chain.** Open chain health. Note each producer, its inputs, and the weakest input.
3. **Feed the inputs.** Start feeds for the weakest inputs, stop level HIGH.
4. **Protect the chain.** The *Protect the gate's supply chain* rule keeps those inputs out of ordinary
   trading while the gate is unfinished.
5. **Buy the finished materials when the producer is ready.** A RESTRICTED producer makes little, and the
   price climbs as you buy.

> **Refill is slow.** During the October build one market recovered only a few units an hour. Feed the
> inputs early, from the first hour.

## Walkthrough: a first game

Each step says what you should see, what to do, and what to avoid. The numbers are illustrative.

1. **Hour 0: look before you buy.** Read Home and the fleet list. Find the home system and nearby markets.
   Avoid buying anything yet.
2. **Hour 0 to 1: price the markets with the command ship.** The command ship starts as a tour ship.
   Send it on a tour of the home system (dispatch_tour). Each market it visits gets priced. No routes
   exist until markets are priced, so wait for the route list to fill before starting traders.
   Avoid starting traders blind.
3. **Hours 1 to 2: start the traders.** Once routes exist, leave them on AUTO. Avoid moving traders by hand.
4. **Hours 2 to 3: start the supply chain early, with miners.** If cash is low, put miners on a feed for the
   raw inputs behind the gate's weakest input, stop level HIGH. The miners earn now and fill the chain later.
   Avoid ABUNDANT, and avoid buying the finished materials before the chain can make them.
5. **Day 1: let the markets breathe.** Check metrics morning and evening. Spread sales. Avoid four sales in
   a row at one market.
6. **Day 1, afternoon: watch a circuit.** Read the trader's sheet. Leave it alone; the planner drops leg 2
   itself if its margin halves.
7. **Day 2: widen.** When home routes shrink, send a tour ship to a system with many markets, within one or
   two gate jumps. Keep traders at home until the jump cost is covered.
8. **Days 2 to 5: deliver the materials.** Buy finished materials in steps when the producer's activity
   rises. Avoid tight buying loops.
9. **End of week: score it.** Metrics, Since reset. Compare net trading with wallet change and cargo still
   held. Note what to change next week.

## Doctrine reference

Doctrine is the fleet's standing rules. Each has an on/off switch and, for some, a value. Defaults are
what the fleet starts with.

| Rule | Default | What it does |
|---|---|---|
| Cash floor | 20,000 c | Never spend below this balance. Applies to every purchase except fuel. |
| Margin floor | 10 c | Ignore a route whose profit per unit is below this. |
| Max lots per trip | 6 | How many of a market's trade-volume lots one trip may buy. |
| Loss floor | 15 % | Refuse to sell cargo below this loss against what it cost. |
| Two-leg circuits | on, 75 % | Plan a buy-and-sell pair so the ship is not empty on the way back. |
| Circuit reach | 10 min | How far apart the two legs of a circuit may be, in flying minutes. |
| Circuits across a gate | on | Allow a circuit to cross a jump gate and come back. |
| Best ship for the best routes | on, 6 | Give the top routes to the ships that would earn most, with travel time counted. |
| Auto cross-system routes | on | Let idle traders take routes that start in another system. |
| Positioning jumps | 3 (max 10) | Gate jumps a trader may take to reach a route's start. A route needing more is not offered. The first trip must out-earn the cost. |
| Follow-on lookahead | off, 50 % | Credit a route for the next good trip that can start where it sells. |
| Protect the gate's supply chain | on | Keep the inputs for a gate under construction out of ordinary trading. |
| Market keepers | 2 | How many ships to station at markets so prices stay fresh. |
| Auto-buy keepers | on | Propose buying a probe to cover an uncovered market. The purchase still needs your approval. |
| Purchase headroom | 100,000 c | Buy a ship only when credits exceed the cash floor by this much. |
| Intel freshness | 90 min | Ignore market prices older than this. |
| Cross-system intel freshness | 360 min | A longer window for routes that cross a gate. |
| Dedicated explorers | 0 | Grow the fleet until this many ships are explorers. |
| Sensor scan | off | Run chart scouts on a timer, which spends credits on new scouts. |
| Repair floor | 0.5 | Repair a ship when its worst part drops below this condition, next time it is docked. |

> **Raise a limit for one purpose, then put it back.** A higher positioning limit lets traders reach
> farther routes, but each extra jump is a fixed cost paid before the first sale. Watch the jump cost
> against matched net for a few hours, and lower the limit if the cost grows faster than the profit.

## Worked examples

**Why is a good route not being flown?** Open the dispatch explanation. Each idle trader lists the
reason it was refused each route. Read the reason:
- *"The first trip does not cover the 3-jump positioning cost."* Real but too far for its profit. Leave
  it, or raise Positioning jumps for a short while.
- *"No finished gate path from X to Y within the jump limit."* Some gates on the way are not finished.
  Wait for construction, or work a nearer cluster first.
- *"Already claimed this cycle."* Another ship has it. Nothing to do.

**Changing a doctrine value from your phone.** Tower, More, Rules. Find Positioning jumps, tap its value
box, type `4`, and leave the box. The new value takes effect on the next dispatch cycle, about a minute later.

**Checking this week's score.** Metrics, then Since reset. Read Net trading and Net per hour. If you want
the wallet, check cargo still held before drawing a conclusion from it.

**A ship at the wrong place.** Check the ship sheet: role, fuel, and whether it is mid-jump. A ship that is
still flying is not stuck. If it has been idle an hour with fuel and no route, ask the co-pilot for the
reason before changing its role.

## Common mistakes

1. **Re-sending a command to a ship already moving.** It wastes the order and can interrupt a good flight.
2. **Moving traders by hand.** The dispatcher picks the best route for each idle trader.
3. **Selling a lot into one market at once.** Each sale lowers the price there for a while.
4. **Buying faster than a market recovers.** A tight loop can push the price up 8 to 10 percent per load.
5. **Expanding far before the near markets are used.** Build out one hop at a time from where your markets are.
6. **Buying probes before traders.** Traders make the money.
7. **Pausing a contract.** Contracts have fixed payouts and deadlines.
8. **Routing through an unfinished gate.** Greyed rows in the jump planner mean the gate is not ready.

## Glossary

- **Reset**: the weekly restart of the universe.
- **Gate**: the link between two systems. Finished on both ends before a ship can jump.
- **Positioning**: the cost of moving an idle ship to where a route starts, in jumps and flight time.
- **Circuit**: a two-leg trip where the second leg starts near where the first one sells.
- **Doctrine**: the fleet's standing rules: on/off switches and values.
- **Keeper**: a ship that stays at one market so its prices stay fresh.
- **Feed**: a crew that sources a good and sells it into a market.
- **Approval**: a purchase the fleet wants to make on its own. You approve or reject it.
- **Proposal**: a change the co-pilot queues for you. Nothing happens until you confirm.

*This guide describes the fleet as it works in the current release. Rule names and defaults can change;
the Rules pane in Tower always shows the live values.*
