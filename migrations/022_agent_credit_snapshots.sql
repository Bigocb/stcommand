-- Running tally of every publicly-known agent's credits/ship count over
-- time, one row per GalaxyCrawler.crawlAgents() pass (hourly, see
-- AGENTS_REFRESH_INTERVAL_MS) — same shared, no-tenant-id pattern as
-- galaxy_jump_costs/galaxy_gate_construction, for the identical reason:
-- another agent's credits are a fact about the galaxy, not about which
-- tenant happened to check them.
--
-- Before this, GalaxyCrawler.agentsInSystem() only ever held the latest
-- pass in memory (agentsBySystem), wiped on every restart — an operator
-- watching a competitor sharing their home system's headquarters waypoint
-- (confirmed live: this exact scenario explained a mystery gate
-- contributor and a market staying crushed longer than the local fleet's
-- own volume would predict) had no way to see whether that agent's
-- credits were climbing, stalled, or just spent, only a single snapshot.
CREATE TABLE IF NOT EXISTS agent_credit_snapshots (
  id           bigserial PRIMARY KEY,
  system_symbol text NOT NULL,
  agent_symbol  text NOT NULL,
  credits       bigint NOT NULL,
  ship_count    integer NOT NULL,
  timestamp     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_credit_snapshots_agent ON agent_credit_snapshots (agent_symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_credit_snapshots_system ON agent_credit_snapshots (system_symbol, timestamp);
