-- Kept across the weekly reset on purpose: the point is to carry the opening into the next universe.

DO $$ 
BEGIN
    CREATE TABLE IF NOT EXISTS opening_tasks (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_key         text NOT NULL,
      name             text NOT NULL,
      trigger_spec     jsonb NOT NULL,
      steps            jsonb NOT NULL,
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('queued','active','done','failed','needs_review','cancelled')),
      step_index       integer NOT NULL DEFAULT 0,
      step_phase       text NOT NULL DEFAULT 'idle' CHECK (step_phase IN ('idle','started')),
      refs             jsonb NOT NULL DEFAULT '{}'::jsonb,
      queued_under_key text,
      universe_key     text,
      created_by       text NOT NULL,
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

    ALTER TABLE opening_tasks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE opening_tasks FORCE ROW LEVEL SECURITY;
    ALTER TABLE opening_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE opening_templates FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS tenant_isolation_tasks ON opening_tasks;
    CREATE POLICY tenant_isolation_tasks ON opening_tasks
      USING (tenant_id = current_setting('app.tenant_id')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_templates ON opening_templates;
    CREATE POLICY tenant_isolation_templates ON opening_templates
      USING (tenant_id = current_setting('app.tenant_id')::uuid);

    CREATE INDEX IF NOT EXISTS idx_opening_tasks_tenant_status ON opening_tasks (tenant_id, status, created_at);
END $$;