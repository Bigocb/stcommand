-- Explicit operator choice: source a feed's good by mining instead of
-- buying at a market. See src/engine/feed.ts's Feed.mine comment — most raw
-- ore has no market seller at all, and guessing "mineable" from that alone
-- is unreliable, so this is a checkbox on the feed, not an auto-detected
-- fallback.

ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS mine boolean NOT NULL DEFAULT false;
