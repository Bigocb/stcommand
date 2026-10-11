-- Every answer the decision model gave (src/engine/judge.ts), kept so its confidence can be checked against what happened.
-- The vendor's speed, cost and accuracy figures are its own and its architecture is unpublished, so before anything acts on
-- these answers we measure them ourselves: this table is that evidence. One row per answered question.
--
-- Tenant-scoped like every other table here (ENABLE/FORCE ROW LEVEL SECURITY + tenant_isolation, written by hand as in
-- 003_greenfield_phase2.sql rather than re-running apply_tenant_rls()). Deliberately NOT in Store.TENANT_GAME_TABLES: it
-- describes the model, not the universe, so it survives the weekly wipe and calibration accumulates across weeks.
CREATE TABLE IF NOT EXISTS judge_decisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  feature       text NOT NULL,          -- router | attention
  subject       text NOT NULL,          -- a ship symbol, or the captain's message with secrets redacted
  question      text NOT NULL,
  answer        jsonb NOT NULL,         -- the model's answer exactly as returned
  confidence    real,
  state         jsonb,                  -- what was sent, so a decision can be replayed
  model         text,
  input_tokens  integer,
  latency_ms    integer,
  acted         boolean NOT NULL DEFAULT false,  -- true only when it changed what the engine did
  note          text,
  outcome       text                    -- filled in later, when what actually happened is known
);
ALTER TABLE judge_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE judge_decisions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'judge_decisions' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON judge_decisions USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_judge_decisions_tenant_feature_at ON judge_decisions (tenant_id, feature, at DESC);
