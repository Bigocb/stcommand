-- The agent rank in the Tower and Deck top bars (src/engine/agentRank.ts) reads the latest directory pass: every row whose
-- timestamp is the newest one (one INSERT per pass, so the pass shares one now()). This index makes that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_agent_credit_snapshots_ts ON agent_credit_snapshots (timestamp);
