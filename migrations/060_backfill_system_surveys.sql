-- Seed system_surveys with the systems the fleet has already charted.
--
-- PR #27 turned surveyedSystems into a table, but that table started empty:
-- before it, the set lived only in process memory and every restart wiped it,
-- silently, with nothing written down. The bill arrived at the 2026-10-20
-- 15:14 deploy — three explorers re-touring systems the atlas had held for
-- hours, X1-QB34 toured from the top twice within two hours by two different
-- hulls. This seeds the ledger once from galaxy_systems, which is the only
-- surviving record of where the fleet has been.
--
-- galaxy_systems is shared and tenant-free, so the insert fans out across
-- every tenant; each tenant still gets its own rows under its own tenant_id,
-- which is what the RLS policy and every read in Store expect.
--
-- source='backfill' is load-bearing, not cosmetic: it is what distinguishes a
-- claim inferred from the atlas from a system an explorer actually swept (a
-- mislabelled mark is otherwise durable and unauditable — see 059's comment),
-- and it is the handle for undoing this wholesale: DELETE WHERE
-- source='backfill', or per system via POST /api/explorer/forget.
--
-- surveyed_at is now(), not the atlas's scanned_at: the value is the moment
-- this tenant's ledger learned the system, and SURVEY_TTL_MS is measured from
-- it. Stated plainly because it bounds this fix — see the note at the end.
--
-- Only systems with at least one MARKETPLACE waypoint are seeded. A system
-- charted with neither a market nor a shipyard has nothing for a tour to
-- read, so it is deliberately left explorable (12 such systems on 2026-10-20).
--
-- RLS: this runs as stcommand_app, which OWNS these tables, and 059 set FORCE
-- ROW LEVEL SECURITY — so the owner is subject to its own policy and an
-- unscoped INSERT would be rejected by WITH CHECK against an unset
-- app.tenant_id. Dropping FORCE for the duration is the same reconciliation
-- migration 055 needed. The whole file is one implicit transaction
-- (node-postgres sends it as a single simple query), so a failure anywhere
-- rolls the FORCE restore back with it — never leave FORCE off on a partial
-- apply.

ALTER TABLE system_surveys NO FORCE ROW LEVEL SECURITY;

INSERT INTO system_surveys (tenant_id, system_symbol, surveyed_at, markets_found, shipyards_found, source)
SELECT t.id,
       m.system_symbol,
       now(),
       m.markets,
       m.yards,
       'backfill'
FROM tenants t
CROSS JOIN LATERAL (
  SELECT gs.system_symbol,
         (SELECT count(*) FROM jsonb_array_elements(gs.waypoints) w
           WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(w->'traits') tr
                          WHERE tr->>'symbol' = 'MARKETPLACE')) AS markets,
         (SELECT count(*) FROM jsonb_array_elements(gs.waypoints) w
           WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(w->'traits') tr
                          WHERE tr->>'symbol' = 'SHIPYARD')) AS yards
  FROM galaxy_systems gs
  WHERE jsonb_array_length(gs.waypoints) > 0
) m
WHERE m.markets > 0
-- Never overwrite a real sweep: an explorer's own mark carries the survey
-- time that gates the TTL and the counts it actually read. Those rows win.
ON CONFLICT (tenant_id, system_symbol) DO NOTHING;

ALTER TABLE system_surveys FORCE ROW LEVEL SECURITY;

-- KNOWN LIMIT, on purpose and not hidden: these marks age like any other, so
-- after SURVEY_TTL_MS (14 days, fleet.ts:346) the explorers will treat those
-- systems as due again. Backfill buys two weeks of exploring new space, it
-- does not change what the TTL means for a survey. Making it permanent is a
-- separate, reviewable change to the hydration filter in fleet.ts init()
-- (exempt source='backfill' from the `surveyed_at >= since` test), not
-- something a data migration should decide on its own.
