-- Supports goodPriceHistory()'s new forward-fill path for the "All markets"
-- combined price chart: for each minute bucket, find the latest snapshot at
-- or before that minute, per waypoint
-- (`... WHERE waypoint_symbol = $1 AND good_symbol = $2 AND timestamp <= $3
-- ORDER BY timestamp DESC LIMIT 1`). The existing idx_snap_waypoint_good
-- index has no timestamp component, so that lookup fell back to a sort of
-- every matching row instead of an index-ordered scan. This composite index
-- lets Postgres walk straight to the answer.
CREATE INDEX IF NOT EXISTS idx_snap_wp_good_ts ON market_snapshots (waypoint_symbol, good_symbol, timestamp DESC);
