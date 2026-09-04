-- Greenfield Phase 3: cargo manifest — intent-tagged cargo holds.
--
-- Tenant-scoped, same RLS shape as ship_state (003). One row per
-- (tenant, ship, good) actually held right now; FleetManager.syncShipManifests
-- reconciles it against each ship's real cargo every coordinator tick, same
-- cadence as ship_state.

-- No `SET search_path` here: src/db/pool.ts sets it per connection from
-- DB_SCHEMA, so this file applies to whichever schema the migration run
-- targets (production `stcommand`, or the test schema).

CREATE TABLE IF NOT EXISTS ship_manifest (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol text NOT NULL,
  good_symbol text NOT NULL,
  units       integer NOT NULL CHECK (units > 0),
  cost_basis  double precision NOT NULL,
  basis_kind  text NOT NULL, -- 'actual' (from this ship's own last purchase) | 'estimated' (fleet-wide average, or 0 if neither known)
  intent      text NOT NULL, -- 'resale' | 'warehouse-deposit' — see README's Greenfield section for why 'mission-delivery'/'held-position' aren't assigned yet
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol, good_symbol)
);
ALTER TABLE ship_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_manifest USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_ship_manifest_tenant ON ship_manifest (tenant_id);
