# INC-05: Trader self-claim and discovery zigzags: -2.65M in jump fees

GitHub: [#36](https://github.com/Bigocb/stcommand/issues/36)

| | |
|---|---|
| When | 2026-11-18 05:17 to ~11:45 UTC (fix live 12:05; follow-ups 13:50, 14:45) |
| Severity | Critical (wallet plus holds 1.43M -> 250k) |
| Status | Fixed (`69b674f`, `57c7927`, `7e3d501`) |
| Detected by | Hourly reports (six losing hours in a row) |

## What happened
After positioningHops went 3 -> 8 -> 6 at 05:17 (operator), every hour from 05:00 lost money: 432 jumps (2.65M) against
1.75M matched profit. About 90 jumps were immediate reversals (A -> B -> A): THEO-A7 17, THEO-1 14, THEO-38 11, THEO-A1 10.
THEO-38 made nine jumps in 30 minutes without a single buy.

## Impact
Wallet plus holds 1.43M (04:43) -> 250k (11:33). The ledger: matched +1.75M, contracts +0.22M, jump fees -2.65M, fuel -0.30M,
hulls -0.06M.

## Cause (traced in code and logs)
- When the dispatcher had nothing for a trader, `trader.findRoute()` fell back to `dispatcher.claim()`, which took the first route in
  the fleet-wide list that `viableRoute()` accepted. `viableRoute()` priced only the buy -> sell leg; the jumps from the ship to the
  buy market were not subtracted, and a claim set no commitment. So the trader flew one hop, the next minute's recompute dropped
  it, and it claimed whatever was first from its new spot.
- `discoverPrices()` jumped to the first reachable market in another system with no cost check (THEO-1 ping-ponged MV84 <-> XD69).
- In 10:20-11:42, 43 of 67 trader jumps came from a self-claim (33) or discovery (10). Self-claims led to 3 purchases worth about
  108k against at least 33 jumps (about 200k).
- positioningHops 6 widened the reach of these fallbacks; the dispatcher's own scoring was right.

## Resolution
- `69b674f`: doctrine `traderSelfClaim` (off) gates self-claim; discovery crosses a gate only for a market a route needs;
  claimed trips recorded with source "claim".
- `57c7927`: discovery skips same-system markets priced in the last 20 minutes.
- `7e3d501`: `traderIdleDiscovery` (off): a trader with no route waits for the dispatcher instead of discovering.

## Follow-ups
- Lesson: a doctrine change that widens reach (positioningHops) needs a jump-fee check in the next hour.
- Brake: alert or auto-revert when jump fees exceed matched profit two hours running ([#43](https://github.com/Bigocb/stcommand/issues/43)).
