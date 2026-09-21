-- A SELL row's own `total` is gross sale proceeds — fine for wallet-delta
-- accounting (ledgerTotals/netSeries), but useless for "is trading actually
-- profitable": a window that catches a buy with no matching sell yet reads
-- as a heavy loss even though the position is still open, and summing gross
-- sells vs gross buys over a short window makes real trading look flat or
-- negative purely from timing (confirmed live 2026-09-21 — see this
-- session's operator P&L walkthrough in CLAUDE.md's own "Reporting matched
-- buy/sell P&L" section, done by hand from activity logs each time).
--
-- TraderAgent already computes the right number for every SELL it makes —
-- proceeds minus that ship's own cost basis for the lot (see trader.ts's
-- `delta = totalReceived - paid`, sourced from `heldCost`, persisted
-- restart-safe in held_route) — it just never left the log line. This
-- column gives it a durable home: populated only for a SELL where a real
-- cost basis was tracked (ordinary arbitrage trades), left NULL for
-- everything else (PURCHASE/REFUEL/SHIP/OTHER rows, and a SELL with no
-- tracked cost basis, e.g. mined/siphoned cargo that was never bought) —
-- NULL means "no matched-trade number applies here", not zero.

ALTER TABLE ledger ADD COLUMN IF NOT EXISTS realized_pnl double precision;
