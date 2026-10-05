-- The game reports an `activity` level per market good (WEAK | GROWING | STRONG | RESTRICTED):
-- for an export it is how close production is to its maximum, for an import how close
-- consumption is. It was always in the API response and never stored. Without it there is
-- no way to tell why one market regenerates stock faster than another, which is the
-- unknown behind the gate-material price problem (docs/TODO.md). Nullable: rows recorded
-- before this migration have no value.
ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS activity text;
ALTER TABLE market_latest ADD COLUMN IF NOT EXISTS activity text;
