-- Mine feeds: hand over (to the collector, or fly to market) once a drone holds this many units of the feed's good,
-- instead of waiting for a nearly full hold. null = the old rule (hold at 80% or full).
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS handoff_units integer;
