-- Operator approval gate: a consequential, engine-initiated decision (right
-- now: an autonomous ship purchase) proposes itself here and waits rather
-- than executing outright. FleetManager re-checks the open row on its own
-- normal tick cadence (see ApprovalGate.request(), src/engine/approvals.ts)
-- instead of blocking in memory — the engine restarts on every deploy, so
-- anything held only in a live await would be lost and silently re-decided
-- from scratch. Same tenant-scoped/RLS shape as held_route/doctrine_fires.
--
-- One open (`status = 'pending'`) row per (tenant_id, kind) at a time by
-- convention (enforced in application code, not a DB constraint, since a
-- partial unique index on status would need a fixed status value baked in
-- and Postgres partial-unique-on-literal is more friction than the
-- single-caller access pattern here actually needs).

CREATE TABLE IF NOT EXISTS pending_approvals (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  ship_symbol  text,
  detail       text NOT NULL,
  cost         numeric,
  status       text NOT NULL DEFAULT 'pending',
  -- False until ApprovalGate has actually acted on the outcome once (an
  -- operator decision sets `status` immediately on click, but the engine
  -- only sees it on its own next poll) — without this, a decided-but-not-
  -- yet-polled row would look identical to a brand-new request and
  -- ApprovalGate would just create a second one instead of consuming it.
  consumed     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  decided_at   timestamptz,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_approvals USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_tenant ON pending_approvals (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_tenant_kind_status ON pending_approvals (tenant_id, kind, status);
