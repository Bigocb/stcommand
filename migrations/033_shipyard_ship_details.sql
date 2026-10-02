-- Per-ship stats the shipyard listing already carries but we never saved:
-- engine speed, reactor power, crew, and the modules/mounts a ship is sold
-- with. Cargo capacity is not on the frame; it comes from the cargo-hold
-- modules, so `modules` is what lets the Yards view show a real hold size.
-- Nullable: rows scanned before this migration have none until a ship of ours
-- is docked at that yard again (the listing only shows stock while one is).
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS engine_speed   integer;
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS reactor_power  integer;
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS crew_required  integer;
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS crew_capacity  integer;
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS modules        jsonb;
ALTER TABLE shipyard_inventory ADD COLUMN IF NOT EXISTS mounts         jsonb;
