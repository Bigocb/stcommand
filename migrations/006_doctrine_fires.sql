-- Greenfield Phase 5-6: doctrine_fires — tracks doctrine rule firings for
-- instrumentation in the dashboard.

SET search_path TO stcommand;

CREATE TABLE IF NOT EXISTS doctrine_fires (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_key   text NOT NULL,
  fire_count integer NOT NULL DEFAULT 0,
  last_fired timestamptz,
  PRIMARY KEY (tenant_id, rule_key)
);
ALTER TABLE doctrine_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctrine_fires FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doctrine_fires USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_doctrine_fires_tenant ON doctrine_fires (tenant_id);
