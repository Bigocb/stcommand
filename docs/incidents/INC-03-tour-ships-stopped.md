# INC-03: Tour ships stopped touring the staged queue; releases stopped

GitHub: [#34](https://github.com/Bigocb/stcommand/issues/34)

| | |
|---|---|
| When | 2026-11-17 13:44 (deploy) to 2026-11-18 00:35 UTC, about 11 h |
| Severity | High (fresh-system pipeline stopped) |
| Status | Fixed (`6f20c3d`, `e358093`) |
| Detected by | Operator, 23:55 ("why are the tour ships not touring the queued systems?") |

## What happened
Eight staged systems (GV7, PD3, RS9, TA36, TU72, UN59, YQ84, YU93) waited untoured at 0-13% keepers while the four tour ships
re-toured systems already live. No release from PN45 (22:30) until RS9 at 01:30.

## Impact
No fresh system for about 3 h of the evening and none staged-to-ready all afternoon; the best routes decayed (top trips 43-54k at
19:00, 17-25k by 23:00). This fed INC-04 and INC-09.

## Cause
Two bugs in the queue-tour code:
1. After a restart every tour ship with a saved destination counted as "the operator's own trip", because the module's "sent"
   list lives only in memory.
2. Tour ships in flight with no destination were skipped, and a touring ship is in flight about 95% of the time, so none was
   ever seen free at the 5-minute check.

## Resolution
`destinationNeedsTour` (first fix, deployed ~00:18) and `shouldConsiderTourShip` (second fix, ~00:35). All four tour ships were
sent 00:35-00:45; RS9, PD3, TA36 and TU72 were released 01:30-02:46.

## Follow-ups
- Queue log still says "1 tour ship(s), none free" for systems with a tour ship in them after a restart (cosmetic) ([#42](https://github.com/Bigocb/stcommand/issues/42)).
