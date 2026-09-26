-- Records one row per coordinator tick pass (FleetManager.tick()) that ran
-- unusually slowly, with a full per-step breakdown of where the time went.
--
-- Built to catch a live incident: FeedManager's own step() heartbeat (logs
-- at most once a minute, unconditionally) went silent for 5-10 minutes at
-- a time, even though tick() calls feeds.tick() every ~2s. That's not a
-- feed-side bug -- it means something EARLIER in the same serial tick()
-- pass (a long chain: refreshCredits -> ... -> missions.tick() ->
-- feeds.tick() -> ...) was occasionally blocking for minutes, stalling
-- every step after it in that same pass. Per-tick console logging alone
-- can't answer "which step, how often, how bad" -- this table can.
--
-- Only slow ticks are recorded (see FleetManager.TICK_WARN_MS), not every
-- tick -- a coordinator tick fires every ~2s, so logging every pass would
-- write roughly 30/minute/tenant for no diagnostic benefit once the fleet
-- is healthy. A tick that's actually slow is rare enough that recording it
-- in full is cheap, and that's exactly the case this needs to catch.

CREATE TABLE IF NOT EXISTS tick_step_timings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL,
  total_ms        integer NOT NULL,
  steps           jsonb NOT NULL, -- [{"name": "missions.tick", "ms": 4213}, ...], in call order
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tick_step_timings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tick_step_timings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tick_step_timings USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX idx_tick_step_timings_tenant_started ON tick_step_timings (tenant_id, started_at DESC);
