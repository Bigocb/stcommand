-- Per-mission buy pacing for construction missions: units per purchase, minimum minutes between
-- purchases of a material, and the cumulative price ceiling (percent above the trailing-24h low).
-- NULL / missing keys mean "use the built-in default" (market lot size, no gap, 40%). Stored as one
-- jsonb blob so a new knob never needs another migration.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pacing jsonb;
