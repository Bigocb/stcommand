-- Greenfield Phase 4: ship_claims — one row per ship recording who currently
-- owns it, per src/engine/shipRegistry.ts. Tenant-scoped, same RLS shape as
-- ship_state and ship_manifest.

-- No `SET search_path` here: src/db/pool.ts sets it per connection from
-- DB_SCHEMA, so this file applies to whichever schema the migration run
-- targets (production `stcommand`, or the test schema).

CREATE TABLE IF NOT EXISTS ship_claims (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol text NOT NULL,
  owner       text NOT NULL, -- operator | mission | warehouse | keeper | auto
  role        text NOT NULL,
  intent      jsonb NOT NULL DEFAULT '{}'::jsonb,
  since       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol)
);
ALTER TABLE ship_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_claims USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_ship_claims_tenant ON ship_claims (tenant_id);
