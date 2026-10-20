-- A manual route's own loss tolerance has to survive a restart next to the
-- route itself (held_route is the durable twin of TraderAgent's heldRoute /
-- heldCost). Store.setHeldRoute writes it and getAllHeldRoutes reads it back;
-- without the column the insert fails at runtime.
--
-- Null = the default margin gate, same meaning as feed_missions.max_loss_per_unit
-- (migrations/040).
ALTER TABLE held_route ADD COLUMN IF NOT EXISTS max_loss_per_unit integer;
