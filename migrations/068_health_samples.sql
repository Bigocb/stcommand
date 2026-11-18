-- The admin health board's history (src/engine/serverHealth.ts, Phase 2): one reading a minute, written by the engine
-- process (src/engine/healthRecorder.ts), so the board can chart the last 6 hours and a stall can be seen after the fact.
--
-- scope is 'server' for the process-wide row (the overall word, uptime, API calls against the cap, 429s, the limiter
-- queue) or a tenant's agent symbol for that tenant's row (heartbeat gap, normal gap and stall line, idle traders,
-- longest engine pass, matched profit in the last hour, wallet). Columns that do not apply to a scope are NULL.
--
-- Operational data about this server, read only by the operator-wide admin page, keyed by agent symbol like
-- agent_samples (063): no tenant_id and no row-level policy. Not wiped at the weekly reset (it is not galaxy state; keep it
-- out of Store.SHARED_GALAXY_TABLES and TENANT_GAME_TABLES); rows older than about 7 days are pruned by the recorder.
CREATE TABLE IF NOT EXISTS health_samples (
  sampled_at        timestamptz NOT NULL,
  scope             text        NOT NULL,
  instance_id       text        NOT NULL,
  word              text        NOT NULL,
  level             text        NOT NULL CHECK (level IN ('ok', 'warn', 'bad')),
  gap_ms            bigint,
  normal_gap_ms     bigint,
  stall_line_ms     bigint,
  idle_traders      integer,
  traders           integer,
  longest_pass_ms   bigint,
  profit_last_hour  bigint,
  wallet            bigint,
  uptime_ms         bigint,
  calls_per_min     real,
  cap               integer,
  hits_429          integer,
  oldest_wait_ms    bigint,
  PRIMARY KEY (scope, sampled_at, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_health_samples_at ON health_samples (sampled_at);
