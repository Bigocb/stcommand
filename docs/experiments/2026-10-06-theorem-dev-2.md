# Experiment log: THEOREM_DEV_2, single-system trading test bed (2026-10-06/07)

Operator goal: "make as much money as we can — it's our test bed." Fresh agent THEOREM_DEV_2 (tenant `1153833e`), home
system X1-XJ90, registered mid-week (reset 2026-10-04, next 2026-10-11). Gate (I59, 1,600 FAB_MATS + 400
ADVANCED_CIRCUITRY) deliberately ignored. THEO (`7e1ea899`) kept running its normal gate-feeding play as the control.
Run by a Claude Code session through the hosted MCP (`/mcp`) plus direct API scripts; every number below is from the
activity feed or the live API.

## Wallet curve

| Time (UTC) | Credits | What happened |
|---|---|---|
| 17:46 | 175,000 | Start: 1 command frigate, 1 probe |
| 18:11 | 65,639 | Bought light shuttle (88,853) + A2 keeper probe (21,627) |
| 18:24 | 68,460 | First pinned ALUMINUM H55 -> D47 trip, +3,930 |
| 18:57 | ~19,000 | Pinned aluminum ran 18 min at a loss, ~-50k (see lesson 1) |
| 20:02 | 17,337 | Low point; frigate idle, tour shuttle stuck bouncing J61 <-> J62 |
| 20:32 | 27,385 | First hand-run DRUGS J62 -> H55, +10,696 |
| 20:58 | 76,854 | Weapons E48 -> J62 + DRUGS J62 -> H55 round trip, +50,845 |
| 21:32 | 133,712 | 20 rifles +40,260, 9 firearms +18,054 |
| 21:42 | 41,683 | Bought 2nd shuttle (91,381) |
| 23:15 | 254,129 | Pinned routes running after the live-balance fix |
| 23:57 | 291,146 | |
| 00:27 | 478,830 | Peak so far; three full 40-unit loads cycling |

Roughly +460k from the 17:46 start and +460k from the 20:02 low in about 4.5 hours, on 3 cargo ships.

## What worked

- **High-margin, low-volume goods.** DRUGS (J62 -> H55, +2,600/unit at first) and ASSAULT_RIFLES/FIREARMS (E48 -> J62,
  +2,000/unit) at tradeVolume 20 barely moved per 4-8 units, where 40 units of ALUMINUM (tradeVolume 60) moved ~8-10%
  per load.
- **Two-way loops.** Weapons east, drugs west: both legs loaded.
- **Pinned routes inside the app** once they were safe (survive the Claude container restarting, which happened ~10
  times in the evening).
- **Route-weighted keeper placement** (operator idea): rank markets by the route profit through them, keep probes there
  (J62, E48, H55, A2), move existing probes instead of buying (operator: "save some money").

## Lessons (each cost real credits)

1. **Pinned routes had no safety net** — skipped the margin floor and the loss floor. The aluminum pin crashed its own
   spread (buy 167 -> 552, sell 266 -> 127) and lost ~50k. Fixed in `28c91e4`: never buy at or above the destination's
   latest sell; two losing trips unpin.
2. **Fast loops crash the spread, even on good goods.** DRUGS J62 buy 2,775 -> 4,666 and H55 sell 5,449 -> 4,145 over
   ~3.5 hours with 1-2 ships; E48 rifles 2,520 -> 3,879 in ~2 hours with 2 ships. Every high-margin leg in the system
   was saturated by ~00:45. Pace legs and rotate goods before the margin closes; one ship per good per market.
3. **Stale cached balance strands pinned ships.** Right after a big sale the fleet's cached credits trailed by minutes
   (`credits=242` with 130k in the wallet); pinned ships rejected their route and flew off to "discover prices", four
   times. Fixed in `c7dcd90`: live balance for pinned planning, wait at the buy market.
4. **Working capital per ship.** Buying a third ship left too little cash for full loads; two drug ships starved for
   ~30 min. Keep ~one full load of capital per pinned ship before buying more ships.
5. **Auto-buyer noise.** It proposed a tour shuttle, a siphon drone, a mining drone and surveyors-as-keepers (~70k)
   repeatedly; `shipCap:FRAME_DRONE` 0 stopped drones, the rest needed denying every check.
6. **Scripts in an ephemeral container die.** Hand-run loop scripts were killed by container restarts mid-leg (one ship
   sat 23 min holding 91k of rifles). Anything that must keep running belongs in the app.

## Engine flaws found (see docs/TODO.md)

Tour holds on a pending keeper approval; drone proposals with targets at 0; idle trader ping-pongs between the two known
markets; new command frigate auto-classed as miner; `[object Object]` MCP errors; tour shuttle bouncing J61 <-> J62;
keeper proposals using a 70k surveyor when the nearest yard has no probes.

## Ideas worth automating

- **Margin-decay rotation:** watch each pinned leg's margin trend and rotate to the next-best leg before it closes,
  instead of waiting for the safety stop.
