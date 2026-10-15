-- The season plan (docs/multi-week-plan.md): a plan that spans several weekly universes.
--
-- seasons: one active season per tenant (ended_at null), started by the operator.
-- season_weeks: one row per week of a season: the phase it is in, its goals (with status), notes, and at close the
-- record the next week starts from (phase, goal results, the week's numbers, and the saved analysis report's id).
--
-- Kept across the weekly reset on purpose, like the ledger: the whole point is to carry the plan from one universe to
-- the next. universe_key says which week a row was played in. Tenant-scoped (RLS), like every tenant table.
CREATE TABLE IF NOT EXISTS seasons (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  notes       text
);
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'seasons' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON seasons USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_seasons_tenant_started ON seasons (tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS season_weeks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  season_id    bigint NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  week_no      integer NOT NULL,
  universe_key text,
  phase        text NOT NULL,
  goals        jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes        text,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  record       jsonb,          -- at close: phase, goal results and the week's numbers; the next week starts from it
  findings_id  bigint          -- the analysis_findings row saved at close
);
ALTER TABLE season_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_weeks FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'season_weeks' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON season_weeks USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_season_weeks_no ON season_weeks (tenant_id, season_id, week_no);
