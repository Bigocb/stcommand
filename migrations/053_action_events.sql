-- Action tracking for the analysis engine (docs/analysis-engine.md).
--
-- action_events: one row per decision or change, with what the bot expected at the time and, later, what happened.
-- A trip's trip_planned and trip_closed rows share a correlation_id. A settings change is a config_change row with the
-- before and after values in context. Kept across the weekly reset, like the ledger: universe_key says which week.
--
-- analysis_findings: a saved copy of an analysis report, so a week's lessons survive the wipe of the shared market
-- tables at a reset and can be compared week to week.
--
-- Both are tenant-scoped (ENABLE/FORCE ROW LEVEL SECURITY + tenant_isolation), like every other tenant table.
CREATE TABLE IF NOT EXISTS action_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  universe_key    text,
  at              timestamptz NOT NULL,
  kind            text NOT NULL,          -- trip_planned | trip_closed | config_change | ...
  actor           text NOT NULL,          -- engine | operator | mcp
  ship_symbol     text,
  good            text,
  waypoint        text,
  correlation_id  text,                   -- links the events of one decision (a trip's planned and closed rows)
  subject         text,                   -- route "A>B", or a setting "doctrine:maxLotsPerTrip"
  expected        jsonb,                  -- what was predicted at decision time
  observed        jsonb,                  -- what actually happened
  context         jsonb,                  -- values in force (trade volumes, lot size, before/after of a change)
  reason          text
);
ALTER TABLE action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_events FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'action_events' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON action_events USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_action_events_tenant_at ON action_events (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_action_events_tenant_kind_at ON action_events (tenant_id, kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_action_events_correlation ON action_events (tenant_id, correlation_id);

CREATE TABLE IF NOT EXISTS analysis_findings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  universe_key    text,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  label           text,                   -- e.g. "end of week", or an operator note
  report          jsonb NOT NULL          -- the full report as the ops analysis tool returned it
);
ALTER TABLE analysis_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_findings FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'analysis_findings' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON analysis_findings USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_analysis_findings_tenant_captured ON analysis_findings (tenant_id, captured_at DESC);
