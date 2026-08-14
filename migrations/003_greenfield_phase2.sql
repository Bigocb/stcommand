-- Greenfield Phase 2: persisted ship state.
--
-- Tenant-scoped, unlike market_latest — this is per-fleet data, not shared
-- galaxy data, so it gets the same ENABLE/FORCE ROW LEVEL SECURITY +
-- tenant_isolation policy as every other tenant-scoped table in
-- 001_init.sql. Written by hand here rather than re-running
-- apply_tenant_rls() (which loops over every tenant_id-having table in the
-- schema and does a bare CREATE POLICY): re-running it against tables that
-- migration already ran RLS setup for would fail with "policy already
-- exists" the moment there's more than one migration file. Scoped to just
-- the table this migration adds instead.

SET search_path TO stcommand;

CREATE TABLE IF NOT EXISTS ship_state (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol text NOT NULL,
  state       text NOT NULL, -- idle | assigned | travelling | docked
  target      text,          -- waypoint this state is heading toward, if any
  step        jsonb,         -- reserved for a future per-agent sub-step; unused by Phase 2
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol)
);
ALTER TABLE ship_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_state USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_ship_state_tenant ON ship_state (tenant_id);
