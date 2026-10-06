-- Every survey batch any of our ships took at an asteroid: which deposits it listed. Waypoint traits only say
-- "common metal deposits"; what a field actually yields (and how much iron) is only visible in surveys, so tally
-- them here. Shared galaxy data like market_transactions: a fact about the field, wiped on a server reset.
CREATE TABLE IF NOT EXISTS field_surveys (
  signature text PRIMARY KEY,
  system_symbol text NOT NULL,
  waypoint_symbol text NOT NULL,
  size text,
  deposits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_field_surveys_wp_ts ON field_surveys (waypoint_symbol, created_at DESC);
