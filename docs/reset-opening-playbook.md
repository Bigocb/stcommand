# Reset opening playbook

What to do in the first hours after a weekly reset, written from the 2026-10-04 week (THEO, X1-JX83), where the
gate stalled at 174/1,600 FAB_MATS because the input chains were only fed from day 2 and the mission bought faster
than the producer made the material. See `CHANGELOG.md` entries dated 2026-10-05 and the project review doc for the
evidence behind each step. Numbers are from that week; re-measure on a new map.

## Hour 0: register and look

1. Register, sign in on the dashboard, run the admin reset cleanup for the old tenant. `protectChainGoods` is on by
   default: keep it on.
2. Command ship as **tour** until every market in the home system has one price read; then trader.
3. Accept the first contract and keep contracts running all week. The game allows only one open contract at a time
   (offered or accepted), so throughput depends on finishing each one fast. Correction 2026-10-08: the old "~1% of profit"
   note was wrong. THEOREM_DEV_2 completed 20 contracts in X1-XJ90 for 1.36M in payouts (MACHINERY/FOOD/MEDICINE ones
   paid 120-230k each, against roughly 60-90k sourcing cost). THEO's were paused on day one, and one half-done
   ALUMINUM_ORE contract blocked new offers for 3 days. Never pause contracts. If one is stuck, finish it cheaply so the
   next offer can come in. Payouts track the good's value; they did not visibly grow over the week.
4. Open Ops: the **Gate supply chain** panel shows the gate's materials, each producer and its inputs. Note which
   inputs read SCARCE: those are the day's work.

## Hour 1-3: feed the chains before buying anything for the gate

5. Start the construction mission so its materials are protected, but set pacing first: `buyLotUnits` = the
   producer's trade volume (20 for FAB_MATS), `buyGapMin` 30, `recoverPct` 3, and **`maxInflationPct` 25** (see
   "The ceiling is a target price" below). Do not buy until the producer's activity reads GROWING or STRONG. Buying
   into a RESTRICTED or WEAK producer only lifts its price.
