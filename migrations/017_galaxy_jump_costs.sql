-- Persists GalaxyAtlas's learned per-gate-pair jump cost average — same
-- shared, no-tenant-id pattern as galaxy_systems/market_snapshots (a real
-- jump's cost is a fact about the galaxy's gate network, not about which
-- tenant happened to pay for it, and letting every tenant's real jumps feed
-- one shared average gets everyone to a useful estimate faster).
--
-- Before this, the average lived only in GalaxyAtlas's in-memory jumpCosts
-- Map (galaxy.ts), wiped on every process restart. Confirmed live: with
-- deploys happening several times a day, a learned cost never survived long
-- enough to replace CROSS_SYSTEM_JUMP_COST_ESTIMATE's flat 5,000c
-- placeholder — every cross-system leg was priced against the placeholder
-- forever regardless of how many real jumps actually happened, which is a
-- large part of why no cross-system route ever profitably fired.
CREATE TABLE IF NOT EXISTS galaxy_jump_costs (
  from_gate text NOT NULL,
  to_system text NOT NULL,
  total_price bigint NOT NULL,
  jump_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_gate, to_system)
);
