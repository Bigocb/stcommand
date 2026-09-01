-- Cache for system waypoints + jump-gate connections, the same public-galaxy-
-- data pattern as market_snapshots/shipyard_inventory (no tenant_id, no RLS —
-- see store.ts's own comment on why those three tables are exempt). Static
-- for the life of a server reset, so no staleness column: unlike market
-- prices, a waypoint's position/traits and a jump gate's connections don't
-- change on their own between resets.
--
-- Before this, GalaxyAtlas.loadSystem() re-fetched a system's waypoints live
-- from the SpaceTraders API on every single boot, for every tenant, even
-- though that data almost never changes — confirmed as one of the main
-- contributors to slow multi-tenant startup and boot-time rate-limit
-- pressure.
CREATE TABLE IF NOT EXISTS galaxy_systems (
  system_symbol text PRIMARY KEY,
  waypoints jsonb NOT NULL,
  jump_gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanned_at timestamptz NOT NULL DEFAULT now()
);
