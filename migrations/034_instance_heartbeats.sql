-- One row per running server process, refreshed every few seconds. Lets any
-- instance see whether ANOTHER one is alive at the same time — the usual
-- cause of SpaceTraders 429 storms (a deploy's old instance still ticking
-- ships while the new one boots; both draw from the same per-IP limit).
-- Not tenant data; purely operational, safe to truncate at any time.
CREATE TABLE IF NOT EXISTS instance_heartbeats (
  instance_id text PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now()
);
