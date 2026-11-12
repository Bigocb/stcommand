# Post-gate recovery: three weeks of data and a plan for next week

Written 2026-11-12 from `ops profit_curve` (resetDate 2026-10-25 and 2026-11-01, this week live), `ops run_results` and `ops gate_history`.
Question from the operator: the gate opens with very low cash, expansion and recovery then take about a day. What do the last weeks say?

## The three weeks side by side

"Start" = the hour the gate opened (2026-11-01 week: hour 50.6, first jump 2026-11-03 15:37; 2026-11-08 week: hour ~47, 2026-11-10 ~12:15).
The 2026-10-25 week has no gate reading, so its start is the first big bucket (Wed 2026-10-28 06:00, hour ~65).

| | 2026-10-25 (THEO) | 2026-11-01 (THEO) | 2026-11-08 (THEO, so far) |
|---|---|---|---|
| Cumulative matched profit at the start | 10.6M | 8.6M | 7.3M |
| Wallet at the start | 0.49M | 1.2-1.3M | 0.77M |
| Hulls bought in the next 24 h (ledger SHIP rows) | **194** | **149** | **46** |
| Matched profit in the next 24 h | **25.6M** | **12.0M** | **5.7M** |
| Profit per hour, day after the start | 4.3M (Thu) | 0.73M (Wed), 2.09M (Thu) | 0.41M (Wed), 0.8M (Thu so far) |

Reading: in every week the wallet at the start was 0.5-1.3M, because 7-10M of profit had gone into the gate materials and the first ships.
So low cash at the gate is the normal state, not a mistake. What differs is how fast the little cash was turned into hulls and keepers
in the 24 h after it: 194, then 149, then 46, and the 24 h profit follows the same order. Three weeks is a small sample and systems,
goods and the number of live systems also differ; this is a strong correlation, not proof.

Other facts that matter:
- Keeper share is not the gap: last week ended with 622 keepers and 32 traders (20:1); this week at hour 85 it is about 9:1.
- Per-ship throughput is lower this week: about 5 sales an hour per selling ship against about 8 last week at hour 85. Profit per unit
  is the same (475 vs 517). The cause is not established (15 live systems against about 27 last week is the likely part).
- 2026-11-09/10 (Mon/Tue) were the freeze: keepers waited for 5M, hulls for 3M and the release floor went to 1M. In those ~15 hours almost
  no hulls were bought while last week, over the same hours, about 64 were.
- The gate itself: FAB_MATS 1,600 done at hour 39 (last week hour 37); ADVANCED_CIRCUITRY sat at 380 of 400 from hour 45 because its
  price (5,519) was over our ceiling (5,500). Gate costs about 5M in materials.

## Plan for next week (proposal, for the operator to change)

1. **Treat gate-open as the start line and spend every hour for 24 h.** Above a floor of about 300k, put all cash into hulls and keepers
   each hour. Target at least 100 hulls in the first 24 h (last week 149, the best week 194).
2. **Do not freeze after a bad day.** If a purchase rule must change, change the mix (traders vs keepers), not the pace.
3. **Mix:** light haulers (80 hold, ~330k) until the wallet allows a heavy (~2.8M); the heavy THEO-64 earned about 340k/h on
   FABRICS/JEWELRY/LAB_INSTRUMENTS, light haulers 44-160k/h. Keep keepers on the staged systems' best markets (8 per system).
4. **Settings at the start:** `keeperAutoApproveMinCash` at about 500k (this week 5M), `systemReleaseMinCash` 500k, no hull hold below 3M
   for the first 24 h after the gate (the hold is for the quiet days before it). `freshTours` on at 2-3 ships so staged systems are priced.
5. **Before the gate:** pace the circuitry ceiling so the last 20 units do not stall the gate (raise the ceiling for the final lot).
6. **Review at hour +12 and +24 after the gate:** hulls bought, profit, wallet, staged systems with keepers in place.

Open questions: why per-ship sales an hour are lower this week; whether staging can happen before the gate opens (2026-11-03 note says a
closed home gate stops staging).
