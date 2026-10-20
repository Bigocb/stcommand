-- Kept across the weekly reset on purpose: the point is to carry the opening into the next universe.
--
-- Two invariants the engine depends on:
--   * (tenant_id, task_key) is unique — Store.addOpeningTask upserts with
--     ON CONFLICT (tenant_id, task_key), which needs a real unique index.
--   * created_by has a default — the insert path is shared by the operator UI,
--     the co-pilot and MCP, and only some of those know who is acting.
-- Policies use current_setting(..., true) like every other tenant table: a
-- missing GUC yields "no rows" rather than an error.

DO $$
BEGIN
    CREATE TABLE IF NOT EXISTS opening_tasks (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_key         text NOT NULL,
      name             text NOT NULL,
      trigger_spec     jsonb NOT NULL,
      steps            jsonb NOT NULL,
      status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','done','failed','needs_review','cancelled')),
      step_index       integer NOT NULL DEFAULT 0,
      step_phase       text NOT NULL DEFAULT 'idle' CHECK (step_phase IN ('idle','started')),
      refs             jsonb NOT NULL DEFAULT '{}'::jsonb,
      queued_under_key text,
      universe_key     text,
      created_by       text NOT NULL DEFAULT 'operator',
      note             text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS opening_templates (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name       text NOT NULL,
      tasks      jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, name)
    );

    -- Idempotent: this file may be re-run against a database that already has
    -- the table from an earlier attempt at 055.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'opening_tasks_tenant_key_uniq'
         AND conrelid = 'opening_tasks'::regclass
    ) THEN
      ALTER TABLE opening_tasks ADD CONSTRAINT opening_tasks_tenant_key_uniq UNIQUE (tenant_id, task_key);
    END IF;

    ALTER TABLE opening_tasks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE opening_tasks FORCE ROW LEVEL SECURITY;
    ALTER TABLE opening_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE opening_templates FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS tenant_isolation_tasks ON opening_tasks;
    CREATE POLICY tenant_isolation_tasks ON opening_tasks
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

    DROP POLICY IF EXISTS tenant_isolation_templates ON opening_templates;
    CREATE POLICY tenant_isolation_templates ON opening_templates
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

    CREATE INDEX IF NOT EXISTS idx_opening_tasks_tenant_status ON opening_tasks (tenant_id, status, created_at);
END $$;
