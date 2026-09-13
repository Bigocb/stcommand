-- Play-style tracking: a per-tenant profile label ("baseline" vs "manual
-- override" vs whatever free text the operator wants) plus a durable log of
-- the operator's own deliberate interventions — a role change or a manual
-- ship purchase, the two actions the operator actually named as "overriding
-- automation." Logged at the HTTP route (src/http/dashboard.ts's
-- POST /fleet/role and POST /fleet/buy), not inside FleetManager's shared
-- setShipRole()/buyShip() methods, since the engine's own autonomous code
-- calls those same methods directly and must never show up here as if the
-- operator had done it.
--
-- Deliberately NOT wiped by the reset-cleanup admin tool
-- (Store.TENANT_GAME_TABLES, src/db/store.ts): a reset invalidates ships and
-- market data, not the fact that the operator once converted a ship to
-- trader — same reasoning CLAUDE.md already gives for leaving doctrine and
-- chat_messages alone. A checkpoint/action from a dead universe is still a
-- real historical data point for comparing play styles across resets.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS play_profile text;

CREATE TABLE IF NOT EXISTS operator_actions (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL, -- 'role_change' | 'manual_buy' | 'checkpoint'
  ship_symbol  text,
  detail       text NOT NULL,
  meta         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE operator_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operator_actions USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_operator_actions_tenant_created ON operator_actions (tenant_id, created_at DESC);
