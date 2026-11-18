# INC-04: Jump fees above trading profit, overnight

GitHub: [#35](https://github.com/Bigocb/stcommand/issues/35)

| | |
|---|---|
| When | 2026-11-18 ~00:00 to 02:55 UTC (recovered by 04:12) |
| Severity | High (losing ~290k/h) |
| Status | Mitigated, then superseded by INC-05's fix |
| Detected by | Hourly report / economy alert |

## What happened
80 jumps an hour, about 486k/h of jump fees against 232k matched profit. THEO-1 (40-unit shuttle) made 32 gate jumps (191.5k)
between two buys, turning back on itself again and again (SN86 -> BB74 -> SN86, AC26 -> GV7 -> AC26, YH41 five times).

## Impact
About -290k/h net for roughly 3 h; wallet plus holds fell from about 1.19M (01:13) to 843-863k.

## Cause
The dispatcher charged each single pick for its own jumps, but an empty ship's target kept changing while it was flying, so the
jumps already flown toward the old target were wasted (route churn). Trip estimates themselves were fine (calibration 0.84).
positioningHops 10 and fresh systems spread far apart gave the churn a long reach. The refusals behind the churn could not be
proven at the time (no record of them); route refusals are now recorded (`371b8f6`, ops `route_refusals`).

## Resolution
Operator-approved at 02:53-02:55: THEO-1 and THEO-3 local-only, positioningHops 10 -> 3. Net turned positive by 03:13 and was
recovered by 04:12 (wallet plus holds 1.60M). The real path (trader self-claim) was found and fixed under INC-05.

## Follow-ups
- See INC-05.
