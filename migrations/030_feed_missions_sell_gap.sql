-- Per-feed minimum gap (ms) between sells into a feed's targetWaypoint,
-- shared across the whole crew. NULL means "use FeedManager's own
-- DEFAULT_SELL_GAP_MS" -- see src/engine/feed.ts's comment on that
-- constant for the reasoning (spacing sells out may matter independently
-- of total volume, since multiple carriers on one feed tend to fall into
-- lockstep and arrive to sell within the same few minutes repeatedly).
-- Per-feed rather than a global setting so the operator can A/B it per
-- route, the same way `force`/`mine` are already per-feed.

ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS sell_gap_ms integer;
