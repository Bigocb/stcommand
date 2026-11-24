# HYDRA: how they play and what it does to us

Operator request (2026-11-23): track HYDRA as closely as we can, both how they play and their impact on us. No asterisk on the
week's results; this is to learn from them. The hourly report carries a HYDRA watch section (scheduled task "Hourly fleet update",
section 6). Week-by-week notes go in the journal; this file holds the profile and the method.

## Profile

| Week | Start system | Ships | End credits | Rank | Gate |
|---|---|---|---|---|---|
| 2026-11-08 | X1-VZ97 | 2 -> 32 | about 19.5M | about 38 (THEO 17) | done 11-09 23:46 (about hour 35) |
| 2026-11-15 | not recorded | 33 | about 12.4M | about 44 (THEO 14) | not recorded |
| 2026-11-22 | X1-AR36-A1 (our HQ) | 33 | 640k at hour 15 | outside the top 15 (THEO 13) | building ours |

Sources: `stcommand_ops_agent_watch resetDate=<week>` (the agent watcher, kept across resets) and the public `GET /agents/HYDRA`.
Ship symbols are hex, so HYDRA-21 is their 33rd ship. An earlier week they also shared our home and were the "mystery gate
contributor" in the CHANGELOG; on 2026-11-18 they were one of the rivals (with SPECTER and VEPRINE) that had flattened our old systems.

## How they play (2026-11-22 week, from market fills our keepers read)

- **A fixed fleet.** 32-33 ships every week, never scaled up. Only 3-4 hulls show in our markets; the rest are probably probes.
- **Feed, then harvest.** HYDRA-1 (40-unit loads) runs raw goods into factories at +5 to +8 a unit, about the same as its fuel:
  SILICON_CRYSTALS B7 -> F49, LIQUID_HYDROGEN C37 -> F48/E47, AMMONIA_ICE B7 -> D45, HYDROCARBON -> G50, ALUMINUM_ORE and COPPER_ORE
  to the refineries. Then HYDRA-1/-20 buy the outputs (ELECTRONICS at F49, AMMUNITION/EXPLOSIVES at F48, PLASTICS at G50, FOOD at
  D45/D41) and sell high-value goods at C37 (ELECTRONICS, SHIP_PLATING, SHIP_PARTS). The margin stays above zero on every leg.
- **Gate from about hour 14.** HYDRA-21 (80-unit loads) bought FAB_MATS at F49 at any price (1,505 -> 2,014 a load, F49 to SCARCE 2,710)
  and HYDRA-20 bought IRON at H54 (472 -> 711) for the producers. About 400 of the gate's FAB_MATS by hour 15 were theirs.
- No circuitry yet (as of 04:15 on 2026-11-23).

## Impact on us: the method

1. **Gate:** each hour, gate `fulfilled` increase minus our own gate purchases (`ops_ledger PURCHASE` of the material with `route`
   null). The remainder is theirs (inferred: the game shows only the total).
2. **Fed vs unfed markets:** `scripts/hydra_split.py <ledger SELL json files>` splits our matched profit by buy market into the markets
   HYDRA feeds (F49, D45, G50, F48) and the rest, per unit and in 4-hour blocks. Pull the sells with `stcommand_ops_ledger type=SELL
   sinceHours=<since reset> limit=300` twice (newest and `oldestFirst=true`) and pass both saved files.
3. **Shared markets:** price moves at a market in the minutes after a HYDRA fill (`get_market_transactions`), e.g. their 43 ELECTRONICS
   at F49 at 02:51 lifted the ask about 6% before our buys.

## Findings so far

- 2026-11-23 04:30, first 15 hours: fed markets 703k of 5.61M matched (12.5%), 342 a unit against 584 elsewhere; both groups followed
  the same arc. Our top routes are all in markets they do not touch. Their gate FAB_MATS (about 400 units at 1,500-2,000) saved us
  roughly 600-800k of gate cost.
- 2026-11-23 10:15, 600 of the week's sells (13:40-22:15 and 02:08-10:08; 22:15-02:08 not read, the ledger tool stops at 300 a call):
  fed markets 534k of 4.89M matched (10.9%), 270 a unit against 485 elsewhere. Both fell together after hour 16 (fed 99-126, other
  168-220 a unit), the home system thinning while the gate waits; their feeding is not holding our margins up.
