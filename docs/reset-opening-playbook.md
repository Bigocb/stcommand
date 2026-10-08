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
