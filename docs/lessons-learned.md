# Lessons learned

The durable, week-over-week lessons from playing the fleet, so the same mistake is not made twice. Each one has what happened,
why, what it cost, and the rule it leaves. The week journals (`docs/journal/`) hold the detail; this file holds the lesson.
Started 2026-11-18 on the operator's request ("maybe we even start a lessons learned document").

Add an entry when a week's journal shows a mistake with a real cost, or when the operator says "put this in lessons learned".
Newest first. Where a lesson became a rule, say where the rule lives (CLAUDE.md, the opening playbook, a doctrine clause).

---

## 2026-11-19: wrong route numbers, three or four times in two days

**What happened.** Route advice was given from the work list's `profitPerTrip` without checking it against the ship that would fly
it: THEO-7 GOLD (225-hold figure for an 80-hold ship 3 jumps away, sold at -8.6k); THEO-33 widened for a one-run ANTIMATTER route
and pulled onto the 858k contract slot 5 jumps away (#53); the FOOD contract bought at ~2x the price one jump from delivery (#54);
ANTIMATTER AB12 -> XS51 listed at 160k while the dispatcher valued it at 15k for THEO-A7 (a units bug in `scoreItem`).

**Why.** The list prices a route at the biggest hold in the fleet and today's cash, before positioning jumps and before the sell
market's depth. A ship's own value is different, and the dispatcher's reasons say why; they were not read first.

**Cost.** Direct losses of ~10k, ~250k overpaid on FOOD, and hours of idle hulls and operator trust.

**Rule.** CLAUDE.md, "Checking a route before quoting it or acting on it (MANDATORY, every time)": the ship's own value from
dispatch_explain and the `dispatch match ... worth` log, units it can afford, counted jumps, fresh prices on both sides, side effects
of widening reach, and the net written out as a line per ship. No number when an input is missing.


## 2026-11-18: the domino week: fresh systems stop, margins thin, a big buy on a thin wallet, then jump fees eat the profit

**Week:** 2026-11-15 (agent THEO). The gate opened at about hour 34, 13 hours earlier than the week before, and by hour 60 the
week was 2.2x ahead of the last one (21.9M against 9.4M matched profit). By 03:00 on 11-18 wallet plus holds was under 1M and
the fleet was losing money every hour. Journal: `docs/journal/2026-11-08.md`, "Week of 2026-11-15: bugs and difficulties so far".

**The chain:**
1. **Fresh systems stopped.** After the 13:44 deploy on 11-17 the tour ships stopped pricing the staged queue (the module's
   sent marks lived in memory, so after the restart every tour ship counted as "the operator's own trip"; then tour ships in flight
   were skipped). Nothing opened after X1-PN45 at 22:30 until X1-RS9 at 01:30.
2. **Margins thinned.** Without new systems the best local routes decayed: the top trips paid 43-54k at 19:00 and 17-25k by
   23:00; profit fell to about 290k an hour against 600k+ earlier that day.
3. **A second big hull was bought into the thin margins.** The operator bought heavy freighters by hand at 19:24 (THEO-A1,
   2,240,596c, wallet about 3.20M to 957k) and 22:11 (THEO-A7, 2,303,936c, wallet about 2.93M to 625k). The standing rules were
   no hull under a 3M wallet and big hulls only over 10M. The hulls themselves earned well (A1 about 940k matched in its first
   hour; the two heavies were the only traders clearly covering their jumps overnight). The wallet did not survive it: a heavy's
   load costs 300-400k, so 625k could be emptied by the two heavies alone. The wallet fell to 95k at 01:37.
4. **The fix came back as a cost.** Once tours ran again, RS9, PD3, TA36 and TU72 opened between 01:30 and 02:46, but far apart.
   With `positioningHops` 10 every trader crossed 5-10 gates to reach them, the 40-unit shuttles included: 80 jumps an hour, about
   486k in fees, against 232k matched profit. THEO-1 (40 cargo) made 29 jumps (about 175k) for 22k profit in two hours.
5. **No cushion to absorb it.** With about 600k there was no room to buy tour ships for the four staged systems still waiting,
   approve keepers beyond the cheapest, or keep every trader fully loaded. Wallet plus holds went from about 1.19M (01:13) to
   about 845k (03:13).

**What it cost:** about 6 hours in which the week fell from 2.2x ahead of the last one to behind it on the 6-hour rate (1.54M
against 1.87M), and wallet plus holds roughly halved after adding back the hulls.

**The lessons:**
- **A big hull needs working capital, not just its price.** After buying one, keep at least (big hulls x one full load, about
  400k) plus about 100k per other trader, about 2M for a 12-trader fleet, on top of the 3M purchase rule. A second big hull waits
  until the first has paid back its price in matched profit. Manual buys bypass every doctrine threshold, so this is held by
  hand until the buy warning below exists. (CLAUDE.md, "Cash discipline".)
- **Don't buy into falling margins.** If no system has opened for about 3 hours and profit per sale is falling, the next hull will
  earn less than the last one did. Fix the pipeline first (tours, releases), then buy.
- **Jump fees ate the profit even though routes are scored net of them.** The dispatcher already subtracts each ship's
  positioning jumps in full and scores each hull on its own hold (`routeHoldAware`), yet THEO-1 (40 cargo) made 29 jumps for 22k.
  So the estimates a route was chosen on did not match what the trips made (stale or decaying prices at far markets, or the
  return trip to sell). Until that is understood, small hulls stay local-only (`set_ship_reach system`) and `positioningHops`
  stays low when the live systems are spread out. Check `trip_planned` against `trip_closed` (ops `analysis`) for the night.
- **A fix to one stage can overload the next.** Releasing four far-apart systems in 75 minutes pulled every trader across the
  gates at once. Release far systems at a pace the traders' jump budget can carry.
- **Watch the net, not just matched profit.** Matched profit stayed positive all night while the fleet lost money. The hourly
  report now shows jumps, jump fees and net after jumps and fuel.

**Monitoring and warnings that would have caught it** (proposed 2026-11-18, `docs/economy-alerts-plan.md`): an "economy" alert
in Tower when jump fees exceed matched profit, when no system has opened for N hours with staged systems waiting, or when wallet
plus holds falls two hours running; and a warning on the buy-ship button when the wallet after the buy would fall under the
working-capital floor, or margins are falling.