6. Feeds for every input of every gate material, from the raw end up, each with `stopAtSupply HIGH` (not ABUNDANT:
   over-feeding grows the market's trade volume and consumption, and it then starves):
   - iron ore -> refinery (mine feed, 2-3 drones, or buy from the ore exchange with a shuttle);
   - iron -> FAB_MATS producer (buy feed, `maxLossPerUnit` 15);
   - quartz sand -> FAB_MATS producer (mine feed or buy from the exchange);
   - silicon crystals and copper (ore -> refinery -> producer) for the electronics / microprocessor chain.
   The exchange markets' silicon and sand get drained by other agents in the first hours: start these first.
7. Buy shuttles (40-hold, ~90k) before probes. Probes only at markets routes actually use; cap `keeperCount`.
   Operator rule of thumb (2026-10-07): a market trading **more than 4 goods** is worth a keeper; shipyards always.
   Run one idle ship as `tour` first so every market has a fresh price, then place keepers from that map, moving
   existing probes before buying new ones. Without it, THEOREM_DEV_2 had 13 of 24 markets unseen for 8-10 hours.
   Start with few keepers; once the wallet passes about 1M, cover every important waypoint (see "Keepers: start minimal,
   then cover the important waypoints" below).

## Day 1 onward: hold, do not burst

8. Watch the chain panel: every input of a producer at HIGH, both import activities STRONG, is the target state.
   A producer is RESTRICTED while any input is SCARCE and only WEAK until inputs are MODERATE or better.
9. Mining: 2-4 drones per asteroid (about 8 extractions per 70 s makes one unstable), one surveyor per worked
   asteroid, and a collector shuttle per feed (`stcommand_set_feed_collector`) so drones never leave the field.
10. Let the mission buy only when the recovery gate allows; at 3-4 units of refill an hour a 1,600-unit material is
    days of work, so the aim of week one is a producer that is GROWING or STRONG, not a count.
11. Keep traders on the big spreads (FABRICS, MEDICINE, SHIP_PARTS when they appear) and let the chain guard keep
    them off iron, sand, silicon and copper.

## The ceiling is a target price, not just a guard

Measured on THEO's F53 FAB_MATS, 2026-10-06/07 (operator's insight): with `recoverPct` on, the mission never buys above
the ceiling and waits for the market to come back down after every lot, so **the ceiling sets the price the market is
held at and the producer's refill sets the buying rate**. Over 7.5 hours at a 40% ceiling (baseline 1,051, so 1,471)
every lot pushed F53 up 30-40 credits, the price walked 1,173 -> 1,469, and the ceiling became the only thing gating
buys.

| Knob | What it controls |
| --- | --- |
| `maxInflationPct` (ceiling over the baseline) | the price level we hold the market at |
| Feeds into the producer | the speed: units per hour at that price |
| `buyLotUnits`, `buyGapMin` | how smooth each step is |

So: a **low ceiling from hour one (25% over the opening price, about 1,100 -> about 1,375 for FAB_MATS) together with
well-fed inputs**. A low ceiling only costs speed while the producer is input-starved; started late on a market that
has already climbed, it halts buying for many hours (at 25% THEO would have paused 17-40 h). Lower it in steps on a
running mission (THEO: 40% -> 35% on 2026-10-07, 30% next once F53 is back near 1,350).

## Numbers from the 2026-10-04 week

| Fact | Value |
| --- | --- |
| Price move per trade-volume lot | 4-5% (FAB_MATS 20-unit lot, both buy and sell sides) |
| FAB_MATS refill at F53 while WEAK/RESTRICTED | 3-4 units/h (ask -4 to -9c/h) |
| Sand to take F53 from SCARCE to ABUNDANT | about 450 units in 1 h; the first 120 did nothing |
| Import activity climb | WEAK -> STRONG over about 12 h of steady feeding (iron) |
| Market tick | about 30 minutes |
| Reset timing | weekly, Saturday ~13:00 UTC (`GET /` reports `serverResets.next`) |

## What the best week looked like, and what to compare against (operator notes, 2026-10-08)

Week of 2026-09-27: THEO ended at 25,738,654 credits (trading net 54.8M, 3,312 trades, 123 ships: 17 traders, 7
haulers, ~100 keepers, 1 explorer). Per the operator, that week ran FOUR systems like the home system, each with its
own traders and keepers, bought from that system's own shipyards, plus one big siphon ship (1,200 fuel, 150 cargo).
The rule of thumb that came out of it: four systems at 300k+/hour each beats the total.

- **Count the home-type systems early.** The galaxy has a handful of "full" systems (26-27 markets, 3 shipyards): on
  the 2026-10-04 universe JX83 (home), AA31, GY77 and YG40. The in-between hubs (TA92, UD26) have no markets or yards of
  their own, so they are jump hops, not places to trade. YG40's gate was incomplete (it takes materials of its own).
- **Buy the fleet where it will work.** Light haulers cost 314,772 at JX83-A2 but 536,845 at AA31-A2 on the same day, so
  check each yard's price before sending a purchase and expect new-system hulls to cost more.
- **Open the gate before judging a system.** The home-system routes got visibly better once I59 was complete
  (11:30 UTC, 2026-10-08): the Tower list showed several routes over 100k a trip. Part of that was the figure being
  priced at an 80-unit hold after the first haulers arrived (a 40-unit shuttle earns ~60% of it), so compare like for
  like. Check next week whether the home routes improve the same way once the gate opens.
- **Shuttles to haulers.** 300-fuel shuttles drift (hours per leg) on long legs; the 600-fuel light hauler keeps
  cruising and carries 80 units. Swap them one at a time, and scrap a shuttle only when it is close to a yard: a
  scrap-bound shuttle drifted 1-2.5 hours to A2 and earned nothing meanwhile.
- **Pace check.** To beat 25.74M from a standing start the fleet needs ~350k/hour for the final three days; the
  matched trading net was ~460k/hour on 2026-10-08 with one home-type system trading (THEO-31/-33/-39 hauler era).

## Hold size matters: swap shuttles for haulers early (2026-10-08, THEO)

Measured on THEO, hour to 2026-10-08 18:37 UTC (trial of parking three of the weakest 40-unit shuttles so the shared wallet
feeds fewer buyers):

- The three 80-unit light haulers made 251k of that hour's 274k matched trading net; the two running 40-unit shuttles
  made 23k. A hauler carries twice the cargo for the same fixed costs per trip (jumps ~5.5k each, refuels), so its net
  per trip is more than double, and its 600-fuel tank keeps it cruising where a 300-fuel shuttle drifts for hours on
  long legs.
- Hold fill: before the trial the haulers averaged ~20 units a buy on an 80-unit hold (a quarter full). In the first trial
  hour they averaged 46-54, in the second 19-29. Cash read at 20-30 minute intervals (586k-1.2M) looked comfortably above
  the floor, but that sampling is too coarse: rebuilding the wallet minute by minute from market transactions shows it
  swinging by hundreds of thousands inside a single minute (a hauler's 80-unit buy of a 5-7k good is 400-550k) and dipping
  to roughly 150-270k at the low (18:26). Trips last 1-15 minutes, so one trader's buy leaves the next trader unable to
  fill a hold of an expensive good. Wallet contention is therefore plausible, and likely worst for high-priced goods; the
  evidence for it is circumstantial, not a measured per-buy balance. Do not judge it from periodic cash readings.
- Total profit did not rise: matched net was 391k the hour before parking three shuttles, then 274k and 308k in the two trial
  hours (the parked shuttles had earned 162k of the 391k). The solid finding is the hold-size split (haulers earned the
  large majority of the profit each hour); whether fewer traders helps is still open.

Rules of thumb to carry forward:

1. Buy light haulers (80 cargo, 600 fuel, ~315k at the home yard on 2026-10-08; check each yard, AA31's was 537k the
   same day) before more shuttles or probes once cash allows. Buy at the cheapest yard and fly them over.
2. Keep ship purchases (haulers, keeper probes, the 2.2M refining freighter) behind a cash level (~1M) so the wallet
   never sits under the floor with traders waiting on it. Cash dipped to 12k twice that day on purchases.
3. Do not scrap a shuttle far from a yard: scrap-bound shuttles drifted 1-2.5 hours to A2 earning nothing. Park it
   (hold) when empty instead, or scrap it when it passes a yard.
4. The Tower and Deck route figures price every route at the fleet's biggest hold; read the per-hold line (40u / 80u)
   to know what a shuttle actually earns.

## Put the right size ship on the right job (2026-10-12, operator)

Check this whenever ships are assigned or after a restart reshuffles them: **the big holds should be on the jobs that can fill them,
the small shuttles on the jobs that cannot.** On 2026-10-12 (THEOREM) every 80-unit hauler (A, C, D, 25) was parked on a feed,
the gate mission or the collector while the paying routes (ADVANCED_CIRCUITRY ~133k a trip, the 157k ASSAULT_RIFLES contract) were run
by the 40-unit shuttles. Nothing was broken; it was just the wrong ships.

What decides it:

- **A market's per-sale cap sets how much hold a feed can use.** H57 takes 60 units of IRON_ORE per transaction and E46 sells 60
  of IRON per buy, so an 80 hold wastes 20 and a 40 hold carries two-thirds of the useful load. Feeds into a 60-unit market want 40-hold
  shuttles. (A hold bigger than the cap also used to fail the whole sale, fixed 2026-10-12: feeds now sell in chunks.)
- **A mission carrier is limited by price recovery, not by hold.** It buys one lot per recovery wait, so a big hold does not speed the
  gate up; do not move a hauler onto it for capacity.
- **A collector wants room for the drones' loads** (4 drones x ~12 units), which a 40 hold nearly covers.
- **Routes and contracts scale with hold until the market's lot size bites** (ADVANCED_CIRCUITRY sells 20 a lot at about +4.5%
  a lot, still well worth 80). Read the per-hold line on the Routes board (40u / 80u), not the headline figure, which prices
  every route at the fleet's biggest hold.
- **Contract goods:** put the haulers on contract duty (Deck/Tower ship sheet, or `set_contract_duty`). Two or more pinned ships split
  a contract that needs more than one hold, in parallel and sized to what is left.

How to check, in a minute: list traders by hold (`get_fleet_status` summary: `cargoCap`) next to their jobs (`get_feeds`,
`ops_assignments`, the mission carriers). Anything with `cargoCap` 80 on a feed capped at 60 or less, or 40 on a route paying
six figures a trip, is the wrong way round. Swap with `remove_feed_carrier` / `assign_feed_carrier` while both ships are empty; a
ship holding cargo should finish its trip first.

## Mine next to where the chain buys its inputs (2026-10-12, operator)

Find the asteroids near the markets where the gate chain's inputs are bought, survey them in the first hours, and put drones on the
closest rich ones. This week the ore feeds worked because H57, which consumes iron and copper ore, has the engineered asteroid EZ5F
28 units away. The same was available for the other inputs and went unused: B7 is where the chain buys QUARTZ_SAND (for FAB_MATS) and
SILICON_CRYSTALS (for the ADVANCED_CIRCUITRY chain), and B11 sits 24 units from it and B8 49 units, both with `MINERAL_DEPOSITS`
(the trait that carries sand, silicon and ice). Drones working those, selling into B7 or feeding on from there, would have pushed
that market all week instead of buying its supply down.

How to find them, in a minute:

1. List where each input is bought: `get_chain_health` shows every producer's inputs with their cheapest source market.
2. For each source market, run the `mining_fields` ops tool (or Deck's Mining screen) with `target=<that market>`, which sorts the
   fields by distance and shows the surveyed share of each deposit. Anything within about 60 units is next door; the hand-off
   and any shuttle trip are then a minute or two.
3. Fields with no surveys show as never surveyed. Send a looping survey tour (Deck: a surveyor's Fleet sheet, Survey tour; or
   `scan_fields loop=true`) over the nearest ones, nearest first. A field needs about 10 surveys before its shares can be trusted.
4. The trait is only a hint (EZ5F is "common metal" yet surveys as an even six-way mix), so go by the survey shares.
5. Then set it up the way EZ5F is: a mine feed into the market that wants the ore, the asteroid as the feed's field, and a collector
   shuttle (several feeds into one market can share it) with the drones handing over at about 10 units.

Cheap to check at hour 1, expensive to find out on day 3. The same listing is what an automatic field chooser would read, so keep
its output stable (see `docs/TODO.md`).

## Open more systems from the start (2026-10-09, operator)

Routes were 100k+ a trip early last week and about 50k a trip by day 6 of this one: eleven traders working the same three
systems squeeze the spreads, and a market recovers only a few percent an hour (measured 2026-10-05). The fix is more
markets to trade in, not a better scoring formula. Plan for the next reset:

1. **As soon as the home gate is open, start looking for large systems and send a tour ship to each.** A full-size system
   has 79-92 waypoints, about 25 markets and 3 shipyards; most others have 0-4 markets (asteroid belts and a gate). On
   2026-10-09 the full-size ones beyond the home cluster were MB58, JU15 (gate still unfinished), JJ27 (gate open), and
   XJ90, PZ19, NU62, NC79, ZZ69, YG40, MK29 (gates unfinished). Mid-size systems with 14-26 markets (GH86, MC94, CU25,
   RQ95, BY91) are worth a tour too. Skip anything under about 10 markets.
2. **Check the gate before sending a ship.** The shared table `galaxy_gate_construction` (`is_complete`) says which
   gates are open; 12 of 93 known gates were still closed. Query it with the read-only login (`stcommand` schema).
3. **Use `dispatch_tour`, not explorers.** It sets the tour role and walks the gate graph; once there the ship tours the
   system's markets itself. Keep `explorerTarget` at **0**. With it above 0, turning explorers into tour ships makes the
   fleet refill the count by converting spare *traders* (it took THEO-62, the 150-hold ship, and THEO-51 on 2026-10-09).
   `dispatch_tour` moves a lone tour ship freely (the old last-tour-in-system guard was removed 2026-10-09).
4. **Then put keepers on the markets a trade route actually uses** (see the keeper rule above), and let the dispatcher's
   cross-system routes and circuits (`chainCircuitCrossSystem`) spread traders across the new systems.
5. **Heavy haulers.** A tour ship at a shipyard records its ship specs (fuel, cargo, speed, crew); check them on Deck's
   yard list. Only the 150-hold refining freighter (2.2M at GY77-A2, speed 36) has been seen so far; light haulers
   (80 cargo, 600 fuel, speed 15) cost 310-540k depending on the yard.

6. **Keep expanding: when one new system goes online, start the next straight away** (operator, 2026-10-09: "we are
   definitely running the current routes dry"). A system is online when its markets show up in the dispatcher's work list
   (`dispatch recompute: ... work:`). Pick the next from the list in step 1 by gate status and distance: traders only take
   routes up to 3 gate hops away, so a system 3+ hops out is only reachable by tour ship (its prices) unless traders are
   moved there. On 2026-10-09 JJ27 (30 markets, 3 yards) was 3 hops from AA31 and MG54; the MC94 / BY91 / GH86 / RQ95
   cluster (about 80 markets) is 1-2 hops from each other but 12+ from the home cluster, so it needs its own traders.
7. **When a tour ship may leave a system (operator, 2026-10-09).** Move it on as soon as both are true: (a) every
   waypoint in the system is mapped (markets and shipyards charted, prices recorded once), and (b) at least one keeper
   is in place, including one at a shipyard so yard stock and prices stay fresh. Then send it to the next system and
   start the next one. Don't keep a tour ship parked in a finished system. `dispatch_tour` no longer refuses the last
   tour ship in a system (guard removed 2026-10-09), so use it directly; it walks the gates itself. Only fall back to
   hopping with `jump_ship` plus `release_ship` at the far end if the walk stalls. A jump is ~10 minutes of cooldown.


## Build out from the markets you already trade, not across the galaxy (2026-10-10, operator)

The positioning limit (the "Positioning jumps" doctrine clause) capped how far an idle trader may be sent to start a
route. The default of 3 hops left the MC94 cluster (about 25 markets, four traders working them) unable to take its best
routes from the home cluster, while its own traders sat on second-rate work. The lesson: a system several gate hops
from anything you trade in should not be the first place you expand into. Expand outward from where your markets already
are, one hop at a time, and let the cross-system routes follow the markets you have priced.

- **Position by distance, then by value.** Before raising the clause, check the route list for the good routes you
  can already fly (`dispatch_explain`, `routeBuild`). If the best unclaimed routes sit three or more hops out, the
  limit is the reason; if they sit in your current cluster, buy traders for that cluster first.
- **Each hop costs a jump (about 5,000 credits) and a cooldown before the first sale.** A route that needs four jumps
  has to earn that back on its first trip. The dispatcher already enforces this (the first trip must out-earn the
  positioning cost), so a raised limit does not mean every far route is offered.
- **Raise the limit deliberately, for a run.** Operator, 2026-10-10: the clause went to 5 for this run (ceiling 10 in
  code) to test whether the MC94 and neighbouring routes come alive. Check the rejection reasons afterwards: a route
  refused as "the first trip does not cover the N-jump positioning cost" is one the limit is correctly keeping out.
- **Watch the fuel legs at each gate.** A multi-jump route is refused if its relay through any intermediate system's
  gates is beyond the tank and no known fuel stop covers it. A cluster with no fuel market between its gates stays
  closed even under a high limit.

## Keepers: start minimal, then cover the important waypoints (2026-10-11, operator)

THEOREM's first day ran with almost no keepers and one tour ship that was too slow to keep a whole system fresh. Prices
went stale: the dispatcher ignores a market price older than the "Intel freshness" clause (90 minutes), so a route whose
buy or sell market had aged out simply was not offered, and the board showed routes at stale prices. Routes were being
priced, and some fleet decisions made, on data 50-70 minutes old.

The rule:

1. **Start minimal.** In the first hours cash is better spent on traders, haulers and the gate feeds, so a few keepers
   (shipyards, plus the markets the first routes use) and one `tour` ship to map the rest is right. Do not buy a probe
   for every market while cash is the constraint.
2. **At about 1,000,000 credits, start covering every important waypoint with a keeper.** A probe is cheap (about
   23-24k at the home yards on 2026-10-11), so twenty of them is under 500k, a small price against the routes stale
   prices hide. Do it in this order:
   - markets a trade route actually uses, the best routes first (the Routes board lists them);
   - every market that trades more than 4 goods, and every shipyard (the standing rule above);
   - the producers and importers of the gate's materials, so the supply-chain view (`get_chain_health`) stays current;
   - markets other systems' routes sell into, once cross-system routes are on.
3. **Raise `keeperCount`** (the "Market keepers" clause) to the number you intend to run, since it caps how many the fleet
   will station, and approve the keeper-probe purchase requests as they arrive (the "Auto-buy keepers" clause proposes
   them; each still waits for approval). Move existing probes to uncovered markets before buying new ones.
4. **Check it worked.** `ops_market_freshness` shows each market's age; the target is every priority market under the
   intel-freshness window with room to spare. A market that is still stale with a keeper on it points to a stuck probe,
   not a missing one.
5. **Keep the tour ship for what keepers cannot reach.** One tour ship still earns its place charting new systems and
   revisiting markets that have no keeper; it is too slow to be the only source of fresh prices.

## Review of the 2026-10-11 week (THEOREM, X1-CM13), written at the 2026-10-18 reset

Result: 151,637,627 credits at the end (the previous week ended at 36.2M), matched trading net 214M over 20,425 trades, 5,965 jumps
(36.1M), 215 ships at the end (190 keepers, 23 traders), peak 240. The fleet was earning about 2M credits an hour by the last day.

- **Keepers paid for themselves.** Fleet profit per hour rose about 40% after each step of the keeper count (from about 0.72M to
  1.01M an hour at 157 trips before, and 0.93M to 1.32M at 239 trips before), a correlation with large samples. Fresh prices are what
  the dispatcher needs; the keepers-from-1M rule in this playbook stands.
- **The wind-down did not work.** With a 120-minute window the fleet went from 239 to 215 ships, all of them keepers, and none of the
  23 traders. Two causes, both fixed 2026-10-18 (see the CHANGELOG): the scrap path looked for a yard only in the galaxy table's
  SHIPYARD traits (now it falls back to the stored `shipyard_inventory`), and traders were never queued unless they sold out (now they
  are queued for the whole window, a loaded one waits for its sale or the 15-minute deadline). Buys were blocked for the whole window,
  so credits grew about 0.85M in the last two hours against about 2M an hour before; the window has a real cost, so decide its length
  with the refund in view (scrap pays part of a hull's price; a probe costs about 23k).
- **One route lost money:** VIRAL_AGENTS X1-KQ90-C16D to X1-QD90-A1 lost 1.96M over 4 trips against an estimate of +2.3M. The floor
  approval is now wired in (see the CHANGELOG, 2026-10-17/18); `maxLossPct` is 10.
- **Check the opening before changing roles.** This week the command ship was switched from tour to trader at 15:34 UTC with 20 of 31
  home-system markets never priced. Keep it on tour until the map is read.
