-- Two per-tenant ledgers of explorer state that used to live only in memory.
-- See docs/system-survey-persistence-design.md.
--
--   system_surveys — systems whose markets an explorer has actually swept.
--                    NOT a claim that every waypoint is charted; that is
--                    scoutExhaustedSystems' job (fleet.ts:519).
--   tour_queue     — the unvisited stops of a tour interrupted by a
--                    cooldown/transit signal, so a restart does not orphan it.
--
-- Both are a row per thing rather than a fleet_flags jsonb blob. The blob
-- shape (chartedSystems) is last-writer-wins across overlapping processes,
-- which markSystemCharted() has to work around with a read-union-write
-- (fleet.ts:2192) — that race once erased a system whose survey data was in
-- the database the whole time. Rows cannot lose each other.
--
-- Policies use current_setting(..., true) like every other tenant table: a
-- missing GUC yields "no rows" rather than an error.
--
-- Both tables are in Store.TENANT_GAME_TABLES: a universe reset changes every
-- system and waypoint symbol, so a surviving row would name places that no
-- longer exist.

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS system_surveys (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    system_symbol   text NOT NULL,
    surveyed_at     timestamptz NOT NULL DEFAULT now(),
    markets_found   integer NOT NULL DEFAULT 0,
    shipyards_found integer NOT NULL DEFAULT 0,
    -- Why the mark exists: survey | tour | explore | scout. Persisting makes a
    -- mislabelled mark durable, so it has to be auditable.
    source          text NOT NULL DEFAULT 'survey',
    PRIMARY KEY (tenant_id, system_symbol)
  );

  CREATE TABLE IF NOT EXISTS tour_queue (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ship_symbol   text NOT NULL,
    system_symbol text NOT NULL,
    -- [{ "symbol": "...", "market": true, "yard": false }, ...] — fleet.ts's
    -- TourStop. Flags are stored, not re-derived: they come from each
    -- waypoint's traits, and a resume must not depend on the atlas still
    -- holding them.
    stops         jsonb NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One row per ship, not per ship-and-system: a hull tours one system at a
    -- time, and the resume path already matches on (ship, system).
    PRIMARY KEY (tenant_id, ship_symbol)
  );

  ALTER TABLE system_surveys ENABLE ROW LEVEL SECURITY;
  ALTER TABLE system_surveys FORCE ROW LEVEL SECURITY;
  ALTER TABLE tour_queue ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tour_queue FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation_system_surveys ON system_surveys;
  CREATE POLICY tenant_isolation_system_surveys ON system_surveys
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

  DROP POLICY IF EXISTS tenant_isolation_tour_queue ON tour_queue;
  CREATE POLICY tenant_isolation_tour_queue ON tour_queue
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

  -- The boot read is "this tenant's rows newer than the TTL window"; the audit
  -- read is "newest first".
  CREATE INDEX IF NOT EXISTS idx_system_surveys_tenant_ts
    ON system_surveys (tenant_id, surveyed_at DESC);
END $$;
