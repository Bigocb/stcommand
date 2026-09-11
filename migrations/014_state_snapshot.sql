-- Durable copy of each tenant's last-successfully-refreshed FleetSnapshot
-- (the exact shape /api/state returns). Written every refresh cycle
-- (tenantRegistry.ts's refreshState()) so that when a tenant's live boot
-- fails — a SpaceTraders outage, a bad token — /api/state can still answer
-- with the last known ship register instead of a bare 503, marked stale.
--
-- One row per tenant, overwritten in place: this is a cache of "the last
-- good answer," not a history, so there's nothing to keep beyond the most
-- recent snapshot.

CREATE TABLE IF NOT EXISTS state_snapshot (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE state_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON state_snapshot USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
