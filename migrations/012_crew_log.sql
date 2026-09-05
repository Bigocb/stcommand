-- Crew log: per-hull captain's entries, and which persona writes them.
--
-- Strictly narrative. Nothing in either table is read by the engine's
-- routing, trading or doctrine decisions — see src/engine/personas.ts for
-- why that line is drawn and kept.
--
-- No `SET search_path` here: src/db/pool.ts sets it per connection from
-- DB_SCHEMA, so this applies to whichever schema the migration run targets.

-- A hull's assigned captain. Rows exist only where an operator has chosen
-- one; personas.ts derives a stable default from the ship symbol otherwise,
-- so a fleet has a cast the first time this is switched on with no backfill.
CREATE TABLE IF NOT EXISTS ship_persona (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol text NOT NULL,
  persona_key text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol)
);
ALTER TABLE ship_persona ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_persona FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_persona USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_ship_persona_tenant ON ship_persona (tenant_id);

-- The feed itself.
--
-- `entry` is nullable on purpose. A row with a null entry is an event that
-- earned a log and did not get one — either because the budget was spent, or
-- because generation is switched off. That is what makes the rate
-- observable before a single token is spent: the triggers can run for days
-- writing candidates, and the answer to "how often would this fire, and
-- about what" is a query rather than an estimate.
CREATE TABLE IF NOT EXISTS ship_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol  text NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  persona_key  text NOT NULL,
  trigger_kind text NOT NULL,
  notability   int NOT NULL,
  -- The ground truth the entry must be about. Kept even once an entry is
  -- written, so a log line can always be traced to the event that earned it.
  detail       text NOT NULL,
  entry        text
);
ALTER TABLE ship_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ship_log USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_ship_log_tenant_ts ON ship_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ship_log_tenant_ship ON ship_log (tenant_id, ship_symbol, ts DESC);
