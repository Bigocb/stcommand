# INC-07: Every trader unassigned: no local spreads, far routes fail the positioning test

GitHub: [#38](https://github.com/Bigocb/stcommand/issues/38)

| | |
|---|---|
| When | 2026-11-18 ~14:45 UTC, ongoing |
| Severity | High (9-11 of 12 traders idle) |
| Status | Open; worked around with trader tours (wave 1 sent 15:47) |
| Detected by | Operator |

## What happened
After INC-05's fix stopped the zigzags, nearly every trader waited with no assignment while the dispatcher listed 34-36 routes.

## Cause (checked)
1. **No local spreads.** Live keeper prices show the cheapest buy at or above the best sell for most goods in the traders' systems
   (BB74 MACHINERY 3,165 / 2,901, FABRICS 2,723 / 2,609; TV64 ELECTRONICS 4,443 / 2,795; HS78 MACHINERY 6,020 / 3,214). Rivals traded
   about 375k units through these markets in 24 h (SPECTER 78 ships, VEPRINE 33, HYDRA, NVIATE, ASTROBJORN, MARAUDER).
2. **Far routes fail the positioning test.** `whyUnreachable` (dispatcher.ts ~1686) refuses a route when its first trip does not
   cover the jumps to the buy market. The trip's profit is sized to the cash budget (`priceLeg`, fleet.ts ~2552:
   `min(hold, budget / buyPrice, volume x lots)`), so a thin wallet shrinks every first trip. THEO-A7 in QM40: MEDICINE
   FD13 -> AH21 31.9k against 4 jumps (~32k).
3. **The release pipeline is waiting on cash.** XR3 is next to stage but its 8 keepers (~280k) would leave under 500k.

Both rules predate 10-29; last week's wallet held millions, so loads were hold-limited and the test always passed.

Not a bug: the `dispatch: ... canJump=false` debug line is misleading (it only checks a single gate); `dispatch_explain` gives
the real reason.

## Resolution so far
Operator plan (15:47): idle traders tour unpriced systems in waves of four; release each when priced and turn the ship back to
trader. Wave 1: THEO-7 -> JD68, THEO-1 -> CN92, THEO-17 -> QA67, THEO-6C -> BQ46.

## Follow-ups
- Judge positioning against several trips or a full hold, not one cash-sized trip (doctrine clause, off by default) ([#44](https://github.com/Bigocb/stcommand/issues/44)).
- Debug line: print the real `whyUnreachable` reason ([#45](https://github.com/Bigocb/stcommand/issues/45)).
