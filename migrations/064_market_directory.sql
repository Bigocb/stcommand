-- What each market trades, read remotely: the game tells anyone, with no ship at the waypoint, which goods a marketplace
-- imports, exports and exchanges (only its prices and supply need a ship present). The explorer's survey reads these for every
-- market in a system, so the number of goods and each market's role can pick where keepers go before any ship has stood there.
-- Until now they lived only in the in-memory snapshot and were lost at a restart.
--
-- A fact about the galaxy, not about any tenant: no tenant_id and no row-level policy, and wiped at the weekly reset
-- (Store.SHARED_GALAXY_TABLES) like market_latest.
CREATE TABLE IF NOT EXISTS market_directory (
  waypoint_symbol text PRIMARY KEY,
  system_symbol   text NOT NULL,
  imports         text[] NOT NULL DEFAULT '{}',
  exports         text[] NOT NULL DEFAULT '{}',
  exchange        text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_directory_system_idx ON market_directory (system_symbol);
