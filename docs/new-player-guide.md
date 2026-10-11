# A guide to playing stcommand: for new players

This is for someone who is new to the fleet, whether you're a person or an AI agent
connecting to it. It explains what you're looking at, what the controls do, and the
mistakes that cost the most credits. It does not explain how the code works.

## 1. What this is

You command a fleet of spaceships in SpaceTraders, a multiplayer trading game. The
universe **resets once a week**. On reset every ship, market and route is regenerated,
and everyone starts from a small amount of credits. Your score for a week is how many
credits you end with (your wallet plus the value of cargo still in your ships).

The fleet runs itself between your commands. Ships keep flying, trading and refuelling
while you're not looking. That is the point, and it is also why most early mistakes come
from acting too fast rather than too slowly.

## 2. The three places you can look and act

- **Tower**: the phone-first screens. Home shows the wallet and fleet mode. Fleet lists
  every ship. Metrics shows profit over time. Markets, Co-pilot and More are the rest.
- **Deck**: the same information on a wide screen, with more detail per ship.
- **MCP tools**: the commands an AI agent uses. Each tool does one thing. They act on the
  real fleet immediately, with one exception: approvals (see §5).

## 3. Ship roles, in one line each

- **trader**: buys goods in one market and sells them in another, round trip, on its own.
  Most of your credits come from these. Leave them to the dispatcher.
- **miner / siphoner**: extracts ore or gas for traders and for the warehouse.
- **surveyor**: scouts mining sites so miners work faster. Carries no cargo.
- **explorer**: jumps to unvisited systems to chart them. Costs jump fees.
- **scout**: charts nearby uncharted waypoints without jumping.
- **tour**: visits every market in a system to keep prices fresh. Send one to a new system
  with `dispatch_tour`.
- **keeper**: sits at one market permanently so its prices never go stale.

Every ship has exactly one role. Changing a role interrupts whatever the ship is doing, so
don't change it mid-trip without a reason.

## 4. How to move a ship

- **dispatch_ship**: a waypoint in the ship's *current* system. The ship flies there and
  stops.
- **jump_ship**: one jump through a gate to an adjacent system.
- **dispatch_tour**: any system more than one jump away. Give it a *system* name, not a
  waypoint. It walks the gates itself.

Don't use `jump_ship` for something two or more jumps away. It fails.

## 5. Approvals and the confirm step

- Most commands take effect immediately.
- Some purchases the fleet wants to make on its own (for example a keeper probe) wait in
  an **approval** queue. You approve or reject them with `stcommand_decide_approval`. Read
  what it costs first.
- The co-pilot never acts directly. It proposes a change and gives you an id. Reply
  `/confirm <id>` to run it or `/cancel <id>` to drop it. A proposal expires after 30
  minutes.

## 6. The mistakes that cost the most

These come from real sessions. Each one looked like a bug at first and was normal
behaviour.

1. **Fuel doesn't drain during a flight.** The game takes the whole fuel cost when a
   flight starts. A ship that left with 300 fuel and still shows 299 after an hour is
   fine. Don't re-send it.
2. **Long flights look stuck.** A drift leg can run for hours with no log lines. Check
   the ship's own ETA before you call it stuck.
3. **Re-sending a command to a ship already in transit does nothing useful.** It wastes a
   turn and can interrupt a good flight.
4. **Don't move traders by hand.** The dispatcher picks the best route for each idle
   trader. Your manual move usually leaves a better trader idle.
5. **Don't burst-sell into one market.** Each sale lowers that market's price for a while.
   Four sales in a row at one station can cut the price in half. Spread sales across
   markets, and let a market recover (roughly a few percent an hour) before going back.
6. **Don't buy in a loop faster than the market recovers.** Price moves with stock. A
   tight loop can push a buy price up 8 to 10 percent per load.
7. **Expand from the markets you already trade, not across the galaxy.** A ship sent to a
   system far away spends its first trip paying jump fees. Build out one hop at a time
   from where your markets already are. The jump limit (doctrine: "Positioning jumps")
   decides how far a trader may be sent; raise it only for a reason.
8. **Early on, buy hulls before scouts or probes.** Traders make the money. A probe is
   for pricing a market you can't see.
9. **Don't pause contracts.** A contract is usually a fixed payout. Pausing it loses the
   deadline.
10. **Check the gate before routing through it.** A jump gate is only usable once its
    construction is finished. Greyed-out rows in the jump planner mean the gate is not
    ready.

## 7. A first week, in order

**Hour 0: look.** Read the wallet, the fleet list and the metrics. Note the home system.
Don't buy anything yet.

**Hours 1 to 3: feed the chains.** If the fleet is building a gate, the materials for it
come from markets that need inputs first. Feed those before buying for the gate. Set
feeds to stop at HIGH supply, not ABUNDANT: over-feeding raises trade volume and
consumption, and the market then needs more input to stay supplied.

**Day 1 onward: hold, don't burst.** Let the traders work. Check the metrics once or
twice a day. Adjust one thing at a time and watch for a few hours before the next change.

**After the first full day: widen.** When the home markets start to look saturated (routes
shrinking), find the next system with a good number of markets, within a few gate jumps
of where you already trade. Send a tour ship there first, then traders once the markets
show up in the work list.

## 8. Reading the numbers

- **Matched trading net**: profit from sales you have already completed. This is the
  honest figure for how the trading is going.
- **Wallet change**: the real change in credits. It also includes purchases, fuel, jumps
  and cargo still held. The gap between the two is cargo in transit and running costs.
- **Net per hour**: matched net divided by the hours in the window. Good for comparing
  windows of the same length.
- **Since reset**: everything since the current universe began. Use this for the week's
  score. Rolling windows mix in the old universe otherwise.

If the two numbers disagree by a lot, look at cargo still held and at jump costs before
you assume something broke.

## 9. Words you'll see

- **Reset**: the weekly regeneration of the universe. Every old token and ship identity is
  invalid after it, and the fleet re-registers automatically when it can.
- **Gate**: the jump point between two systems. It must be finished (construction
  complete) on both ends.
- **Positioning**: the cost of getting an idle ship to where a route starts. Measured in
  jumps and in flight time.
- **Circuit**: a two-leg trip where the second leg starts near where the first one sells,
  so the ship is never flying empty.
- **Doctrine**: the fleet's standing rules, such as the margin floor, the cash floor and
  the loss floor. Each has an on/off switch and, for numbers, a value.
- **Keeper**: a ship that stays at one market so its prices stay fresh.
- **Feed**: a crew that sources a good and sells it into a market.

## 10. If something looks wrong

1. Check the ship's own log lines for the last hour, not the summary.
2. Check whether the ship is in transit and how long it has been travelling.
3. Check the route list for the reason a route was not picked (the dispatch explanation
   shows one reason per refused route).
4. Check the metrics window. A rolling window and a "since reset" window can disagree for
   a week after a reset.
5. Only then change a setting, and change one thing at a time.
