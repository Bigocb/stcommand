-- Field & Book: ship_position_history — periodic position samples per ship,
-- so the replay scrubber can play back real fleet movement instead of
-- interpolated guesswork. Recorded once per state-refresh cycle
-- (tenantRegistry.ts's refreshState(), every STATE_REFRESH_MS).

SET search_path TO stcommand;

CREATE TABLE IF NOT EXISTS ship_position_history (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol     text NOT NULL,
  timestamp       timestamptz NOT NULL DEFAULT now(),
  waypoint_symbol text NOT NULL,
  x               integer NOT NULL,
  y               integer NOT NULL,
  status          text NOT NULL
);
ALTER TABLE ship_position_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_position_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_position_history USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_ship_position_history_tenant_time ON ship_position_history (tenant_id, timestamp);

-- Doctrine per-ship fire attribution: a real event log (one row per firing),
-- distinct from doctrine_fires' aggregate counter — this is what lets Book
-- mode's clause hover highlight the actual hulls a rule governed, not just a
-- count. doctrine_fires stays as the fast summary the gutter already reads.
CREATE TABLE IF NOT EXISTS doctrine_fire_log (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_key    text NOT NULL,
  ship_symbol text NOT NULL,
  fired_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE doctrine_fire_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctrine_fire_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doctrine_fire_log USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_doctrine_fire_log_tenant_rule_time ON doctrine_fire_log (tenant_id, rule_key, fired_at);
