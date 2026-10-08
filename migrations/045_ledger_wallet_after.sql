-- The wallet balance right after each ledger row (2026-10-08, operator). Many traders buy from one wallet, so a buy's
-- size depends on what the previous trader left; periodic cash readings cannot show that. The value comes from the
-- game's own response to the trade (agent.credits). NULL on rows written before this column existed.
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS wallet_after bigint;