- **Per-market pressure budget:** cap units/hour bought at one market for one good (one ship per good per market).
- **Capital-aware ship buying:** only buy a ship when spare cash covers its first load.
- **Route-weighted keeper placement** as a periodic job (done by hand here hourly).
- **Weekly test bed:** a fresh agent each week to try one new opening idea against THEO's play, with this log format.

## Running notes (hourly market reviews)

- **00:50** Weapons legs saturated (E48 rifles 2,603 -> 3,879 in ~2h with two ships). Shuttles unpinned, marginFloor
  300.
- **01:32** EQUIPMENT K92 -> J62 closed (+73/unit). Frigate and shuttle 2-5 held instead of wandering.
- **01:37** Only leg >= 800 with fresh prices at both ends: CLOTHING K92 -> J62 (+829). Frigate pinned to it. Weapons
  have no leg >= 300, so keeper 2-2 moved E48 -> F52: F52's CLOTHING price (the best sink, +975) was 7 hours stale.
  Keeper list now J62, F52, H55, A2. The dispatcher took an IRON_ORE procurement contract (201 to H55, 27,594 on
  delivery plus 3,891 on accept, ore ~39/unit at J62): about +20k for ~5 shuttle trips, worth running while the
  trade legs recover.
- **02:24** First automatic pinned-route safety stop: CLOTHING K92 buy reached 5,223, at or above J62's latest sell, so
  the frigate's pin cleared itself (`28c91e4` working as intended). Two clothing trips: +23,080, +13,560. No leg in
  the system clears 300 except ANTIMATTER I60 -> I59 (+415); frigate held. Wallet 771k at 02:35.
- **03:06** Recovery is slow: FIREARMS at E48 3,378 (00:50) -> 3,319 (03:06), about -25/hour after we stopped buying;
  ASSAULT_RIFLES at E48 still 4,141 vs J62's 4,012. F52's CLOTHING price, fresh now that a keeper sits there, is 5,353
  — only +130 over K92's 5,223, so the "+975" leg was a stale-price illusion. Nothing in X1-XJ90 clears 800; all three
  cargo ships idle or on the IRON_ORE contract. At this recovery rate the system supports roughly one leg-trip every
  few hours, not the 6-7M goal.
- **03:38** Wallet 767k (771k at 02:35: fuel only). No leg clears 800; FIREARMS E48 -> J62 back to +456 (from closed at
  00:50), ANTIMATTER I60 -> I59 +415. The idle frigate was ping-ponging F52 <-> H55 every ~15 min (engine flaw 3): held.
  Shuttle 2-3 is on the IRON_ORE contract, 120/201 delivered. Denied a 94k shuttle proposal (no leg for it).
- **03:47** Recovery check (asks at the export, bids at the import): FIREARMS E48 3,319 -> 3,248 since 03:06 (~-100/h),
  J62 bid 3,704, so +456; ASSAULT_RIFLES E48 4,141 -> 4,043 (~-140/h) against J62 4,093, +50. DRUGS has not recovered:
  J62's ask is 4,780 (4,666 at 00:45) with the export RESTRICTED, so the source itself is short, while H55's bid came back
  4,145 -> 4,844; margin +64. CLOTHING K92 5,223 (79 min old) vs F52 5,367, +144. Only FIREARMS and ANTIMATTER (+415)
  clear 300; nothing clears 800. No keeper move (no stale market worth more than one already covered), no pins.
