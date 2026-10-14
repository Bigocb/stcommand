-- Every warp and gate jump the engine makes, kept durably so "how much is this ship warping versus taking gates" can be
-- answered after a restart. The log buffer and the activity feed both forget; the ledger has jumps but not warps.
--
-- Tenant-scoped like every other table here (ENABLE/FORCE ROW LEVEL SECURITY + tenant_isolation). Kept across the weekly
-- reset, like the ledger: universe_key says which week a row belongs to.
CREATE TABLE IF NOT EXISTS ship_movements (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  universe_key  text,
  at            timestamptz NOT NULL,
  ship_symbol   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('warp', 'jump')),
  from_waypoint text NOT NULL,
  to_waypoint   text NOT NULL,
  distance      real,          -- galaxy units between the two systems (warps; null for jumps)
  fuel_before   integer,       -- tank before the move
  fuel_after    integer,       -- tank after the move (the warp's real fuel cost is fuel_before - fuel_after)
  cost          integer,       -- credits paid (jump fee; null for warps)
  source        text           -- trader | tour | fleet: which engine path made the move
);
ALTER TABLE ship_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_movements FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'ship_movements' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON ship_movements USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_ship_movements_tenant_at ON ship_movements (tenant_id, at DESC);
