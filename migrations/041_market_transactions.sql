-- Every agent's recent trades at a market, as the game returns them in GET .../market (`transactions`, visible
-- while one of our ships is at the market). Shared galaxy data, like market_latest: a fact about the market, not
-- about any one tenant. This is the only direct view of other players' buying and of real executed prices.
CREATE TABLE IF NOT EXISTS market_transactions (
  id bigserial PRIMARY KEY,
  system_symbol text NOT NULL,
  waypoint_symbol text NOT NULL,
  ship_symbol text NOT NULL,
  trade_symbol text NOT NULL,
  type text NOT NULL,
  units integer NOT NULL,
  price_per_unit integer NOT NULL,
  total_price integer NOT NULL,
  timestamp timestamptz NOT NULL,
  UNIQUE (waypoint_symbol, ship_symbol, trade_symbol, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_market_tx_wp_good_ts ON market_transactions (waypoint_symbol, trade_symbol, timestamp DESC);
