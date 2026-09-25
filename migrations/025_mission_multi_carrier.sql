-- Multi-carrier missions: a construction/feeder site can now be staffed by
-- more than one ship at once (see the "protocol" work in CLAUDE.md/TODO —
-- racing a jump-gate build needs several buyers on the bottleneck material,
-- not one). `assigned_ship` was a single column throughout mission.ts;
-- replaced with `assigned_ships` (jsonb array) plus `carrier_target` (how
-- many ships this mission wants staffed — defaults to 1, preserving today's
-- single-carrier behavior for every existing mission).

ALTER TABLE missions ADD COLUMN IF NOT EXISTS assigned_ships jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS carrier_target integer NOT NULL DEFAULT 1;

UPDATE missions
   SET assigned_ships = jsonb_build_array(assigned_ship)
 WHERE assigned_ship IS NOT NULL AND assigned_ships = '[]'::jsonb;

ALTER TABLE missions DROP COLUMN IF EXISTS assigned_ship;
