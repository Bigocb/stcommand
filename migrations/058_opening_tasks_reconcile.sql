-- Reconcile an opening_tasks table created by the FIRST version of 055.
--
-- Why this file exists: migrations are keyed by filename, so editing 055 after
-- it has been recorded in schema_migrations does nothing on a database that
-- already ran it. The first 055 created the table without the
-- (tenant_id, task_key) unique constraint and with no default on created_by,
-- both of which Store.addOpeningTask depends on:
--
--   * it upserts with ON CONFLICT (tenant_id, task_key), which Postgres rejects
--     outright — "there is no unique or exclusion constraint matching the ON
--     CONFLICT specification" — so adding any task failed;
--   * created_by is NOT NULL, so an insert that does not name it fails.
--
-- The rewritten 055 already carries both for a fresh database. This brings an
-- existing one to the same shape. Everything here is idempotent, so a fresh
-- install (where 055 already did it) is a no-op.
--
-- Two ordering constraints learned the hard way (the first attempt at this
-- migration crash-looped the container):
--
--   1. The first 055's policy calls current_setting('app.tenant_id') with no
--      missing-ok flag, so under FORCE RLS any statement that is not scoped to a
--      tenant raises 42704 'unrecognized configuration parameter'. The dedupe
--      below is exactly that kind of statement. Dropping FORCE first lets the
--      table owner work on it, and FORCE is restored at the end.
--   2. The policy has to be replaced before FORCE goes back on, or the window in
--      between is a table nobody may read.

ALTER TABLE opening_tasks NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    -- Collapse any duplicates the constraint-free window allowed, keeping the
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
END $$;

-- Both sides stated explicitly, and with the missing-ok flag so an unscoped
-- statement reads as "no rows" instead of raising.
DROP POLICY IF EXISTS tenant_isolation_tasks ON opening_tasks;
CREATE POLICY tenant_isolation_tasks ON opening_tasks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE opening_tasks FORCE ROW LEVEL SECURITY;
