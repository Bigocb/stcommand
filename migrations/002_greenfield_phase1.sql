-- Greenfield Phase 1: market_latest read-model projection.
--
-- market_snapshots is append-only and grows unbounded; every "current price"
-- read (latestMarketSnapshots, freshMarketSnapshots, bestTrades, tradeLegs)
-- did its own ROW_NUMBER() OVER (PARTITION BY waypoint_symbol, good_symbol)
-- scan over the whole history table. This projection is maintained
-- incrementally on every recordMarket() write (one upsert, keyed on the same
-- pair) so those reads become a plain index lookup instead of a full scan
-- that gets slower as history grows.
--
-- No tenant_id, same as market_snapshots itself: this is shared galaxy data,
-- one row per waypoint+good for the whole server reset, not per tenant. See
-- 001_init.sql's "Shared, ungated: public galaxy data" section for why that
-- table has no RLS — the same reasoning applies here unchanged.

SET search_path TO stcommand;

CREATE TABLE IF NOT EXISTS market_latest (
  system_symbol   text NOT NULL,
  waypoint_symbol text NOT NULL,
  good_symbol     text NOT NULL,
  type            text NOT NULL,
  supply          text NOT NULL,
  purchase_price  double precision NOT NULL,
  sell_price      double precision NOT NULL,
  trade_volume    integer NOT NULL,
  timestamp       timestamptz NOT NULL,
  PRIMARY KEY (waypoint_symbol, good_symbol)
);
CREATE INDEX IF NOT EXISTS idx_market_latest_good ON market_latest (good_symbol);
CREATE INDEX IF NOT EXISTS idx_market_latest_system ON market_latest (system_symbol);
