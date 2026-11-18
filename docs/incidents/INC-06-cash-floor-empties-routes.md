# INC-06: Route list emptied below the cash floor

GitHub: [#37](https://github.com/Bigocb/stcommand/issues/37)

| | |
|---|---|
| When | 2026-11-18 ~10:00 to 14:45 UTC |
| Severity | High (no trading while the wallet was under 100k) |
| Status | Fixed (`7e3d501`, `tradeBudget.ts`, clause `cashFloorTradeSharePct` 50%) |
| Detected by | Operator ("there's not even enough money for one jump") |

## What happened
With the wallet under `cashFloor` (100k), the dispatcher showed one route or none, so traders sat idle exactly when cash was most
needed.

## Cause
Route building sized each leg by `floor(spendable / buyPrice)`, where `spendable` was wallet minus the 100k floor. Under the floor
every leg sized to 0 units and was dropped.

## Resolution
`tradeBudget(credits, floor, share)`: below the floor, cargo may use a share of the wallet (50%); above it the old rule applies.
Ship, keeper and mission buys keep the full floor. Live 14:45; routes came back (34 at 14:46).

## Follow-ups
- The cash-sized route also feeds INC-07.
