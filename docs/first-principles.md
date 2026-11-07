# First principles (draft from the week of 2026-11-01)

Operator request (2026-11-07): "come out of this week with a list of first principles". This is a working list, one
principle per item, each with the evidence it rests on and the boundary where it stops being true. Edit it freely; add
the next week's evidence under the same heading rather than rewriting the principle. Confidence is stated per item:
**measured** (the numbers say it), **supported** (the numbers fit, other things changed too), **inferred** (a reading, not tested).

Numbers are UTC and come from `ops_profit_curve`, `ops_pnl`, `ops_run_results`, the week journal
(`docs/journal/2026-11-01.md`) and the earlier docs named below.

## A. What makes money

**1. Trade volume beats margin, up to the rate a market recovers.** (measured, with a boundary)
- Profit per unit stayed in the 300-500 band all of 2026-11-06 (333 at 08:00, 430 at 23:00) while profit per hour went from
  4.3M to 8.3M. What moved was sells per hour (250 -> 383) and ships selling (22 -> 27).
- The money goods are cheap staples sold in volume: CLOTHING made 123M in the 2026-10-18 week and 56M in the 2026-10-25 week,
  with FOOD, FABRICS, LAB_INSTRUMENTS and EQUIPMENT behind it.
- Boundary: a fast loop crashes its own spread. 2026-10-06, 40 units every ~90 s moved prices 8-10% a load, 167 -> 552 to
  buy and 266 -> 127 to sell in 35 minutes. Pace the loop to the market tick (about 30 minutes), do not run it flat out.

**2. A fresh market pays more, and our own selling uses that up in hours.** (supported)
- 2026-10-23: one ship's profit per unit went about 1,170 -> 860 -> 770 selling into the same two small systems, then
  350-480 once it moved on; its earnings fell from about 2.6M/h to 0.9M/h.
- A newly covered system pays about 1.7x for roughly 8 hours (freshGate). So coverage is revenue: keep opening systems and
  keep hulls moving to the ones not yet worn down. This week 9 systems opened between 21:16 and 01:28 and the hourly rate
  rose from about 5M to 7-8M, though other things changed in those hours too (see 9).

**3. Bigger hulls carry the volume; buy the biggest whose payback is hours.** (supported)
- Heavy freighter (225 hold, ~1.7M): about 580k/h, payback about 3 h. Bulk freighter (~3.2M): THEO-2DD about 650k/h over its
  first 5 h (payback about 5 h), THEO-306 about 260k/h over its first 2 h (about 12 h). One bulk freighter made 2.06M in a
  single hour and 0.42M the next, so judge a hull over several hours.
- Keep the right size on the job (playbook): big hulls on paying routes, small hulls on feeds into small markets.

## B. What limits growth

**4. In week one the gate is the critical path.** (measured)
- 2026-11-01 week: day 1 about 4.5M, day 2 about 3.1M, then 12.6M and 43.6M once the gate was open (around 11-03 15:30).
  The gate opened at hour ~50; the playbook target is hour 18. Cash goes to the gate first (`docs/reset-opening-playbook.md`).

**5. Information is the inventory, and the API is what it costs.** (measured)
- A market with no recent price read cannot be traded. Every read is an API call and the game limits each source IP to 2 a
  second. Before 2026-11-06 17:02 the box ran at 104 of 105 calls a minute, keeper reads waited 3-4 s and the keepers were
  starved (about 25 reads a minute against 91 wanted).
- A second IP for the calls nothing waits on (the API lane: keeper and survey reads) took the box to about 70-80 calls a
  minute with ~0.3 s waits and the keepers to about 45 reads a minute with ~1 s waits. Writes (trades, jumps, docks) stay on
  the box. The lane is now at 78-90% of its rate, so the next step is a second proxy, not a higher ceiling.

**6. Cash compounds; spend it where payback is shortest, and stop when payback outruns the time left.** (supported)
- Order seen this week: gate, then heavies (~3 h), then keepers for fresh systems, then bulk (~5-12 h). With about 34 h
  left in the week a 5-12 h payback still earns; it stops earning at about the last 5-12 h before the reset.

