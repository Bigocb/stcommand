# Always be expanding: big hulls on fresh systems (operator insight, 2026-10-24)

Operator direction (2026-10-24, after the 2026-10-18 week's analysis): next week, let the engine keep buying and managing
keepers so there are always fresh systems to trade in, and run big hulls. "Big hulls and always be expanding."

## What the 2026-10-23 data showed

Matched trading profit per hour, 3-hour windows differenced from `ops_pnl` (UTC, 2026-10-23):

| Window | Profit/h |
|---|---|
| 02:22-05:22 | 8.1M |
| 05:22-08:22 | 7.5M |
| **08:22-11:22** | **9.2M** |
| 11:22-14:22 | 6.0M |
| **14:22-17:22** | **9.7M** |
| 17:22-20:22 | 7.4M |
| 20:22-23:22 | 7.3M |

The day averaged about 7.3M/h and no 6-hour window passed 8.5M/h. The two peaks were carried by a few bulk freighters
(THEOREM-152, -174, -BE) selling into systems that had only just gained keeper coverage:

- 08:22-11:22: THEOREM-152 made 3.06M in X1-PZ97 (keepers added 05:47) at about 1,060 a unit; THEOREM-174 made 750-1,000 a
  unit in DG35 (keepers 08:28), CB43, HM42 and KP19.
- 14:36-18:00: THEOREM-152 made 8.9M in X1-YB39 (keepers 11:40) and X1-UF49 (keepers 14:23).
- The same ship's profit per unit fell as it sold into the same two small systems (about 1,170, then 860, then 770), and ran at
  350-480 once it moved to HM42 and KP19. Its earnings went from about 2.6M/h to about 0.9M/h.
- The keeper list stopped growing around 19:00 on 10-23 and the budget (`keeperMaxTotal`, set by the 90 calls a minute API
  allowance) has been binding since; the fleet has run flat at about 7.7M/h since.

Confidence: moderate. Only two ships' sells were broken down (the ledger tool returns 300 rows a call), and a before/after on
a keeper change is a correlation. The plan below therefore measures first.

## Mechanism (our reading)

A keeper gives a market a fresh price, so the dispatcher can route there. A system nobody has traded has untouched supply and
spreads about twice the usual; our own volume erodes that within a few hours (the learned price impact already measures it).
The yield of a system is therefore a curve: high just after coverage, decaying toward the fleet norm. Staying ahead of the
decay means continually adding systems and moving coverage and hulls off the ones that have decayed.

## What exists

- `autoKeeperGoodSystems`: a system an explorer accepts gets a keeper on every marketplace.
- `autoApproveKeeperProbes`: a probe within the cap is bought with no card; the buy goes through a ship already at the yard.
- `keeperMaxTotal`: automatic buying stops at the cap (the API budget); manual buys are not blocked.
- Keeper review (`ops keeper_review`): scores stationed keepers and uncovered markets, suggests swaps. Advisory only.
- `park_ship` (stops polling, keeps the hull, frees a slot, market stays marked covered), `sell_ship` (scrap, market uncovered).
- `keeperPollMaxMin` (up to 60) and `traderSkipKeeperMarkets` cut the API cost per keeper.

The gap: once the cap is full nothing rotates coverage toward fresh systems, and nothing tells us how fast a system decays.

## Plan

**Phase 0, measure (shipped 2026-10-24; read it in `stcommand_ops_analysis` under `freshness`).** Add a per-system "yield since coverage" series to the analysis engine:
for each system, the hour its first keeper was stationed, then profit per sold unit and per trip in hourly buckets after it,
beside the fleet norm. Save it with `capture_findings` so it survives the reset. This turns the table above into a curve we can
read live, and it confirms or kills the hypothesis in the first days of next week.

**Phase 1, free budget (config only).** Turn `traderSkipKeeperMarkets` on, raise `keeperPollMaxMin` toward 60 for markets that
barely move, park keepers on markets with no recent routed trades. Each saved call is room for one more fresh-system keeper.
Check with `keeper_review` (polling cost now and at the limit).

**Phase 2a, shipped 2026-10-24: park the dead ones and look again (doctrine `keeperTriage`, off).** `keeperTriage.ts` and `reminders.ts`: the engine parks keepers on markets no viable route touches and sets itself a reminder to look again (see CHANGELOG). It frees budget; the swap-in of a fresh system's keeper is Phase 2b.

**Phase 2b, rotate (pure module, doctrine clause off by default).** `src/engine/keeperRotation.ts`, in the style of `chain.ts`
and `pace.ts`: inputs are the stationed keepers (market, recent routed trades and profit attributed to the market, age since
coverage), the uncovered markets (system, expected yield from the Phase 0 curve, buy cost) and the budget; output is a short
list of swaps with a one-line reason each. Rules: only swap when an uncovered market beats the weakest stationed one by a set
margin; at most N swaps an hour; park, not scrap, the loser (reversible, and its market stays covered); never park a keeper
that a current route's buy or sell leg depends on; a fresh system's keepers are protected for its first M hours. Ships first
as advisory in `keeper_review`, then as an automatic clause once the advisory list has matched what the operator would do.

**Phase 3, big hulls and where they go.** Next week's opening buys bulk freighters earlier (the 80-unit rule in the opening
playbook already points this way; 152 and 174 returned the most per hull this week). Let the dispatcher see the freshness
premium: the learned impact (`lotImpact`) per market is the signal, and a hull should leave a system when its per-unit margin
there falls to the fleet norm. Only after Phase 0 shows the decay curve is stable.

