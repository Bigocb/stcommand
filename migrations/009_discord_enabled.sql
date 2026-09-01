-- Discord relay pause/resume: an operator wants to stop alerts without
-- losing the saved webhook URL, so this is a separate flag rather than
-- overloading "webhook cleared" to also mean "paused". Defaults to true so
-- every existing tenant with a webhook already configured keeps behaving
-- exactly as before this migration runs.

-- No `SET search_path` here: src/db/pool.ts sets it per connection from
-- DB_SCHEMA, so this file applies to whichever schema the migration run
-- targets (production `stcommand`, or the test schema).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_enabled boolean NOT NULL DEFAULT true;
