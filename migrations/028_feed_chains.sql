-- Feeder chains: an ordered set of feeder tiers where each tier buys where
-- the previous one sold (ore->H56->F50->D40), instead of each tier
-- independently re-deriving "cheapest known market" and possibly landing on
-- an unconnected one. See src/engine/feed.ts's FeedChain/Feed.buyAt
-- comments. Not a separate table -- a chain is just a shared chain_id
-- across several feed_missions rows, grouped on read.

ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS buy_at text;
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS chain_id text;
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS chain_name text;
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS chain_order integer;
CREATE INDEX IF NOT EXISTS idx_feed_missions_chain ON feed_missions (tenant_id, chain_id);