- **04:10** 764k. 2-5 turned into a tour ship at 04:02 (13 of 24 markets were 8-10 h unseen, so "no leg >= 800" only
  covered the fresh third). Operator keeper rule: every market with more than 4 goods, plus the shipyard; the list is
  built from the tour's fresh prices and approved before buying. The held frigate flew F52 -> H55 after each restart
  (a restored hold loses to the trader's first tick; TODO); re-held at H55. Denied the re-proposed 94k shuttle.
- **04:42** 762k. The tour ship never left the I59/J61 corner (stale markets all > 300 from it); fixed with a
  stepping-stone hop (CHANGELOG). Denied an auto-proposed 287k light hauler. IRON_ORE contract at 160/201.
- **05:15** 759k. The stepping-stone fix works: the tour ship left the I59 corner at 04:51 and has since refreshed I60,
  K92, E49, G54, C45 and is docking at C44; 12 of 24 markets are still more than 2 h old. Margins are climbing back
  toward 800: FIREARMS E48 -> J62 +724, CLOTHING K92 -> F52 +682 (K92's ask fell 5,223 -> 4,680 in ~2 h), DRUGS
  J62 -> H55 +581 (J62 4,780 -> 4,515). IRON_ORE contract at 200/201. Denied the 287k light hauler again.
- **05:48** 763k. First trade in three hours: the dispatcher sent 2-3 on CLOTHING K92 -> F52 (40 @ 4,680 -> 5,350-5,362),
  +26,920. DRUGS J62 -> H55 is back to +820 with both ends fresh, so the frigate is pinned to it. The tour has now
  refreshed 16 of 24 markets; still >2 h old: A1, A3, A4, BX5D, F50, F51, H57, H58. Denied a 287k hauler and a 70k
  surveyor-as-keeper proposal. (The 05:37 market review was lost to a container restart; folded into this check.)
- **06:21** 873k (+110k since 05:47): DRUGS J62 -> H55 pinned run +24,900 (bought 4,434/4,876, sold 5,318/5,237), FABRICS
  E49 -> D46 +15,900 (a leg only the tour revealed: E49 was 10 h unseen), IRON_ORE contract fulfilled +27,594, and a
  new MEDICINE x18 contract (D46 -> F52) paid 44,947 on accept, 127,925 on delivery, ~95k to source. The tour has every
  market under 2 h old. Keeper list (more than 4 goods, ranked by route value): K92 74.8k, E49 49.6k, D46 25.5k,
  E48 24.2k, F53 24.0k, A1 17.7k, D47 12.2k, C44 7.2k; G54, H57, H58, F51, F50 carry no leg >= 300 right now.
  Already covered: J62, F52, H55, A2. Probe 23,834 at A2. Sent to the operator for approval.
- **06:52** 948k (+75k in 30 min, 175k -> 948k since the start). The DRUGS pin self-stopped at 06:22: one 40-unit
  run lifted J62's ask 4,434 -> 5,303, above H55's bid, so a DRUGS leg is one trip per recovery cycle. The dispatcher
  then used the frigate well on its own: MEDICINE contract delivered (+127,925; contract net ~+78.9k with the 44,947
  accept and 94,014 sourcing), CLOTHING K92 -> A1 +25,150; 2-3 ran MACHINERY E49 -> D47 +17,400. Since the tour
  refreshed the far markets, the dispatcher has had legs again: E49, D46, D47 and A1 trades were all invisible before.
- **07:25** 943k, no trades in 30 min: the dispatcher kept assigning sub-floor legs (FERTILIZERS +96, COPPER +60) that the
  traders rejected (TODO), while weapons had recovered: FIREARMS E48 -> J62 +1,141 (E48 ask 3,378 at 00:50 -> 2,935),
  ASSAULT_RIFLES +844. Pinned the frigate to FIREARMS and 2-3 to ASSAULT_RIFLES. Weapons took ~6.5 h to recover from
  saturation. A new POLYNUCLEOTIDES x23 contract (to J62, 3,168 + 7,757) is open.
- **07:57** **1,029,557, past 1M.** Weapons pins made +89,480 in 30 min: FIREARMS +40,960 and +21,980 (E48 ask 2,935 ->
  3,531 across the two buys), ASSAULT_RIFLES +26,540 (E48 3,590 -> 3,948). Both legs then closed (RIFLES ~+30, FIREARMS
  ~+300), so both pins were cleared and the ships held rather than left to the dispatcher's sub-floor picks. CLOTHING
  K92 -> F52 is back to +1,051 (K92 ask 4,959 at 07:25), so the frigate is pinned there; 2-3 waits (one ship per good per
  market). Weapons pattern: ~6.5 h to recover, ~2 loads before the spread closes again.
- **08:30** 1,041,506. The CLOTHING pin was a near-miss: priced at +1,051 from a K92 ask 13 min old (~4,256), the frigate
  actually paid 5,186 and sold at 5,266-5,282, +3,360 for the trip. Rule for pins: the buy side must be under ~5 min old,
  or confirmed live on arrival. The dispatcher then sent the frigate on FABRICS E49 -> K92 (+11,930) by itself; 2-3
  held at I59, tour at A1. Light hauler proposal denied (9th).
- **09:34** 1,055,481. Dispatcher trips: FABRICS E49 -> D46 +14,550, CLOTHING K92 -> F52 +20,860, then a loss: ADVANCED_CIRCUITRY
  D47 -> A4 -12,600 (bought 3,475/3,618; A4 paid 3,651 for the first 20 and 2,812 for the second, -23% in one lot, on an
  import price 35+ min old). A tradeVolume-20 sink can't take 40 units. DRUGS J62 -> H55 back to +770 (fresh both
  ends), so 2-3 (held at I59, one leg from J62) is pinned to it.
- **11:55** Operator approved keepers. The tour had every market under 4 h old (most under 2 h; it also found B7, 18
  goods, the system's biggest market). Bought 9 probes at A2 for ~257k (23.8k rising to ~31k each; 1,075k -> 819k)
  and stationed them: K92, E48, E49, D46, F53, A1, D47, B7, F51 (C44 already had probe 2-8). With J62, F52, H55, A2 and
  C44 that is 14 keepers on every market with more than 4 goods except F50, G54, H57, H58, which the tour keeps
  covering. Purpose: see a leg recover the minute it does, instead of on the tour's 2-4 h lap.
- **12:45** THEO (control fleet), the chain-guard fix's payoff: between 12:28 and 12:40 MICROPROCESSORS A3 -> D44 made
  +197,820 over four 40-unit trips and ELECTRONICS F53 -> D44 +140,320 over three, ~338k in 12 minutes, while feeding
  D44 (the ADVANCED_CIRCUITRY producer). D44 bids eased 3,902 -> 3,794 (MICROPROCESSORS) and 3,041 -> 2,787
  (ELECTRONICS). THEOREM_DEV_2: rifles pin +30,900, then both weapons legs closed (~+200); pins cleared, all 14 keepers
  docked with prices 1-4 min old.
