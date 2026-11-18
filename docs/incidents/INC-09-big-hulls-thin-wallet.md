# INC-09: Two heavy freighters bought on a thin wallet (decision)

GitHub: [#40](https://github.com/Bigocb/stcommand/issues/40)

| | |
|---|---|
| When | 2026-11-17 19:24 and 22:11 UTC |
| Severity | High in effect (removed the cash cushion before INC-04/05) |
| Status | Lesson recorded (docs/lessons-learned.md, CLAUDE.md "Cash discipline") |
| Kind | Operator decision, not a code bug |

## What happened
THEO-A1 (2,240,596) and THEO-A7 (2,303,936), both heavy freighters from B64-CA2B, bought about 3 h apart below the 10M big-hull
line: wallet about 3.20M -> 957k, then about 2.93M -> 625k.

## Impact
The hulls were good (A1 made about 940k matched in its first hour; the heavies were the only traders covering their jumps
overnight). The wallet was not: one heavy load costs 300-400k, so the wallet fell to 95k by 01:37, with no room for tour ships,
keepers or full loads when INC-03, INC-04 and INC-05 hit.

## Lesson
After a big-hull buy keep a working-capital floor of (big hulls x ~400k) + ~100k per other trader, on top of the 3M purchase
rule; a second big hull waits until the first has paid back. Manual buys bypass doctrine, so this is held by hand. The
buy-ship warning (`b4b4f94`, clause `buyAdvice`) now warns on the floor, the 10M line and payback.
