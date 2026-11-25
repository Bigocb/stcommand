# Unpriced tour-only markets: tracking from 2026-11-25 16:40 UTC

Operator rule (2026-11-25): no market we rely on should carry a price older than 90 minutes. Baseline from the full sweep of the
78 live systems plus AR36 (journal 2026-11-25 16:50). Markets with 6+ goods and no keeper, stale or never priced. Each hourly report
re-reads freshness for these systems and updates the "Now" column: **covered** (keeper or loop keeper reads it) and **priced** (newest
snapshot under 90 min). A market is done when it has been under 90 minutes in two hourlies running.

Fixes in place: keeperTourPlan 3 (loop keepers, 16:50), tours THEO-2A -> AR36 and THEO-48 -> MG38 (16:52), keeperCoverSystems and
keeperPlanLoopBuy (28375f9, 17:03; clause on at the 17:15 check).

| System | Market | Goods | Age at baseline | Now |
|---|---|---|---|---|
| AR36 | J61 | 15 | 37.8 h | |
| AR36 | K86 | 10 | 38.7 h | |
| AR36 | E47 | 8 | 38.7 h | |
| AR36 | D39 | 7 | 39.0 h | |
| XV54 | E50 | 8 | never | |
| XV54 | E49 | 6 | never | |
| XV54 | G53 | 6 | never | |
| XV54 | K90 | 6 | never | |
| XV54 | F51 | 6 | 40.8 h | |
| XV54 | H57 | 6 | 40.9 h | |
| XN55 | K78 | 10 | never | |
| XN55 | E45 | 8 | never | |
| XN55 | H49 | 8 | never | |
| XN55 | F46 | 6 | never | |
| XN55 | G48 | 6 | never | |
| XN55 | H52 | 6 | never | |
| MG38 | G55 | 6 | 17.3 h | |
| MG38 | F50 | 6 | 17.8 h | |
| MG38 | F54 | 6 | 18.1 h | |
| MG38 | H60 | 6 | 18.2 h | |
| CJ53 | F50 | 6 | 46.0 h | |
| CJ53 | E48 | 6 | 46.1 h | |
| CJ53 | G53 | 6 | 46.2 h | |
| CJ53 | H57 | 6 | 46.3 h | |
| GQ73 | F12C | 6 | 35.3 h | |
| CC63 | ED5A | 6 | 20.8 h | |
| FB58 | F15A | 6 | 44.4 h | |
| FZ79 | CD1D | 6 | 20.1 h | |
| MD23 | B19D | 6 | 36.8 h | |
| MD23 | C14B | 6 | 37.3 h | |
| MJ27 | F11F | 6 | 39.0 h | |
| MM90 | BD5C | 6 | 11.6 h | |
| TR21 | F54 | 6 | 9.4 h | |
| TR21 | G56 | 6 | 9.5 h | |
| UF92 | F12C | 6 | 23.0 h | |
| XC59 | B12Z | 6 | 1.9 h | |
| CT21 | B18F | 8 | never | |
| CT21 | C11C | 6 | never | |
| DG35 | A13A | 6 | never | |
| DG35 | E22Z | 6 | never | |
| HD38 | AD8F | 6 | never | |
| PX72 | C26Z | 6 | never | |
| VY66 | E44 | 8 | 84 min (aging) | |
| VY66 | F45 | 6 | 64 min (aging) | |
| VY66 | G51 | 6 | 76 min (aging) | |
| VY66 | H55 | 6 | 79 min (aging) | |

Totals at baseline: 46 tracked (26 stale, 16 never priced, 4 aging); 0 priced under 90 min.
