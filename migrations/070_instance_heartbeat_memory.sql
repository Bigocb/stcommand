-- How each server process ended (src/ops/containerStats.ts, ops `container`): the heartbeat row also keeps the process's memory at
-- its last beat, the container's cgroup memory and OOM-kill counter, and which code it ran. A row whose process died says what memory
-- looked like 10 s before the end; the next process's code time says whether a deploy replaced it. Rows are kept 7 days.
ALTER TABLE instance_heartbeats
  ADD COLUMN IF NOT EXISTS rss_mb integer,
  ADD COLUMN IF NOT EXISTS heap_used_mb integer,
  ADD COLUMN IF NOT EXISTS heap_limit_mb integer,
  ADD COLUMN IF NOT EXISTS cgroup_current_mb integer,
  ADD COLUMN IF NOT EXISTS cgroup_limit_mb integer,
  ADD COLUMN IF NOT EXISTS oom_kills integer,
  ADD COLUMN IF NOT EXISTS build text,
  ADD COLUMN IF NOT EXISTS code_mtime timestamptz;
