-- Mark the systems that provably have nothing to survey.
--
-- 060 seeded the ledger from galaxy_systems but deliberately skipped systems
-- with neither a MARKETPLACE nor a SHIPYARD waypoint, "so they are left
-- explorable". That was the wrong trade, and the bill arrived on 2026-10-20:
--
--   19:38  THEOREM-59 was five jumps into a trip to X1-MV21 — 71 asteroids,
--          2 fuel stations, an asteroid base and one gate, and not one
--          MARKETPLACE waypoint — because it was the nearest loaded system
--          without a ledger row. A jump costs ~12 minutes of cooldown, so the
--          nine such systems were hours of travel to record `0 markets,
--          0 shipyards` nine times, all of it ahead of the real frontier,
--          which is 13 hops away.
--
-- The "0" is not an inference: surveySystem() reads exactly two things and both
-- come from waypoint traits already cached in galaxy_systems —
-- GalaxyAtlas.surveyMarkets() filters on MARKETPLACE, surveyShipyards() on
-- SHIPYARD. A system with neither trait cannot produce a different answer.
-- Checked against every organic survey row on 2026-10-20: atlas MARKETPLACE
-- counts matched markets_found in 19 of the 20 most recent surveys (the one
-- exception, X1-MB49, read 0 against an atlas holding 4 — a stale scan, not a
-- counter-example to the rule).
--
-- Two consumers read this:
--   1. Explorer targeting — also fixed in code (FleetManager.hasNothingToSurvey),
--      so this migration is not load-bearing for the routing fix; it is here so
--      a fresh database starts from the same truth as production.
--   2. The ops Systems panel (src/engine/systems/candidates.ts) — it lists every
--      unsurveyed system as a "survey target". Without these rows it keeps
--      recommending nine voyages the engine will now refuse to make.
--
-- source='atlas-empty' is deliberately its own value, not 'backfill': it marks a
-- claim provable from the atlas rather than one where an explorer once stood.
-- Undo with: DELETE FROM system_surveys WHERE source='atlas-empty'.
--
-- Asymmetry with 060, on purpose: this inserts markets_found=0, shipyards_found=0
-- and touches no system holding a MARKETPLACE or SHIPYARD waypoint, so a real
-- sweep is never overwritten (ON CONFLICT DO NOTHING).
--
-- RLS: same reconciliation as 055 and 060 — the app user owns these tables and
-- 059 set FORCE ROW LEVEL SECURITY, so an unscoped INSERT would be rejected by
-- WITH CHECK against an unset app.tenant_id. The file is one implicit
-- transaction; a failure rolls the FORCE restore back with it.

ALTER TABLE system_surveys NO FORCE ROW LEVEL SECURITY;

INSERT INTO system_surveys (tenant_id, system_symbol, surveyed_at, markets_found, shipyards_found, source)
SELECT t.id,
       gs.system_symbol,
       now(),
       0,
       0,
       'atlas-empty'
FROM tenants t
CROSS JOIN galaxy_systems gs
WHERE jsonb_array_length(gs.waypoints) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(gs.waypoints) w,
         jsonb_array_elements(COALESCE(w->'traits', '[]'::jsonb)) tr
    WHERE tr->>'symbol' IN ('MARKETPLACE', 'SHIPYARD')
  )
ON CONFLICT (tenant_id, system_symbol) DO NOTHING;

ALTER TABLE system_surveys FORCE ROW LEVEL SECURITY;
