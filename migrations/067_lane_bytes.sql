-- Response bytes through the API lanes (the box's own IP and each proxy), by UTC day and call kind, so the proxy plan's monthly
-- bandwidth survives a restart (src/engine/laneBytes.ts). The plan is billed in bytes (256 GB a month, renewing on the 8th), and the
-- in-memory meter forgot everything at each restart.
--
-- label is host:port of the proxy, never its credentials, or 'box'. Written as increments about once a minute.
-- Not tenant data and not a fact about the game universe: no tenant_id, no row-level policy, and NOT wiped at the weekly reset
-- (it is a billing record, not galaxy state; keep it out of Store.SHARED_GALAXY_TABLES and TENANT_GAME_TABLES).
CREATE TABLE IF NOT EXISTS lane_bytes (
  day   date   NOT NULL,
  label text   NOT NULL,
  kind  text   NOT NULL,
  calls bigint NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, label, kind)
);
