-- Which waypoints are still uncharted, read from the game's public waypoint list. A waypoint nobody has charted shows the single
-- trait UNCHARTED instead of its real traits; charting pays a one-time reward to the first agent to do it (docs/TODO.md, the chart
-- test). The galaxy crawler reads the systems we are in first, then re-reads those that still have uncharted waypoints.
--
-- A fact about the galaxy, not about any tenant: no tenant_id, no row-level policy, wiped at the weekly reset
-- (Store.SHARED_GALAXY_TABLES).
CREATE TABLE IF NOT EXISTS waypoint_charts (
  waypoint_symbol text PRIMARY KEY,
  system_symbol   text NOT NULL,
  waypoint_type   text NOT NULL DEFAULT '',
  uncharted       boolean NOT NULL,
  checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waypoint_charts_system_idx ON waypoint_charts (system_symbol);
CREATE INDEX IF NOT EXISTS waypoint_charts_uncharted_idx ON waypoint_charts (system_symbol) WHERE uncharted;
