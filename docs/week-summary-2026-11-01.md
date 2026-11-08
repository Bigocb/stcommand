# Week of 2026-11-01 (THEO, home X1-UZ49): summary from the journal

Source: `docs/journal/2026-11-01.md` (the days before 11-05 are reconstructed and thinner).

## Result
- Wallet 175,000 -> 297.67M (peak 297.71M). Trading net 461.2M on 28,376 trades, 9,289 jumps. Sell revenue 3.007B, purchases 2.561B, ship spend 93.9M, jump cost 57.3M. 1,371 ships ended the week (622 keepers, 712 parked, 32 traders; the journal's own figures).
- Top goods: CLOTHING 67.6M, LAB_INSTRUMENTS 50.3M, FOOD 37.8M.
- Against earlier weeks: 2026-11-01 week's predecessor ended at 253.6M wallet / 400.1M trading net; THEOREM's 2026-10-18 week ended at 543M.
- Best hours 8-9M matched profit (11-07 night). The last two hours were idle: traders out of routes, no staged system ready (12:15 entry).

## What drove it
- Fresh-system premium: profit tracked system releases. 24 h to midday 11-05 made 43.6M (1.81M/h); by 11-07 the fleet held 100+ live systems and ran 6-9M/h.
- Heavy freighters (6 by the standing 2-hourly order, then 3 more and 2 more) and 2 bulk freighters (2.7-3.3M each; the first earned 2.06M in one hour). Route fit for big hulls (`routeFitMinTrip` 10k, `routeFitBigHold` 150).
- Fresh-system hybrid run by hand: tour/explorer ships sent to staged systems to price them while keepers travel; 15 minutes between releases; release as soon as routes show.

## Problems and fixes
- 11-05: `hopToward()` closed a jump gate on any jump error (16 hub gates closed in an hour, 14,796 legs dropped); fixed 19:05. API ceiling: arrival surveys cost 19 calls/min; fixed with `arrivalSurveyMaxAgeMin`.
- 429s and the 90-105/min ceiling: API lane proxy, crawler proxy, proxy pool (20 configured, 3 active), Webshare byte meter, projected 38 GB a month.
- Keeper ceiling (1,000 total, 150 polls/min) bound for the last day; listed keepers fell as the engine parked idle systems.
- Losses: THEO-C3 MICRO_FUSION_GENERATORS (36 units, about 790k exposure; sold at SR93), THEO-44 dump, MICRO_FUSION blocked; a RELIC_TECH third lot -94k.
- Gate took about 50 h (FAB_MATS 37 h, circuitry 13 h after): the "Gate open in 18 hours" playbook came from it.
- Last two hours: idle traders, staged systems under their ready share.

## Experiments run and their answers
- Manual explorer trial (3 ships to VQ68, ZJ17, ZY57): all arrived, refuelled at stops, priced 13/14, 7/9 then 9/9, 6/14 then 13/14 markets; ZY57 released at 100% ready. Side effect: engine bought 13 probes at the VQ68 yard while it was still staged.
- Charting test: THEO-150 charted X1-ST57-C11D, paid 432 credits (one sample); a scan pays nothing and charts nothing. 11 uncharted waypoints were in range there.
- Knob test 1 (more traders): light hauler (not what was meant), then heavies.
- Bulk vs heavy: bulk 490 units, speed 60, about 5.5k a unit; heavy 225 units, speed 36, about 7.9k a unit.

## Not tested or left open at the end
See the list delivered with this summary (open items from the journal's Open section and trials).
