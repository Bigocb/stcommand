-- Drone-plus-collector mining (review item 6): a mine feed can pin its drones to one asteroid (`field`) and name a
-- shuttle (`collector`) that waits in orbit there, takes the drones' holds via the cargo-transfer endpoint, and
-- flies the full load to the target market. The drones never leave the field.
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS field text;
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS collector text;
