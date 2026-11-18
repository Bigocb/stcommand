# INC-01: Engine stall, trading stopped ~1.5 h

GitHub: [#32](https://github.com/Bigocb/stcommand/issues/32)

| | |
|---|---|
| When | 2026-11-16 23:10 to 2026-11-17 00:46 UTC |
| Severity | High (no sales for 1.5 h) |
| Status | Mitigated (operator restart); watchdog open |
| Detected by | Operator, at 00:08 (the 23:12 hourly showed zero sales and was not flagged) |

## What happened
Matched sales dropped to 0 and API use fell to about 3 calls a minute. The process was alive and no ship was reported stuck.
The same pattern was seen on 2026-11-10, at about the same uptime (31-32 h).

## Impact
About 1.5 h of lost trading during the week's best stretch (the hours around it made 400k-1.5M).

## Cause
Self-reinforcing idle: the fleet model held every trader "in transit", so the dispatcher had no free trader, and with no
dispatches nothing refreshed the model. The exact trigger was not captured (the log buffer had rolled).

## Resolution
Operator restart at 00:46. Health board built so the next stall shows at once: Phase 1 `b425c40`, Phase 2 `7134e6b`
(stall tile, 6 h charts, "Engine stalled" push), on main from 11-18 01:10.

## Follow-ups
- Stall-capture watchdog: dump the model's ship states when sales are 0 and calls fall for 20 min ([#41](https://github.com/Bigocb/stcommand/issues/41)).
- Consider a planned restart before ~28 h uptime until the cause is found.
- My miss: a zero-sales hourly must be flagged at once.
