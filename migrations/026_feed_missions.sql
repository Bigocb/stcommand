-- Feeder tiers: a dedicated crew that continuously buys a good cheap and
-- sells it into one specific upstream market, to keep that market's price
-- from spiking under a buyer's own repeated purchasing pressure (the
-- "protocol" work — see CLAUDE.md/docs/TODO.md's multi-carrier mission
-- entry). Deliberately a SEPARATE table/engine from `missions`, not a
-- SUPPLY_CONSTRUCTION variant: a feed has no construction site, no
-- required/fulfilled materials, and never "completes" the way a mission
-- does — it runs until the operator pauses or removes it. Same crew shape
-- as missions (assigned_ships/carrier_target) so the UI/engine patterns
-- match, but its own FeedManager (src/engine/feed.ts) and its own
-- ship_claims owner ("feed", see shipRegistry.ts).

CREATE TABLE IF NOT EXISTS feed_missions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_system   text NOT NULL,
  target_waypoint text NOT NULL,
  good            text NOT NULL,
  assigned_ships  jsonb NOT NULL DEFAULT '[]'::jsonb,
  carrier_target  integer NOT NULL DEFAULT 1,
  paused          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, target_waypoint, good)
);
ALTER TABLE feed_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_missions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feed_missions USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_feed_missions_tenant ON feed_missions (tenant_id);
