-- Operator's own scratchpad: free-text log entries/notes-to-self ("what I
-- want to do next", a reminder, a running log), persisted across sessions
-- and deploys. Same reasoning as operator_actions (019) and CLAUDE.md's own
-- note on doctrine/chat_messages: this is the operator's own durable record,
-- not game state, so it's deliberately absent from Store.TENANT_GAME_TABLES
-- (src/db/store.ts) — a server reset invalidates ships and markets, not the
-- fact that the operator wrote themselves a note last Tuesday.

CREATE TABLE IF NOT EXISTS operator_notes (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE operator_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operator_notes USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_operator_notes_tenant_created ON operator_notes (tenant_id, created_at DESC);
