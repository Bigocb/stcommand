-- docs/policy-library-and-onboarding-plan.md: a doctrine row now tracks
-- whether the tenant has adopted that policy into their active set, not
-- just its value/enabled state. DEFAULT true means every existing row
-- (every tenant's every prior explicit override) becomes adopted=true
-- automatically here — no backfill script, no risk of an existing tenant's
-- tuned fleet losing a rule it was relying on. Combined with Doctrine's own
-- grandfather fallback for a catalog entry with no row at all
-- (defaultAdopted:true), every current tenant's Book page renders
-- identically to before this migration, for both tuned and untouched rules.
ALTER TABLE doctrine ADD COLUMN IF NOT EXISTS adopted boolean NOT NULL DEFAULT true;