**Phase 4, supply of fresh systems.** Explorers and the systems-candidates list are the pipeline. Keep at least two accepted but
not yet covered systems queued ahead of the keeper purchases, and rank uncovered markets by system freshness first.

## Queued systems and the release gate (operator idea, 2026-10-24; first measured result)

Phase 0 on the live week (40 hours to 2026-10-24 17:27 UTC): profit per unit in a system's first 8 hours after coverage was about
1.7x the mature rate (938c, 865c, 868c against 513c), 1.2x in hours 8-16 and 1.0x after. Only about 9% of sells fell inside a premium
window (about one new system every 2 hours), and the excess was about 17.4M credits of roughly 290M, so the premium is real but the
two 9-10M/h peaks were mostly a few big hulls arriving in fresh systems together. The lever is a steady supply of fresh systems, and
the timing of each one matters, because a system's premium is spent by the hulls that reach it first.

Today there is no hold: when an explorer accepts a system, `autoKeeperGoodSystems` adds its markets to the keeper list at once, and the
tour itself records prices, so routes can appear before any keeper is stationed. Waiting on keepers alone therefore does not hold a
system back. The decision (operator, 2026-10-24): **queue the systems and mark their routes unavailable until the flip.**

- **Scouted:** toured and accepted by an explorer; nothing bought; the dispatcher ignores every route that touches the system (a
  system-level block, in the style of `routeBlocks.ts`).
- **Staged:** keepers bought, sent and **parked** on arrival (`keeperTriage` machinery). A parked keeper polls nothing, so staging
  costs probe prices but no API budget, and the lead time (buy and travel, about 4 hours at HF67) is paid before the release.
- **Live:** the gate opens and the keepers unpark. The freshness clock starts here, which also makes the Phase 0 age exact (it is
  anchored today at the keeper-list change, which runs early).

**Lead time is an operator knob first.** `freshLeadHours`: release the next staged system this long before the live cohort is
expected to fade (default about 4). `freshTarget`: how many live-premium systems to hold at once. A manual release or hold of one
system always works. Automatic nudges come later and only advise at first: shorten the lead when traders are waiting or idle
(`idleTraders`, the dispatcher's waiting count) or when a live system's rolling 2-hour ratio is falling faster than the curve; lengthen
it when more premium systems are live than the target. The trigger to release should be a live per-system ratio (the last 2 hours of
sells against the mature rate), not age alone: THEOREM-152 sold about 8,000 units into two small systems in 3.4 hours and its profit
per unit fell from 1,170 to 770, which is our own volume saturating the system, not time.

Coverage per fresh system should be its top markets by keeper score (perhaps 5 to 8), not every market (HF67 had 20 keepers, HM42
29), or the API budget cannot carry one new system an hour. Build order: the gate, the scouted/staged/live states and a manual
stage/release ops tool first (lead time is entirely the operator's), then the live per-system premium in `freshness.ts`, then an
advisory controller in `keeper_review`, then an automatic clause that ships off.

## Risks

- The API budget is real: at 300 keepers plus traders the limiter was already at 80-88 of 90 calls a minute, with 429s outside
  deploys. Rotation must be budget-neutral (a swap, not an addition), which is why Phase 1 comes before more keepers.
- The fresh-system premium may be partly the same ships being first; the yield curve will say.
- A weekly reset wipes keepers and coverage. The opening has to restart the cycle: tour, first keepers on the markets routes
  use, then expand once cash passes about 1M (see "Keepers: start minimal" in `reset-opening-playbook.md`).