- 2026-11-23 10:00: HYDRA-20 bought 22 circuitry at D40 the moment it reached 9,036 (20 at 9,036, 2 at 10,404), the price our 9,000
  ceiling was waiting for. With both of us buying from one SCARCE market of 20 a lot, they take the cheap loads at any price; they
  are also finishing our gate for us (about 480 FAB_MATS and 107 circuitry so far).
- 2026-11-23 about 12:00: **HYDRA finished the gate.** HYDRA-22 (a ship new to us) bought 67 circuitry at D40 at 11:50, 14,871 -> 25,047
  (about 1.24M), and delivered the last 55. They pay any price at the end to open the gate early. Their week: about 480 FAB_MATS and about
  140 circuitry (of 1,600 and 400).
- 2026-11-23 16:15, 600 sells (13:40-22:15 and 06:18-16:13; 22:15-06:18 not read): fed markets 465k of 4.12M (11.3%), 223 a unit
  against 413 elsewhere. After the gate HYDRA went back to a copper chain (ore into H54, COPPER to F49/A3) and profit trading; it does not
  follow us into the new systems. The new competition there is other agents: HERMES-BRAVO (9 ships, 80-unit loads) bought 960 units at
  QY43-ZD8A in an hour, VEPRINE-C sold 40 LAB_INSTRUMENTS into QY43-AC5Z.
- 2026-11-23 22:12, 600 sells (11-22 13:40 to 11-23 about 00:30, and 11-23 about 10:10 to 22:10; the 4-hour blocks from about 01:00 to 09:00 not
  read): fed markets (F49, D45, G50, F48) 422k of 7.38M (5.7%), 281 a unit against 748 elsewhere (10.9% and 11.3% in the two earlier readings).
  Fed markets per unit by 4-hour block: 503, 296, 373, then 124 and 132 in the two latest; elsewhere 1,050, 455, 415, then 114, 425, 1,187, 1,197.
  Our profit now comes from the new systems (QY43, CJ53, MM91, CK92), not the home markets HYDRA feeds. HYDRA itself (4 ships, 1,204 units in the
  hour: SILVER 450, PLATINUM 180, FERTILIZERS 136) is profit trading at home and has not followed us out.
- 2026-11-24 04:12, 137 sells (11-24 01:16 to 04:12 only, a 3-hour reading, not the weekly sample): none of our profit came from the markets
  HYDRA feeds (F49, D45, G50, F48); the one home-system origin was C37 (THEO-7, 4 sells, 155k of 3.54M matched, 4.4%). HYDRA (5 ships, 909 units
  in the hour: GOLD 270, JEWELRY 110, MICROPROCESSORS 110) is profit trading at home and has not followed us out.
- 2026-11-24 10:12, 300 sells (11-24 05:48 to 10:12 only, a 4.4-hour reading, not the weekly sample): none from the markets HYDRA feeds (F49, D45, G50, F48); all 7.27M of
  matched profit came from other markets, 841 a unit (787 in the 05:00-09:00 block, 982 since 09:00). HYDRA itself fell from 1,901 units (08:12) to 189 (09:12) and back to 717
  (5 ships, AMMUNITION 256, at AR36 H54, E46 and F48); it has still not followed us out of the home system.
- 2026-11-24 16:12, 300 sells (11-24 13:57 to 16:12 only, a 2.3-hour reading, not the weekly sample): none from the markets HYDRA feeds (F49, D45, G50, F48); all 9.53M of
  matched profit came from other markets, 678 a unit (PM62, RC73, YK65, TV69). HYDRA did not appear in the rival fills at all this hour (it was at 717 units at 10:12); the new
  traffic is JEANLUC (12,054 units), HERMES-BRAVO (6,870) and TUSK-1 (4,601), all in UF92 and our other new systems, so the neighbours are now following our releases, not HYDRA.
- 2026-11-24 22:12, 300 sells (11-24 20:34 to 22:12, a 1.6-hour reading, not the weekly sample): none from the markets HYDRA feeds; all 7.65M of matched profit came from other markets, 460 a unit (KC13-AE9C BIOCOMPOSITES 602k, UF92-ZC3F CLOTHING 428k, TS52-XC9C DRUGS 266k). HYDRA is back at home with four ships (HYDRA-23/24 ELECTRONICS 32 each at F49 21:17, HYDRA-21/22 PLATINUM 45 each at B7 21:59); the busy neighbours are HERMES-BRAVO, TUSK-1 (in the staged BD14), TIPTAP and JEANLUC (in VB83).
