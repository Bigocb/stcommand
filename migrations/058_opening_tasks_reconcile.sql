-- Reconcile an opening_tasks table created by the FIRST version of 055.
--
-- Why this file exists: migrations are keyed by filename, so editing 055 after
-- it has been recorded in schema_migrations does nothing on a database that
-- already ran it. The first 055 shipped in this repo created the table without
-- the (tenant_id, task_key) unique constraint and with no default on
-- created_by, both of which Store.addOpeningTask depends on:
--
--   * it upserts with ON CONFLICT (tenant_id, task_key), which Postgres rejects
--     outright — "there is no unique or exclusion constraint matching the ON
--     CONFLICT specification" — so adding any task failed;
--   * created_by is NOT NULL, so an insert that does not name it fails.
--
-- The rewritten 055 already carries both for a fresh database. This brings an
-- existing one to the same shape. Everything here is idempotent, so a fresh
-- install (where 055 already did it) is a no-op.

DO $$
BEGIN
    -- Collapse any duplicates a constraint-free window allowed, keeping the
    -- newest row per (tenant, key), then enforce uniqueness.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'opening_tasks_tenant_key_uniq'
         AND conrelid = 'opening_tasks'::regclass
    ) THEN
      DELETE FROM opening_tasks a
       USING opening_tasks b
       WHERE a.tenant_id = b.tenant_id
         AND a.task_key = b.task_key
         AND a.id < b.id;

      ALTER TABLE opening_tasks
        ADD CONSTRAINT opening_tasks_tenant_key_uniq UNIQUE (tenant_id, task_key);
    END IF;

    ALTER TABLE opening_tasks ALTER COLUMN created_by SET DEFAULT 'operator';

    -- The first version's policy had no WITH CHECK, so an insert was only
    -- constrained by the USING expression. State both sides explicitly.
    DROP POLICY IF EXISTS tenant_isolation_tasks ON opening_tasks;
    CREATE POLICY tenant_isolation_tasks ON opening_tasks
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;
