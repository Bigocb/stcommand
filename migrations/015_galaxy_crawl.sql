-- Extends galaxy_systems (011_galaxy_topology.sql) with system-level metadata
-- (sector, star type, x/y) that a background galaxy-wide crawl can fill in
-- for systems no tenant has ever flown to -- the existing table only ever
-- got a row once some tenant's own GalaxyAtlas.loadSystem() visited that
-- system, and only ever stored its waypoints/jump-gates, never the system
-- object itself (type/x/y come from a separate GET /systems{,/{symbol}}
-- call). All nullable: a crawled-but-not-yet-waypoint-scanned system has
-- metadata but no waypoints/jump_gates yet, and vice versa for the
-- reactive per-tenant path this table already served before this crawl
-- existed.
ALTER TABLE galaxy_systems ADD COLUMN IF NOT EXISTS sector_symbol text;
ALTER TABLE galaxy_systems ADD COLUMN IF NOT EXISTS system_type text;
ALTER TABLE galaxy_systems ADD COLUMN IF NOT EXISTS x integer;
ALTER TABLE galaxy_systems ADD COLUMN IF NOT EXISTS y integer;

-- Public, tenant-agnostic reference data, same pattern as galaxy_systems --
-- no tenant_id, no RLS. Small (a couple dozen factions per reset), crawled
-- in one pass via GET /factions.
CREATE TABLE IF NOT EXISTS galaxy_factions (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  headquarters text,
  is_recruiting boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Generic resumable-cursor storage for background crawl jobs (currently
-- just the galaxy-wide systems crawl) -- a restart must not restart the
-- crawl from page 1 against a galaxy that can hold tens of thousands of
-- systems.
CREATE TABLE IF NOT EXISTS galaxy_crawl_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
