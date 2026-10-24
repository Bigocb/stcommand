-- Who registered when, and how fast gates get built (docs/agent-watch.md).
--
-- The public API gives no registration time for an agent, and agent_credit_snapshots (hourly, 022) is on
-- Store.SHARED_GALAXY_TABLES, so it is wiped at every weekly reset, and it records neither an agent's faction nor the
-- state of its start gate. These three tables are kept across resets (they are NOT in SHARED_GALAXY_TABLES) and every
-- row carries the reset date it belongs to, so a week can be compared with the last. All are public facts about the
-- universe, not about any tenant, so there is no tenant_id and no row-level policy, like galaxy_gate_construction.

-- One row per agent per reset: when we first saw it, how sure that is, where it started and what that start looked like.
CREATE TABLE IF NOT EXISTS agent_sightings (
  reset_date        text        NOT NULL,
  agent_symbol      text        NOT NULL,
  system_symbol     text        NOT NULL,
  hq_waypoint       text        NOT NULL,
  faction           text,
  first_seen_at     timestamptz NOT NULL,
  -- 'live': first appeared between two of our scans (prior_scan_at .. first_seen_at brackets the registration).
  -- 'snapshot': backfilled from the hourly agent_credit_snapshots (first_seen_at is the first hourly row).
  -- 'baseline': already there when the watcher first ran, so the registration time is unknown (first_seen_at is only an upper bound).
  source            text        NOT NULL CHECK (source IN ('live', 'snapshot', 'baseline')),
  prior_scan_at     timestamptz,
  first_credits     bigint,
  first_ships       integer,
  -- Agents headquartered in the same system in the scan that first saw this one (including it).
  agents_in_system  integer,
  last_seen_at      timestamptz NOT NULL,
  last_credits      bigint,
  last_ships        integer,
  PRIMARY KEY (reset_date, agent_symbol)
);
CREATE INDEX IF NOT EXISTS idx_agent_sightings_first ON agent_sightings (reset_date, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_agent_sightings_system ON agent_sightings (reset_date, system_symbol);

-- Credits and ship count per agent about every 30 minutes (the leaderboard curve).
CREATE TABLE IF NOT EXISTS agent_samples (
  reset_date   text        NOT NULL,
  agent_symbol text        NOT NULL,
  sampled_at   timestamptz NOT NULL,
  credits      bigint      NOT NULL,
  ships        integer     NOT NULL,
  PRIMARY KEY (reset_date, agent_symbol, sampled_at)
);

-- A start-system gate's construction progress, written when it changes (and once at first sight): how long a gate took
-- to build, and what it looked like when an agent first appeared next to it.
CREATE TABLE IF NOT EXISTS gate_progress_samples (
  reset_date    text        NOT NULL,
  gate_symbol   text        NOT NULL,
  system_symbol text        NOT NULL,
  sampled_at    timestamptz NOT NULL,
  fulfilled     integer     NOT NULL,
  required      integer     NOT NULL,
  complete      boolean     NOT NULL,
  PRIMARY KEY (reset_date, gate_symbol, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_gate_progress_system ON gate_progress_samples (reset_date, system_symbol, sampled_at);