**7. Hulls and systems have to grow together.** (inferred)
- Ships selling went up 25% while live systems went up 50% (40 -> 61). Sells per ship per hour swung 9.8 to 14.7 across the
  day, which is as large as the hull effect, so extra hulls on the same markets would crowd them. Not tested directly.

## C. What loses money

**8. Dear goods in thin markets are where the big losses come from, and the planning assumption is the flaw.** (measured)
- Losses this week: RELIC_TECH -573k, MICRO_FUSION_GENERATORS -118k and -626k (same market, SR93-A1, 17:12 and 22:24),
  ROBOTIC_DRONES -533k realized (+ a -345k card). Earlier: NOVEL_LIFEFORMS -729k (2026-10-30).
- The plan assumed about 12% a lot (the dear tier); ROBOTIC_DRONES fell 33-40% a lot and MICRO_FUSION 32% then 59%. One bad dump
  equals about 30 average sales (626k against ~20k per sell), so these goods are worth far less than their margin says.
- Size by the measured per-lot drop of that market, not by the margin; cap exposure per good and market; do not value a
  hold at the bid (the cargo-value tool uses a flat 4.5% a lot, which overstates a thin dump).

**9. A decision loop that stalls is lost trades.** (supported)
- The route pass held the server's event loop (p50 260 ms, p99 1.4 s, spikes of 9-23 s) until 2026-11-06 19:14; traders
  wait behind it. After the fix p50 is 10 ms. The hourly rate rose in the hours after, but the lane, the keeper ceiling,
  nine system releases and four hull purchases landed in the same window, so the share of each is unknown.

## D. How to run it

**10. Change one thing at a time, and write down when.** (measured, by its absence)
- The rise from 20:00 to 02:00 cannot be split between hulls, systems, the server fix and the lane, because they all
  landed within six hours. A before/after needs a clean window and the journal entry that says when the change went live.

**11. Rules that act on a guess must prove themselves in the data.** (measured)
- Systems parked by the profit bar turned out to have made 260k to 1.03M while parked (parked 08:52, unparked 10:31 and
  11:51); the rule was wrong several times before the hold-while-a-loaded-ship-is-bound fix. Ship policies off, measure, then turn up.

## E. Added 2026-11-07, from the profit-per-hour chart (hours 90-110 were flat)

**12. Our own regressions cost more than the market does, and a 3-hour average hides them.** (measured)
- 2026-11-05 about 18:15-19:20: `hopToward()` closed a jump gate on any error (16 finished hub gates in an hour, 14,796 legs
  dropped as "outside our gate network") while arrival surveys used 19 API calls a minute and made keeper reads wait 9-15 s.
  The hour fell from about 2M to 200-600k; fixed 19:05 and 19:20, then 3.9M the next full hour. The hourly's Fleet-health
  table (gates closed, dropped routes, idle traders, top API callers, restarts) exists to catch this.

**13. Rivals share the exporters; spread to where they are not.** (supported)
- 2026-11-05: buy costs at the exporters rose (FOOD ~30%, EQUIPMENT ~10%, FABRICS ~10%, CLOTHING ~9%) while sell prices held,
  with rival agents (ASTROBJORN, TANDEM, ODIODIN, HERMES-BRAVO and others) buying at the same exporters; the best route was
  about 10k a trip. This is the flat stretch at hours ~90-110 on the chart. The ramp that followed matches system releases.
  Competition cannot be fixed, only moved away from.

## Open questions

- How much of the week's rise is the nine fresh systems, and what does the rate settle to once their premium fades (about 8 h)?
- Where does the second bulk freighter's early rate settle (THEO-306 started below THEO-2DD)?
- What per-lot cap would have stopped the dear-goods losses without removing the good dear trades (THEO-20's 2 VIRAL_AGENTS
  lots at -3.4% made +652k)?
- Does `autoApproveFloorSale` (40% of cost, cap 600,000) help or hurt? It let the largest of these dumps through without a card.
