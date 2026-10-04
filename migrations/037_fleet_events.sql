-- Durable timeline of what happened to the fleet and when, kept across the
-- weekly reset wipe (like run_results — not tenant-scoped, no RLS, no FK, and
-- never listed in Store.TENANT_GAME_TABLES).
--
-- fleet_events: append-only, one row per event — a ship's role changing
-- (including changes the engine makes by itself, which operator_actions never
-- saw), a ship being bought (any initiator), an approval being requested or
-- decided. Written from the three Store chokepoints (setFleetState,
-- recordLedger type SHIP, create/decideApproval). Recording never blocks or
-- fails the action it describes.
--
-- run_timeline: a sample every ~15 minutes per agent — credits, ship count,
-- roles — so a week can be drawn as a cash/fleet curve. `reset_date` is the
-- game universe (resetDate) the row belongs to, as last handled by the reset
-- watcher, so weeks can be separated and compared.
CREATE TABLE IF NOT EXISTS fleet_events (
  id           bigserial PRIMARY KEY,
  agent_symbol text NOT NULL,
  tenant_id    uuid,
  reset_date   text NOT NULL DEFAULT 'unknown',
  ts           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,   -- role_change | ship_purchased | approval_requested | approval_decided
  ship_symbol  text,
  detail       text NOT NULL,
  meta         jsonb
);
CREATE INDEX IF NOT EXISTS idx_fleet_events_agent_ts ON fleet_events (agent_symbol, ts);
CREATE INDEX IF NOT EXISTS idx_fleet_events_reset ON fleet_events (agent_symbol, reset_date, ts);

CREATE TABLE IF NOT EXISTS run_timeline (
  id           bigserial PRIMARY KEY,
  agent_symbol text NOT NULL,
  tenant_id    uuid,
  reset_date   text NOT NULL DEFAULT 'unknown',
  ts           timestamptz NOT NULL DEFAULT now(),
  credits      bigint,
  ship_count   integer,
  roles        jsonb,
  buys         bigint,          -- the engine's running purchase total at sample time
  sells        bigint
);
CREATE INDEX IF NOT EXISTS idx_run_timeline_agent_ts ON run_timeline (agent_symbol, ts);
