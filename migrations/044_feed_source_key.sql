-- A buying feed and a mining feed may now supply the same target market with the same good (2026-10-07, operator:
-- buy QUARTZ_SAND at B7 and mine it at CE5D, both into F53). The source mode becomes part of a feed's identity; see
-- FeedManager.key() in src/engine/feed.ts. Existing rows are unaffected: at most one row per (tenant, waypoint, good)
-- exists today, so the wider key is already unique.
ALTER TABLE feed_missions DROP CONSTRAINT IF EXISTS feed_missions_tenant_id_target_waypoint_good_key;
CREATE UNIQUE INDEX IF NOT EXISTS feed_missions_tenant_waypoint_good_mine_key
  ON feed_missions (tenant_id, target_waypoint, good, mine);
