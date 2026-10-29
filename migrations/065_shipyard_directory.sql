-- Which hull types each shipyard lists, read remotely. Like a market's goods lists (064), the game gives anyone a yard's list of
-- ship types without a ship at the waypoint; only the stock, prices and ships need a ship docked. This is how to know whether a
-- yard sells probes (a keeper hull) before anything of ours has been there.
--
-- A fact about the galaxy, not about any tenant: no tenant_id, no row-level policy, wiped at the weekly reset
-- (Store.SHARED_GALAXY_TABLES).
CREATE TABLE IF NOT EXISTS shipyard_directory (
  waypoint_symbol text PRIMARY KEY,
  system_symbol   text NOT NULL,
  ship_types      text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipyard_directory_system_idx ON shipyard_directory (system_symbol);
